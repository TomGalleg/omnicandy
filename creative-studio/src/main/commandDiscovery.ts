/** Read-only formatting for application command catalogs. Never determines execution permissions. */
export interface DiscoveredCommand { id: string; label?: string; params?: unknown }

const PAGE_SIZE = 80;

/** Small hints preserve useful ranges for common commands without shipping full schemas. */
export function compactParameterHints(params: unknown, maxLength = 180): string {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return '';
  const value = params as Record<string, unknown>;
  const props = value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)
    ? value.properties as Record<string, unknown> : value;
  const required = new Set(Array.isArray(value.required) ? value.required.filter((x): x is string => typeof x === 'string') : []);
  const hints: string[] = [];
  for (const [key, raw] of Object.entries(props).slice(0, 8)) {
    if (key === 'required' || key === 'additionalProperties' || key === 'type' || key === '$schema') continue;
    if (typeof raw === 'string') { hints.push(`${key}:${raw.slice(0, 28)}`); continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const p = raw as Record<string, unknown>;
    const typ = typeof p.type === 'string' ? p.type : 'value';
    const limits = [p.minimum ?? p.min, p.maximum ?? p.max].map(v => typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
    const range = limits.some(Boolean) ? `(${limits[0] || '…'}..${limits[1] || '…'})` : '';
    const opts = Array.isArray(p.enum) ? `{${p.enum.slice(0, 4).map(v => String(v).slice(0, 16)).join('|')}${p.enum.length > 4 ? '|…' : ''}}` : '';
    hints.push(`${key}${required.has(key) ? '!' : '?'}:${typ}${range}${opts}`);
  }
  const text = hints.join(', ');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/** A CLI may print either one command per line or a command followed by indented description lines. */
export function parsePlainCommandCatalog(output: string): DiscoveredCommand[] {
  const commands: DiscoveredCommand[] = [];
  for (const original of output.split(/\r?\n/)) {
    const line = original.trim();
    if (!line) continue;
    const last = commands[commands.length - 1];
    // Indented lines (descriptions, params) always continue the current command, never start one.
    // A trailing `*` is FigCraft's undoable marker (`commands --json` lists the id without it), not part of the id.
    const match = /^\s/.test(original) ? null : line.match(/^([A-Za-z_][\w.:-]*)\*?(?:\s+(.*))?$/);
    const id = match?.[1];
    if (match && id) {
      commands.push({ id, label: match[2] || undefined });
    } else if (last) {
      last.label =`${last.label ? `${last.label} ` : ''}${line}`.slice(0, 500);
    }
  }
  return commands;
}

/** The filter supports e.g. `blur page:2` or `page:3`; pagination counts commands, not lines. */
export function formatDiscoveredCommands(data: unknown, filter?: string, app = 'Application'): string {
  const raw = Array.isArray(data) ? data : data && typeof data === 'object' ?
    ((data as Record<string, unknown>).commands ?? (data as Record<string, unknown>).items ?? (data as Record<string, unknown>).tools) : undefined;
  if (!Array.isArray(raw)) throw new Error(`${app} returned an unsupported command catalog format.`);
  const entries = raw.flatMap((entry): Array<{ id: string; label: string; params?: unknown }> => {
    if (typeof entry === 'string') return [{ id: entry, label: '' }];
    if (!entry || typeof entry !== 'object') return [];
    const c = entry as Record<string, unknown>;
    const id = typeof c.id === 'string' ? c.id : typeof c.name === 'string' ? c.name : null;
    if (!id) return [];
    return [{ id, label: String(c.label ?? c.description ?? ''), params: c.params ?? c.parameters ?? c.inputSchema ?? c.input_schema }];
  });
  // An exact-id query is an inspection request, not a catalog search.
  // Do not silently truncate parameter definitions: fail explicitly if the model-facing limit is exceeded.
  const exact = filter?.trim();
  const match = exact ? entries.find((entry) => entry.id === exact) : undefined;
  if (match) {
    const detail = JSON.stringify(match);
    if (detail.length > 7500) return `${app} command ${match.id} has a schema too large for this tool response; inspection requires a smaller dedicated schema endpoint.`;
    return detail;
  }
  const rows = entries.map((c) => {
    const summary = `${c.id}${c.label ? ` — ${c.label.slice(0, 150)}` : ''}`;
    if (c.params === undefined) return summary;
    const hints = compactParameterHints(c.params);
    return `${summary}${hints ? ` [${hints}]` : ''} [inspect exact id for full schema]`;
  });
  if (!rows.length) throw new Error(`${app} lists no commands; use the quick edits in get_status.`);
  const requested = filter ?? '';
  const pageTokens = [...requested.matchAll(/(?:^|\s)page:(\d+)(?=\s|$)/gi)];
  const lastToken = pageTokens[pageTokens.length - 1];
  const page = lastToken ? Number(lastToken[1] ?? '') : 1;
  if (!Number.isSafeInteger(page) || page < 1) return 'Invalid page; use page:1, page:2, etc.';
  const q = requested.replace(/(?:^|\s)page:\d+(?=\s|$)/gi, ' ').trim().toLowerCase();
  const matches = q ? rows.filter((row) => row.toLowerCase().includes(q)) : rows;
  if (!matches.length) return `No ${app} commands match "${q}". Try a shorter filter.`;
  const pages = Math.ceil(matches.length / PAGE_SIZE);
  if (page > pages) return `${app} has ${matches.length} matching commands (${pages} pages). Page ${page} does not exist.`;
  const start = (page - 1) * PAGE_SIZE;
  const shown = matches.slice(start, start + PAGE_SIZE);
  const header = `${app} commands: ${matches.length} matching; page ${page}/${pages} (commands ${start + 1}-${start + shown.length}).`;
  const footer = page < pages ? `\nMore commands: call app_commands with filter "${q ? `${q} ` : ''}page:${page + 1}".` : '';
  return `${header}\n${shown.join('\n')}${footer}`;
}

export function formatMcpTools(data: unknown, filter?: string, app = 'Application'): string {
  if (!data || typeof data !== 'object' || !Array.isArray((data as { tools?: unknown }).tools)) {
    throw new Error(`${app} returned an invalid MCP tools list.`);
  }
  const tools = (data as { tools: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }> }).tools;
  const excluded = new Set(['command_run', 'command_batch', 'command_list', 'execute_command', 'run_script', 'script_ui', 'doc_open', 'doc_save', 'doc_export', 'open_project', 'save_project', 'batch', 'list_commands', 'describe_command']);
  const rows = tools.filter((t) => typeof t.name === 'string' && !excluded.has(t.name))
    .map((t) => ({ id: `tool:${t.name}`, label: typeof t.description === 'string' ? t.description : '', params: t.inputSchema }));
  return formatDiscoveredCommands(rows, filter, app);
}

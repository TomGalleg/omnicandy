// Stage "research normalization": absorbs HARMLESS differences between how Claude phrases its research and the strict research
// schema (wrapper objects, unknown extra fields, slightly long notes, missing optional lists, capitalised enum words), and
// reports each change it made. It never invents or "fixes" a technical fact:
//   * identity (application name) and the summary must be present, or the research is rejected with a clear reason;
//   * sources with a missing or non-https address are DROPPED (never repaired), and if none remain the research is marked
//     "no documentation consulted", which stops the build (needs documentation);
//   * unknown method names are dropped, unknown support levels and source kinds are DOWNGRADED (never upgraded);
//   * claims that depend on missing evidence are never switched on (sourcesConsulted defaults to false and is forced false when no
//     valid source remains).
// The result still goes through the strict schema afterwards. Research carries no executable paths, permissions or commands:
// those exist only in the blueprint, which keeps its strict validation untouched (blueprint.ts, validate.ts).

export interface NormalizedResearch { value: unknown; notes: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Truncates descriptive text only (never addresses or names that identify things). */
function clip(v: unknown, max: number, notes: string[], what: string): string {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
  if (s.length <= max) return s;
  notes.push(`${what} was shortened from ${s.length} to ${max} characters.`);
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function list(v: unknown, notes: string[], what: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') { notes.push(`${what} was a single text and was treated as a one-item list.`); return v.trim() ? [v] : []; }
  if (!Array.isArray(v)) throw new Error(`${what} must be a list.`);
  return v;
}

function strList(v: unknown, itemMax: number, maxItems: number, notes: string[], what: string): string[] {
  const out = list(v, notes, what).map((x) => clip(x, itemMax, notes, `An entry of ${what}`)).filter((x) => x.length > 0);
  if (out.length > maxItems) { notes.push(`${what} had ${out.length} entries; the first ${maxItems} were kept.`); return out.slice(0, maxItems); }
  return out;
}

const word = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/[_\s]+/g, '-') : '');

const SOURCE_KIND: Record<string, 'official' | 'vendor-community' | 'user-supplied'> = {
  official: 'official', 'official-documentation': 'official', 'official-docs': 'official', 'vendor-documentation': 'official', 'vendor-docs': 'official', vendor: 'official',
  'vendor-community': 'vendor-community', community: 'vendor-community', 'vendor-forum': 'vendor-community',
  'user-supplied': 'user-supplied', user: 'user-supplied', 'user-provided': 'user-supplied',
};
const METHOD: Record<string, string> = {
  api: 'api', scripting: 'scripting', script: 'scripting', mcp: 'mcp', cli: 'cli', 'command-line': 'cli', commandline: 'cli', 'file-exchange': 'file-exchange', 'file-based': 'file-exchange', files: 'file-exchange',
  'ui-automation': 'ui-automation', visual: 'visual',
};
const SUPPORT: Record<string, 'official' | 'partial' | 'none'> = { official: 'official', full: 'official', partial: 'partial', limited: 'partial', none: 'none', no: 'none', unofficial: 'none' };

function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/** Throws an Error with a plain explanation when the research cannot be used at all. */
export function normalizeResearch(input: unknown): NormalizedResearch {
  const notes: string[] = [];
  let r: unknown = input;
  // wrappers such as {"research": {...}} or {"result": {...}}
  for (let i = 0; i < 2 && isObj(r) && !('summary' in r) && !('application' in r); i++) {
    const inner = ['research', 'result', 'report', 'data'].map((k) => (r as Record<string, unknown>)[k]).find(isObj);
    if (!inner) break;
    notes.push('The research was wrapped in an extra object; it was unwrapped.');
    r = inner;
  }
  if (!isObj(r)) throw new Error('The research is not a JSON object.');
  const known = new Set(['application', 'summary', 'sources', 'methods', 'scripting', 'commandLine', 'fileFormats', 'pluginTechnologies', 'licensing', 'requiredTools', 'limitations', 'insufficient', 'sourcesConsulted']);
  const extra = Object.keys(r).filter((k) => !known.has(k));
  if (extra.length) notes.push(`Ignored extra fields: ${extra.slice(0, 6).join(', ')}.`);

  // identity: never invented
  const appIn = isObj(r.application) ? r.application : null;
  const appName = clip(appIn?.name, 80, notes, 'The application name');
  if (!appName) throw new Error('The research does not name the application, so it cannot be used.');
  const summary = clip(r.summary, 2000, notes, 'The summary');
  if (!summary) throw new Error('The research has no summary of how the program can be controlled, so it cannot be used.');
  const publisher = clip(appIn?.publisher, 80, notes, 'The publisher') || null;
  const version = clip(appIn?.version, 40, notes, 'The version') || null;
  const platforms = strList(appIn?.platforms, 40, 6, notes, 'platforms');

  // sources: dropped when unusable, never repaired
  const sources: Array<Record<string, unknown>> = [];
  let dropped = 0;
  for (const s of list(r.sources, notes, 'sources')) {
    if (!isObj(s)) { dropped++; continue; }
    const url = typeof s.url === 'string' ? s.url.trim() : '';
    let ok = false;
    try { ok = /^https:\/\//i.test(url) && !!new URL(url).hostname && url.length <= 300; } catch { ok = false; }
    if (!ok) { dropped++; continue; }
    const kindRaw = word(s.kind);
    const kind = SOURCE_KIND[kindRaw] ?? 'other';
    if (kindRaw && !SOURCE_KIND[kindRaw]) notes.push(`A source of kind "${String(s.kind).slice(0, 30)}" was filed as "other" (not treated as official).`);
    const title = clip(s.title, 160, notes, 'A source title') || new URL(url).hostname;
    const note = clip(s.note ?? s.description ?? s.summary, 700, notes, 'A source note');
    sources.push({ title, url, kind, ...(note ? { note } : {}) });
  }
  if (dropped) notes.push(`${dropped} source${dropped === 1 ? ' was' : 's were'} dropped because the address was missing or not an https link.`);
  const seen = new Set<string>();
  const uniq = sources.filter((s) => (seen.has(String(s.url)) ? false : (seen.add(String(s.url)), true)));
  const keptSources = uniq.slice(0, 30);
  if (uniq.length > 30) notes.push('More than 30 sources were given; the first 30 were kept.');

  // methods: unknown names dropped, unknown support levels downgraded
  const methods: Array<Record<string, unknown>> = [];
  for (const m of list(r.methods, notes, 'methods')) {
    if (!isObj(m)) continue;
    const method = METHOD[word(m.method)];
    if (!method) { notes.push(`A method named "${String(m.method).slice(0, 30)}" is not one OmniCandy knows and was dropped.`); continue; }
    const support = SUPPORT[word(m.officialSupport)] ?? 'none';
    if (!SUPPORT[word(m.officialSupport)]) notes.push(`The support level of method ${method} was unclear and was recorded as "none".`);
    methods.push({ method, officialSupport: support, note: clip(m.note, 400, notes, `The note for method ${method}`) || 'No note given.' });
  }
  const methodsKept = methods.slice(0, 8);

  const insufficientText = clip(r.insufficient, 800, notes, 'The "insufficient" explanation') || null;
  let consulted = bool(r.sourcesConsulted);
  if (consulted === null) { notes.push('The research did not say whether documentation was read; it was recorded as "not read".'); consulted = false; }
  if (consulted && keptSources.length === 0) { notes.push('The research claimed documentation was read but no valid source address remains; it was recorded as "not read".'); consulted = false; }

  return {
    notes,
    value: {
      application: { name: appName, publisher, platforms, version },
      summary,
      sources: keptSources,
      methods: methodsKept,
      scripting: strList(r.scripting, 300, 10, notes, 'scripting'),
      commandLine: strList(r.commandLine, 300, 10, notes, 'commandLine'),
      fileFormats: strList(r.fileFormats, 120, 20, notes, 'fileFormats'),
      pluginTechnologies: strList(r.pluginTechnologies, 160, 10, notes, 'pluginTechnologies'),
      licensing: clip(r.licensing, 600, notes, 'The licensing text'),
      requiredTools: strList(r.requiredTools, 160, 10, notes, 'requiredTools'),
      limitations: strList(r.limitations, 400, 12, notes, 'limitations'),
      insufficient: insufficientText,
      sourcesConsulted: consulted,
    },
  };
}

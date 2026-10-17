// Reading what an AI said when the owner pastes it back (docs/planner-simplification-plan.md, section 5). Deterministic text parsing
// only: no model, no network. Reading never applies anything; the result is a preview. Hostile or malformed text can only produce
// "unclear" or an error list, never an action.
import { ACTOR_KINDS, type Actor, changeSchema, type ProposalChange } from './planner';
import { parseReportText, type ReportImportPreview } from './plannerHandoff';

export const MAX_PASTE_CHARS = 200_000;
const MAX_CHANGES = 30;

export interface SuggestionPreview {
  format: 'json' | 'markdown' | 'unreadable';
  proposer?: Actor;
  note: string;
  changes: ProposalChange[];
  uncertain: string[];
  errors: string[];
}

const SECTIONS: Array<[RegExp, 'requirement' | 'decision' | 'task' | 'question' | 'idea']> = [
  [/^(requirements?|rules?|must haves?)$/, 'requirement'],
  [/^(decisions?)$/, 'decision'],
  [/^(tasks?|suggested tasks?|to ?do|next steps|steps)$/, 'task'],
  [/^(questions?|open questions?)$/, 'question'],
  [/^(ideas?|notes?)$/, 'idea'],
];
const KEYS: Record<string, 'requirement' | 'decision' | 'task' | 'question' | 'idea'> = { requirements: 'requirement', decisions: 'decision', tasks: 'task', questions: 'question', ideas: 'idea' };

const kindOf = (v: unknown) => ((ACTOR_KINDS as readonly string[]).includes(String(v)) ? (String(v) as Actor['kind']) : 'other');
const clip = (t: string, n: number) => t.replace(/\s+/g, ' ').trim().slice(0, n);

function jsonObject(text: string): Record<string, unknown> | undefined {
  const tries: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let m = fence.exec(text); m; m = fence.exec(text)) tries.push(m[1] ?? '');
  const a = text.indexOf('{'); const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) { try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>; } catch { /* next */ } }
  return undefined;
}

function entryToChange(kind: 'requirement' | 'decision' | 'task' | 'question' | 'idea', e: unknown, errors: string[], where: string): ProposalChange | undefined {
  const o: Record<string, unknown> = typeof e === 'string' ? { title: e } : e && typeof e === 'object' ? (e as Record<string, unknown>) : {};
  const title = clip(String(o.title ?? o.name ?? ''), 200);
  if (!title) { errors.push(`${where}: an entry has no title.`); return undefined; }
  const text = String(o.text ?? o.description ?? o.details ?? '').trim().slice(0, 4000);
  const raw = kind === 'task'
    ? { op: 'add_task', title, description: text, priority: ['low', 'normal', 'high', 'urgent'].includes(String(o.priority)) ? o.priority : 'normal', completionChecks: Array.isArray(o.checks ?? o.completionChecks) ? ((o.checks ?? o.completionChecks) as unknown[]).map((x) => clip(String(typeof x === 'object' && x ? (x as { text?: unknown }).text ?? '' : x), 400)).filter(Boolean).slice(0, 20) : [] }
    : { op: 'add_item', itemType: kind, title, text, reason: String(o.reason ?? o.why ?? '').trim().slice(0, 2000) };
  const parsed = changeSchema.safeParse(raw);
  if (!parsed.success) { errors.push(`${where} "${title.slice(0, 40)}": ${parsed.error.issues[0]?.message ?? 'not valid'}`); return undefined; }
  return parsed.data;
}

/** Reads a brainstorming answer: JSON ({changes:[...]} or {tasks, requirements, decisions, questions, ideas}) or Markdown lists under those headings. */
export function parseSuggestionText(text: string): SuggestionPreview {
  const uncertain: string[] = []; const errors: string[] = [];
  const empty = (format: SuggestionPreview['format']): SuggestionPreview => ({ format, note: '', changes: [], uncertain, errors });
  if (!text.trim()) return { ...empty('unreadable'), errors: ['Nothing was pasted.'] };
  if (text.length > MAX_PASTE_CHARS) return { ...empty('unreadable'), errors: [`That is too long to read safely (more than ${MAX_PASTE_CHARS.toLocaleString()} characters). Paste the part you want.`] };
  const changes: ProposalChange[] = [];
  const o = jsonObject(text);
  if (o && ('changes' in o || Object.keys(KEYS).some((k) => k in o))) {
    const who = o.proposer ?? o.executor ?? o.by;
    const proposer: Actor | undefined = typeof who === 'string' ? { kind: 'other', name: clip(who, 80) } : who && typeof who === 'object' && (who as { name?: unknown }).name ? { kind: kindOf((who as { kind?: unknown }).kind), name: clip(String((who as { name: unknown }).name), 80) } : undefined;
    if (Array.isArray(o.changes)) {
      o.changes.slice(0, MAX_CHANGES).forEach((c, i) => { const r = changeSchema.safeParse(c); if (r.success) changes.push(r.data); else errors.push(`change ${i + 1}: ${r.error.issues[0]?.path.join('.') || 'entry'}: ${r.error.issues[0]?.message ?? 'not valid'}`); });
      if (o.changes.length > MAX_CHANGES) errors.push(`Only the first ${MAX_CHANGES} changes were read.`);
    }
    for (const [key, kind] of Object.entries(KEYS)) {
      const list = o[key];
      if (!Array.isArray(list)) continue;
      for (const e of list.slice(0, MAX_CHANGES)) { const c = entryToChange(kind, e, errors, key); if (c && changes.length < MAX_CHANGES) changes.push(c); }
    }
    if (!proposer) uncertain.push('The answer does not say who wrote it; it will be recorded as "Pasted suggestion".');
    return { format: 'json', ...(proposer ? { proposer } : {}), note: clip(String(o.note ?? o.summary ?? ''), 1000), changes, uncertain, errors };
  }

  let cur: (typeof SECTIONS)[number][1] | null = null;
  let lastTask: Extract<ProposalChange, { op: 'add_task' }> | null = null;
  let subChecks = false;
  for (const raw of text.split(/\r?\n/)) {
    const h = /^\s{0,3}(?:#{1,6}\s+|\*\*)([^*#:]+?)\s*(?:\*\*)?\s*:?\s*$/.exec(raw);
    const name = h ? (h[1] ?? '').trim().toLowerCase() : null;
    const sec = name ? SECTIONS.find(([re]) => re.test(name))?.[1] : undefined;
    if (sec) { cur = sec; lastTask = null; continue; }
    if (h && !sec) { cur = null; lastTask = null; continue; }
    if (!cur) continue;
    const b = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(raw);
    if (!b) continue;
    const indent = (b[1] ?? '').length; const item = (b[2] ?? '').trim();
    if (indent >= 2 && cur === 'task' && lastTask) { if (lastTask.completionChecks.length < 20) lastTask.completionChecks.push(clip(item, 400)); subChecks = true; continue; }
    if (changes.length >= MAX_CHANGES) { if (!errors.some((e) => e.startsWith('Only the first'))) errors.push(`Only the first ${MAX_CHANGES} suggestions were read.`); continue; }
    const c = entryToChange(cur, item, errors, cur);
    if (c) { changes.push(c); lastTask = c.op === 'add_task' ? c : null; }
  }
  if (subChecks) uncertain.push('Indented lines under a task were read as how to check that it is done.');
  if (!changes.length) return { ...empty('unreadable'), errors: errors.length ? errors : ['No suggestions were found. Use headings such as Requirements, Decisions, Tasks, Questions or Ideas with a list under each.'] };
  uncertain.push('The answer does not say who wrote it; it will be recorded as "Pasted suggestion".');
  return { format: 'markdown', note: '', changes, uncertain, errors };
}

export type PasteKind = 'report' | 'suggestions' | 'unclear';
export interface PasteClassification { kind: PasteKind; report?: ReportImportPreview; suggestions?: SuggestionPreview; why: string }

/**
 * A result for a task (report) or a plan suggestion? A report wins when the text names a package/task or has report headings;
 * otherwise suggestions; otherwise unclear, and the owner is asked.
 */
export function classifyPaste(text: string): PasteClassification {
  if (!text.trim()) return { kind: 'unclear', why: 'Nothing was pasted.' };
  if (text.length > MAX_PASTE_CHARS) return { kind: 'unclear', why: `That is too long to read safely (more than ${MAX_PASTE_CHARS.toLocaleString()} characters).` };
  const report = parseReportText(text);
  if (report.format !== 'unreadable') return { kind: 'report', report, why: 'It looks like the result of a task.' };
  const suggestions = parseSuggestionText(text);
  if (suggestions.changes.length) return { kind: 'suggestions', suggestions, why: 'It looks like suggestions for the plan.' };
  return { kind: 'unclear', report, suggestions, why: 'It does not look like a task result or plan suggestions.' };
}

export const describeChange = (c: ProposalChange): string =>
  c.op === 'add_item' ? `${c.itemType === 'requirement' ? 'Rule' : c.itemType === 'decision' ? 'Decision' : c.itemType === 'question' ? 'Question' : c.itemType === 'idea' ? 'Idea' : 'Note'}: ${c.title}${c.reason ? ` (why: ${c.reason})` : ''}` : c.op === 'add_task' ? `Task: ${c.title}` : `Change ${c.op === 'update_item' ? 'item' : 'task'} ${c.id}: ${Object.keys(c.patch).join(', ')}`;

/** True for changes that alter the accepted plan once approved (rules and decisions); tasks, questions and ideas do not. */
export const changesThePlan = (c: ProposalChange): boolean => (c.op === 'add_item' && (c.itemType === 'requirement' || c.itemType === 'decision')) || c.op === 'update_item';

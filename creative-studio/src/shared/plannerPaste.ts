// Reading what an AI said when the owner pastes it back (docs/planner-simplification-plan.md, section 5). Deterministic text parsing
// only: no model, no network. Reading never applies anything; the result is a preview. Hostile or malformed text can only produce
// "unclear" or an error list, never an action.
//
// What an answer can fill in (each part is a separate suggestion the owner ticks or unticks): the project brief (goal, description, scope,
// constraints, deliverables), milestones, rules (requirements), decisions with their reasons, tasks (optionally under a milestone),
// open questions, ideas and references.
import { ACTOR_KINDS, type Actor, changeSchema, type ProposalChange } from './planner';
import { parseReportText, type ReportImportPreview } from './plannerHandoff';

export const MAX_PASTE_CHARS = 200_000;
const MAX_CHANGES = 40;

export interface SuggestionPreview {
  format: 'json' | 'markdown' | 'unreadable';
  proposer?: Actor;
  note: string;
  changes: ProposalChange[];
  uncertain: string[];
  errors: string[];
}

type Kind = 'requirement' | 'decision' | 'task' | 'question' | 'idea' | 'reference' | 'milestone' | 'brief';
type BriefKey = 'goal' | 'description' | 'scope' | 'constraints' | 'deliverables';

const SECTIONS: Array<[RegExp, Kind]> = [
  [/^(project brief|brief|project summary|summary|overview)$/, 'brief'],
  [/^(milestones?|phases?|stages?|timeline)$/, 'milestone'],
  [/^(requirements?|rules?|must haves?|accepted requirements?)$/, 'requirement'],
  [/^(decisions?)$/, 'decision'],
  [/^(tasks?|suggested tasks?|to ?do|next steps|steps)$/, 'task'],
  [/^(questions?|open questions?)$/, 'question'],
  [/^(ideas?|notes?)$/, 'idea'],
  [/^(references?|links?|sources?|resources?|further reading)$/, 'reference'],
];
const KEYS: Record<string, Kind> = { brief: 'brief', milestones: 'milestone', requirements: 'requirement', decisions: 'decision', tasks: 'task', questions: 'question', ideas: 'idea', references: 'reference' };
/** Order in the preview: the brief first, then the structure, then the lists. */
const KIND_ORDER: Kind[] = ['brief', 'milestone', 'requirement', 'decision', 'task', 'question', 'idea', 'reference'];
const BRIEF_LABEL = /^(goal|aim|purpose|description|summary|scope|constraints?|limits|deliverables?|outputs?)$/;
const briefKey = (label: string): BriefKey | null => {
  const l = label.toLowerCase();
  if (/^(goal|aim|purpose)$/.test(l)) return 'goal';
  if (/^(description|summary)$/.test(l)) return 'description';
  if (l === 'scope') return 'scope';
  if (/^(constraints?|limits)$/.test(l)) return 'constraints';
  if (/^(deliverables?|outputs?)$/.test(l)) return 'deliverables';
  return null;
};
const DUE = /\s*[—–-]?\s*\(?\b(?:due|by|target|in)?\s*:?\s*(\d{4}-\d{2}-\d{2}|week \d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?: \d{1,2})?(?:,? \d{4})?)\)?\s*$/i;

const kindOf = (v: unknown) => ((ACTOR_KINDS as readonly string[]).includes(String(v)) ? (String(v) as Actor['kind']) : 'other');
const clip = (t: string, n: number) => t.replace(/\s+/g, ' ').trim().slice(0, n);
const strings = (v: unknown, n: number, each = 400): string[] => (Array.isArray(v) ? v.map((x) => clip(String(typeof x === 'object' && x ? (x as { text?: unknown; title?: unknown }).text ?? (x as { title?: unknown }).title ?? '' : x), each)).filter(Boolean).slice(0, n) : []);

function jsonObject(text: string): Record<string, unknown> | undefined {
  const tries: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let m = fence.exec(text); m; m = fence.exec(text)) tries.push(m[1] ?? '');
  const a = text.indexOf('{'); const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) { try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>; } catch { /* next */ } }
  return undefined;
}

/** "Title — why: reason" → [title, reason]. */
function splitReason(s: string): [string, string] {
  const m = /^(.*?)\s+[—–-]+\s*(?:why|because|reason)\s*[:-]?\s+(.+)$/i.exec(s) ?? /^(.*?)\s*\((?:why|because|reason)[:\s]+(.+?)\)\s*$/i.exec(s);
  return m ? [m[1]!.trim(), m[2]!.trim()] : [s, ''];
}

/** "Name — due 2026-11-01" / "Name (by week 6)" → [name, due]. */
function splitDue(s: string): [string, string] {
  const m = DUE.exec(s);
  if (!m || m.index === 0) return [s, ''];
  return [s.slice(0, m.index).replace(/[\s—–:-]+$/, '').trim(), m[1]!.trim()];
}

/** "Link title — https://example.org/page" → [title, text]. */
function splitReference(s: string): [string, string] {
  const md = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(s);
  if (md) return [md[1]!.trim(), `${md[2]}${s.replace(md[0], '').replace(/^[\s—–:-]+|[\s—–:-]+$/g, '') ? ` ${s.replace(md[0], '').replace(/^[\s—–:-]+|[\s—–:-]+$/g, '')}` : ''}`];
  const u = /https?:\/\/[^\s)>\]]+/.exec(s);
  if (!u) return [s, ''];
  const before = s.slice(0, u.index).replace(/[\s—–:(-]+$/, '').trim();
  const after = s.slice(u.index + u[0].length).replace(/^[\s—–:)-]+/, '').trim();
  return [before || u[0], [u[0], after].filter(Boolean).join(' ')];
}

function entryToChange(kind: Exclude<Kind, 'brief'>, e: unknown, errors: string[], where: string): ProposalChange | undefined {
  const o: Record<string, unknown> = typeof e === 'string' ? { title: e } : e && typeof e === 'object' ? (e as Record<string, unknown>) : {};
  let title = clip(String(o.title ?? o.name ?? ''), 200);
  if (!title) { errors.push(`${where}: an entry has no title.`); return undefined; }
  let text = String(o.text ?? o.description ?? o.details ?? o.url ?? o.link ?? '').trim().slice(0, 4000);
  let reason = String(o.reason ?? o.why ?? '').trim().slice(0, 2000);
  let raw: unknown;
  if (kind === 'milestone') {
    let due = clip(String(o.due ?? o.date ?? o.target ?? ''), 40);
    if (typeof e === 'string' && !due) [title, due] = splitDue(title);
    raw = { op: 'add_milestone', title: clip(title, 200), due };
  } else if (kind === 'task') {
    let milestone = clip(String(o.milestone ?? o.phase ?? ''), 200);
    if (typeof e === 'string') { const m = /^(.*?)\s*[([]\s*(?:milestone|phase)\s*:\s*([^)\]]+)[)\]]\s*$/i.exec(title); if (m) { title = clip(m[1]!, 200); milestone = clip(m[2]!, 200); } }
    raw = { op: 'add_task', title, description: text, milestone: milestone || null, priority: ['low', 'normal', 'high', 'urgent'].includes(String(o.priority)) ? o.priority : 'normal', completionChecks: Array.isArray(o.checks ?? o.completionChecks) ? ((o.checks ?? o.completionChecks) as unknown[]).map((x) => clip(String(typeof x === 'object' && x ? (x as { text?: unknown }).text ?? '' : x), 400)).filter(Boolean).slice(0, 20) : [] };
  } else {
    if (typeof e === 'string') {
      if (kind === 'decision' || kind === 'requirement') { const [t, r] = splitReason(title); title = clip(t, 200); if (r) reason = r.slice(0, 2000); }
      else if (kind === 'reference') { const [t, x] = splitReference(title); title = clip(t, 200); text = x.slice(0, 4000); }
    }
    raw = { op: 'add_item', itemType: kind, title, text, reason };
  }
  const parsed = changeSchema.safeParse(raw);
  if (!parsed.success) { errors.push(`${where} "${title.slice(0, 40)}": ${parsed.error.issues[0]?.message ?? 'not valid'}`); return undefined; }
  return parsed.data;
}

/** One suggestion per part of the brief the answer fills in, so the owner can take the goal but leave the scope. */
function briefChanges(b: Partial<Record<BriefKey, string | string[]>>): ProposalChange[] {
  const out: ProposalChange[] = [];
  const max = { goal: 1000, description: 4000, scope: 2000 } as const;
  for (const key of ['goal', 'description', 'scope'] as const) {
    const v = b[key];
    const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max[key]) : '';
    if (t) out.push({ op: 'set_brief', patch: { [key]: t } });
  }
  for (const key of ['constraints', 'deliverables'] as const) {
    const v = b[key];
    const list = Array.isArray(v) ? v.map((x) => clip(x, 400)).filter(Boolean).slice(0, 30) : [];
    if (list.length) out.push({ op: 'set_brief', patch: { [key]: list } });
  }
  return out;
}

const sortChanges = (list: ProposalChange[]): ProposalChange[] => {
  const rank = (c: ProposalChange) => KIND_ORDER.indexOf(c.op === 'set_brief' ? 'brief' : c.op === 'add_milestone' ? 'milestone' : c.op === 'add_task' || c.op === 'update_task' ? 'task' : c.op === 'add_item' ? (c.itemType as Kind) : 'requirement');
  return list.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
};

/** Reads a brainstorming answer: JSON ({changes:[...]} or {brief, milestones, requirements, decisions, tasks, questions, ideas, references}) or Markdown lists under those headings. */
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
    const br = o.brief && typeof o.brief === 'object' && !Array.isArray(o.brief) ? (o.brief as Record<string, unknown>) : null;
    if (br) changes.push(...briefChanges({ goal: String(br.goal ?? ''), description: String(br.description ?? br.summary ?? ''), scope: String(br.scope ?? ''), constraints: strings(br.constraints, 30), deliverables: strings(br.deliverables, 30) }));
    for (const [key, kind] of Object.entries(KEYS)) {
      if (kind === 'brief') continue;
      const list = o[key];
      if (!Array.isArray(list)) continue;
      for (const e of list.slice(0, MAX_CHANGES)) { const c = entryToChange(kind, e, errors, key); if (c && changes.length < MAX_CHANGES) changes.push(c); }
    }
    if (!proposer) uncertain.push('The answer does not say who wrote it; it will be recorded as "Pasted suggestion".');
    return { format: 'json', ...(proposer ? { proposer } : {}), note: clip(String(o.note ?? o.summary ?? ''), 1000), changes: sortChanges(changes), uncertain, errors };
  }

  let cur: Kind | null = null;
  let lastTask: Extract<ProposalChange, { op: 'add_task' }> | null = null;
  let subChecks = false;
  let briefSub: BriefKey | null = null;
  const brief: Partial<Record<BriefKey, string | string[]>> = {};
  const addBrief = (k: BriefKey, v: string) => {
    if (k === 'constraints' || k === 'deliverables') { const a = (brief[k] as string[] | undefined) ?? []; a.push(v); brief[k] = a; }
    else brief[k] = v;
  };
  const room = () => {
    if (changes.length < MAX_CHANGES) return true;
    if (!errors.some((e) => e.startsWith('Only the first'))) errors.push(`Only the first ${MAX_CHANGES} suggestions were read.`);
    return false;
  };
  for (const raw of text.split(/\r?\n/)) {
    const h = /^\s{0,3}(?:#{1,6}\s+|\*\*)([^*#:]+?)\s*(?:\*\*)?\s*:?\s*$/.exec(raw);
    const name = h ? (h[1] ?? '').trim().toLowerCase() : null;
    // Inside the brief, headings such as "Constraints" start a list of the brief rather than ending it.
    if (cur === 'brief' && name && BRIEF_LABEL.test(name) && !SECTIONS.some(([re]) => re.test(name))) { briefSub = briefKey(name); continue; }
    const sec = name ? SECTIONS.find(([re]) => re.test(name))?.[1] : undefined;
    if (sec) { cur = sec; lastTask = null; briefSub = null; continue; }
    if (h && !sec) { cur = null; lastTask = null; briefSub = null; continue; }
    if (!cur) continue;
    if (cur === 'brief') {
      // "Goal: text" (with or without a bullet), a label alone ("Constraints:"), or a bullet under the current label.
      const lab = /^\s*(?:[-*+]\s+)?\**([A-Za-z ]{3,20}?)\**\s*:\s*(.*\S)?\s*$/.exec(raw);
      const k = lab ? briefKey((lab[1] ?? '').trim()) : null;
      if (lab && k) { briefSub = k; if (lab[2]) addBrief(k, clip(lab[2], k === 'description' ? 4000 : 1000)); continue; }
      const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(raw);
      if (bullet && briefSub) { addBrief(briefSub, (bullet[1] ?? '').trim()); continue; }
      if (!bullet && raw.trim() && !briefSub) { addBrief('description', clip(raw, 4000)); }
      else if (!bullet && raw.trim() && briefSub && (briefSub === 'goal' || briefSub === 'description' || briefSub === 'scope') && brief[briefSub] === undefined) addBrief(briefSub, clip(raw, 4000));
      continue;
    }
    const b = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(raw);
    if (!b) continue;
    const indent = (b[1] ?? '').length; const item = (b[2] ?? '').trim();
    if (indent >= 2 && cur === 'task' && lastTask) { if (lastTask.completionChecks.length < 20) lastTask.completionChecks.push(clip(item, 400)); subChecks = true; continue; }
    if (!room()) continue;
    const c = entryToChange(cur, item, errors, cur);
    if (c) { changes.push(c); lastTask = c.op === 'add_task' ? c : null; }
  }
  const fromBrief = briefChanges(brief);
  if (fromBrief.length) changes.push(...fromBrief);
  if (subChecks) uncertain.push('Indented lines under a task were read as how to check that it is done.');
  if (!changes.length) return { ...empty('unreadable'), errors: errors.length ? errors : ['No suggestions were found. Use headings such as Project brief, Milestones, Requirements, Decisions, Tasks, Questions, Ideas or References with a list under each.'] };
  uncertain.push('The answer does not say who wrote it; it will be recorded as "Pasted suggestion".');
  return { format: 'markdown', note: '', changes: sortChanges(changes), uncertain, errors };
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

const BRIEF_NAME: Record<BriefKey, string> = { goal: 'Goal', description: 'Description', scope: 'Scope', constraints: 'Constraints', deliverables: 'Deliverables' };
const short = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export const describeChange = (c: ProposalChange): string => {
  if (c.op === 'set_brief') {
    const [k, v] = Object.entries(c.patch)[0] ?? ['goal', ''];
    return `Project brief, ${BRIEF_NAME[k as BriefKey] ?? k}: ${Array.isArray(v) ? short(v.join('; ')) : short(String(v))}`;
  }
  if (c.op === 'add_milestone') return `Milestone: ${c.title}${c.due ? ` (due ${c.due})` : ''}`;
  if (c.op === 'add_item') return `${c.itemType === 'requirement' ? 'Rule' : c.itemType === 'decision' ? 'Decision' : c.itemType === 'question' ? 'Question' : c.itemType === 'idea' ? 'Idea' : c.itemType === 'reference' ? 'Reference' : 'Note'}: ${c.title}${c.itemType === 'reference' && c.text ? ` (${short(c.text, 70)})` : ''}${c.reason ? ` (why: ${c.reason})` : ''}`;
  if (c.op === 'add_task') return `Task: ${c.title}${c.milestone ? ` (milestone: ${c.milestone})` : ''}`;
  return `Change ${c.op === 'update_item' ? 'item' : 'task'} ${c.id}: ${Object.keys(c.patch).join(', ')}`;
};

/** True for changes that alter the accepted plan once approved (the brief, rules and decisions); tasks, milestones, questions, ideas and references do not. */
export const changesThePlan = (c: ProposalChange): boolean => c.op === 'set_brief' || (c.op === 'add_item' && (c.itemType === 'requirement' || c.itemType === 'decision')) || c.op === 'update_item';

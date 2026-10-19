// The context builder (docs/planner-simplification-plan.md, section 6): decides which project information an AI receives. Pure and
// local: no model, no network, no file contents. Rules that keep it safe:
//  * the default is to include EVERY accepted rule and decision; trimming starts only above a size budget (chat destinations);
//  * what was left out is always listed, stored on the package, and can be put back by the owner;
//  * ideas, unanswered questions, rejected items, other tasks and history are never sent as requirements.
import type { PlanReport, PlannerProject, PlanTask } from './planner';
import type { DestinationId } from './plannerSend';

export type ContextPurpose = 'execute' | 'brainstorm';

/** Characters allowed for accepted rules and decisions in one brief. Chats are small; tools that can read files get everything. */
export const RULE_BUDGET: Record<DestinationId, number> = { chat: 6000, createcraft: Infinity, tools: Infinity };

export interface ContextRule { id: string; kind: 'requirement' | 'decision'; title: string; text: string; reason: string }
export interface OmittedRule { id: string; kind: 'requirement' | 'decision'; title: string }
export interface UpstreamResult { taskId: string; title: string; summary: string; outputs: Array<{ description: string; path: string }> }

/** What is stored on a package: which rules were sent, which were left out, and the results of tasks this one builds on. */
export interface Delivery {
  purpose: ContextPurpose;
  destination: DestinationId;
  budget: number | null;
  includedIds: string[];
  omitted: OmittedRule[];
  upstream: UpstreamResult[];
}

export interface ContextRequest {
  purpose: ContextPurpose;
  taskIds?: string[];
  destination: DestinationId;
  /** Rules the owner put back after seeing the left-out list. */
  forceInclude?: string[];
  budget?: number;
}

export interface BuiltContext extends Delivery {
  rules: Array<ContextRule & { included: boolean; score: number }>;
  size: number;
}

const size = (r: ContextRule) => r.title.length + r.text.length + r.reason.length + 40;
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);

function taskWords(tasks: PlanTask[]): Set<string> {
  const out = new Set<string>();
  for (const t of tasks) for (const w of words(`${t.title} ${t.description} ${t.completionChecks.map((c) => c.text).join(' ')} ${t.expectedOutputs.join(' ')}`)) out.add(w);
  return out;
}

/** The accepted results of the tasks these tasks wait for (direct dependencies only), so dependent work can build on them. */
export function upstreamResults(p: PlannerProject, tasks: PlanTask[]): UpstreamResult[] {
  const inSet = new Set(tasks.map((t) => t.id));
  const seen = new Set<string>();
  const out: UpstreamResult[] = [];
  for (const t of tasks) {
    for (const id of t.dependsOn) {
      if (inSet.has(id) || seen.has(id)) continue;
      const dep = p.tasks.find((x) => x.id === id);
      if (!dep || dep.status !== 'accepted') continue;
      const rep = [...p.reports].reverse().find((r): r is PlanReport => r.taskId === id && r.status === 'accepted');
      seen.add(id);
      out.push({ taskId: id, title: dep.title, summary: (rep?.workPerformed ?? 'Accepted by the owner.').replace(/\s+/g, ' ').trim().slice(0, 600), outputs: (rep?.outputs ?? []).slice(0, 10).map((o) => ({ description: o.description.slice(0, 200), path: o.path })) });
    }
  }
  return out;
}

export function buildContext(p: PlannerProject, req: ContextRequest): BuiltContext {
  const tasks = (req.taskIds ?? []).map((id) => p.tasks.find((t) => t.id === id)).filter((t): t is PlanTask => !!t);
  const all: ContextRule[] = [
    ...p.items.filter((i) => i.type === 'requirement' && i.status === 'accepted').map((i) => ({ id: i.id, kind: 'requirement' as const, title: i.title, text: i.text, reason: '' })),
    ...p.items.filter((i) => i.type === 'decision' && i.status === 'accepted').map((i) => ({ id: i.id, kind: 'decision' as const, title: i.title, text: i.text, reason: i.reason })),
  ];
  const budget = req.budget ?? RULE_BUDGET[req.destination];
  const total = all.reduce((n, r) => n + size(r), 0);
  const tw = taskWords(tasks);
  const score = (r: ContextRule) => { let n = 0; for (const w of words(`${r.title} ${r.text}`)) if (tw.has(w)) n++; return n; };
  const scored = all.map((r, i) => ({ r, i, s: score(r) }));
  const force = new Set(req.forceInclude ?? []);
  const keep = new Set<string>();
  if (total <= budget) for (const r of all) keep.add(r.id);
  else {
    let used = 0;
    for (const { r } of scored.filter((x) => force.has(x.r.id))) { keep.add(r.id); used += size(r); }
    for (const x of [...scored].filter((y) => !force.has(y.r.id)).sort((a, b) => b.s - a.s || a.i - b.i)) {
      if (used + size(x.r) <= budget) { keep.add(x.r.id); used += size(x.r); }
    }
  }
  const rules = scored.map(({ r, s }) => ({ ...r, included: keep.has(r.id), score: s }));
  return {
    purpose: req.purpose, destination: req.destination, budget: Number.isFinite(budget) ? budget : null,
    includedIds: rules.filter((r) => r.included).map((r) => r.id),
    omitted: rules.filter((r) => !r.included).map((r) => ({ id: r.id, kind: r.kind, title: r.title })),
    upstream: req.purpose === 'execute' ? upstreamResults(p, tasks) : [],
    rules, size: rules.filter((r) => r.included).reduce((n, r) => n + size(r), 0),
  };
}

/** The plan in short form for an AI: goal, scope, constraints, agreed rules, open questions, task titles. No file locations or task details. */
export function planSummary(p: PlannerProject): string[] {
  const rules = p.items.filter((i) => (i.type === 'requirement' || i.type === 'decision') && i.status === 'accepted');
  const qs = p.items.filter((i) => i.type === 'question' && i.status === 'open');
  const live = p.tasks.filter((t) => t.status !== 'cancelled');
  return [
    `Project: "${p.title}"`, `Goal: ${p.goal || '(not written yet)'}`,
    ...(p.description ? [`Description: ${p.description.slice(0, 1500)}`] : []),
    ...(p.scope ? [`Scope: ${p.scope}`] : []),
    ...(p.constraints.length ? ['Constraints:', ...p.constraints.map((c) => `- ${c}`)] : []),
    ...(p.deliverables.length ? ['Expected deliverables:', ...p.deliverables.map((c) => `- ${c}`)] : []),
    ...(rules.length ? ['', 'Rules and decisions already agreed:', ...rules.map((r) => `- ${r.title}${r.text ? `: ${r.text.slice(0, 300)}` : ''}${r.reason ? ` (why: ${r.reason.slice(0, 200)})` : ''}`)] : []),
    ...(qs.length ? ['', 'Questions still open:', ...qs.map((q) => `- ${q.title}`)] : []),
    ...(p.milestones.length ? ['', 'Milestones so far:', ...p.milestones.map((m) => `- ${m.title}${m.due ? ` (due ${m.due})` : ''}`)] : []),
    ...(live.length ? ['', 'Tasks so far (titles only):', ...live.map((t) => `- ${t.title}`)] : []),
  ];
}

/** The sections an answer can fill in, with the exact shapes the reader understands (see parseSuggestionText). */
export const PLAN_FORMAT = [
  'Put concrete suggestions under these headings. Use exactly these headings and shapes:',
  '## Project brief',
  'Goal: one or two sentences.',
  'Description: a short paragraph.',
  'Scope: what is in and out.',
  'Constraints:',
  '- one limit per line',
  'Deliverables:',
  '- one thing to hand over per line',
  '## Milestones',
  '- Milestone name — due 2026-12-01 (the date is optional; use a real date only if the user gave one)',
  '## Requirements',
  '- A rule the result must follow',
  '## Decisions',
  '- What was decided — why: the reason',
  '## Tasks',
  '- Task name (milestone: Milestone name)',
  '  - how to check it is done (indented)',
  '## Questions',
  '- A question the user still needs to answer',
  '## Ideas',
  '- An idea worth considering',
  '## References',
  '- Title — https://link (only links you are sure exist; otherwise describe what to look for)',
].join('\n');

/** A plain-words request for ideas: goal and accepted plan in short form, open questions and task titles. No file locations. */
export function brainstormText(p: PlannerProject): string {
  const lines = [
    `I am planning a project called "${p.title}". Please suggest improvements to the plan. Do not do the work itself.`,
    '', ...planSummary(p).slice(1),
    '', 'Answer with these sections (leave out any you have nothing for):', PLAN_FORMAT,
    'Everything you write is only a suggestion; I decide what joins the plan.',
  ];
  return lines.join('\n');
}

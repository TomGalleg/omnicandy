// The shared view model of a project plan (docs/planner-2.0/stage-1-blueprint.md, section 4). Pure and read-only: it is computed from the stored
// PlannerProject and never stored itself, so Studio and (later) Village render the same facts and neither keeps a second copy of task state.
// Nothing here changes what is stored; older projects, the MCP tools and the history keep their exact meaning.
import type { AppRef, PlannerProject, PlanReport, PlanTask, Proposal, ProposalChange } from './planner';
import { displayStatus, needsYou, type DisplayStatus } from './plannerView';

export type ViewNodeKind =
  | 'project' | 'idea' | 'question' | 'requirement' | 'decision' | 'reference'
  | 'milestone' | 'chunk' | 'task' | 'resource' | 'result' | 'ghost';

export interface ViewNodeRef { type: 'plan' | 'item' | 'task' | 'milestone' | 'asset' | 'report' | 'proposal'; id: string; rev?: number }

/** Leaf-only progress: a task that has subtasks is counted through them, never twice. */
export interface ViewProgress { done: number; total: number; percent: number }

export interface ViewNode {
  /** Entity id, `project:<planId>`, or `ghost:<proposalId>:<changeIndex>`. Canvas layout is keyed by this. */
  id: string;
  kind: ViewNodeKind;
  title: string;
  /** The first ~160 characters of the description, text or reason. */
  summary: string;
  status: DisplayStatus | null;
  progress: ViewProgress | null;
  /** Containment: project, then milestone, then chunk, then task. */
  parentId: string | null;
  ref: ViewNodeRef;
  /** `PlanTask.appRef`, untouched: the view never decides which application does the work. */
  resourceHint: AppRef | null;
  /** Reserved for the agent stages. */
  assignee: null;
  /** A change an AI proposed that the owner has not accepted. It is not part of the plan. */
  ghost?: { proposalId: string; changeIndex: number; by: string; op: ProposalChange['op'] };
  flags: { needsReview: boolean; stalled: boolean; planChanged: boolean; removed: boolean; waiting: boolean };
}

/** `from` must finish before `to` (dependsOn), or `from` contains `to` (contains). */
export interface ViewEdge { id: string; from: string; to: string; kind: 'dependsOn' | 'contains' | 'ghostDependsOn' }

export interface ProjectView {
  planId: string;
  projectId: string | null;
  title: string;
  revision: number;
  planRevision: number;
  metaRev: number;
  nodes: ViewNode[];
  edges: ViewEdge[];
  progress: ViewProgress;
  needsYou: ReturnType<typeof needsYou>;
  current: { taskId: string; title: string } | null;
  pendingProposals: Array<Pick<Proposal, 'id' | 'note' | 'at' | 'source'> & { by: string; changes: number }>;
  awaitingReview: Array<Pick<PlanReport, 'id' | 'taskId' | 'outcome' | 'submittedAt'>>;
  /** Reserved, always null today. Later stages fill them without changing any field above. */
  capabilities: null;
  team: null;
  town: null;
  runs: null;
}

const clip = (t: string, n = 160) => t.replace(/\s+/g, ' ').trim().slice(0, n);
/** Cap per proposal so one huge pasted answer cannot flood a canvas. */
export const MAX_GHOSTS_PER_PROPOSAL = 200;

const live = (t: PlanTask) => t.status !== 'cancelled';

/** The chunk worked on now: the one named, the one worked on last, the next one ready, or the first open one. */
export function currentTask(p: PlannerProject, focusTaskId?: string | null): PlanTask | undefined {
  const open = p.tasks.filter((t) => t.status !== 'accepted' && t.status !== 'cancelled');
  const unmet = (t: PlanTask) => t.dependsOn.map((id) => p.tasks.find((x) => x.id === id)).filter((x): x is PlanTask => !!x && x.status !== 'accepted' && x.status !== 'cancelled').length;
  const ready = open.find((t) => ['todo', 'revision'].includes(t.status) && !unmet(t));
  return open.find((x) => x.id === focusTaskId) ?? open.find((x) => x.id === p.lastActive?.taskId) ?? ready ?? open[0];
}

function childrenOf(tasks: PlanTask[]): Map<string, PlanTask[]> {
  const m = new Map<string, PlanTask[]>();
  for (const t of tasks) if (t.parentId && live(t)) m.set(t.parentId, [...(m.get(t.parentId) ?? []), t]);
  return m;
}

function leavesUnder(root: PlanTask, kids: Map<string, PlanTask[]>, seen = new Set<string>()): PlanTask[] {
  if (seen.has(root.id)) return [];
  seen.add(root.id);
  const c = kids.get(root.id);
  return c?.length ? c.flatMap((k) => leavesUnder(k, kids, seen)) : [root];
}

const progressOfList = (list: PlanTask[]): ViewProgress => {
  const done = list.filter((t) => t.status === 'accepted').length;
  return { done, total: list.length, percent: list.length ? Math.round((done / list.length) * 100) : 0 };
};

/** Progress over leaf tasks only (those with no live subtasks). `scopeTaskIds` limits it to those tasks and their subtasks. */
export function leafProgress(p: PlannerProject, scopeTaskIds?: readonly string[]): ViewProgress {
  const kids = childrenOf(p.tasks);
  const tasks = p.tasks.filter(live);
  const leaves = tasks.filter((t) => !kids.get(t.id)?.length);
  if (!scopeTaskIds) return progressOfList(leaves);
  const inScope = new Set<string>();
  for (const id of scopeTaskIds) {
    const root = tasks.find((t) => t.id === id);
    if (root) for (const l of leavesUnder(root, kids)) inScope.add(l.id);
  }
  return progressOfList(leaves.filter((t) => inScope.has(t.id)));
}

function ghostTitle(p: PlannerProject, c: ProposalChange): string {
  switch (c.op) {
    case 'add_task': case 'add_item': case 'add_milestone': return c.title;
    case 'update_task': return `Change: ${p.tasks.find((t) => t.id === c.id)?.title ?? 'a task'}`;
    case 'update_item': return `Change: ${p.items.find((i) => i.id === c.id)?.title ?? 'an item'}`;
    case 'set_brief': return 'Project summary';
  }
}
function ghostSummary(c: ProposalChange): string {
  switch (c.op) {
    case 'add_task': return clip(c.description);
    case 'add_item': return clip(c.text || c.reason);
    case 'set_brief': return clip(Object.keys(c.patch).join(', '));
    case 'update_task': case 'update_item': return clip(Object.keys(c.patch).join(', '));
    case 'add_milestone': return c.due ? `Due ${c.due}` : '';
  }
}

export function buildProjectView(p: PlannerProject, opts: { now?: Date; focusTaskId?: string | null } = {}): ProjectView {
  const now = opts.now ?? new Date();
  const rootId = `project:${p.id}`;
  const nodes: ViewNode[] = [];
  const edges: ViewEdge[] = [];
  const flags = (o: Partial<ViewNode['flags']> = {}): ViewNode['flags'] => ({ needsReview: false, stalled: false, planChanged: false, removed: false, waiting: false, ...o });
  const kids = childrenOf(p.tasks);
  const taskIds = new Set(p.tasks.map((t) => t.id));

  nodes.push({ id: rootId, kind: 'project', title: p.title, summary: clip(p.goal), status: null, progress: leafProgress(p), parentId: null, ref: { type: 'plan', id: p.id, rev: p.revision }, resourceHint: null, assignee: null, flags: flags() });

  for (const m of p.milestones) {
    const ids = p.tasks.filter((t) => t.milestoneId === m.id && !t.parentId).map((t) => t.id);
    nodes.push({ id: m.id, kind: 'milestone', title: m.title, summary: m.due ? `Due ${m.due}` : '', status: null, progress: leafProgress(p, ids), parentId: rootId, ref: { type: 'milestone', id: m.id, rev: m.rev }, resourceHint: null, assignee: null, flags: flags() });
  }

  for (const i of p.items) {
    nodes.push({
      id: i.id, kind: i.type, title: i.title, summary: clip(i.answer || i.text || i.reason), status: null, progress: null, parentId: rootId, ref: { type: 'item', id: i.id, rev: i.rev },
      resourceHint: null, assignee: null, flags: flags({ removed: i.status === 'rejected' || i.status === 'superseded' }),
    });
  }

  for (const t of p.tasks) {
    const ds = displayStatus(t, p, now);
    const waiting = t.dependsOn.some((d) => { const x = p.tasks.find((y) => y.id === d); return !!x && x.status !== 'accepted' && x.status !== 'cancelled'; });
    const hasKids = !!kids.get(t.id)?.length;
    nodes.push({
      id: t.id, kind: t.parentId ? 'task' : 'chunk', title: t.title, summary: clip(t.description), status: ds,
      progress: hasKids ? progressOfList(leavesUnder(t, kids)) : null,
      parentId: t.parentId && taskIds.has(t.parentId) ? t.parentId : (t.milestoneId && p.milestones.some((m) => m.id === t.milestoneId) ? t.milestoneId : rootId),
      ref: { type: 'task', id: t.id, rev: t.rev }, resourceHint: t.appRef, assignee: null,
      flags: flags({ needsReview: ds.label === 'Needs Review', stalled: !!ds.stalled, planChanged: !!ds.planChanged, removed: !!ds.removed, waiting }),
    });
    for (const d of t.dependsOn) if (taskIds.has(d)) edges.push({ id: `dep:${d}>${t.id}`, from: d, to: t.id, kind: 'dependsOn' });
  }

  for (const a of p.assets) {
    nodes.push({ id: a.id, kind: 'resource', title: a.title, summary: clip(a.note || a.path || a.url), status: null, progress: null, parentId: rootId, ref: { type: 'asset', id: a.id, rev: a.rev }, resourceHint: null, assignee: null, flags: flags() });
  }

  for (const r of p.reports) {
    nodes.push({
      id: r.id, kind: 'result', title: `${r.outcome}: ${p.tasks.find((t) => t.id === r.taskId)?.title ?? 'a task'}`, summary: clip(r.workPerformed), status: null, progress: null,
      parentId: taskIds.has(r.taskId) ? r.taskId : rootId, ref: { type: 'report', id: r.id }, resourceHint: null, assignee: null, flags: flags({ needsReview: r.status === 'submitted' }),
    });
  }

  const pending = p.proposals.filter((x) => x.status === 'pending');
  for (const pr of pending) {
    pr.changes.slice(0, MAX_GHOSTS_PER_PROPOSAL).forEach((c, i) => {
      const id = `ghost:${pr.id}:${i}`;
      nodes.push({
        id, kind: 'ghost', title: ghostTitle(p, c), summary: ghostSummary(c), status: null, progress: null, parentId: rootId, ref: { type: 'proposal', id: pr.id },
        resourceHint: null, assignee: null, ghost: { proposalId: pr.id, changeIndex: i, by: pr.proposedBy.name, op: c.op }, flags: flags(),
      });
      if (c.op === 'add_task') for (const d of c.dependsOn) if (taskIds.has(d)) edges.push({ id: `gdep:${d}>${id}`, from: d, to: id, kind: 'ghostDependsOn' });
    });
  }

  for (const n of nodes) if (n.parentId) edges.push({ id: `contains:${n.parentId}>${n.id}`, from: n.parentId, to: n.id, kind: 'contains' });

  const cur = currentTask(p, opts.focusTaskId);
  return {
    planId: p.id, projectId: p.ownerProjectId ?? null, title: p.title, revision: p.revision, planRevision: p.planRevision, metaRev: p.metaRev,
    nodes, edges, progress: leafProgress(p), needsYou: needsYou(p, now), current: cur ? { taskId: cur.id, title: cur.title } : null,
    pendingProposals: pending.map((x) => ({ id: x.id, note: x.note, at: x.at, source: x.source, by: x.proposedBy.name, changes: x.changes.length })),
    awaitingReview: p.reports.filter((r) => r.status === 'submitted').map((r) => ({ id: r.id, taskId: r.taskId, outcome: r.outcome, submittedAt: r.submittedAt })),
    capabilities: null, team: null, town: null, runs: null,
  };
}

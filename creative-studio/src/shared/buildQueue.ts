// "Let's build this": the open tasks put in the order they need to happen, and the rule for which one is next. Pure, no AI and no files: the Production Director's
// opinion arrives as text and is checked here (an AI that names a task that does not exist, repeats one or puts a task before the one it needs cannot break the
// queue). The queue is the runner's own to-do order, kept apart from the plan: the plan stays the owner's.
import type { PlanTask, Priority } from './planner';
import { DIRECTORS, type DirectorKey, isDirectorKey } from './town';

export type BuildStatus = 'idle' | 'running' | 'paused' | 'waiting' | 'done';
export interface BuildQueue {
  version: 1;
  status: BuildStatus;
  /** Task ids in the order they will be done. */
  order: string[];
  /** The task being worked on right now. */
  current?: string;
  /** Why it stopped and who needs the owner: shown as a flag; the owner goes to that office. */
  waiting?: { taskId: string; director: DirectorKey; message: string };
  /** One plain sentence: how the order was decided. */
  why?: string;
  startedAt?: string;
  /** Task ids finished in this build (made and reported). */
  finished: string[];
}
export const emptyQueue = (): BuildQueue => ({ version: 1, status: 'idle', order: [], finished: [] });

const RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
/** Tasks the build can pick up: not started, or sent back for changes. */
export const isOpen = (t: PlanTask): boolean => (t.status === 'todo' || t.status === 'revision') && !t.claim;
const DONE_ENOUGH = new Set(['reported', 'accepted', 'cancelled']);
export const directorOf = (t: PlanTask): DirectorKey => (isDirectorKey(t.assignee) ? t.assignee : 'general-manager');
export const titleOf = (k: DirectorKey) => DIRECTORS.find((d) => d.key === k)?.title ?? k;

/** Moves any task after the tasks it depends on, otherwise keeping the given order. A dependency that is not in the list is ignored (it is not part of this build). */
export function respectDependencies(order: readonly string[], tasks: readonly PlanTask[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const inList = new Set(order);
  const out: string[] = []; const placed = new Set<string>(); const visiting = new Set<string>();
  const place = (id: string) => {
    if (placed.has(id) || visiting.has(id)) return; // a loop in the dependencies cannot hang this
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (inList.has(dep)) place(dep);
    visiting.delete(id); placed.add(id); out.push(id);
  };
  for (const id of order) place(id);
  return out;
}

/** The order with no AI: what others need first, then urgent before low, then the order the tasks were added. */
export function defaultOrder(tasks: readonly PlanTask[]): string[] {
  const open = tasks.filter(isOpen).map((t, i) => ({ t, i }));
  open.sort((a, b) => RANK[a.t.priority] - RANK[b.t.priority] || a.i - b.i);
  return respectDependencies(open.map((x) => x.t.id), tasks);
}

/** What the Production Director is asked: put these in the order they should be done, by what each one needs. */
export function orderPrompt(tasks: readonly PlanTask[]): { system: string; user: string } {
  const open = tasks.filter(isOpen);
  const name = (id: string) => open.findIndex((x) => x.id === id) + 1;
  return {
    system: 'You are the Production Director. The owner wants the project built. Put the tasks in the order they should be done: a task that another one needs comes first (a style brief before artwork, artwork before checking it). Do not add, rename or drop tasks.',
    user: [
      'Tasks:',
      ...open.map((t, i) => `${i + 1}. ${t.title} (for ${titleOf(directorOf(t))})${t.dependsOn.some((d) => name(d) > 0) ? ` — needs ${t.dependsOn.map(name).filter((n) => n > 0).join(', ')} first` : ''}`),
      '', 'Answer with exactly one line like "Order: 2, 1, 3" using the numbers above, every task once. Then one short sentence saying why, in plain words.',
    ].join('\n'),
  };
}

/** Reads the Production Director's answer. Anything unusable falls back to the default order, and says so. */
export function parseOrder(reply: string, tasks: readonly PlanTask[]): { order: string[]; why: string; usedAi: boolean } {
  const open = tasks.filter(isOpen);
  const fallback = defaultOrder(tasks);
  const m = /order\s*:\s*([\d\s,;>.-]+)/i.exec(reply);
  const picked: string[] = [];
  if (m) for (const n of (m[1] ?? '').split(/[^\d]+/).filter(Boolean).map(Number)) { const t = open[n - 1]; if (t && !picked.includes(t.id)) picked.push(t.id); }
  if (picked.length === 0) return { order: fallback, why: 'Ordered by what each task needs and how urgent it is.', usedAi: false };
  const rest = fallback.filter((id) => !picked.includes(id));
  const sentence = reply.replace(/order\s*:[^\n]*/i, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { order: respectDependencies([...picked, ...rest], tasks), why: sentence || 'Ordered by the Production Director.', usedAi: true };
}

export type NextStep =
  | { kind: 'run'; task: PlanTask; director: DirectorKey }
  | { kind: 'wait'; task: PlanTask; director: DirectorKey; message: string }
  | { kind: 'done' };

/**
 * What happens next: the first task in the order that is still open and whose needs are done (one whose need is unfinished is passed over for now). A task reported as done counts as done (the owner reviews it later; the
 * build does not wait for that). A director who only advises (no tools that make files) cannot do a task alone, so the owner is flagged to talk it through with them.
 */
export function nextStep(order: readonly string[], tasks: readonly PlanTask[], works: (d: DirectorKey) => boolean): NextStep {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let stuck: NextStep | null = null;
  for (const id of order) {
    const t = byId.get(id);
    if (!t || !isOpen(t)) continue;
    const director = directorOf(t);
    const unmet = t.dependsOn.map((d) => byId.get(d)).filter((d): d is PlanTask => !!d && !DONE_ENOUGH.has(d.status));
    // A task whose need is not done yet is skipped for now; if nothing else can be done, the owner is told what it is waiting for.
    if (unmet.length) { stuck ??= { kind: 'wait', task: t, director, message: `"${t.title}" needs "${unmet[0]!.title}" first, and that one is not finished.` }; continue; }
    if (!works(director)) return { kind: 'wait', task: t, director, message: `"${t.title}" is a job for the ${titleOf(director)} to talk through with you; they advise and do not make files on their own.` };
    return { kind: 'run', task: t, director };
  }
  return stuck ?? { kind: 'done' };
}

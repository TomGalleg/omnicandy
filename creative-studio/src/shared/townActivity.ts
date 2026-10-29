// What each director is really doing, read from the plan. Nothing here is stored and nothing is guessed: a state exists only when the plan holds the
// fact that makes it true, so a badge over a director always means something real.
//   needs-you  a chunk of theirs has a result waiting for the owner to review
//   working    a chunk of theirs is claimed right now (a live claim; an expired one counts for nothing)
//   blocked    a chunk of theirs is marked blocked
// A request another worker made of them, still waiting for the owner to decide, also counts as something waiting for the owner.
// Anything else is idle and has no entry. A chunk with no owner belongs to nobody, so it makes nobody look busy.
import { isClaimLive, type PlannerProject, type PlanTask } from './planner';
import { requestTasks } from './townRequests';
import { isDirectorKey, type DirectorKey } from './town';

export type ActivityState = 'needs-you' | 'working' | 'blocked';
export interface DirectorActivity { state: ActivityState; /** The chunks behind the state, in plan order. */ tasks: Array<{ id: string; title: string }> }

const ORDER: ActivityState[] = ['needs-you', 'working', 'blocked'];

const stateOf = (t: PlanTask, now: Date): ActivityState | null => {
  if (t.status === 'reported') return 'needs-you';
  if (t.status === 'blocked') return 'blocked';
  if (t.status === 'in_progress' && isClaimLive(t.claim, now)) return 'working';
  return null;
};

/** The most pressing thing for each director who has anything real going on. The owner's own attention comes first, then work in progress, then blocks. */
export function directorActivity(p: Pick<PlannerProject, 'tasks'> & Partial<Pick<PlannerProject, 'proposals'>>, now: Date): Partial<Record<DirectorKey, DirectorActivity>> {
  const by = new Map<DirectorKey, Map<ActivityState, Array<{ id: string; title: string }>>>();
  for (const t of p.tasks) {
    if (!isDirectorKey(t.assignee)) continue;
    const s = stateOf(t, now);
    if (!s) continue;
    const m = by.get(t.assignee) ?? new Map<ActivityState, Array<{ id: string; title: string }>>();
    m.set(s, [...(m.get(s) ?? []), { id: t.id, title: t.title }]);
    by.set(t.assignee, m);
  }
  for (const r of requestTasks(p.proposals)) {
    const m = by.get(r.assignee) ?? new Map<ActivityState, Array<{ id: string; title: string }>>();
    m.set('needs-you', [...(m.get('needs-you') ?? []), { id: `request:${r.assignee}:${r.title}`, title: r.title }]);
    by.set(r.assignee, m);
  }
  const out: Partial<Record<DirectorKey, DirectorActivity>> = {};
  for (const [key, m] of by) {
    const state = ORDER.find((o) => m.has(o));
    if (state) out[key] = { state, tasks: m.get(state)! };
  }
  return out;
}

export const ACTIVITY_LABEL: Record<ActivityState, string> = { 'needs-you': 'Waiting for you', working: 'Working on', blocked: 'Stuck on' };

// Why a director leaves their desk. Only the plan can give a director a reason to go somewhere on purpose; everything else is idle chatter.
//   work-visit  a chunk of theirs is claimed right now AND builds on a chunk owned by another director: they go and see that director while it runs
//   stay        they have real work or a result waiting (see townActivity), so they do not wander off to chat
//   meeting     the owner is running a meeting with AI help and they are at the table: they go to the Town Hall and stay until it ends
//   chat        nothing is going on: the casual visits to a neighbour, as before
// Nothing here is stored. Everything is worked out from the plan each time, and costs nothing.
import { isClaimLive, type PlannerProject } from './planner';
import { directorActivity } from './townActivity';
import { isDirectorKey, type DirectorKey } from './town';

export type Intent = { kind: 'chat' } | { kind: 'stay' } | { kind: 'meeting' } | { kind: 'work-visit'; target: DirectorKey };
export const CHAT: Intent = { kind: 'chat' };

/** How long a work visit may last, in milliseconds, however long the work runs. */
export const WORK_VISIT_MS = 180_000;
/** A meeting keeps its people for as long as it runs; this only stops a stuck one from holding them forever. */
export const MEETING_STAY_MS = 30 * 60_000;

export function directorIntents(p: Pick<PlannerProject, 'tasks'>, now: Date): Partial<Record<DirectorKey, Intent>> {
  const out: Partial<Record<DirectorKey, Intent>> = {};
  for (const key of Object.keys(directorActivity(p, now)) as DirectorKey[]) out[key] = { kind: 'stay' };
  for (const t of p.tasks) {
    if (!isDirectorKey(t.assignee) || t.status !== 'in_progress' || !isClaimLive(t.claim, now) || out[t.assignee]?.kind === 'work-visit') continue;
    const other = t.dependsOn.map((id) => p.tasks.find((x) => x.id === id)).find((d) => d && d.status !== 'cancelled' && isDirectorKey(d.assignee) && d.assignee !== t.assignee);
    if (other && isDirectorKey(other.assignee)) out[t.assignee] = { kind: 'work-visit', target: other.assignee };
  }
  return out;
}

export const intentFor = (intents: Partial<Record<DirectorKey, Intent>>, key: DirectorKey | undefined): Intent => (key && intents[key]) || CHAT;

/**
 * What a director does when their time at the desk is up. `offices` are the doors of the other directors, `targetDoor` is the door of a work visit's
 * target. A director with something real going on never leaves for a chat, and a work visit never goes anywhere but to the one it is for.
 */
export function chooseTrip(intent: Intent, offices: readonly string[], targetDoor: string | undefined, rnd: () => number): { go: false } | { go: true; to: string; purpose: 'work' | 'meeting' | 'chat' } {
  if (intent.kind === 'stay') return { go: false };
  if (intent.kind === 'meeting') return targetDoor ? { go: true, to: targetDoor, purpose: 'meeting' } : { go: false };
  if (intent.kind === 'work-visit') return targetDoor ? { go: true, to: targetDoor, purpose: 'work' } : { go: false };
  if (!offices.length) return { go: false };
  return { go: true, to: offices[Math.floor(rnd() * offices.length)]!, purpose: 'chat' };
}

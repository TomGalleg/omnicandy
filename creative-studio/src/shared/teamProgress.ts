// What every director is told about the team's progress, so none of them works in the dark: the order the work is being done in, who has which task, what is finished
// (and what it made), what is waiting for the owner and what comes next. Built from the plan and the build queue only, never guessed; a task is "finished" only
// when a report says so, and that is the director's report, not proof (the owner reviews it).
import { defaultOrder, directorOf, isOpen, titleOf, type BuildQueue } from './buildQueue';
import type { PlanReport, PlannerProject, PlanTask, TaskStatus } from './planner';

const STATUS: Record<TaskStatus, string> = {
  todo: 'to do', in_progress: 'being worked on now', blocked: 'blocked', reported: 'finished, waiting for the owner to review', revision: 'sent back for changes', accepted: 'accepted by the owner', cancelled: 'cancelled',
};
const MAX_TASKS = 24;
const clip = (t: string, n: number) => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}...` : s; };

function latestReport(plan: PlannerProject, taskId: string): PlanReport | undefined {
  return plan.reports.filter((r) => r.taskId === taskId).sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))[0];
}
const result = (r: PlanReport | undefined): string => {
  if (!r) return '';
  const made = (r.outputs ?? []).map((o) => o.description).filter(Boolean).slice(0, 3).join(', ');
  return ` Result: ${r.outcome}${made ? `, made ${made}` : ''}${r.status === 'revision_requested' ? ' (the owner asked for changes)' : ''}.`;
};

/** Lines for a director's briefing. Empty when the plan has no tasks. */
export function teamProgressLines(plan: PlannerProject, queue: BuildQueue | null): string[] {
  const live = plan.tasks.filter((t) => t.status !== 'cancelled');
  if (live.length === 0) return [];
  const byId = new Map(live.map((t) => [t.id, t]));
  const building = !!queue && queue.status !== 'idle' && queue.order.length > 0;
  const ordered: PlanTask[] = [];
  const add = (id: string) => { const t = byId.get(id); if (t && !ordered.includes(t)) ordered.push(t); };
  if (building) queue!.order.forEach(add); else defaultOrder(plan.tasks).forEach(add);
  live.forEach((t) => add(t.id)); // anything not in the order (already finished, or added later) comes after
  const shown = ordered.slice(0, MAX_TASKS);

  const lines = [
    building ? 'Team progress. The Production Director put the work in this order, and the directors take it one task at a time:' : 'Team progress. Nobody has started building yet; this is the order the open tasks would be done in:',
    ...shown.map((t, i) => `${i + 1}. "${t.title}" (${titleOf(directorOf(t))}): ${STATUS[t.status]}.${t.status === 'reported' || t.status === 'accepted' || t.status === 'revision' ? result(latestReport(plan, t.id)) : ''}${t.status === 'blocked' && t.progressNote ? ` ${clip(t.progressNote, 120)}` : ''}`),
  ];
  if (ordered.length > shown.length) lines.push(`(${ordered.length - shown.length} more tasks not listed.)`);
  if (building) {
    const cur = queue!.current ? byId.get(queue!.current) : undefined;
    if (cur) lines.push(`Right now: ${titleOf(directorOf(cur))} is working on "${cur.title}".`);
    if (queue!.status === 'waiting' && queue!.waiting) lines.push(`The build is waiting for the owner: ${titleOf(queue!.waiting.director)} needs them. ${clip(queue!.waiting.message, 200)}`);
    if (queue!.status === 'paused') lines.push('The build is paused.');
    if (queue!.status === 'done') lines.push('The build is finished; the results are waiting for the owner to review.');
  }
  const next = ordered.find((t) => isOpen(t));
  if (next && !(building && queue!.current)) lines.push(`Next up: "${next.title}" (${titleOf(directorOf(next))}).`);
  lines.push('Use this: say what has been finished by others and what it made when it matters to your work, respect the order, and do not redo finished work. Only report a task as finished if it says so here.');
  return lines;
}

// Plain-language view of the planner's stored state (docs/planner-simplification-plan.md, section 3.2 and 3.3). Pure and read-only:
// nothing here changes what is stored, so older projects, the MCP tools and the history keep their exact meaning.
import { isClaimLive, planDrift, snapshotOf, unmetDependencies, type PlannerProject, type PlanTask, type ProjectSummary, type TaskStatus } from './planner';

/** Window event the planning chat sends while the AI is thinking (`detail: { busy: boolean }`), so the Planner tab can show it. */
export const PLANNER_BUSY_EVENT = 'createcraft:planner-busy';

/** The number on the Planner tab: results to review plus suggestions to look at, in the plan of the open project. */
export function plannerTabBadge(list: ReadonlyArray<Pick<ProjectSummary, 'awaitingReview' | 'pendingProposals' | 'inThisProject'>>): number {
  const mine = list.find((s) => s.inThisProject);
  return mine ? mine.awaitingReview + mine.pendingProposals : 0;
}

export const SIMPLE_STATUSES = ['To Do', 'In Progress', 'Needs Review', 'Done', 'Blocked'] as const;
export type SimpleStatus = (typeof SIMPLE_STATUSES)[number];
export type Tone = 'off' | 'warn' | 'bad' | 'ok';

export interface DisplayStatus {
  label: SimpleStatus;
  tone: Tone;
  /** A short plain explanation shown next to the label (who is working, why it waits, what changed). */
  chip?: string;
  /** True when a claim ran out without a result: the owner should take the task back or send it again. */
  stalled?: boolean;
  /** Cancelled tasks are hidden from the board unless "show removed" is on. */
  removed?: boolean;
  /** Needs Review only: the plan changed since the work was handed off. */
  planChanged?: boolean;
}

/** Plain label for a stored status when no task context is available (history lists, package rows). */
export const SIMPLE_LABEL: Record<TaskStatus, SimpleStatus | 'Removed'> = {
  todo: 'To Do', revision: 'To Do', in_progress: 'In Progress', blocked: 'Blocked', reported: 'Needs Review', accepted: 'Done', cancelled: 'Removed',
};

const TONE: Record<SimpleStatus, Tone> = { 'To Do': 'off', 'In Progress': 'warn', 'Needs Review': 'warn', Done: 'ok', Blocked: 'bad' };

export function displayStatus(t: PlanTask, p: PlannerProject, now: Date = new Date()): DisplayStatus {
  const out = (label: SimpleStatus, extra: Partial<DisplayStatus> = {}): DisplayStatus => ({ label, tone: TONE[label], ...extra });
  const pkg = t.packageId ? p.packages.find((k) => k.id === t.packageId) : undefined;
  switch (t.status) {
    case 'accepted': return out('Done');
    case 'cancelled': return { label: 'To Do', tone: 'off', chip: 'Removed', removed: true };
    case 'blocked': return out('Blocked', t.progressNote ? { chip: t.progressNote } : {});
    case 'reported': {
      const outdated = !!pkg && planDrift(pkg.plan, snapshotOf(p)).outdated;
      return out('Needs Review', outdated ? { chip: 'The plan changed after this was sent', planChanged: true } : {});
    }
    case 'revision': return out('To Do', { chip: t.progressNote ? `Changes requested: ${t.progressNote}` : 'Changes requested' });
    case 'in_progress': {
      if (isClaimLive(t.claim, now)) return out('In Progress', { chip: `${t.claim?.executor.name ?? 'An AI'} is working on it` });
      const last = [...p.reports].reverse().find((r) => r.taskId === t.id);
      if (!t.claim && last?.outcome === 'partial') return out('In Progress', { chip: 'Partly done' });
      return out('In Progress', { chip: 'Stalled: no result arrived', stalled: true });
    }
    case 'todo': default: {
      if (pkg?.state === 'open') return out('In Progress', { chip: 'Sent to AI, waiting for a result' });
      const waits = unmetDependencies(p, t);
      return out('To Do', waits.length ? { chip: `Waiting for ${waits[0]?.title}${waits.length > 1 ? ` and ${waits.length - 1} more` : ''}` } : {});
    }
  }
}

/** One plain line about a workflow run, for a task that points at a workflow. Read-only: the Workflow tab is where it is run and approved. */
export function describeWorkflowRun(r: Pick<import('./workflowControl').RunSnapshot, 'state' | 'ok' | 'cancelled' | 'steps' | 'waitingFor' | 'problems'>): string {
  const done = r.steps.filter((s) => s.status === 'completed').length;
  const total = r.steps.length;
  switch (r.state) {
    case 'idle': return 'Not run yet.';
    case 'running': return `Running: ${done} of ${total} steps done.`;
    case 'paused': return `Paused after ${done} of ${total} steps.`;
    case 'waiting-for-you': return `Waiting for you in the Workflow tab${r.waitingFor ? `: ${r.waitingFor}` : ''}.`;
    case 'finished': return r.cancelled ? 'The last run was stopped.' : r.ok === false ? `The last run finished with problems${r.problems.length ? ` (${r.problems.length})` : ''}.` : 'The last run finished. Check the results, then mark the task done yourself or send it for review.';
  }
}

/** What waits for the owner: the single number behind "Needs you". */
export function needsYou(p: PlannerProject, now: Date = new Date()) {
  const reports = p.reports.filter((r) => r.status === 'submitted').length;
  const suggestions = p.proposals.filter((x) => x.status === 'pending').length;
  const stalled = p.tasks.filter((t) => displayStatus(t, p, now).stalled).length;
  return { reports, suggestions, stalled, total: reports + suggestions + stalled };
}

/**
 * The service's messages are exact (they name revisions, claims, packages). In the plain view the same facts are said in everyday
 * words. Unknown messages are returned unchanged, so a new error is never hidden.
 */
export function plainError(message: string): string {
  const m = message;
  let r: RegExpExecArray | null;
  if (/was changed by someone else \(revision \d+, you had \d+\)/.test(m)) return 'This changed while you were looking at it. The latest version is showing now; make your change again.';
  if ((r = /"?([^"]+?)"? (?:is claimed by|already claimed this task)\b/.exec(m)) || (r = /^(.+?) (?:already claimed this task|has this task claimed)/.exec(m))) return `${r[1]?.replace(/^"[^"]*" is claimed by /, '') ?? 'An AI'} is already working on this. Take the task back first if you want to change it.`;
  if (/An executor is working on this task/.test(m)) return 'An AI is working on this task. Take it back before changing what it asks for.';
  if (/has a report waiting|report from this package is waiting/.test(m)) return 'A result is waiting for your review. Review it first.';
  if (/handed off, so it is cancelled rather than deleted/.test(m)) return 'This task was already sent to an AI, so it can be removed but not deleted. The history stays.';
  if (/The plan changed after this work was handed off/.test(m)) return 'The plan changed after this was sent. Look at what changed, then tick the box to accept it anyway.';
  if (/not in that package any more|no longer part of that package|now belongs to a newer package|is (?:closed|cancelled|superseded)\. Ask for the current package/.test(m)) return 'This task was sent again since, so that older copy is out of date.';
  if (/^Not applied: (.*)\. Reject the proposal or deselect those changes\.$/.test(m)) return `Not applied: ${/^Not applied: (.*)\. Reject/.exec(m)?.[1]}. Untick those items or reject the suggestion.`;
  if (/That report was already reviewed/.test(m)) return 'You already reviewed this result.';
  if (/That proposal was already decided/.test(m)) return 'You already decided on this suggestion.';
  if (/report for this task is already waiting/.test(m)) return 'A result for this task is already waiting for your review.';
  return m;
}

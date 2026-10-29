// What the General Manager is told has changed in the plan lately, so work started with someone else (a worker's tasks, a result, a meeting) is not news
// to them. Read from the plan's own history; nothing is stored and no AI is used. Short on purpose: a line per change, newest last.
import type { ActivityEntry } from './planner';

const DAY = 86_400_000;
const SKIP = /^(recovered|chat)/;

const when = (at: string, now: Date): string => {
  const days = Math.floor((now.getTime() - new Date(at).getTime()) / DAY);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

export function recentChangeLines(activity: readonly ActivityEntry[], now: Date, opts: { limit?: number; days?: number } = {}): string[] {
  const limit = opts.limit ?? 8;
  const since = now.getTime() - (opts.days ?? 7) * DAY;
  const recent = activity.filter((e) => !SKIP.test(e.kind) && e.summary.trim() && new Date(e.at).getTime() >= since).slice(-limit);
  return recent.length ? ['What changed in the plan lately (newest last):', ...recent.map((e) => `- ${when(e.at, now)}, ${e.actor.name}: ${e.summary.replace(/\s+/g, ' ').slice(0, 140)}`)] : [];
}

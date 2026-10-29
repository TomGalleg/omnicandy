// Worker to worker. A worker (an AI the owner is talking with) can write two kinds of line at the end of a reply:
//   Ask: <title> — <what is needed>    a request for another director to do something
//   Note: <title> — <what to know>     information for another director
// Neither reaches anyone by itself. The owner sees a card and chooses Send or Skip. A note is added to the other director's conversation as one plain line; a
// request becomes ONE pending suggestion for a task owned by that director, which joins the plan only when the owner adds it. Nobody gives work to anyone.
import type { Actor, PlanTask, Proposal, ProposalChange } from './planner';
import { directorFromName, directorTitle, type DirectorKey, type TownAgent } from './town';
import type { Intent } from './townIntent';

export interface TeamLine { kind: 'ask' | 'note'; to: DirectorKey; what: string }

/** At most this many lines are read from one reply. */
export const MAX_TEAM_LINES = 2;
/** A suggestion that starts with this is a request from one worker to another (see requestProposal). */
export const REQUEST_NOTE = 'Request: ';

const LINE = /^\s*(?:[-*]\s+)?\**\s*(ask|note)\s*\**\s*:\s*\**\s*(.+?)\s*$/i;
const SPLIT = /^(.+?)(?:\s*[—–]\s*|\s+-\s+|:\s+)(.+)$/;

/** The text to show without the lines, the lines that name a real director, and the names that did not match any (never guessed). */
export function parseTeamLines(text: string): { text: string; lines: TeamLine[]; unknown: string[] } {
  const keep: string[] = []; const lines: TeamLine[] = []; const unknown: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    const parts = m ? SPLIT.exec(m[2]!) : null;
    if (!m || !parts) { keep.push(raw); continue; }
    const to = directorFromName(parts[1]!);
    if (!to) { unknown.push(parts[1]!.trim()); continue; }
    if (lines.length < MAX_TEAM_LINES) lines.push({ kind: m[1]!.toLowerCase() === 'ask' ? 'ask' : 'note', to, what: parts[2]!.replace(/\*+/g, '').trim().slice(0, 400) });
  }
  return { text: keep.join('\n').replace(/\n{3,}/g, '\n\n').trim(), lines, unknown };
}

/** The suggestion a request becomes: one task, owned by the director it is for, from the worker who asked. */
export function requestProposal(sender: string, line: TeamLine): { proposer: Actor; note: string; changes: ProposalChange[] } {
  const title = directorTitle(line.to) ?? line.to;
  return {
    proposer: { kind: 'other', name: sender },
    note: `${REQUEST_NOTE}${sender} asks ${title}`.slice(0, 1000),
    changes: [{ op: 'add_task', title: line.what.slice(0, 200), description: `Asked by ${sender} of ${title}.`.slice(0, 4000), priority: 'normal', dependsOn: [], completionChecks: [], assignee: line.to }],
  };
}

/** The line added to the other director's conversation for a note. */
export const noteText = (sender: string, what: string) => `(Note from ${sender}) ${what}`;

export const isRequest = (p: Pick<Proposal, 'note'>) => p.note.startsWith(REQUEST_NOTE);

/** Requests still waiting for the owner: the task and the director it is for. */
export function pendingRequests(proposals: ReadonlyArray<Pick<Proposal, 'status' | 'note' | 'changes' | 'proposedBy'>> | undefined): Array<{ sender: string; to: DirectorKey; title: string }> {
  const out: Array<{ sender: string; to: DirectorKey; title: string }> = [];
  for (const pr of proposals ?? []) {
    if (pr.status !== 'pending' || !isRequest(pr)) continue;
    for (const c of pr.changes) if (c.op === 'add_task' && c.assignee && directorTitle(c.assignee)) out.push({ sender: pr.proposedBy.name, to: c.assignee as DirectorKey, title: c.title });
  }
  return out;
}

/** The sender of a waiting request goes to see its receiver, for as long as it waits. Only for a sender who is one of the nine and is not asking themselves. */
export function requestIntents(proposals: Parameters<typeof pendingRequests>[0], agents: readonly Pick<TownAgent, 'name' | 'director' | 'retired'>[]): Partial<Record<DirectorKey, Intent>> {
  const out: Partial<Record<DirectorKey, Intent>> = {};
  for (const r of pendingRequests(proposals)) {
    const from = agents.find((a) => a.name === r.sender && a.director && !a.retired)?.director;
    if (from && from !== r.to && !out[from]) out[from] = { kind: 'work-visit', target: r.to };
  }
  return out;
}

/** What the receivers of waiting requests show: something is waiting for the owner. */
export const requestTasks = (proposals: Parameters<typeof pendingRequests>[0]): Array<Pick<PlanTask, 'title'> & { assignee: DirectorKey }> => pendingRequests(proposals).map((r) => ({ title: `${r.sender} asks: ${r.title}`, assignee: r.to }));

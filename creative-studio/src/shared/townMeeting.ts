// A meeting the team holds with AI help. Pure rules and text only: nothing here calls an AI (the Town Hall does, one request at a time).
//
// It is run like an organised meeting. The owner talks with ONE person at a time (the General Manager to begin with). Who might have something to add is
// worked out by rules, for free (see townHands.ts): a ! over their head means only "they could add something". What they say is asked for ONLY when the
// owner clicks the ! to invite them. So a message costs one request for the answer, and hearing from an invited colleague is one more.
import type { TownAgent, TownMeeting, MeetingNote } from './town';
import { CHUNK_FORMAT } from './plannerContext';

/** The most recent notes that go into a prompt, so a long meeting does not grow without bound. */
const RECENT = 8;
const said = (notes: readonly MeetingNote[]) => notes.slice(-RECENT).map((n) => `${n.by}: ${n.text.slice(0, 300)}`);

/** A task a person recommends is a line of its own: `Task: <short title>`. At most this many are read from one reply. */
export const MAX_TASK_LINES = 2;
export const TASK_NOTE = ' If a task is clearly needed, offer it: end with a short question in your own words asking whether the owner wants you to take it on (for example "Want me to draft that?"), then up to two lines, each exactly: Task: <short title>. The owner only has to say yes. Only offer a task when it really helps; the owner decides.';

/** The words without the Task lines, and the titles those lines recommend (empty titles and repeats dropped). */
export function parseTaskLines(text: string): { text: string; tasks: string[] } {
  const keep: string[] = []; const tasks: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:[-*]\s+)?\**task\**\s*:\s*\**\s*(.+?)\s*\**\s*$/i.exec(raw);
    if (!m) { keep.push(raw); continue; }
    const title = m[1]!.replace(/\*+/g, '').trim().slice(0, 200);
    if (title && !tasks.some((t) => t.toLowerCase() === title.toLowerCase()) && tasks.length < MAX_TASK_LINES) tasks.push(title);
  }
  return { text: keep.join('\n').replace(/\n{3,}/g, '\n\n').trim(), tasks };
}

/** What the person the owner is talking with is asked: answer the owner directly, from their own job. */
export function replyPrompt(meeting: Pick<TownMeeting, 'topic' | 'kind'>, speaker: Pick<TownAgent, 'name'>, others: readonly string[], notes: readonly MeetingNote[]): string {
  return [
    `We are in a ${meeting.kind} meeting with the owner. It started with: ${meeting.topic}`,
    `The others at the table, listening: ${others.length ? others.join(', ') : 'nobody else'}.`,
    '',
    ...(notes.length ? ['What has been said so far (the owner is "You"):', ...said(notes), ''] : []),
    `${speaker.name}, the owner is talking to you. Answer them directly in two to four short sentences, from your own job. Ask at most one short question if you need to. If something belongs to someone else at the table, say who. Do not do the work, and do not say anything is done.${TASK_NOTE}`,
  ].join('\n');
}

/** A colleague the owner invited by clicking their "!": what they would add from their own job, not what has already been said. */
export function invitePrompt(meeting: Pick<TownMeeting, 'topic' | 'kind'>, speaker: Pick<TownAgent, 'name'>, talkingWith: string, notes: readonly MeetingNote[]): string {
  return [
    `We are in a ${meeting.kind} meeting with the owner. It started with: ${meeting.topic}`,
    `The owner has been talking with ${talkingWith}.`,
    '',
    'What has been said so far (the owner is "You"):',
    ...said(notes),
    '',
    `${speaker.name}, the owner has invited you to add your view. In one to three short sentences, say what you would add from your own job that has not already been said. Do not repeat others, do not do the work, and do not say anything is done.${TASK_NOTE}`,
  ].join('\n');
}

/** The last request: the General Manager turns the discussion into tasks, in the plan format, or says so when nothing was decided. */
export function summaryPrompt(meeting: Pick<TownMeeting, 'topic'>, notes: readonly MeetingNote[]): string {
  return [
    `The meeting that started with "${meeting.topic}" is over. This is what was said:`,
    ...said(notes),
    '',
    'If the discussion points to clear work, answer in exactly this shape (the owner will decide what joins the plan):',
    CHUNK_FORMAT,
    'If nothing clear was decided, answer with one short sentence saying what is still open, and no list.',
  ].join('\n');
}

/** The cost, said plainly, for the settings under the chat. */
export function costText(hands: boolean, providerLabel: string, model: string): string {
  return hands
    ? `Each message you send makes one request to ${providerLabel} (${model}) for the answer. A ! over someone's head costs nothing: it only means they could add something here. Hearing from them is one more request, and only if you click it.`
    : `Each message you send makes one request to ${providerLabel} (${model}) for the answer. Nobody else shows a ! unless you turn it on.`;
}

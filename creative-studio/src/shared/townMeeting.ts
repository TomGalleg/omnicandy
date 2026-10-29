// A meeting the team holds with AI help. Pure rules and text only: nothing here calls an AI (the Town tab does, one request at a time, only after the owner
// confirms). The cost is bounded three ways: a small fixed number of replies, a cap on each reply (MAX_REPLY_TOKENS), and a stop on the first problem.
import type { TownAgent, TownMeeting, MeetingNote } from './town';
import { CHUNK_FORMAT } from './plannerContext';

/** How many replies a meeting may have. The summary at the end is one more request. */
export const MEETING_TURNS = { default: 6, min: 2, max: 12 } as const;
export const clampMeetingTurns = (n: number | undefined): number => (n === undefined || !Number.isFinite(n) ? MEETING_TURNS.default : Math.min(MEETING_TURNS.max, Math.max(MEETING_TURNS.min, Math.floor(n))));

/** Who speaks, in order: everyone in turn, round and round, until the replies run out. */
export function turnOrder(participantIds: readonly string[], turns: number): string[] {
  const ids = [...new Set(participantIds)];
  return ids.length ? Array.from({ length: clampMeetingTurns(turns) }, (_, i) => ids[i % ids.length]!) : [];
}

/** The most recent notes that go into a prompt, so a long meeting does not grow without bound. */
const RECENT = 8;
const said = (notes: readonly MeetingNote[]) => notes.slice(-RECENT).map((n) => `${n.by}: ${n.text.slice(0, 300)}`);

/** What one speaker is asked. They are not asked to do any work, only to say what they think from their own job. */
export function turnPrompt(meeting: Pick<TownMeeting, 'topic' | 'kind'>, speaker: Pick<TownAgent, 'name'>, others: readonly string[], notes: readonly MeetingNote[]): string {
  return [
    `We are in a ${meeting.kind} meeting about: ${meeting.topic}`,
    `Also here: ${others.length ? others.join(', ') : 'only the owner'}.`,
    '',
    ...(notes.length ? ['What has been said so far:', ...said(notes), ''] : ['Nobody has spoken yet.', '']),
    `It is your turn, ${speaker.name}. In two or three short sentences, say what you think from your own job. Do not repeat what others said, do not do the work, and do not say anything is done.`,
  ].join('\n');
}

/** The last request: the General Manager turns the discussion into tasks, in the plan format, or says so when nothing was decided. */
export function summaryPrompt(meeting: Pick<TownMeeting, 'topic'>, notes: readonly MeetingNote[]): string {
  return [
    `The meeting about "${meeting.topic}" is over. This is what was said:`,
    ...said(notes),
    '',
    'If the discussion points to clear work, answer in exactly this shape (the owner will decide what joins the plan):',
    CHUNK_FORMAT,
    'If nothing clear was decided, answer with one short sentence saying what is still open, and no list.',
  ].join('\n');
}

/** What the owner is told before anything starts. Nothing else is promised. */
export function meetingConfirmText(turns: number, people: number, providerLabel: string, model: string): string {
  const calls = clampMeetingTurns(turns) + 1;
  return `This makes up to ${calls} requests to ${providerLabel} (${model}), one reply at a time from the ${people === 1 ? 'one person' : `${people} people`} at the table, and then one more to turn it into tasks. Each reply is kept short. It stops at once if you press Stop, leave this screen or anything goes wrong. It only adds to the meeting notes and, at the end, sends at most one suggestion to the Studio canvas, which waits for you.`;
}

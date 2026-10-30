// A meeting the team holds with AI help. Pure rules and text only: nothing here calls an AI (the Town Hall does, one request at a time).
//
// It is run like an organised meeting. The owner talks with ONE person at a time (the General Manager to begin with). After each exchange the others work out
// who, if anyone, has the most important thing the owner should hear next; that person gets a ! over their head and the owner chooses when to open it. Opening
// it starts a conversation with them, until someone else has something more important. Each message costs at most three short requests: the reply, a quick
// choice of who might speak up, and that person's remark (which may be a PASS).
import type { TownAgent, TownMeeting, MeetingNote } from './town';
import { CHUNK_FORMAT } from './plannerContext';

/** The most recent notes that go into a prompt, so a long meeting does not grow without bound. */
const RECENT = 8;
const said = (notes: readonly MeetingNote[]) => notes.slice(-RECENT).map((n) => `${n.by}: ${n.text.slice(0, 300)}`);
const jobOf = (a: { job?: string; specialty?: string }) => (a.job ?? a.specialty ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);

/** A reply that means "nothing to add". */
export const isPass = (text: string): boolean => {
  const t = text.trim().replace(/^["'*_\s]+/, '');
  return /^pass[\s.!"')\]*_]*$/i.test(t) || (t.length < 24 && /^pass\b/i.test(t));
};

/** What the person the owner is talking with is asked: answer the owner directly, from their own job. */
export function replyPrompt(meeting: Pick<TownMeeting, 'topic' | 'kind'>, speaker: Pick<TownAgent, 'name'>, others: readonly string[], notes: readonly MeetingNote[]): string {
  return [
    `We are in a ${meeting.kind} meeting with the owner. It started with: ${meeting.topic}`,
    `The others at the table, listening: ${others.length ? others.join(', ') : 'nobody else'}.`,
    '',
    ...(notes.length ? ['What has been said so far (the owner is "You"):', ...said(notes), ''] : []),
    `${speaker.name}, the owner is talking to you. Answer them directly in two to four short sentences, from your own job. Ask at most one short question if you need to. If something belongs to someone else at the table, say who. Do not do the work, and do not say anything is done.`,
  ].join('\n');
}

/** Who might speak up next. One short request that names a title or NONE, so it is cheap. */
export function chimePickPrompt(talkingWith: string, candidates: ReadonlyArray<{ name: string; job?: string; specialty?: string }>, recent: readonly string[], notes: readonly MeetingNote[]): string {
  return [
    `You are choosing who, if anyone, should speak up next in a meeting between the owner and their team. The owner is talking with ${talkingWith}.`,
    '',
    'The others at the table, and their jobs:',
    ...candidates.map((c) => `- ${c.name}: ${jobOf(c) || 'general help'}`),
    '',
    'What has been said so far (the owner is "You"):',
    ...said(notes),
    '',
    `Pick the ONE person who has the most important thing the owner should hear right now, judged by their job, that ${talkingWith} has not already covered.${recent.length ? ` Do not pick anyone who spoke in the last few turns (${recent.join(', ')}) unless it is truly important.` : ''} Most of the time nobody needs to speak up: if so, say NONE.`,
    'Reply with only that person\'s exact title, or NONE.',
  ].join('\n');
}

/** The person chosen: what they most need the owner to hear, or a pass. */
export function chimePrompt(speaker: Pick<TownAgent, 'name'>, talkingWith: string, notes: readonly MeetingNote[]): string {
  return [
    `You are ${speaker.name}, listening to a meeting between the owner and ${talkingWith}.`,
    '',
    'What has been said so far (the owner is "You"):',
    ...said(notes),
    '',
    'If you have something important the owner should hear now, from your own job, say it to them in one to three short sentences. Do not repeat what has been said, do not do the work, and do not say anything is done. If you have nothing important to add, reply with exactly: PASS',
  ].join('\n');
}

/** Reads the answer to chimePickPrompt: the one name it names, or null for NONE (or anyone not at the table). */
export function parsePick(text: string, names: readonly string[]): string | null {
  const t = text.toLowerCase();
  let best: { name: string; at: number } | null = null;
  for (const n of names) {
    const at = t.indexOf(n.toLowerCase());
    if (at >= 0 && (!best || at < best.at)) best = { name: n, at };
  }
  return best?.name ?? null;
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
export function costText(chime: boolean, providerLabel: string, model: string): string {
  return chime
    ? `Each message you send makes one request to ${providerLabel} (${model}) for the answer, and up to two short ones so the others can decide whether to speak up. A ! over someone's head means they really have something to tell you.`
    : `Each message you send makes one request to ${providerLabel} (${model}) for the answer. Nobody else speaks up unless you click them.`;
}

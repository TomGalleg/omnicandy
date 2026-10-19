// The planning conversation (docs/project-planner.md). Pure text: what an AI is told, the limits that bound cost, and how its answers are read.
// Nothing here calls a provider (main/planner/chat.ts does that, only when the owner sends a message).
//
// The flow is a conversation. The AI talks the idea through with the owner; when it has enough it asks "Ready to start building?" and ends that
// message with READY_MARK. When the owner says yes, it answers once more in CHUNK_FORMAT: a short summary of the project and the work broken into
// clear, ordered chunks. Those are shown as a plain list the owner can tick, and join the plan only when the owner presses a button.
import type { ProposalChange } from './planner';
import { CHUNK_FORMAT, planSummary } from './plannerContext';
import { parseSuggestionText } from './plannerPaste';
import type { PlannerProject } from './planner';

export const CHAT_PROVIDER_IDS = ['claude', 'openai', 'gemini'] as const;
export type ChatProviderId = (typeof CHAT_PROVIDER_IDS)[number];
export interface ChatProvider { id: ChatProviderId; label: string; /** How it is paid for, said to the owner before the first message. */ cost: string }

export const CHAT_PROVIDERS: ChatProvider[] = [
  { id: 'claude', label: 'Claude', cost: 'Uses your Claude sign-in on this PC.' },
  { id: 'openai', label: 'OpenAI', cost: 'Uses your OpenAI API key. Each message is billed to your OpenAI account.' },
  { id: 'gemini', label: 'Google Gemini', cost: 'Uses your Google Gemini API key. Each message is billed to your Google account.' },
];

export interface ChatMessage { role: 'user' | 'assistant'; text: string }

// Limits that bound what one message can cost and what is sent.
export const MAX_CHAT_MESSAGES = 24;
export const MAX_CHAT_MESSAGE_CHARS = 6000;
export const MAX_REPLY_TOKENS = 3000;

/** Keeps the last messages that fit the limits (always ends on the newest). */
export function trimChat(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-MAX_CHAT_MESSAGES).map((m) => ({ role: m.role, text: m.text.slice(0, MAX_CHAT_MESSAGE_CHARS) }));
}

/** talk: understand the idea. chunks: the owner said yes, break the project into chunks. */
export type ChatMode = 'talk' | 'chunks';

/** The AI writes this on its own last line when it understands enough to plan the work. The page hides it and shows "Yes, make the plan". */
export const READY_MARK = '[[READY]]';
export const READY_QUESTION = "Ready to start building? I'll break it into clear steps.";
/** What the owner's "Yes" sends. */
export const MAKE_PLAN_REQUEST = 'Yes, I am ready. Please break the project into clear chunks now.';

export const isReady = (text: string): boolean => text.includes(READY_MARK);
export const withoutMarker = (text: string): string => text.split(READY_MARK).join('').replace(/\n{3,}/g, '\n\n').trim();

const TALK_RULES = [
  'You are the planning partner inside CreateCraft, an app for making things (art, video, audio, documents, software, research, engineering, anything). You are talking with someone who may have no project-management experience, to understand the project they want to make and plan it with them.',
  'How to talk:',
  '- Plain, short sentences. No headings, no lists, no jargon. Sound like a curious, friendly collaborator.',
  '- Ask at most two short questions at a time, and build on what they just said. Never interrogate.',
  '- Find out what they want to make, what it is for and who it is for, what "finished" looks like, the limits that matter (time, size, style, budget, tools they have) and what already exists. Offer a suggestion or two when it helps them decide, but let them lead.',
  `When you understand enough to plan the work (usually after a few exchanges, sooner if they gave a lot of detail), say in two or three sentences what you understood, then ask exactly: "${READY_QUESTION}" and put ${READY_MARK} on its own last line. Do not write the steps yet. Only use ${READY_MARK} when you really have enough.`,
  'If the user asks you to add or change steps in a plan that already exists, answer in the plan format below instead, listing only the new chunks.',
  'Never say the plan has changed or that work is done: the user decides what joins the plan and what is finished.',
  '',
  'Plan format (only when asked for the steps):',
  CHUNK_FORMAT,
];

const CHUNK_RULES = [
  'You are the planning partner inside CreateCraft. The user has agreed they are ready to start building. Break the project into clear, logical chunks.',
  CHUNK_FORMAT,
  'Do not write anything outside that format.',
];

/** What the AI is told: how to behave, what the project already contains (names and counts), and the plan so far (short; no file locations). */
export function chatSystemPrompt(p: PlannerProject, projectContext: string[] = [], mode: ChatMode = 'talk'): string {
  return [
    ...(mode === 'chunks' ? CHUNK_RULES : TALK_RULES),
    ...(projectContext.length ? ['', 'What this CreateCraft project already contains (do not plan work that already exists unless asked):', ...projectContext] : []),
    '', 'The project so far:', ...planSummary(p),
  ].join('\n');
}

/** What an answer in CHUNK_FORMAT holds: the intro, the project summary (set quietly when added) and the chunks. Null when it is not a plan of chunks. */
export interface ChunkPlan {
  intro: string;
  brief: ProposalChange[];
  chunks: Array<Extract<ProposalChange, { op: 'add_task' }>>;
}

export function chunkPlan(text: string): ChunkPlan | null {
  const clean = withoutMarker(text);
  const r = parseSuggestionText(clean);
  const chunks = r.changes.filter((c): c is Extract<ProposalChange, { op: 'add_task' }> => c.op === 'add_task');
  if (chunks.length < 2) return null;
  const firstHeading = clean.search(/^\s{0,3}(?:#{1,6}\s|\*\*[^*]+\*\*\s*:?\s*$)/m);
  const intro = (firstHeading > 0 ? clean.slice(0, firstHeading) : '').trim();
  return { intro, brief: r.changes.filter((c) => c.op === 'set_brief'), chunks };
}

/** Turns a transcript into one prompt, for providers called as a single request (Claude). */
export function transcriptText(messages: ChatMessage[]): string {
  return [...messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`), 'Assistant:'].join('\n\n');
}

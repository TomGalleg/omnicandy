// The planning chat beside the project brief (docs/planner-simplification-plan.md, Part 20). Pure text: the prompt an AI is given,
// limits that bound cost, and nothing that calls a provider (main/planner/chat.ts does that, only when the owner presses a button).
import type { PlannerProject } from './planner';
import { PLAN_FORMAT, planSummary } from './plannerContext';

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

/** What the AI is told. It sees the short plan summary (no file locations, no task details, no ideas) and may only suggest. */
export function chatSystemPrompt(p: PlannerProject, projectContext: string[] = []): string {
  return [
    'You are a friendly planning helper inside CreateCraft. You help the user plan a project of any kind (art, video, software, documents, research, engineering). Write in plain, short sentences for someone with no project-management experience.',
    'If the goal is unclear, ask at most three short questions first. Otherwise suggest a plan.',
    PLAN_FORMAT,
    'Keep everything outside those sections to a few sentences. Fill in as many sections as you honestly can; leave out a heading when you have nothing useful for it. Do not repeat things the project already has.',
    'Everything you write is only a suggestion. Never say the plan has changed or that work is done: the user decides what joins the plan and what is finished.',
    ...(projectContext.length ? ['', 'What this CreateCraft project already contains:', ...projectContext] : []),
    '', 'The project so far:', ...planSummary(p),
  ].join('\n');
}

/** The first message after the owner presses "Ask AI to help plan this". */
export function starterMessage(p: PlannerProject): string {
  return p.goal.trim()
    ? 'Please help me plan this project and fill in the plan: a clear project brief, milestones, the rules the result must follow, decisions with their reasons, the main tasks in a sensible order (each under a milestone, with how to check it is done), open questions for me, ideas worth considering and useful references.'
    : 'I have only a title so far. Ask me up to three short questions that would help you plan this project.';
}

/** Turns a transcript into one prompt, for providers called as a single request (Claude). */
export function transcriptText(messages: ChatMessage[]): string {
  return [...messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`), 'Assistant:'].join('\n\n');
}

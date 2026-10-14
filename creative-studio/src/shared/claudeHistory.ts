// Per-project Claude conversation: what is saved in the project folder and what Claude is told
// when a reopened project starts a new session (a short summary plus the last few messages).

import type { ClaudeChatItem } from './claude';

export const HISTORY_FILE = 'conversation.json';
export const HISTORY_FOLDER = 'Claude';
export const MAX_SAVED_ITEMS = 200;
const RECENT_MESSAGES = 6;
const SUMMARY_REQUESTS = 8;

const ROLES = new Set(['user', 'claude', 'activity', 'error']);

/** Reads a saved file defensively; anything malformed is dropped rather than failing the project. */
export function parseHistory(raw: unknown): ClaudeChatItem[] {
  const list = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) return [];
  const out: ClaudeChatItem[] = [];
  for (const i of list) {
    const o = i as Partial<ClaudeChatItem> | null;
    if (!o || typeof o.id !== 'string' || typeof o.text !== 'string' || typeof o.at !== 'string' || !ROLES.has(String(o.role))) continue;
    out.push({ id: o.id.slice(0, 64), role: o.role as ClaudeChatItem['role'], text: o.text.slice(0, 8000), at: o.at.slice(0, 40) });
  }
  return out.slice(-MAX_SAVED_ITEMS);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s).replace(/\s+/g, ' ');

/**
 * Context for a fresh Claude session after reopening a project: one line per earlier request, then
 * the last few messages (trimmed). Activity and errors are left out. Empty when there is no chat.
 * No model call is made to produce it, so it costs nothing beyond the tokens it adds.
 */
export function buildResumeContext(items: ClaudeChatItem[]): string {
  const talk = items.filter((i) => i.role === 'user' || i.role === 'claude');
  if (!talk.length) return '';
  const recent = talk.slice(-RECENT_MESSAGES);
  const older = talk.slice(0, talk.length - recent.length).filter((i) => i.role === 'user').slice(-SUMMARY_REQUESTS);
  const parts = ['Earlier in this project (restored from its saved chat; the app state is the source of truth, so check get_status):'];
  if (older.length) parts.push(`Earlier requests: ${older.map((i) => `"${clip(i.text, 120)}"`).join('; ')}.`);
  parts.push('Latest messages:', ...recent.map((i) => `${i.role === 'user' ? 'User' : 'Claude'}: ${clip(i.text, 400)}`));
  return parts.join('\n');
}

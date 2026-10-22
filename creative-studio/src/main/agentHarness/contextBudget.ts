import type { Message } from './types';

/** Bound model-visible tool output; verified receipts and the recovery journal remain untouched. */
export const MAX_TOOL_OUTPUT = 12000;
export function boundToolOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n[Tool output truncated; inspect smaller sections to verify remaining content.]`;
}
/** Preserve tool call/result pairing by replacing old content, never deleting messages. */
export function compactAgentHistory(messages: Message[], recentMessages = 28): void {
  const boundary = Math.max(0, messages.length - recentMessages);
  for (let i = 0; i < boundary; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === 'tool' && msg.content.length > 320) msg.content = '[Earlier tool output compacted; inspect the current application state again before relying on it.]';
    if (msg.role === 'user' && msg.imageDataUrl) {
      msg.imageDataUrl = undefined;
      msg.content = '[Older preview omitted; obtain a fresh preview to verify current state.]';
    }
  }
}

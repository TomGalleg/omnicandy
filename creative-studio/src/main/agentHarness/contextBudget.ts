import type { Message } from './types';

/** Bound model-visible tool output; verified receipts and the recovery journal remain untouched. */
export const MAX_TOOL_OUTPUT = 12000;
export function boundToolOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n[Tool output truncated; inspect smaller sections to verify remaining content.]`;
}
/**
 * Smaller JSON Schema for the model: validation keywords that only matter at execution time are dropped
 * ($schema, additionalProperties:false, string/array length limits, propertyNames). Types, enums, required lists,
 * descriptions, defaults and numeric ranges stay. Execution still validates against the full zod schema, so nothing
 * becomes more permissive.
 */
const DROP_KEYS = new Set(['$schema', 'maxLength', 'minLength', 'maxItems', 'minItems', 'propertyNames', 'exclusiveMinimum', 'exclusiveMaximum']);
export function compactToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const node = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(node);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEYS.has(k)) continue;
      if (k === 'additionalProperties' && v === false) continue;
      if (k === 'properties' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, node(pv)]));
      else out[k] = node(v);
    }
    return out;
  };
  return node(schema) as Record<string, unknown>;
}
/** Survives compaction so a resumed task can still tell that a comparison passed. */
export const VERIFIED_MARKER = '[evidence_verify passed]';
/** Preserve tool call/result pairing by replacing old content, never deleting messages. The `Error:` prefix and the
 * verification marker are kept so that compaction can never turn a failed call into a success or erase a passed check. */
export function compactAgentHistory(messages: Message[], recentMessages = 28): void {
  const boundary = Math.max(0, messages.length - recentMessages);
  for (let i = 0; i < boundary; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === 'tool' && msg.content.length > 320) {
      msg.content = `${msg.content.startsWith('Error:') ? 'Error: ' : ''}${msg.content.includes('"passed":true') ? `${VERIFIED_MARKER} ` : ''}[Earlier tool output compacted; inspect the current application state again before relying on it.]`;
    }
    if (msg.role === 'user' && msg.imageDataUrl) {
      msg.imageDataUrl = undefined;
      msg.content = '[Older preview omitted; obtain a fresh preview to verify current state.]';
    }
  }
}

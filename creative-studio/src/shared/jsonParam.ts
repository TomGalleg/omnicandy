// Bounded JSON parameters for the integration framework. Only built-in adapters may declare them (the manager
// refuses them anywhere else), and the value is always reduced to ONE canonical string: sorted keys, no
// whitespace. The same text is hashed, approved by the user and handed to the adapter, so what was checked is what runs.

export const JSON_PARAM_DEFAULT_MAX_CHARS = 16_000;
export const JSON_PARAM_HARD_MAX_CHARS = 64_000;
export const JSON_PARAM_DEFAULT_MAX_DEPTH = 8;
export const JSON_PARAM_HARD_MAX_DEPTH = 12;
export const JSON_PARAM_MAX_NODES = 20_000;

export type JsonParamResult = { ok: true; text: string; value: unknown } | { ok: false; error: string };

/** Largest nesting depth (a scalar is 0, `{a:1}` is 1, `{a:{b:1}}` is 2) and node count, found without recursion so a hostile value cannot overflow the stack. */
function measure(root: unknown): { depth: number; nodes: number; badKey?: string } {
  let depth = 0, nodes = 0;
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    nodes++;
    if (nodes > JSON_PARAM_MAX_NODES) return { depth, nodes };
    if (v && typeof v === 'object') {
      if (d + 1 > depth) depth = d + 1;
      const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
      for (const [k, x] of entries) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') return { depth, nodes, badKey: k };
        stack.push([x, d + 1]);
      }
    }
  }
  return { depth, nodes };
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canonical((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** Accepts JSON text or an already-parsed object/array (models usually send the object itself). */
export function normalizeJsonParam(raw: unknown, name: string, limits: { maxChars?: number; maxDepth?: number } = {}): JsonParamResult {
  const maxChars = Math.min(limits.maxChars ?? JSON_PARAM_DEFAULT_MAX_CHARS, JSON_PARAM_HARD_MAX_CHARS);
  const maxDepth = Math.min(limits.maxDepth ?? JSON_PARAM_DEFAULT_MAX_DEPTH, JSON_PARAM_HARD_MAX_DEPTH);
  let value: unknown;
  if (typeof raw === 'string') {
    if (raw.length > maxChars) return { ok: false, error: `"${name}" must be at most ${maxChars} characters of JSON (got ${raw.length}).` };
    try { value = JSON.parse(raw); } catch { return { ok: false, error: `"${name}" must be valid JSON text or a JSON object.` }; }
  } else if (raw !== null && typeof raw === 'object') {
    value = raw;
  } else return { ok: false, error: `"${name}" must be a JSON object or JSON text.` };
  if (value === null || typeof value !== 'object') return { ok: false, error: `"${name}" must be a JSON object or array.` };
  const m = measure(value);
  if (m.badKey) return { ok: false, error: `"${name}" must not contain the key "${m.badKey}".` };
  if (m.nodes > JSON_PARAM_MAX_NODES) return { ok: false, error: `"${name}" must have at most ${JSON_PARAM_MAX_NODES} values.` };
  if (m.depth > maxDepth) return { ok: false, error: `"${name}" must be at most ${maxDepth} levels deep (got ${m.depth}).` };
  let text: string;
  try { text = JSON.stringify(canonical(value)); } catch { return { ok: false, error: `"${name}" must be plain JSON data.` }; }
  if (text.length > maxChars) return { ok: false, error: `"${name}" must be at most ${maxChars} characters of JSON (got ${text.length}).` };
  return { ok: true, text, value: JSON.parse(text) };
}

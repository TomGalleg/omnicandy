/** Conservative native command-schema normalization. Never grants execution permissions.
 * A prose hint is not a machine-readable constraint; unrecognized supplied parameters fail closed.
 */
export type NativeRule = { type: 'number' | 'integer' | 'boolean' | 'string' | 'array' | 'object' | 'unknown'; min?: number; max?: number; enum?: Array<string | number>; required: boolean };
export type NativeSchema = { properties: Record<string, NativeRule>; complete: boolean };

/** Split only at top-level separators: nested braces, parentheses and quoted delimiters are preserved. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []; let start = 0; const closers: string[] = []; let quote = ''; let escape = false;
  const pair: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) { if (escape) escape = false; else if (ch === '\\') escape = true; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (pair[ch]) { closers.push(pair[ch]); continue; }
    if (closers.length && ch === closers[closers.length - 1]) { closers.pop(); continue; }
    if (ch === separator && closers.length === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function bareValue(s: string): string | number {
  const v = s.trim().replace(/^["']|["']$/g, '');
  return /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : v;
}
function parseRule(raw: unknown, required: boolean): NativeRule {
  const base: NativeRule = { type: 'unknown', required };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const typ = o.type === 'integer' ? 'integer' : o.type;
    if (typeof typ === 'string' && ['number', 'integer', 'boolean', 'string', 'array', 'object'].includes(typ)) base.type = typ as NativeRule['type'];
    if (typeof o.min === 'number' || typeof o.minimum === 'number') base.min = (o.min ?? o.minimum) as number;
    if (typeof o.max === 'number' || typeof o.maximum === 'number') base.max = (o.max ?? o.maximum) as number;
    if (Array.isArray(o.enum) && o.enum.every(x => typeof x === 'string' || typeof x === 'number')) base.enum = o.enum as Array<string | number>;
    return base;
  }
  if (typeof raw !== 'string') return base;
  let s = raw.trim();
  // Strip descriptive return/result suffix, retaining only the input grammar.
  s = s.split(/\s+→\s+/)[0]!.trim();
  s = splitTopLevel(s, '=')[0]!.trim();
  // Remove trailing prose annotations; no semantics are inferred from prose.
  const paren = s.search(/\s+\(/);
  if (paren >= 0) s = s.slice(0, paren).trim();
  const numericRange = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:\.\.|[–-])\s*(-?\d+(?:\.\d+)?)(?:\s*(?:px|pt|%|ppi|deg))?$/i);
  if (numericRange) return { ...base, type: 'number', min: Number(numericRange[1]), max: Number(numericRange[2]) };
  if (/^(?:bool|boolean)$/i.test(s)) return { ...base, type: 'boolean' };
  if (/^(?:str|string|text|name)$/i.test(s)) return { ...base, type: 'string' };
  if (/^(?:int|integer)$/i.test(s)) return { ...base, type: 'integer' };
  if (/^(?:n|number|float|double|px|pt|deg|%)$/i.test(s)) return { ...base, type: 'number' };
  const unionText = /^"[^"]*"$/.test(s) && s.includes('|') ? s.slice(1, -1) : s;
  const union = splitTopLevel(unionText, '|').map(x => x.trim());
  if (union.length > 1 && union.length <= 64 && union.every(x => /^(?:-?\d+(?:\.\d+)?|"[^"|]*"|'[^'|]*'|[A-Za-z_][\w-]*)$/.test(x))) {
    const values = union.map(bareValue);
    const kind = values.every(v => typeof v === 'number') ? 'number' : values.every(v => typeof v === 'string') ? 'string' : 'unknown';
    return { ...base, type: kind, enum: values };
  }
  if (s.startsWith('[') && s.endsWith(']')) return { ...base, type: 'array' };
  if (s.startsWith('{') && s.endsWith('}')) return { ...base, type: 'object' };
  return base;
}

export function normalizeNativeParameters(raw: unknown): NativeSchema | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    const props = r.properties && typeof r.properties === 'object' && !Array.isArray(r.properties) ? r.properties as Record<string, unknown> : r;
    const required = new Set(Array.isArray(r.required) ? r.required.filter((x): x is string => typeof x === 'string') : []);
    const properties: Record<string, NativeRule> = Object.create(null);
    for (const [key, value] of Object.entries(props)) {
      if (['required', 'additionalProperties', 'type', '$schema'].includes(key)) continue;
      properties[key] = parseRule(value, required.has(key) || (typeof value === 'object' && value !== null && (value as Record<string,unknown>).required === true));
    }
    return { properties, complete: true };
  }
  if (typeof raw !== 'string') return null;
  // e.g. '{"depth":8|16|32=8, "opacity":0..100=100} → {changed}'
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  let depth = 0; let quote = ''; let end = -1; let escaped = false;
  for (let i=0; i<trimmed.length; i++) {
    const ch=trimmed[i]!;
    if (quote) { if (escaped) escaped=false; else if (ch==='\\') escaped=true; else if (ch===quote) quote=''; continue; }
    if (ch==='"' || ch==="'") { quote=ch; continue; }
    if (ch==='{') depth++;
    if (ch==='}') { depth--; if (depth===0) { end=i; break; } }
  }
  if (end<0) return null;
  const fields = splitTopLevel(trimmed.slice(1,end), ',').filter(Boolean);
  const properties: Record<string, NativeRule> = Object.create(null);
  let complete = true;
  for (const field of fields) {
    const m = field.match(/^\s*(?:"([A-Za-z_][\w-]*)"|'([A-Za-z_][\w-]*)'|([A-Za-z_][\w-]*))(\?)?\s*(:)?\s*(.*)$/s);
    if (!m) { complete=false; continue; }
    const key = m[1] ?? m[2] ?? m[3]; const colon = !!m[5]; const value = m[6]?.trim() ?? '';
    // A name without a parameter separator is not a trustworthy schema field.
    if (!colon) { complete = false; continue; }
    if (!key || Object.hasOwn(properties,key)) { complete=false; continue; }
    properties[key] = parseRule(colon ? value : '', !m[4] && !value.includes('=') && !/\?$/.test(value));
  }
  return { properties, complete };
}

export function validateNormalizedNative(schema: NativeSchema, params: Record<string, unknown>, command: string): string | undefined {
  if (!schema.complete) return `Cannot validate ${command}: incomplete parameter schema. Do not execute.`;
  for (const key of Object.keys(params)) if (!Object.hasOwn(schema.properties,key)) return `Unknown parameter "${key}" for ${command}. Inspect exact command ID.`;
  for (const [key, rule] of Object.entries(schema.properties)) {
    const value = params[key];
    if (value === undefined) { if (rule.required) return `Missing required parameter "${key}".`; continue; }
    if (rule.type === 'unknown') return `Cannot validate ${command}: unsupported schema for "${key}". Do not execute.`;
    if (rule.type === 'number' || rule.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (rule.type === 'integer' && !Number.isInteger(value))) return `Parameter "${key}" must be a finite ${rule.type}.`;
      if (rule.min !== undefined && value < rule.min) return `Parameter "${key}" must be at least ${rule.min}.`;
      if (rule.max !== undefined && value > rule.max) return `Parameter "${key}" must be at most ${rule.max}.`;
    } else if (rule.type === 'array' ? !Array.isArray(value) : rule.type === 'object' ? !value || typeof value !== 'object' || Array.isArray(value) : typeof value !== rule.type) return `Parameter "${key}" must be ${rule.type}.`;
    if (rule.enum && !rule.enum.includes(value as string | number)) return `Parameter "${key}" must be one of ${rule.enum.join('|')}.`;
  }
  return undefined;
}

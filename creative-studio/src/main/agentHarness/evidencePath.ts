/**
 * Bounded paths into structured read-back JSON, for evidence_verify.
 *
 *   data.details.1.location.0            dotted keys and numeric indexes (always supported)
 *   data.details[1].location[0]          bracket index
 *   data.details[name=Cube.001].scale[2] select the ONE array element whose key equals a value (real Blender
 *                                        scene.inspect lists objects as an array of {name, location, materials, ...})
 *
 * Everything is length-limited and never evaluated: a path can only walk own properties of parsed JSON.
 */
export type PathToken = { key: string } | { index: number } | { select: { key: string; value: string } };

export const MAX_PATH_LENGTH = 160;
export const MAX_PATH_TOKENS = 12;
export const MAX_ARRAY_INDEX = 9999;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SELECT_VALUE = /^[A-Za-z0-9 _.-]{1,64}$/;

/** Cheap syntax screen used by the tool schema; the real parse below is authoritative. */
export const PATH_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]{1,80}\]|\.(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+))*$/;

export function parseEvidencePath(path: string): PathToken[] | undefined {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || !PATH_SHAPE.test(path)) return;
  const tokens: PathToken[] = [];
  let i = 0;
  const first = /^[A-Za-z_][A-Za-z0-9_]*/.exec(path)!;
  tokens.push({ key: first[0] });
  i = first[0].length;
  while (i < path.length) {
    if (tokens.length >= MAX_PATH_TOKENS) return;
    if (path[i] === '.') {
      const m = /^\.([A-Za-z_][A-Za-z0-9_]*|[0-9]+)/.exec(path.slice(i));
      if (!m) return;
      tokens.push(/^[0-9]+$/.test(m[1]!) ? toIndex(m[1]!) ?? ({ key: '' }) : { key: m[1]! });
      i += m[0].length;
    } else if (path[i] === '[') {
      const close = path.indexOf(']', i);
      if (close < 0) return;
      const inner = path.slice(i + 1, close);
      if (/^[0-9]+$/.test(inner)) tokens.push(toIndex(inner) ?? ({ key: '' }));
      else {
        const eq = inner.indexOf('=');
        const key = inner.slice(0, eq), value = inner.slice(eq + 1);
        if (eq < 1 || !IDENT.test(key) || !SELECT_VALUE.test(value)) return;
        tokens.push({ select: { key, value } });
      }
      i = close + 1;
    } else return;
  }
  if (tokens.some((t) => 'key' in t && t.key === '')) return; // an over-large index
  return tokens;
}
function toIndex(digits: string): { index: number } | undefined {
  const n = Number(digits);
  return digits.length <= 5 && n <= MAX_ARRAY_INDEX ? { index: n } : undefined;
}

export type Resolved = { exists: true; value: unknown } | { exists: false; reason?: string };

/** Walks own properties only. A `[key=value]` selector must match exactly one element, otherwise the path is unusable (never guessed). */
export function resolveEvidencePath(root: unknown, tokens: readonly PathToken[]): Resolved {
  let cur: unknown = root;
  for (const t of tokens) {
    if ('key' in t) {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, t.key)) return { exists: false };
      cur = (cur as Record<string, unknown>)[t.key];
    } else if ('index' in t) {
      if (!Array.isArray(cur) || t.index >= cur.length) return { exists: false };
      cur = cur[t.index];
    } else {
      if (!Array.isArray(cur)) return { exists: false };
      const hits = cur.filter((e) => e && typeof e === 'object' && !Array.isArray(e) && Object.prototype.hasOwnProperty.call(e, t.select.key) && String((e as Record<string, unknown>)[t.select.key]) === t.select.value);
      if (hits.length === 0) return { exists: false, reason: `no element with ${t.select.key}=${t.select.value}` };
      if (hits.length > 1) return { exists: false, reason: `${hits.length} elements have ${t.select.key}=${t.select.value}; select by index instead` };
      cur = hits[0];
    }
  }
  return { exists: true, value: cur };
}

export type Primitive = string | number | boolean | null;
const isPrimitive = (v: unknown): v is Primitive => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const numEq = (a: unknown, b: number, tolerance: number | undefined) => typeof a === 'number' && Number.isFinite(a) && (tolerance !== undefined ? Math.abs(a - b) <= tolerance : a === b);
const hexToRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
export const MAX_EXPECTED_ITEMS = 16;
/** Default colour tolerance: Blender reports colours rounded to 3 decimals. */
export const COLOR_TOLERANCE = 0.002;

/**
 * Compares an observed read-back value with the expected one.
 *  - primitives: exact, or within `tolerance` for numbers
 *  - an array of primitives: same length, element by element (numbers within `tolerance`)
 *  - "#rrggbb" against a colour array of at least 3 numbers: the first three channels (0..1) within `tolerance` (default 0.002)
 * Anything else (objects, nested arrays, length mismatch) does not match.
 */
export function compareEvidence(observed: unknown, expected: Primitive | Primitive[], tolerance: number | undefined): boolean {
  if (Array.isArray(expected)) {
    if (expected.length === 0 || expected.length > MAX_EXPECTED_ITEMS || !Array.isArray(observed) || observed.length !== expected.length) return false;
    return expected.every((want, i) => typeof want === 'number' ? numEq(observed[i], want, tolerance) : isPrimitive(observed[i]) && observed[i] === want);
  }
  if (typeof expected === 'string' && /^#[0-9a-fA-F]{6}$/.test(expected) && Array.isArray(observed) && observed.length >= 3 && observed.slice(0, 3).every((c) => typeof c === 'number')) {
    const want = hexToRgb(expected);
    return want.every((w, i) => numEq(observed[i], w, tolerance ?? COLOR_TOLERANCE));
  }
  if (typeof expected === 'number') return numEq(observed, expected, tolerance);
  return observed === expected;
}

/** Bounded copy of an observed value for the tool result and the check record. */
export function summarizeObserved(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= 400) return value;
  return Array.isArray(value) ? { type: 'array', length: value.length, note: 'too large to show; select a smaller part' } : { type: typeof value, note: 'too large to show; select a smaller part' };
}

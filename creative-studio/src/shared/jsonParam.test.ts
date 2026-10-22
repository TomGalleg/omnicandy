import { describe, expect, it } from 'vitest';
import { JSON_PARAM_HARD_MAX_CHARS, normalizeJsonParam } from './jsonParam';

const deep = (n: number): unknown => { let v: unknown = 1; for (let i = 0; i < n; i++) v = { a: v }; return v; };

describe('bounded JSON parameters', () => {
  it('accepts JSON text or an object and returns one canonical string (sorted keys, no whitespace)', () => {
    const a = normalizeJsonParam({ b: 2, a: { d: 1, c: [3, { z: 1, y: 2 }] } }, 'spec');
    const b = normalizeJsonParam('{ "a": {"c": [3, {"y": 2, "z": 1}], "d": 1}, "b": 2 }', 'spec');
    expect(a).toMatchObject({ ok: true, text: '{"a":{"c":[3,{"y":2,"z":1}],"d":1},"b":2}' });
    expect(b).toEqual(a);
  });
  it('rejects malformed JSON, scalars and non-JSON values', () => {
    for (const bad of ['{nope', '', 'null', '5', '"x"', 5, null, undefined, true]) expect(normalizeJsonParam(bad, 'spec').ok, String(bad)).toBe(false);
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    expect(normalizeJsonParam(cyc, 'spec').ok).toBe(false);
  });
  it('enforces size, depth and node limits, with the hard limits above whatever a command asks for', () => {
    expect(normalizeJsonParam({ t: 'x'.repeat(300) }, 'spec', { maxChars: 100 })).toMatchObject({ ok: false, error: expect.stringMatching(/at most 100/) });
    expect(normalizeJsonParam('{"t":"' + 'x'.repeat(300) + '"}', 'spec', { maxChars: 100 }).ok).toBe(false);
    expect(normalizeJsonParam(deep(3), 'spec', { maxDepth: 3 }).ok).toBe(true);
    expect(normalizeJsonParam(deep(4), 'spec', { maxDepth: 3 })).toMatchObject({ ok: false, error: expect.stringMatching(/levels deep/) });
    expect(normalizeJsonParam(deep(500), 'spec', { maxDepth: 9999 }).ok).toBe(false); // hard depth cap; no stack overflow
    expect(normalizeJsonParam({ t: 'x'.repeat(JSON_PARAM_HARD_MAX_CHARS) }, 'spec', { maxChars: 10_000_000 }).ok).toBe(false);
    expect(normalizeJsonParam({ a: Array.from({ length: 30_000 }, () => 0) }, 'spec', { maxChars: 64_000 })).toMatchObject({ ok: false });
  });
  it('refuses prototype-pollution keys at any depth', () => {
    expect(normalizeJsonParam('{"a":{"__proto__":{"x":1}}}', 'spec')).toMatchObject({ ok: false, error: expect.stringMatching(/__proto__/) });
    expect(normalizeJsonParam({ a: [{ constructor: 1 }] }, 'spec').ok).toBe(false);
  });
});

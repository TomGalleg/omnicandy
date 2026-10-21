import { describe, expect, it } from 'vitest';
import { normalizeNativeParameters, validateNormalizedNative } from './nativeSchemaNormalizer';

/** Actual CLI declarations preserved in the Patch 7 handoff's four JSON catalog excerpts.
 * These fixtures are *samples*, NOT all 2,650 commands. No application is launched.
 */
const samples = [
  {app: 'PhotoCraft', id: 'file.new', raw: '{"width":1..300000=1920,"height":1..300000=1080 (pixel counts are rounded),"mode":"rgb|gray|grayscale|cmyk|lab"="rgb","depth":8|16|32=8,"background":"white|black|backgroundColor|transparent|#rrggbb"="white","backgroundColor":[r,g,b]? (0..1; defaults to toolbox colour),"resolution":1..30000=72 (ppi),"name":str}'},
  {app: 'PhotoCraft', id: 'edit.undo', raw: '{}'},
  {app: 'CADCraft', id: 'audit', raw: '{fix?: bool} → {errors, fixed, issues: [{kind, location, handle?, message, fix}], message}'},
  {app: 'CADCraft', id: 'saveas', raw: '{path, version?: 2000|2004|2007|2010|2013|2018, binary?: bool}'},
  {app: 'CADCraft', id: 'close', raw: '{index?}'},
  {app: 'CADCraft', id: 'open', raw: '{path} | {data: base64, name} → {index, entities?, warnings: what reading left out}'},
  {app: 'CADCraft', id: 'mtext', raw: '{at, text, height?, width?, attach?: 1..9 | justify?: TL..BR, rotation?, style?, lineSpacing?, lineSpacingExact?, list?: bullet|number|lower|upper, indent?, firstIndent?, rightIndent?, tabs?: [..], align?: left|center|right|justify|distributed, columns?: {type: static|dynamic, count?, gutter?, height, heights?, reversed?}} (indents and tabs in text heights; width = one column)'},
] as const;

type Classification = 'fully-understood' | 'partially-understood' | 'unsupported';
function classify(raw: unknown): Classification {
  const parsed = normalizeNativeParameters(raw);
  if (!parsed || !parsed.complete) return 'unsupported';
  const hasUnknown = (rules: typeof parsed.properties): boolean => Object.values(rules).some(rule =>
    rule.type === 'unknown' || (rule.type === 'object' && !!rule.properties && hasUnknown(rule.properties)));
  return hasUnknown(parsed.properties) ? 'partially-understood' : 'fully-understood';
}
function check(raw: unknown, values: Record<string, unknown>): string | undefined {
  const schema = normalizeNativeParameters(raw);
  if (!schema) return 'schema unavailable or malformed. Do not execute.';
  return validateNormalizedNative(schema, values, 'audit.sample');
}

describe('7D: read-only real-command schema probes', () => {
  it('classifies sample coverage without claiming full-catalog coverage', () => {
    const results = samples.map(s => ({ app: s.app, id: s.id, state: classify(s.raw) }));
    expect(results).toHaveLength(7);
    expect(results.find(r => r.id === 'open')?.state).toBe('unsupported');
    expect(results.find(r => r.id === 'edit.undo')?.state).toBe('fully-understood');
    expect(results.find(r => r.id === 'close')?.state).toBe('partially-understood');
    // Intentional: no assertion about a global compatibility percentage.
  });
  it('enforces real PhotoCraft ranges and enums', () => {
    const raw = samples[0].raw;
    expect(check(raw, {width: 1280, depth: 16, name: 'Example'})).toMatch(/Missing required|Do not execute/);
    expect(check(raw, {width: -1})).toMatch(/at least 1/);
    expect(check(raw, {depth: 24})).toMatch(/one of/);
    expect(check(raw, {notAParameter: true})).toMatch(/Unknown parameter/);
  });
  it('enforces actual CADCraft union and boolean inputs', () => {
    const raw = samples[2].raw;
    expect(check(raw, {fix: true})).toBeUndefined();
    expect(check(raw, {fix: 'true'})).toMatch(/boolean/);
    expect(check(raw, {surprise: 1})).toMatch(/Unknown parameter/);
  });
  it('does not mistake parameter-free real commands for schema failures', () => {
    expect(check(samples[1].raw, {})).toBeUndefined();
    expect(check(samples[1].raw, {mystery: 1})).toMatch(/Unknown parameter/);
  });
  it('does not claim unknown-type parameters are validated', () => {
    const raw = samples[4].raw;
    expect(check(raw, {})).toBeUndefined();
    expect(check(raw, {index: 2})).toMatch(/Do not execute/);
  });
  it('refuses actual alternative input branches rather than selecting one', () => {
    const raw = samples[5].raw;
    expect(check(raw, {path: 'temp.dxf'})).toMatch(/Do not execute/);
    expect(check(raw, {data: 'YQ==', name: 'temp.dxf'})).toMatch(/Do not execute/);
  });
  it('checks nested or prose-heavy real declaration conservatively', () => {
    const raw = samples[6].raw;
    expect(check(raw, {columns: {type: 'static', count: 2}})).toMatch(/Do not execute|Missing required/);
    expect(check(raw, {madeUp: true})).toMatch(/Unknown parameter|Do not execute/);
  });
});

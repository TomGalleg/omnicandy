import { describe, expect, it } from 'vitest';
import { normalizeNativeParameters, validateNormalizedNative } from './nativeSchemaNormalizer';
import { validateNativeCommandDetail } from './nativeCommandValidation';

describe('real Craft schema normalization', () => {
  const check = (raw: string, params: Record<string, unknown>) => {
    const schema = normalizeNativeParameters(raw);
    expect(schema).not.toBeNull();
    return validateNormalizedNative(schema!, params, 'test.command');
  };
  it('validates PhotoCraft actual depth union and ranges', () => {
    const raw = '{"depth":8|16|32=8,"brightness":-150..150=0,"legacy":bool=false}';
    expect(check(raw, {depth:16,brightness:20})).toBeUndefined();
    expect(check(raw, {})).toBeUndefined();
    expect(check(raw, {depth:24})).toMatch(/one of/);
    expect(check(raw, {brightness:99999})).toMatch(/at most 150/);
    expect(check(raw, {nonexistent:1})).toMatch(/Unknown parameter/);
  });
  it('handles quoted enum values and trailing result documentation', () => {
    const raw = '{"mode":"rgb|gray|cmyk"="rgb","opacity":0..100=100} → {changed, offset}';
    expect(check(raw, { mode: 'gray', opacity: 40 })).toBeUndefined();
    expect(check(raw, { mode: 'wrong' })).toMatch(/one of/);
  });
  it('preserves nested object and array boundaries in discovery', () => {
    const raw = '{size?: [w,h] pt, layout?: {columns?: n, spacing?: pt=20}, blank?: bool}';
    const schema = normalizeNativeParameters(raw)!;
    expect(Object.keys(schema.properties)).toEqual(['size','layout','blank']);
    expect(check(raw, {layout:{columns:3}})).toBeUndefined();
  });
  it('rejects unknown supplied values and ambiguous grammar rather than guessing', () => {
    expect(check('{pattern:id|name,opacity:0..100=100}', { pattern: ['bad'] })).toMatch(/must be|unsupported schema/);
    expect(check('{pattern:id|name,opacity:0..100=100}', {opacity:25})).toContain('Missing required parameter "pattern"');
    expect(check('{bogus: completely custom syntax}', {bogus:123})).toMatch(/unsupported schema/);
  });
  it('routes complete JSON detail through shared normalizer', () => {
    const detail = JSON.stringify({id:'file.new',params:'{"depth":8|16|32=8}'});
    expect(validateNativeCommandDetail(detail,'file.new',{depth:32})).toBeUndefined();
    expect(validateNativeCommandDetail(detail,'file.new',{depth:24})).toMatch(/one of/);
  });
});

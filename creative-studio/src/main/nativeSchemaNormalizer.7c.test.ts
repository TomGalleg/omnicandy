import { describe, expect, it } from 'vitest';
import { normalizeNativeParameters, validateNormalizedNative } from './nativeSchemaNormalizer';

function check(raw: unknown, params: Record<string, unknown>) {
  const schema = normalizeNativeParameters(raw);
  expect(schema).not.toBeNull();
  return validateNormalizedNative(schema!, params, 'test.nested');
}

describe('7C conservative nested object validation', () => {
  it('validates nested compact parameter declarations', () => {
    const spec = '{artboardLayout?: {layout?: "row"|"column", spacing?: 0..72}}';
    expect(check(spec, { artboardLayout: {layout: 'row', spacing: 20} })).toBeUndefined();
    expect(check(spec, { artboardLayout: {layout: 'diagonal'} })).toMatch(/one of/);
    expect(check(spec, { artboardLayout: {spacing: 100} })).toMatch(/at most 72/);
    expect(check(spec, { artboardLayout: {surprise: true} })).toMatch(/Unknown parameter/);
  });
  it('validates structured nested JSON schema', () => {
    const schema = {type:'object', properties:{settings:{type:'object', properties:{quality:{type:'integer', minimum:1, maximum:5}}, required:['quality'], additionalProperties:false}}};
    expect(check(schema, {settings:{quality:4}})).toBeUndefined();
    expect(check(schema, {settings:{quality:1.5}})).toMatch(/integer/);
    expect(check(schema, {settings:{}})).toMatch(/Missing required/);
    expect(check(schema, {settings:{quality:4, mystery:true}})).toMatch(/Unknown parameter/);
  });
  it('does not treat ambiguous alternatives as valid', () => {
    expect(check('{path} | {data: base64, name}', {path:'x'})).toMatch(/Do not execute/);
    expect(check('{settings?: {layout?: row|column, ...}}', {settings:{layout:'row'}})).toMatch(/Do not execute/);
  });
});

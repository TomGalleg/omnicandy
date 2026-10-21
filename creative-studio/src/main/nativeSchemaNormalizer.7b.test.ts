import { describe, expect, it } from 'vitest';
import { normalizeNativeParameters, validateNormalizedNative } from './nativeSchemaNormalizer';

function validate(raw: string, args: Record<string, unknown>) {
  const schema = normalizeNativeParameters(raw);
  expect(schema).not.toBeNull();
  return validateNormalizedNative(schema!, args, 'sample.command');
}

describe('Patch 7B actual Craft CLI syntax', () => {
  it('handles CADCraft optional bare fields without blindly validating their values', () => {
    expect(validate('{index?}', {})).toBeUndefined();
    expect(validate('{index?}', { index: 5 })).toMatch(/unsupported schema/);
    expect(validate('{path}', {})).toMatch(/Missing required parameter/);
    expect(validate('{path}', { path: 'file.dxf' })).toMatch(/unsupported schema/);
  });
  it('accepts omitted optional values alongside enforceable numeric ranges', () => {
    const raw = '{axis: horizontal|vertical, ref?: 0..8 (reference point of the selection bounds, default 4: centre), ids?}';
    expect(validate(raw, { axis: 'horizontal', ref: 4 })).toBeUndefined();
    expect(validate(raw, { axis: 'diagonal' })).toMatch(/one of/);
    expect(validate(raw, { axis: 'vertical', ref: 50 })).toMatch(/at most/);
    expect(validate(raw, { axis: 'vertical', ids: [1] })).toMatch(/unsupported schema/);
  });
  it('safely handles named fields with parenthetical documentation', () => {
    expect(validate('{angle (degrees), ref?: 0..8 (reference point), ids?}', { ref: 2 })).toMatch(/Missing required parameter/);
    expect(validate('{angle (degrees), ref?: 0..8 (reference point), ids?}', { angle: 30 })).toMatch(/unsupported schema/);
  });
  it('does not accept ambiguous alternatives or malformed bare fields', () => {
    const schema = normalizeNativeParameters('{path} | {data: base64, name} → {index}');
    expect(schema).not.toBeNull();
    expect(validateNormalizedNative(schema!, {path:'x'}, 'sample.command')).toMatch(/Do not execute|unsupported schema/);
    expect(validate('{name?|title?: document name}', {title:'x'})).toMatch(/Do not execute/);
  });
  it('fails closed when an uppercase placeholder appears among real parameters', () => {
    expect(validate('{"brightness":-150..150=0,BOGUS}', {brightness:20})).toMatch(/incomplete parameter schema.*Do not execute/);
    expect(validate('{"brightness":-150..150=0,BOGUS}', {})).toMatch(/incomplete parameter schema.*Do not execute/);
  });
});

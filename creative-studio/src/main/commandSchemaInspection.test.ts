import { describe, expect, it } from 'vitest';
import { inspectNativeSchema, inspectExternalSchema } from './commandSchemaInspection';

describe('shared read-only schema inspection', () => {
  it('provides typed information with raw DSL preserved', () => {
    const raw = '{"opacity":0..100=100,"mode":normal|multiply}';
    const result = inspectNativeSchema(raw);
    expect(result.status).toBe('complete');
    expect(result.raw).toBe(raw);
    expect(result.fields.opacity).toMatchObject({ type: 'number', min: 0, max: 100 });
  });
  it('retains incomplete input alternatives rather than pretending to validate them', () => {
    const raw = '{path} | {data: base64, name}';
    expect(inspectNativeSchema(raw)).toMatchObject({ status: 'unavailable', raw });
  });
  it('marks bare unknown native input fields partially understood', () => {
    expect(inspectNativeSchema('{index?}').status).toBe('partial');
  });
  it('preserves external adapter parameters without granting any authorization', () => {
    const result = inspectExternalSchema({ id: 'test', label: 'Test', description: '', permissions: [], params: { count: { type: 'number', description: 'Count', required: true, min: 1 } } } as Parameters<typeof inspectExternalSchema>[0]);
    expect(result).toMatchObject({ status: 'complete', fields: { count: { type: 'number', min: 1 } } });
  });
});

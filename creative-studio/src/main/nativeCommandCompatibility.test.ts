import { describe, expect, it } from 'vitest';
import { validateNativeCommandDetail as validate } from './nativeCommandValidation';

/**
 * Offline contract tests for the shared validator. These schemas are synthetic,
 * representative fixtures, NOT captured CLI output from installed Craft apps.
 * A passing test does not establish live compatibility with any particular app.
 */
const apps = [
  'PhotoCraft', 'VectorCraft', 'EffectCraft', 'LightCraft', 'DesignCraft',
  'SoundCraft', 'FilmCraft', 'WordCraft', 'PDFCraft', 'GridCraft',
  'DeckCraft', 'FigCraft', 'CADCraft',
] as const;

const variants = [
  (id: string) => JSON.stringify({ id, params: '{"amount":-10..10=0,"enabled":bool=false}' }),
  (id: string) => JSON.stringify({ id, params: { amount: '-10..10=0', enabled: 'bool=false' } }),
  (id: string) => JSON.stringify({ id, parameters: { amount: { type: 'number', minimum: -10, maximum: 10 }, enabled: { type: 'boolean' } } }),
  (id: string) => JSON.stringify({ id, inputSchema: { type: 'object', properties: { amount: { type: 'number', minimum: -10, maximum: 10 }, enabled: { type: 'boolean' } }, required: [] } }),
] as const;

describe('13 Craft applications: synthetic shared-schema compatibility', () => {
  it.each(apps)('%s follows identical local validation rules for representative schemas', (_app) => {
    const id = 'test.adjust';
    for (const makeDetail of variants) {
      const detail = makeDetail(id);
      expect(validate(detail, id, { amount: 5, enabled: true })).toBeUndefined();
      expect(validate(detail, id, {})).toBeUndefined();
      expect(validate(detail, id, { amount: 99999 })).toContain('at most 10');
      expect(validate(detail, id, { amount: -99999 })).toContain('at least -10');
      expect(validate(detail, id, { enabled: 'true' })).toContain('must be boolean');
      expect(validate(detail, id, { unexpected: 1 })).toContain('Unknown parameter');
      expect(validate(detail, 'test.other', {})).toContain('ID mismatch');
    }
  });

  it('rejects unsupported or malformed schemas instead of executing', () => {
    const id = 'test.adjust';
    for (const params of [null, 'not-a-schema', '{"amount":unknown}', ['amount'], { amount: { type: 'file' } }]) {
      const result = validate(JSON.stringify({ id, params }), id, { amount: 1 });
      expect(result, `params=${JSON.stringify(params)}`).toBeTruthy();
    }
  });

  it('rejects non-finite numeric inputs locally', () => {
    const id = 'test.adjust';
    const detail = variants[1](id);
    expect(validate(detail, id, { amount: Number.NaN })).toContain('finite number');
    expect(validate(detail, id, { amount: Infinity })).toContain('finite number');
  });

  it('honors required fields when supplied as JSON Schema', () => {
    const id = 'test.required';
    const detail = JSON.stringify({ id, inputSchema: { type: 'object', properties: { amount: { type: 'number', minimum: 0 } }, required: ['amount'] } });
    expect(validate(detail, id, {})).toContain('Missing required');
    expect(validate(detail, id, { amount: 1 })).toBeUndefined();
  });
});

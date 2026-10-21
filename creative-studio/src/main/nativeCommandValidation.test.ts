import { describe, expect, it } from 'vitest';
import { validateNativeCommandDetail as validate } from './nativeCommandValidation';
const detail = JSON.stringify({id:'image.adjustments.brightnessContrast',params:{brightness:'-150..150=0',contrast:'-50..100=0',legacy:'bool=false'}});
describe('native command schema execution guard', () => {
  it('rejects out-of-range inputs', () => expect(validate(detail,'image.adjustments.brightnessContrast',{brightness:99999})).toContain('at most 150'));
  it('rejects unknown parameters', () => expect(validate(detail,'image.adjustments.brightnessContrast',{nonexistent:1})).toContain('Unknown parameter'));
  it('rejects wrong types', () => expect(validate(detail,'image.adjustments.brightnessContrast',{legacy:'yes'})).toContain('must be boolean'));
  it('accepts valid parameters', () => expect(validate(detail,'image.adjustments.brightnessContrast',{brightness:25,contrast:0,legacy:false})).toBeUndefined());
  it('rejects incomplete or mismatched schema', () => {
    expect(validate('applied','image.adjustments.brightnessContrast',{})).toContain('not structured JSON');
    expect(validate(JSON.stringify({id:'wrong',params:{}}),'image.adjustments.brightnessContrast',{})).toContain('ID mismatch');
  });
});

// Use the actual PhotoCraft CLI shape, not just an object with rule strings.
describe('PhotoCraft compact params text', () => {
  const compact = JSON.stringify({id:'image.adjustments.brightnessContrast', params:'{"brightness":-150..150=0,"contrast":-50..100=0,"legacy":bool=false}'});
  const id = 'image.adjustments.brightnessContrast';
  it('accepts valid inputs and omitted optional defaults', () => {
    expect(validate(compact,id,{brightness:20})).toBeUndefined();
    expect(validate(compact,id,{})).toBeUndefined();
  });
  it('rejects out-of-range, unknown, and wrong-type inputs', () => {
    expect(validate(compact,id,{brightness:99999})).toContain('at most 150');
    expect(validate(compact,id,{nonexistent:1})).toContain('Unknown parameter');
    expect(validate(compact,id,{legacy:'false'})).toContain('must be boolean');
  });
  it('fails closed for malformed or ambiguous compact schemas', () => {
    for (const params of ['{"brightness":mystery=0}', '{"brightness":-150..150=0,BOGUS}', '{"brightness":-150..150=0,"brightness":-5..5=0}', 'anything']) {
      expect(validate(JSON.stringify({id,params}),id,{brightness:20})).toMatch(/unsupported schema|incomplete parameter schema|parameter schema unavailable or malformed/);
    }
  });
});

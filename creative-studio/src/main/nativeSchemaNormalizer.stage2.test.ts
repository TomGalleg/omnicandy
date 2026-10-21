import { describe, it, expect } from 'vitest';
import { preflightNativeCommand } from './nativeCommandPreflight';
const assess = (schema: unknown, params: Record<string, unknown>) => preflightNativeCommand(JSON.stringify({id:'example', inputSchema:schema}), 'example', params);
describe('Stage 2 conservative structured-schema preflight', () => {
  it('enforces JSON schema required, enum and numeric bounds', () => {
    const schema={type:'object', required:['size'], properties:{size:{type:'integer',minimum:1,maximum:10}, mode:{type:'string',enum:['a','b']}}};
    expect(assess(schema,{size:2}).status).toBe('validated');
    expect(assess(schema,{size:0}).status).toBe('rejected');
    expect(assess(schema,{size:2,mode:'c'}).status).toBe('rejected');
    expect(assess(schema,{}).status).toBe('rejected');
  });
  it('never claims full validation for unsupported root alternatives', () => {
    expect(assess({oneOf:[{type:'object',properties:{a:{type:'string'}}}]},{a:'ok'}).status).toBe('unavailable');
  });
  it('does not silently accept unimplemented constraints', () => {
    expect(assess({type:'object',properties:{name:{type:'string',minLength:5}}},{name:'a'}).status).toBe('unavailable');
  });
});

describe('Craft schema delimiter handling', () => {
  it('preserves dx/dy descriptions containing commas inside parentheses', () => {
    const detail = JSON.stringify({id:'edit.transform',params:'{"layer":id?, "dx":number (horizontal, pixels), "dy":number (vertical, pixels)}'});
    const out = preflightNativeCommand(detail,'edit.transform',{dx:100,dy:50});
    expect(out.status).not.toBe('rejected');
  });
});

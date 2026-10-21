import { describe, expect, it } from 'vitest';
import type { CommandSpec } from '@shared/integrations';
import { preflightExternalParams, classifyCommandError } from './commandPreflight';
const cmd = { id:'shape', label:'Shape', description:'', permissions:[], params: {
  radius: {type:'number', description:'', required:true, min:5, max:200},
  fill: {type:'boolean', description:'', default:true},
  name: {type:'string', description:''},
} } satisfies CommandSpec;
describe('external fast-fail validation', () => {
  it('checks unknown and missing parameters locally', () => {
    expect(preflightExternalParams(cmd, { extra:2 })).toContain('Unknown parameter');
    expect(preflightExternalParams(cmd, {})).toContain('Missing required');
  });
  it('uses the same numeric bounds and basic types as the manager', () => {
    expect(preflightExternalParams(cmd, {radius:4})).toContain('at least 5');
    expect(preflightExternalParams(cmd, {radius:201})).toContain('at most 200');
    expect(preflightExternalParams(cmd, {radius:'10',fill:false})).toBeUndefined();
    expect(preflightExternalParams(cmd, {radius:10,fill:'false'})).toContain('true or false');
  });
  it('classifies failures conservatively', () => {
    expect(classifyCommandError('permission-denied')).toBe('permission');
    expect(classifyCommandError('Unknown parameter')).toBe('validation');
    expect(classifyCommandError('Application disconnected')).toBe('unavailable');
    expect(classifyCommandError('Unknown failure')).toBe('execution');
  });
});

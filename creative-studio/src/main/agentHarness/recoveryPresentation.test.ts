import { describe, it, expect } from 'vitest';
import { recoveryPresentation } from './recoveryPresentation';
import type { EditIntent } from './editIntentJournal';

const intent: EditIntent = {
  version:1, id:'123e4567-e89b-42d3-a456-426614174000', goal:'Edit ellipse',
  tool:'app_command',command:'shape.edit',startedAt:'2026-10-21T12:00:00.000Z',
  expected:{kind:'photocraft.shape.edit.rect',layer:33,rect:[300,400,150,150]},
};
describe('recovery status presentation',()=>{
  it('shows recorded target, exact intent and timestamp without the goal',()=>{
    const info=recoveryPresentation(intent);
    expect(info?.status).toBe('unresolved');
    expect(info?.expected).toEqual(intent.expected);
    expect(info?.command).toBe('shape.edit');
    expect(JSON.stringify(info)).not.toContain('Edit ellipse');
    expect(info?.message).toContain('not verified');
  });
  it('never reports an unreadable journal as clear',()=>{
    expect(recoveryPresentation(null,true)?.status).toBe('unreadable');
    expect(recoveryPresentation(null)).toBeUndefined();
  });
  it('does not invent expected results for unsupported commands',()=>{
    const info=recoveryPresentation({...intent,expected:undefined,command:'some.edit'});
    expect(info?.expected).toBeUndefined();
    expect(info?.status).toBe('unresolved');
  });
});

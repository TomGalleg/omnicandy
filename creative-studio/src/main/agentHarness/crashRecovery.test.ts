import { describe, expect, it } from 'vitest';
import { recoveryNotice, resumeFailureNotice } from './crashRecovery';
import type { EditIntent } from './editIntentJournal';
import type { TaskCheckpoint } from './taskCheckpoint';
const intent: EditIntent = {version:1,id:'db9605e3-8c48-4cbe-bd19-5d9e93bdc108',tool:'app_command',command:'shape.edit',goal:'Poster',startedAt:'2026-10-21T12:00:00Z'};
const task: TaskCheckpoint = {goal:'Poster',model:'gpt-4.1-mini',status:'limit',messages:[{role:'user',content:'Poster'}]};
describe('unresolved edit recovery presentation',()=>{
  it('shows how to continue an interrupted saved task',()=>{expect(recoveryNotice(intent,task)).toContain('Continue Task');});
  it('does not suggest a blind restart when no checkpoint exists',()=>{const message=recoveryNotice(intent,null);expect(message).toContain('without a resumable task');expect(message).toContain('Editing remains blocked');expect(message).not.toContain('Continue Task');});
  it('shows no recovery warning with no journal',()=>{expect(recoveryNotice(null,task)).toBeNull();});
});

describe('IPC resume failure recovery decision',()=>{
  it('retains a resumable continuation and warns against replay after a journaled edit',()=>{
    const notice = resumeFailureNotice('Provider disconnected',true);
    expect(notice).toContain('Continue Task');
    expect(notice).toContain('reconcile');
    expect(notice).toContain('may already have changed');
  });
  it('retains the prior checkpoint even for provider failures without a pending edit',()=>{
    const notice = resumeFailureNotice('Model unavailable',false);
    expect(notice).toContain('saved task remains available');
    expect(notice).toContain('inspect current state');
  });
});

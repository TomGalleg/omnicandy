import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { restoreRecoveryState } from './crashRecovery';
import { TaskCheckpointStore, type CheckpointCrypto } from './taskCheckpoint';
import { EditIntentJournal } from './editIntentJournal';

const dirs:string[]=[];
// Test-only reversible cipher, never used as production encryption.
const crypto:CheckpointCrypto = {
  isEncryptionAvailable:()=>true,
  encryptString:s=>Buffer.from(s).reverse(),
  decryptString:b=>Buffer.from(b).reverse().toString('utf8'),
};
async function stores() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'omnicandy-restore-'));
  dirs.push(root);
  return {root, task:new TaskCheckpointStore(root,crypto), journal:new EditIntentJournal(root,crypto)};
}
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>fs.rm(dir,{recursive:true,force:true})));});

const checkpoint = {goal:'Move ellipse',model:'gpt-4.1-mini',status:'limit' as const,
  messages:[{role:'user' as const,content:'Move ellipse'}]};

describe('IPC recovery restoration via encrypted project stores',()=>{
  it('restores the intended target from both persisted files after simulated restart',async()=>{
    const {root,task,journal}=await stores();
    expect(await task.save(checkpoint)).toBe(true);
    await journal.begin('Move ellipse','app_command','shape.edit',
      {command:'shape.edit',params:{layer:33,rect:[300,400,150,150]}});
    const restored=await restoreRecoveryState(new TaskCheckpointStore(root,crypto),new EditIntentJournal(root,crypto));
    expect(restored.kind).toBe('task');
    if(restored.kind!=='task')return;
    expect(restored.uncertainEdit).toContain('shape.edit');
    expect(restored.intent?.expected).toEqual({kind:'photocraft.shape.edit.rect',layer:33,rect:[300,400,150,150]});
    expect(restored.notice).toContain('Continue Task');
  });
  it('fails closed if journal exists without checkpoint',async()=>{
    const {root,journal}=await stores();
    await journal.begin('Move ellipse','app_command','shape.edit');
    const restored=await restoreRecoveryState(new TaskCheckpointStore(root,crypto),new EditIntentJournal(root,crypto));
    expect(restored.kind).toBe('orphan');
    if(restored.kind==='orphan')expect(restored.notice).toContain('Editing remains blocked');
  });
  it('fails closed on an unreadable encrypted journal even with valid checkpoint',async()=>{
    const {root,task,journal}=await stores();
    expect(await task.save(checkpoint)).toBe(true);
    await journal.begin('Move ellipse','app_command','shape.edit');
    await fs.writeFile(path.join(root,'.omnicandy-edit-intent.enc'),'corrupt');
    const restored=await restoreRecoveryState(new TaskCheckpointStore(root,crypto),new EditIntentJournal(root,crypto));
    expect(restored.kind).toBe('orphan');
  });
  it('restores a paused checkpoint with no outstanding journal',async()=>{
    const {root,task}=await stores();
    expect(await task.save(checkpoint)).toBe(true);
    const restored=await restoreRecoveryState(new TaskCheckpointStore(root,crypto),new EditIntentJournal(root,crypto));
    expect(restored.kind).toBe('task');
    if(restored.kind==='task')expect(restored.intent).toBeNull();
  });
});

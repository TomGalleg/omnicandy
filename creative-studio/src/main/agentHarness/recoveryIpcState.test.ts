import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskCheckpointStore, type CheckpointCrypto } from './taskCheckpoint';
import { EditIntentJournal } from './editIntentJournal';
import { restoreRecoveryState } from './crashRecovery';
import { recoveryIpcState } from './recoveryIpcState';
import type { AgentUiState } from '@shared/agentHarness';

const roots: string[] = [];
const crypto: CheckpointCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(text).reverse(),
  decryptString: bytes => Buffer.from(bytes).reverse().toString('utf8'),
};
const initial: AgentUiState = { status: 'idle', model: 'gpt-4.1-mini', goal: '', result: '', events: [] };
async function stores() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicandy-ipc-recovery-'));
  roots.push(root);
  return { root, task: new TaskCheckpointStore(root, crypto), journal: new EditIntentJournal(root, crypto) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

/** Exercises the exact restore-to-IPC-state conversion used by agentState, with
 * fresh encrypted store instances as if Electron had restarted. No Electron
 * process, application editor, or model is launched. */
describe('Independent AI recovery IPC state hydration', () => {
  it('provides a resumable UI state with the original rectangle intent', async () => {
    const { root, task, journal } = await stores();
    expect(await task.save({ goal: 'Move ellipse', model: 'gpt-4.1-mini', status: 'limit',
      messages: [{ role: 'user', content: 'Move ellipse' }] })).toBe(true);
    await journal.begin('Move ellipse', 'app_command', 'shape.edit',
      { command: 'shape.edit', params: { layer: 33, rect: [300, 400, 150, 150] } });
    const restored = await restoreRecoveryState(new TaskCheckpointStore(root, crypto), new EditIntentJournal(root, crypto));
    const result = recoveryIpcState(restored, initial);
    expect(result.state.status).toBe('limit');
    expect(result.state.recovery?.status).toBe('unresolved');
    expect(result.state.recovery?.expected).toEqual({ kind: 'photocraft.shape.edit.rect', layer: 33, rect: [300, 400, 150, 150] });
    expect(result.paused?.uncertainEdit).toContain('shape.edit');
    expect(result.paused?.messages).toEqual([{ role: 'user', content: 'Move ellipse' }]);
  });
  it('shows a blocked warning when there is a journal but no task', async () => {
    const { root, journal } = await stores();
    await journal.begin('Move ellipse', 'app_command', 'shape.edit');
    const restored = await restoreRecoveryState(new TaskCheckpointStore(root, crypto), new EditIntentJournal(root, crypto));
    const result = recoveryIpcState(restored, initial);
    expect(result.state.status).toBe('failed');
    expect(result.state.recovery?.status).toBe('unreadable');
    expect(result.paused).toBeNull();
  });
  it('does not silently clear an unreadable journal', async () => {
    const { root, task, journal } = await stores();
    expect(await task.save({ goal: 'Move ellipse', model: 'gpt-4.1-mini', status: 'limit',
      messages: [{ role: 'user', content: 'Move ellipse' }] })).toBe(true);
    await journal.begin('Move ellipse', 'app_command', 'shape.edit');
    await fs.writeFile(path.join(root, '.omnicandy-edit-intent.enc'), 'invalid');
    const restored = await restoreRecoveryState(new TaskCheckpointStore(root, crypto), new EditIntentJournal(root, crypto));
    const result = recoveryIpcState(restored, initial);
    expect(result.state.status).toBe('failed');
    expect(result.state.recovery?.status).toBe('unreadable');
    expect(result.paused).toBeNull();
  });
  it('restores a normal paused task without displaying a false recovery warning', async () => {
    const { root, task } = await stores();
    expect(await task.save({ goal: 'Finish poster', model: 'gpt-4.1-mini', status: 'paused',
      messages: [{ role: 'user', content: 'Finish poster' }] })).toBe(true);
    const restored = await restoreRecoveryState(new TaskCheckpointStore(root, crypto), new EditIntentJournal(root, crypto));
    const result = recoveryIpcState(restored, initial);
    expect(result.state.status).toBe('paused');
    expect(result.state.recovery).toBeUndefined();
    expect(result.paused?.goal).toBe('Finish poster');
  });
});

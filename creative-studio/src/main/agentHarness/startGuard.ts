import type { LiveTaskController } from '../liveTask';
import { userControlActive } from './loop';

export interface NewTaskRequest {
  /** An agent run is already in flight in this process. */
  busy: boolean;
  /** Loads the encrypted write-ahead edit journal; a present entry means an edit may be unresolved. */
  loadJournal: () => Promise<unknown>;
  claudeWorking: boolean;
  ctl: LiveTaskController;
  /** A saved (paused / limit) task exists in memory. */
  hasPausedTask: boolean;
  /** Discards the saved task and its checkpoint. Called only after every check passed. */
  reset: () => Promise<void>;
}

/**
 * Gate for starting a NEW Independent AI task. Every rejection happens before `reset`, so a refused Run can never
 * delete or replace the interrupted task or its encrypted checkpoint (Continue Task keeps working after hand-back).
 * Manual-takeover protections are unchanged: user control or a pause still blocks the start.
 */
export async function prepareNewTask(r: NewTaskRequest): Promise<void> {
  if (r.busy) throw new Error('The independent agent is already working.');
  if (await r.loadJournal()) throw new Error('Unresolved edit journal found. Restore and resolve the previous task before starting a new one.');
  if (r.claudeWorking) throw new Error('Stop Claude before starting the independent agent.');
  const c = r.ctl.snapshot().collab;
  if (c.activeOperation || c.phase === 'running') throw new Error('An application task is already running.');
  if (userControlActive(r.ctl)) {
    throw new Error(`The user has control or the task is paused, so a new task cannot start.${r.hasPausedTask ? ' Your interrupted task is kept: hand control back and use Continue Task, or press Cancel task first.' : ''}`);
  }
  await r.reset();
}

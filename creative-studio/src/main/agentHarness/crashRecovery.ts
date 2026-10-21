import type { EditIntent } from './editIntentJournal';
import type { TaskCheckpoint } from './taskCheckpoint';

/** Renderer-safe presentation of a write-ahead edit that cannot yet be reconciled. */
export function recoveryNotice(intent: EditIntent | null, checkpoint: TaskCheckpoint | null): string | null {
  if (!intent) return null;
  const operation = `${intent.tool} (${intent.command})`;
  if (checkpoint) return `An interrupted edit (${operation}) needs reconciliation. Continue Task will inspect the current document; no editing is permitted until a fresh, passing verification resolves the uncertainty.`;
  return `An interrupted edit (${operation}) was found without a resumable task checkpoint. Editing remains blocked. Open and inspect the affected document, and preserve the project and its encrypted journal for recovery. Do not delete the journal or repeat the command.`;
}

/** A thrown resume (network, provider, or journal error) is not a reason to
 * discard a previously persisted task. Preserve it for explicit continuation.
 * Never clear the journal here: an edit may already have reached the app. */
export function resumeFailureNotice(message: string, unresolved: boolean): string {
  const suffix = unresolved
    ? ' An unresolved edit may already have changed the document. Continue Task must inspect and reconcile it before further editing.'
    : ' The saved task remains available through Continue Task; inspect current state before editing.';
  return `Resume interrupted: ${message}.${suffix}`;
}


/** Read the same encrypted project stores used by Electron IPC. Errors in the
 * journal must never turn into an apparently clean restoration. */
export async function restoreRecoveryState(
  taskStore: Pick<import('./taskCheckpoint').TaskCheckpointStore, 'load'>,
  journal: Pick<import('./editIntentJournal').EditIntentJournal, 'load'>,
): Promise<
  | { kind: 'task'; task: TaskCheckpoint; intent: EditIntent | null; uncertainEdit?: string; notice: string }
  | { kind: 'orphan'; notice: string }
  | { kind: 'empty' }
> {
  let intent: EditIntent | null = null;
  let unreadable = false;
  try { intent = await journal.load(); }
  catch { unreadable = true; }
  let task: TaskCheckpoint | null = null;
  try { task = await taskStore.load(); }
  catch { /* An unreadable checkpoint is not a reason to discard a journal. */ }
  if (unreadable) {
    return { kind: 'orphan', notice: 'Edit journal cannot be securely read. Editing remains blocked; preserve the project and journal for review.' };
  }
  if (!task) {
    return intent ? { kind:'orphan', notice:recoveryNotice(intent,null) ?? 'Editing remains blocked.' } : { kind:'empty' };
  }
  const uncertainEdit = intent ? `${intent.tool} (${intent.command})` : task.uncertainEdit;
  return {
    kind:'task', task, intent,
    ...(uncertainEdit ? { uncertainEdit } : {}),
    notice: recoveryNotice(intent,task) ?? 'Task restored from this project. Continue Task will inspect current application state before editing.',
  };
}

// Collaboration lifecycle between Claude and the user on one document.
// Pure reducer: every transition either returns a new state or a rejection reason; it never throws.
//
// Invariants:
//  - At most one actor holds the edit lock.
//  - Claude may only start an operation while Running and holding the lock.
//  - The user may only edit in Manual Control while holding the lock.
//  - Pause / Take Control act at a safe boundary: if an operation is active they wait for it to finish.
//  - Resume after manual control requires a sync; if the document changed on disk, Claude replans.

export type Actor = 'claude' | 'user';

export type CollabPhase =
  | 'idle'
  | 'planning'
  | 'ready'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'manual'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CollabState {
  phase: CollabPhase;
  lockOwner: Actor | null;
  activeOperation: string | null;
  /** Set when Take Control was requested during an active operation. */
  takeoverPending: boolean;
  /** Document version Claude last observed; compared on resume. */
  knownVersion: string | null;
  /** True after manual control until Claude has re-read the document. */
  needsSync: boolean;
  lastMessage: string | null;
}

export type CollabEvent =
  | { type: 'plan' }
  | { type: 'planReady'; version: string }
  | { type: 'start' }
  | { type: 'beginOperation'; opId: string }
  | { type: 'endOperation'; opId: string; ok: boolean; version?: string }
  | { type: 'requestPause' }
  | { type: 'takeControl' }
  | { type: 'userEdit' }
  | { type: 'releaseControl' }
  | { type: 'resume'; diskVersion: string }
  /** Record a version change Claude caused outside an operation (e.g. saving). */
  | { type: 'syncVersion'; version: string }
  | { type: 'requestApproval' }
  | { type: 'approve' }
  | { type: 'reject' }
  | { type: 'complete' }
  | { type: 'cancel' };

export type CollabResult = { ok: true; state: CollabState } | { ok: false; state: CollabState; reason: string };

export const initialCollabState: CollabState = {
  phase: 'idle',
  lockOwner: null,
  activeOperation: null,
  takeoverPending: false,
  knownVersion: null,
  needsSync: false,
  lastMessage: null,
};

const TERMINAL: CollabPhase[] = ['completed', 'failed', 'cancelled'];

export const PHASE_LABEL: Record<CollabPhase, string> = {
  idle: 'Idle',
  planning: 'Planning',
  ready: 'Ready',
  running: 'Running',
  pausing: 'Pausing…',
  paused: 'Paused',
  manual: 'Manual Control',
  awaiting_approval: 'Awaiting Approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function collabReducer(s: CollabState, e: CollabEvent): CollabResult {
  const ok = (patch: Partial<CollabState>, msg?: string): CollabResult => ({
    ok: true,
    state: { ...s, ...patch, lastMessage: msg ?? null },
  });
  const no = (reason: string): CollabResult => ({ ok: false, state: s, reason });

  // Finished tasks accept only a new plan, or you grabbing the edit lock to work by hand.
  if (TERMINAL.includes(s.phase) && e.type !== 'plan' && e.type !== 'takeControl') return no(`Task is ${s.phase}; start a new plan.`);

  switch (e.type) {
    case 'plan':
      if (s.activeOperation) return no('An operation is still running.');
      if (s.phase === 'manual') return no('Release manual control first.');
      return ok({ ...initialCollabState, phase: 'planning', knownVersion: s.knownVersion });
    case 'planReady':
      if (s.phase !== 'planning') return no('Not planning.');
      return ok({ phase: 'ready', knownVersion: e.version, needsSync: false });
    case 'start':
      if (s.phase !== 'ready') return no('Plan is not ready.');
      if (s.lockOwner && s.lockOwner !== 'claude') return no('The user holds the edit lock.');
      return ok({ phase: 'running', lockOwner: 'claude' });
    case 'beginOperation':
      if (s.phase !== 'running') return no(`Cannot start an operation while ${PHASE_LABEL[s.phase]}.`);
      if (s.lockOwner !== 'claude') return no('Claude does not hold the edit lock.');
      if (s.activeOperation) return no('Another operation is active.');
      return ok({ activeOperation: e.opId });
    case 'endOperation': {
      if (s.activeOperation !== e.opId) return no('No such active operation.');
      const version = e.version ?? s.knownVersion;
      if (!e.ok) return ok({ phase: 'failed', activeOperation: null, lockOwner: null, takeoverPending: false, knownVersion: version }, 'Operation failed.');
      if (s.phase === 'pausing') {
        if (s.takeoverPending) {
          return ok({ phase: 'manual', lockOwner: 'user', activeOperation: null, takeoverPending: false, knownVersion: version }, 'Operation finished; you have control.');
        }
        return ok({ phase: 'paused', lockOwner: null, activeOperation: null, knownVersion: version }, 'Paused at a safe boundary.');
      }
      return ok({ activeOperation: null, knownVersion: version });
    }
    case 'requestPause':
      if (s.phase !== 'running') return no('Nothing is running.');
      if (s.activeOperation) return ok({ phase: 'pausing' }, 'Will pause when the current operation finishes.');
      return ok({ phase: 'paused', lockOwner: null }, 'Paused.');
    case 'takeControl':
      if (s.phase === 'manual') return no('You already have control.');
      if (s.activeOperation) return ok({ phase: 'pausing', takeoverPending: true }, 'Handing over after the current operation.');
      return ok({ phase: 'manual', lockOwner: 'user', takeoverPending: false }, 'You have control.');
    case 'userEdit':
      if (s.phase !== 'manual' || s.lockOwner !== 'user') return no('Take control before editing.');
      return ok({ needsSync: true });
    case 'releaseControl':
      if (s.phase !== 'manual') return no('You do not have control.');
      return ok({ phase: 'paused', lockOwner: null, needsSync: true }, 'Control released. Claude will re-sync before resuming.');
    case 'resume':
      if (s.phase !== 'paused') return no('Resume is only possible from Paused.');
      if (e.diskVersion !== s.knownVersion) {
        return ok({ phase: 'planning', needsSync: false, knownVersion: e.diskVersion }, 'Document changed on disk; replanning.');
      }
      return ok({ phase: 'running', lockOwner: 'claude', needsSync: false }, 'Resumed.');
    case 'syncVersion':
      if (s.activeOperation || s.needsSync || s.phase === 'manual') return no('Cannot sync while an operation or manual edit is pending.');
      return { ok: true, state: { ...s, knownVersion: e.version } };
    case 'requestApproval':
      if (s.phase !== 'running' || s.activeOperation) return no('Approval can be requested between operations only.');
      return ok({ phase: 'awaiting_approval' });
    case 'approve':
      if (s.phase !== 'awaiting_approval') return no('Nothing awaiting approval.');
      return ok({ phase: 'running' }, 'Approved.');
    case 'reject':
      if (s.phase !== 'awaiting_approval') return no('Nothing awaiting approval.');
      return ok({ phase: 'paused', lockOwner: null }, 'Rejected; paused for direction.');
    case 'complete':
      if (s.activeOperation) return no('An operation is still running.');
      if (s.phase !== 'running') return no('Not running.');
      return ok({ phase: 'completed', lockOwner: null });
    case 'cancel':
      if (s.activeOperation) return ok({ phase: 'pausing' }, 'Cancelling after the current operation.');
      return ok({ phase: 'cancelled', lockOwner: null, takeoverPending: false });
  }
}

/** Async controller over the reducer, matching the CollaborationController contract. */
export class LocalCollaborationController {
  state: CollabState = initialCollabState;
  dispatch(e: CollabEvent): CollabResult {
    const r = collabReducer(this.state, e);
    this.state = r.state;
    return r;
  }
  private must(e: CollabEvent) {
    const r = this.dispatch(e);
    if (!r.ok) throw new Error(r.reason);
  }
  async requestPause() { this.must({ type: 'requestPause' }); }
  async acquireEditLock(actor: Actor, _documentId: string) {
    if (actor === 'user') this.must({ type: 'takeControl' });
    else if (this.state.lockOwner !== 'claude') this.must({ type: 'start' });
  }
  async releaseEditLock(actor: Actor, _documentId: string) {
    if (actor === 'user') this.must({ type: 'releaseControl' });
    else this.must({ type: 'requestPause' });
  }
  async resumeAfterSync(_documentId: string, diskVersion: string) { this.must({ type: 'resume', diskVersion }); }
}

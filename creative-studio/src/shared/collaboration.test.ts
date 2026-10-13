import { describe, expect, it } from 'vitest';
import { collabReducer, initialCollabState, LocalCollaborationController, type CollabEvent, type CollabState } from './collaboration';

function apply(events: CollabEvent[], from: CollabState = initialCollabState) {
  let s = from;
  const refusals: string[] = [];
  for (const e of events) {
    const r = collabReducer(s, e);
    if (!r.ok) refusals.push(`${e.type}: ${r.reason}`);
    s = r.state;
  }
  return { s, refusals };
}

const running: CollabEvent[] = [{ type: 'plan' }, { type: 'planReady', version: 'v1' }, { type: 'start' }];

describe('collaboration state machine', () => {
  it('follows Planning → Ready → Running → Completed', () => {
    const { s, refusals } = apply([...running, { type: 'beginOperation', opId: 'a' }, { type: 'endOperation', opId: 'a', ok: true, version: 'v2' }, { type: 'complete' }]);
    expect(refusals).toEqual([]);
    expect(s).toMatchObject({ phase: 'completed', lockOwner: null, knownVersion: 'v2' });
  });

  it('pause during an operation waits for the safe boundary', () => {
    const mid = apply([...running, { type: 'beginOperation', opId: 'a' }, { type: 'requestPause' }]).s;
    expect(mid).toMatchObject({ phase: 'pausing', activeOperation: 'a', lockOwner: 'claude' });
    // no new operation may start while pausing
    expect(collabReducer(mid, { type: 'beginOperation', opId: 'b' }).ok).toBe(false);
    const after = apply([{ type: 'endOperation', opId: 'a', ok: true }], mid).s;
    expect(after).toMatchObject({ phase: 'paused', activeOperation: null, lockOwner: null });
  });

  it('take control transfers the lock only after the active operation resolves', () => {
    const mid = apply([...running, { type: 'beginOperation', opId: 'a' }, { type: 'takeControl' }]).s;
    expect(mid).toMatchObject({ phase: 'pausing', takeoverPending: true, lockOwner: 'claude' });
    expect(collabReducer(mid, { type: 'userEdit' }).ok).toBe(false); // user cannot edit yet
    const after = apply([{ type: 'endOperation', opId: 'a', ok: true, version: 'v2' }], mid).s;
    expect(after).toMatchObject({ phase: 'manual', lockOwner: 'user', takeoverPending: false });
  });

  it('prevents simultaneous edits: Claude cannot operate during manual control', () => {
    const manual = apply([...running, { type: 'takeControl' }]).s;
    expect(manual).toMatchObject({ phase: 'manual', lockOwner: 'user' });
    expect(collabReducer(manual, { type: 'beginOperation', opId: 'x' })).toMatchObject({ ok: false });
    expect(collabReducer(manual, { type: 'start' })).toMatchObject({ ok: false });
    expect(collabReducer(manual, { type: 'resume', diskVersion: 'v1' })).toMatchObject({ ok: false });
  });

  it('resume re-syncs: unchanged document resumes, changed document forces a replan', () => {
    const released = apply([...running, { type: 'takeControl' }, { type: 'releaseControl' }]).s;
    expect(released).toMatchObject({ phase: 'paused', needsSync: true, lockOwner: null });
    expect(apply([{ type: 'resume', diskVersion: 'v1' }], released).s).toMatchObject({ phase: 'running', lockOwner: 'claude', needsSync: false });
    const edited = apply([{ type: 'takeControl' }, { type: 'userEdit' }, { type: 'releaseControl' }, { type: 'resume', diskVersion: 'v7' }], released).s;
    expect(edited).toMatchObject({ phase: 'planning', knownVersion: 'v7' });
  });

  it('approval gates and cancellation at safe boundaries', () => {
    const awaiting = apply([...running, { type: 'requestApproval' }]).s;
    expect(awaiting.phase).toBe('awaiting_approval');
    expect(collabReducer(awaiting, { type: 'beginOperation', opId: 'x' }).ok).toBe(false);
    expect(apply([{ type: 'reject' }], awaiting).s).toMatchObject({ phase: 'paused', lockOwner: null });
    const cancelling = apply([...running, { type: 'beginOperation', opId: 'a' }, { type: 'cancel' }]).s;
    expect(cancelling.phase).toBe('pausing');
    expect(apply([{ type: 'cancel' }], apply([{ type: 'endOperation', opId: 'a', ok: true }], cancelling).s).s.phase).toBe('cancelled');
  });

  it('failed operations release the lock; terminal states refuse everything but a new plan', () => {
    const failed = apply([...running, { type: 'beginOperation', opId: 'a' }, { type: 'endOperation', opId: 'a', ok: false }]).s;
    expect(failed).toMatchObject({ phase: 'failed', lockOwner: null, activeOperation: null });
    expect(collabReducer(failed, { type: 'start' }).ok).toBe(false);
    expect(collabReducer(failed, { type: 'plan' }).ok).toBe(true);
  });

  it('controller wrapper throws on illegal transitions', async () => {
    const c = new LocalCollaborationController();
    await expect(c.requestPause()).rejects.toThrow(/Nothing is running/);
    c.dispatch({ type: 'plan' }); c.dispatch({ type: 'planReady', version: 'v1' });
    await c.acquireEditLock('claude', 'doc');
    expect(c.state.lockOwner).toBe('claude');
    await c.acquireEditLock('user', 'doc');
    expect(c.state).toMatchObject({ phase: 'manual', lockOwner: 'user' });
    await c.releaseEditLock('user', 'doc');
    await c.resumeAfterSync('doc', 'v1');
    expect(c.state.phase).toBe('running');
  });
});

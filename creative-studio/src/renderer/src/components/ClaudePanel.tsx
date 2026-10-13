import { useCallback, useEffect, useRef, useState } from 'react';
import { collabReducer, initialCollabState, PHASE_LABEL, type CollabEvent, type CollabState } from '@shared/collaboration';
import type { IntegrationSnapshot } from '@shared/ipc';
import type { Asset } from '@shared/types';

interface Props {
  selected: Asset | null;
  integrations: IntegrationSnapshot | null;
  log: (source: string, msg: string) => void;
}

interface Msg { role: 'user' | 'system'; text: string }

const MOCK_STEPS = ['Inspect document', 'Adjust exposure', 'Retouch highlights'];


/**
 * Creative Partner panel. Claude is not connected in this build, so the lifecycle controls drive a
 * clearly labelled MOCK task through the real collaboration state machine (no app is edited).
 */
export function ClaudePanel({ selected, integrations, log }: Props) {
  const [state, setState] = useState<CollabState>(initialCollabState);
  const current = useRef(state);
  const dispatch = useCallback((e: CollabEvent) => {
    const r = collabReducer(current.current, e);
    if (!r.ok) log('collab', `Refused ${e.type}: ${r.reason}`);
    else if (r.state.lastMessage) log('collab', r.state.lastMessage);
    current.current = r.state;
    setState(r.state);
  }, [log]);
  const [step, setStep] = useState(0);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const version = useRef(1);

  // Mock agent loop: while Running and between operations, start the next step; each takes ~1.4 s.
  useEffect(() => {
    if (state.phase === 'running' && !state.activeOperation) {
      if (step >= MOCK_STEPS.length) { dispatch({ type: 'complete' }); return; }
      const t = setTimeout(() => dispatch({ type: 'beginOperation', opId: `op-${step}` }), 300);
      return () => clearTimeout(t);
    }
    if (state.activeOperation) {
      const op = state.activeOperation;
      const t = setTimeout(() => {
        dispatch({ type: 'endOperation', opId: op, ok: true, version: `v${++version.current}` });
        setStep((s) => s + 1);
      }, 1400);
      return () => clearTimeout(t);
    }
  }, [state.phase, state.activeOperation, step, dispatch]);

  const startMock = () => {
    setStep(0);
    dispatch({ type: 'plan' });
    dispatch({ type: 'planReady', version: `v${version.current}` });
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setMessages((m) => [...m, { role: 'user', text }, { role: 'system', text: 'Not sent: Claude is not connected in this build. Nothing left this computer.' }]);
    setDraft('');
  };

  const p = state.phase;
  return (
    <aside className="pane claude" aria-label="Claude Creative Partner">
      <div className="pane-header">Claude · Creative Partner <span className="chip off"><span className="dot" />{integrations?.claude.connected ? 'Connected' : 'Not connected'}</span></div>

      <div className="claude-section">
        <h3>Context</h3>
        <div style={{ fontSize: 12 }}>{selected ? <>Selected: <strong>{selected.name}</strong> ({selected.kind})</> : 'No asset selected'}</div>
      </div>

      <div className="claude-section" aria-live="polite">
        <h3>Current task <span className="badge-mock">MOCK</span></h3>
        <div className="phase"><span className={`phase-dot ${p}`} />{PHASE_LABEL[p]}{state.activeOperation && <span className="asset-meta"> · {MOCK_STEPS[step] ?? ''}</span>}</div>
        <div className="asset-meta">
          Lock: {state.lockOwner ?? 'nobody'} · Doc version: {state.knownVersion ?? 'n/a'} · Step {Math.min(step, MOCK_STEPS.length)}/{MOCK_STEPS.length}
        </div>
        <div className="btn-row">
          {(p === 'idle' || p === 'completed' || p === 'cancelled' || p === 'failed') && <button className="btn small" onClick={startMock}>Plan mock task</button>}
          {p === 'ready' && <button className="btn small primary" onClick={() => dispatch({ type: 'start' })}>Run</button>}
          {p === 'running' && <button className="btn small" onClick={() => dispatch({ type: 'requestPause' })}>Pause</button>}
          {(p === 'running' || p === 'paused' || p === 'ready') && <button className="btn small" onClick={() => dispatch({ type: 'takeControl' })}>Take Control</button>}
          {p === 'manual' && <button className="btn small" onClick={() => { dispatch({ type: 'userEdit' }); version.current++; log('collab', `Manual edit recorded (doc now v${version.current}).`); }}>Simulate my edit</button>}
          {p === 'manual' && <button className="btn small" onClick={() => dispatch({ type: 'releaseControl' })}>Release control</button>}
          {p === 'paused' && <button className="btn small primary" onClick={() => dispatch({ type: 'resume', diskVersion: `v${version.current}` })}>Resume</button>}
          {p === 'planning' && <button className="btn small primary" onClick={() => dispatch({ type: 'planReady', version: `v${version.current}` })}>Accept new plan</button>}
          {!['idle', 'completed', 'cancelled', 'failed', 'manual'].includes(p) && <button className="btn small danger" onClick={() => dispatch({ type: 'cancel' })}>Cancel</button>}
        </div>
        {state.lastMessage && <div className="asset-meta">{state.lastMessage}</div>}
      </div>

      <div className="chat" aria-label="Conversation">
        <div className="msg system">
          Claude is not connected. The task controls above drive a <strong>simulated</strong> task through the real
          pause / take-control / resync state machine so it can be tested. No ArtCraft app is edited.
        </div>
        {messages.map((m, i) => <div key={i} className={`msg ${m.role}`}>{m.text}</div>)}
      </div>
      <div className="composer">
        <label className="sr-only" htmlFor="claude-input">Message Claude</label>
        <textarea id="claude-input" placeholder="Describe a change… (not sent: Claude not connected)" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="btn primary" onClick={send}>Send</button>
      </div>
    </aside>
  );
}

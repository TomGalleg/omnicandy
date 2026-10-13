import { useState } from 'react';
import { PHASE_LABEL } from '@shared/collaboration';
import type { IntegrationSnapshot } from '@shared/ipc';
import type { Asset } from '@shared/types';
import type { LiveApi } from '../useLive';

interface Props {
  selected: Asset | null;
  integrations: IntegrationSnapshot | null;
  liveApi: LiveApi;
}

interface Msg { role: 'user' | 'system'; text: string }

/**
 * Creative Partner panel. Claude itself is not connected yet. The task section controls the REAL
 * automation task running in the live PhotoCraft window (pause, take control, resume after resync).
 */
export function ClaudePanel({ selected, integrations, liveApi }: Props) {
  const { live, busy, act } = liveApi;
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setMessages((m) => [...m, { role: 'user', text }, { role: 'system', text: 'Not sent: Claude is not connected in this build. Nothing left this computer.' }]);
    setDraft('');
  };

  const p = live?.collab.phase ?? 'idle';
  const open = live?.status === 'ready' && !!live.asset;
  const total = live?.steps.length ?? 0;
  const L = window.studio.live;

  return (
    <aside className="pane claude" aria-label="Claude Creative Partner">
      <div className="pane-header">Claude · Creative Partner <span className="chip off"><span className="dot" />{integrations?.claude.connected ? 'Connected' : 'Not connected'}</span></div>

      <div className="claude-section">
        <h3>Context</h3>
        <div style={{ fontSize: 12 }}>{selected ? <>Selected: <strong>{selected.name}</strong> ({selected.kind})</> : 'No asset selected'}</div>
        {open && <div style={{ fontSize: 12 }}>Open in PhotoCraft: <strong>{live!.asset!.name}</strong></div>}
      </div>

      <div className="claude-section" aria-live="polite">
        <h3>Current task {open && <span className="chip real" style={{ height: 18 }}><span className="dot" />live PhotoCraft</span>}</h3>
        {!open ? (
          <div className="asset-meta">No live document. Open an image from <strong>Edit</strong> to run steps in PhotoCraft.</div>
        ) : (
          <>
            <div className="phase"><span className={`phase-dot ${p}`} />{PHASE_LABEL[p]}
              {live!.collab.activeOperation && <span className="asset-meta"> · {live!.steps[live!.stepIndex]?.label ?? ''}</span>}
            </div>
            <div className="asset-meta">
              Edit lock: {live!.collab.lockOwner === 'user' ? 'you' : live!.collab.lockOwner === 'claude' ? 'automation' : 'free'}
              {total > 0 && <> · Step {Math.min(live!.stepIndex, total)}/{total}</>}
            </div>
            <div className="btn-row">
              {(p === 'running') && <button className="btn small" disabled={busy} onClick={() => void act('Pause', L.pause)}>Pause</button>}
              {p !== 'manual' && p !== 'pausing' && <button className="btn small" disabled={busy} onClick={() => void act('Take control', L.takeControl)}>Take Control</button>}
              {p === 'manual' && <button className="btn small primary" disabled={busy} onClick={() => void act('Hand back control', L.releaseControl)}>I'm done, hand back</button>}
              {p === 'paused' && <button className="btn small primary" disabled={busy} onClick={() => void act('Resume', L.resume)}>Resume</button>}
              {live!.needsReplanConfirm && <button className="btn small primary" disabled={busy} onClick={() => void act('Continue', L.confirmReplan)}>Continue on changed document</button>}
              {['running', 'pausing', 'paused', 'planning', 'ready'].includes(p) && <button className="btn small danger" disabled={busy} onClick={() => void act('Cancel', L.cancel)}>Cancel task</button>}
            </div>
            {p === 'manual' && <div className="notice">You have control. Edit freely in the PhotoCraft window; automation won't touch the document until you hand it back.</div>}
            {live!.message && <div className="asset-meta">{live!.message}</div>}
          </>
        )}
      </div>

      <div className="chat" aria-label="Conversation">
        <div className="msg system">
          Claude is not connected yet, so chat messages are not sent anywhere. The task controls above are real: they drive the automation running in the PhotoCraft window.
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

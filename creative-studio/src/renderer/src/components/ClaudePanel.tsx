import { useEffect, useRef, useState } from 'react';
import { EDITOR_APPS } from '@shared/appEditors';
import { CLAUDE_MODELS, type ClaudeState } from '@shared/claude';
import type { IntegrationSnapshot } from '@shared/ipc';
import type { Asset } from '@shared/types';
import type { LiveApi } from '../useLive';
import { TaskControls } from './live/LiveParts';

interface Props {
  selected: Asset | null;
  integrations: IntegrationSnapshot | null;
  liveApi: LiveApi;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * Claude, the Creative Partner. Uses Claude Code on this PC (its own sign-in, no API key in
 * CreateCraft). Claude edits the file open in the Edit tab through CreateCraft's tools only, under
 * the same lock as everything else: Pause / Take Control stop it.
 */
export function ClaudePanel({ liveApi }: Props) {
  const { live } = liveApi;
  const [st, setSt] = useState<ClaudeState | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.studio.claude.state().then(setSt);
    void window.studio.claude.checkAuth();
    return window.studio.claude.onChange(setSt);
  }, []);
  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight }); }, [st?.items.length]);

  const working = st?.status === 'working';
  const signedOut = st?.signedIn === false || st?.status === 'signed-out';
  const open = live?.status === 'ready' && !!live.asset;
  const appName = live ? EDITOR_APPS[live.appId].name : '';

  const send = () => {
    const text = draft.trim();
    if (!text || working) return;
    setDraft('');
    setError(null);
    window.studio.claude.send(text).catch((e) => setError(errText(e)));
  };

  return (
    <aside className="pane claude" aria-label="Claude Creative Partner">
      <div className="pane-header">
        Claude · Creative Partner
        <span className={`chip ${signedOut ? 'warn' : st?.signedIn ? 'real' : 'off'}`}><span className="dot" />{signedOut ? 'Sign-in needed' : working ? 'Working…' : 'Ready'}</span>
      </div>

      <div className="claude-section">
        <div className="claude-row">
          <select aria-label="Claude model" value={st?.model ?? 'claude-opus-5-5'} disabled={working}
            onChange={(e) => void window.studio.claude.setModel(e.target.value).then(setSt)}>
            {CLAUDE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <button className="btn small" disabled={working || !st?.items.length} onClick={() => void window.studio.claude.reset().then(setSt)}>New chat</button>
        </div>
        <div className="asset-meta">
          {open ? <>Working on <strong>{live!.asset!.name}</strong> in {appName}.</> : 'Open a file in the Edit tab and Claude can edit it with you.'}
        </div>
        {open && <TaskControls liveApi={liveApi} />}
      </div>

      {signedOut && (
        <div className="claude-section">
          <div className="notice">
            Claude uses the Claude Code sign-in on this PC, and it isn't signed in yet.
            Click below, finish signing in with your Claude account in the browser, then come back.
          </div>
          <div className="btn-row">
            <button className="btn primary" onClick={() => window.studio.claude.signIn().catch((e) => setError(errText(e)))}>Sign in to Claude</button>
            <button className="btn" onClick={() => void window.studio.claude.checkAuth()}>I've signed in</button>
          </div>
        </div>
      )}

      <div className="chat" ref={chatRef} aria-label="Conversation" aria-live="polite">
        {!st?.items.length && (
          <div className="msg system">
            Tell Claude what you want, for example "make this warmer and a bit brighter" or "what would make this poster pop?".
            Claude makes the changes in the open app while you watch. Use Pause or Take Control any time. Nothing is saved until you say so.
          </div>
        )}
        {st?.items.map((m) => (
          <div key={m.id} className={`msg ${m.role === 'user' ? 'user' : m.role === 'claude' ? 'assistant' : m.role === 'error' ? 'error' : 'activity'}`}>{m.text}</div>
        ))}
        {working && <div className="msg activity">Claude is working…</div>}
        {error && <div className="msg error">{error}</div>}
      </div>

      <div className="composer">
        <label className="sr-only" htmlFor="claude-input">Message Claude</label>
        <textarea id="claude-input" placeholder={signedOut ? 'Sign in to Claude first' : 'Ask Claude to change something…'} value={draft} disabled={signedOut}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        {working
          ? <button className="btn danger" onClick={() => void window.studio.claude.stop()}>Stop</button>
          : <button className="btn primary" disabled={!draft.trim() || signedOut} onClick={send}>Send</button>}
      </div>
      {!!st?.costUsd && <div className="asset-meta claude-cost">Usage this session (reported by Claude Code): ${st.costUsd.toFixed(3)}</div>}
    </aside>
  );
}

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
 * OmniCandy). Claude edits the file open in the Edit tab through OmniCandy's tools only, under
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
  // The Planner's "Send to AI" can fill the box for the user; it never sends anything (the user presses Send).
  useEffect(() => {
    const fill = (e: Event) => { const t = (e as CustomEvent<{ text?: unknown }>).detail?.text; if (typeof t === 'string' && t) setDraft(t); };
    window.addEventListener('createcraft:claude-prefill', fill);
    return () => window.removeEventListener('createcraft:claude-prefill', fill);
  }, []);

  const working = st?.status === 'working';
  const apiKeyMode = st?.billing.mode === 'api-key';
  const needsKey = apiKeyMode && !st?.billing.keyReady;
  const notInstalled = !apiKeyMode && st?.installed === false;
  const signedOut = !apiKeyMode && !notInstalled && (st?.signedIn === false || st?.status === 'signed-out');
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

      {needsKey && (
        <div className="claude-section">
          <div className="notice">Claude is set to use an Anthropic API key, but no usable key is saved on this PC. Add the key in <strong>Settings → Integrations → Claude</strong>, or switch back to the Claude sign-in there.</div>
        </div>
      )}

      {notInstalled && (
        <div className="claude-section">
          <div className="notice">
            <strong>Claude Code is not installed on this PC</strong>, or OmniCandy cannot find it. Claude in OmniCandy uses your own Claude Code sign-in.<br />
            1. Install Claude Code from <a href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank" rel="noreferrer">the Claude Code setup page</a>.<br />
            2. Come back here and press <strong>Check again</strong>, then sign in.
          </div>
          <div className="btn-row">
            <button className="btn primary" onClick={() => void window.studio.claude.checkAuth()}>Check again</button>
          </div>
        </div>
      )}

      {signedOut && (
        <div className="claude-section">
          {st?.login.stage === 'waiting-code' || st?.login.stage === 'checking' ? (
            <>
              <div className="notice">
                A <strong>Sign in to Claude</strong> window opened, and your browser shows the Claude sign-in page.<br />
                1. Sign in and click <strong>Authorize</strong> in the browser.<br />
                2. If the browser then shows a code, copy it, click into the black sign-in window, paste it (right-click) and press Enter.<br />
                OmniCandy notices automatically when you're signed in.
              </div>
              <div className="btn-row">
                <span className="asset-meta">Waiting for sign-in…</span>
                <button className="btn small ghost" onClick={() => void window.studio.claude.cancelSignIn()}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <div className="notice">
                Claude uses the Claude Code sign-in on this PC, and it isn't signed in yet. Sign in once with your Claude account.
              </div>
              {st?.login.stage === 'failed' && <div className="wf-msg error">{st.login.message}</div>}
              <div className="btn-row">
                <button className="btn primary" onClick={() => window.studio.claude.signIn().catch((e) => setError(errText(e)))}>Sign in to Claude</button>
                <button className="btn" onClick={() => void window.studio.claude.checkAuth()}>Check again</button>
              </div>
            </>
          )}
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
        <textarea id="claude-input" placeholder={needsKey ? 'Add your API key in Settings first' : notInstalled ? 'Install Claude Code first' : signedOut ? 'Sign in to Claude first' : 'Ask Claude to change something…'} value={draft} disabled={signedOut || notInstalled || needsKey}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        {working
          ? <button className="btn danger" onClick={() => void window.studio.claude.stop()}>Stop</button>
          : <button className="btn primary" disabled={!draft.trim() || signedOut} onClick={send}>Send</button>}
      </div>
      {st?.billing && (
        <div className="asset-meta claude-billing">
          {st.billing.mode === 'api-key'
            ? 'Claude is using your Anthropic API key. Usage is billed to your Anthropic account, separately from any Claude plan. Change this in Settings.'
            : 'Claude is using your Claude sign-in (your plan). Change this in Settings.'}
        </div>
      )}
      {!!st?.costUsd && <div className="asset-meta claude-cost">Usage this session (reported by Claude Code): ${st.costUsd.toFixed(3)}</div>}
    </aside>
  );
}

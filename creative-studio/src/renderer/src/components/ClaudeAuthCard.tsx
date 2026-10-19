import { useEffect, useState } from 'react';
import type { ClaudeAuthMode, ClaudeBilling } from '@shared/claude';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** How Claude signs in: the Claude Code sign-in (default) or an Anthropic API key. Lives in Settings > Integrations. */
export function ClaudeAuthCard() {
  const [b, setB] = useState<ClaudeBilling | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { void window.studio.claude.authInfo().then(setB).catch((e) => setMsg(errText(e))); }, []);

  const act = async (fn: () => Promise<ClaudeBilling>) => {
    setBusy(true); setMsg(null);
    try { setB(await fn()); } catch (e) { setMsg(errText(e)); } finally { setBusy(false); }
  };
  const options: Array<{ id: ClaudeAuthMode; label: string; hint: string }> = [
    { id: 'sign-in', label: 'Claude sign-in', hint: 'Uses your Claude Code sign-in and your Claude plan. This is the default.' },
    { id: 'api-key', label: 'Anthropic API key', hint: 'Uses your own API key. Anthropic bills API usage to your API account, separately from any Claude plan, and it can cost real money.' },
  ];
  const mode = b?.mode ?? 'sign-in';

  return (
    <div className="field">
      <span className="menu-label">Claude</span>
      <div role="radiogroup" aria-label="How Claude signs in" className="theme-options">
        {options.map((o) => (
          <button key={o.id} role="radio" aria-checked={mode === o.id} disabled={!b || busy} className={`theme-option${mode === o.id ? ' active' : ''}`}
            onClick={() => { if (mode !== o.id) void act(() => window.studio.claude.setAuthMode(o.id)); }}>
            <span><strong>{o.label}</strong><small>{o.hint}</small></span>
          </button>
        ))}
      </div>
      <p className="asset-meta" aria-live="polite">
        {mode === 'api-key'
          ? (b?.keyReady ? 'Active: Anthropic API key. Usage is billed to your Anthropic account.' : 'Active: Anthropic API key, but no usable key is saved. Add one below.')
          : 'Active: Claude sign-in (your plan). Chat, model choice and sign-in are in the Claude panel.'}
      </p>
      {b?.keyIgnored && <small>An Anthropic API key was found on this PC (an environment variable). OmniCandi never uses it unless you choose the API key option and add a key here.</small>}
      {msg && <div className="wf-msg error" role="alert">{msg}</div>}
      <div className="provider-row" aria-label="Anthropic API key">
        <div className="provider-head">
          <strong>Anthropic API key</strong>
          <span className={`chip ${b?.keyUnreadable ? 'warn' : b?.keyReady ? 'ok' : 'off'}`}><span className="dot" />{b?.keyUnreadable ? "Key can't be read" : b?.keyReady ? 'Key saved' : 'Not set up'}</span>
        </div>
        {b?.keyUnreadable && <div className="asset-meta err">A key is saved here, but this PC can't decrypt it (it was saved by another PC or Windows user). Paste the key again to replace it.</div>}
        <div className="asset-meta">Copy your key (it starts with sk-ant-), then click Paste key. OmniCandi reads it from the clipboard, encrypts it with your operating system and clears the clipboard. The key is never shown, logged or saved in projects. It is not tested when saved (a test would be an API request); the first Claude message uses it.</div>
        <div className="btn-row">
          <button className="btn small primary" disabled={busy} onClick={() => void act(() => window.studio.claude.pasteApiKey())}>{busy ? 'Saving…' : b?.keyReady || b?.keyUnreadable ? 'Replace key (paste)' : 'Paste key'}</button>
          {(b?.keyReady || b?.keyUnreadable) && <button className="btn small danger" disabled={busy} onClick={() => { if (window.confirm('Remove the saved Anthropic API key from this PC? Claude goes back to the Claude sign-in.')) void act(() => window.studio.claude.removeApiKey()); }}>Remove</button>}
        </div>
      </div>
    </div>
  );
}

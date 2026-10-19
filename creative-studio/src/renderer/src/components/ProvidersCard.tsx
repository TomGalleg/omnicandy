import { useEffect, useState } from 'react';
import type { ProviderStatusDto } from '@shared/ipc';

/** Fired after any key change so open workspaces (AI Generate) re-read which providers are ready. */
export const PROVIDERS_CHANGED = 'cs-providers-changed';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Bring-your-own-key AI image providers: paste, test and remove keys. Lives in Settings > Integrations. */
export function ProvidersCard() {
  const [providers, setProviders] = useState<ProviderStatusDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { void window.studio.generate.providers().then(setProviders); }, []);

  const provAct = async (label: string, fn: () => Promise<ProviderStatusDto[]>) => {
    setBusy(label); setMsg(null);
    try { setProviders(await fn()); window.dispatchEvent(new Event(PROVIDERS_CHANGED)); } catch (e) { setMsg(errText(e)); } finally { setBusy(null); }
  };

  return (
    <div className="field">
      <span className="menu-label">AI image providers</span>
      <p className="asset-meta">Use your own OpenAI or Google account. Copy your API key, then click <strong>Paste key</strong>: OmniCandi reads it straight from the clipboard, encrypts it with your operating system and clears the clipboard. The key is never shown, logged, saved in projects or given to Claude. Every paid request asks for your approval first.</p>
      {providers?.find((p) => !p.encryptionAvailable) && <div className="wf-msg error">{providers.find((p) => !p.encryptionAvailable)?.encryptionProblem ?? "Protected storage is unavailable, so keys can't be saved."}</div>}
      {msg && <div className="wf-msg error" role="alert">{msg}</div>}
      {providers?.filter((p) => p.billable).map((p) => (
        <div key={p.id} className="provider-row" aria-label={`${p.label} provider`}>
          <div className="provider-head">
            <strong>{p.label}</strong>
            <span className={`chip ${p.unreadable ? 'warn' : p.configured ? (p.lastTest?.ok === false ? 'warn' : 'ok') : 'off'}`}><span className="dot" />{p.unreadable ? "Key can't be read" : p.configured ? (p.lastTest?.ok === false ? 'Key saved · test failed' : 'Key saved') : 'Not set up'}</span>
          </div>
          {p.configured && p.lastTest && <div className={`asset-meta${p.lastTest.ok ? '' : ' err'}`}>{p.lastTest.message} <span className="asset-meta">({when(p.lastTest.at)})</span></div>}
          {p.unreadable && <div className="asset-meta err">A key is saved here, but this PC can't decrypt it (it was saved by another PC or Windows user). Paste the key again to replace it.</div>}
          {!p.configured && !p.unreadable && <div className="asset-meta">{p.keyHint}</div>}
          <div className="btn-row">
            <button className="btn small" onClick={() => void window.studio.generate.openKeyPage(p.id)}>Get a key ↗</button>
            <button className="btn small primary" disabled={!!busy || !p.encryptionAvailable} onClick={() => void provAct(`paste-${p.id}`, () => window.studio.generate.pasteKey(p.id))}>{busy === `paste-${p.id}` ? 'Saving…' : p.configured || p.unreadable ? 'Replace key (paste)' : 'Paste key'}</button>
            {p.configured && <button className="btn small" disabled={!!busy} onClick={() => void provAct(`test-${p.id}`, () => window.studio.generate.test(p.id))}>{busy === `test-${p.id}` ? 'Testing…' : 'Test connection'}</button>}
            {p.configured && <button className="btn small danger" disabled={!!busy} onClick={() => { if (window.confirm(`Remove the saved ${p.label} key from this PC?`)) void provAct(`rm-${p.id}`, () => window.studio.generate.removeKey(p.id)); }}>Remove</button>}
          </div>
        </div>
      ))}
      <small>Testing only lists models; it never generates and costs nothing.</small>
    </div>
  );
}

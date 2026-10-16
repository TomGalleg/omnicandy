import { Fragment, useEffect, useRef, useState } from 'react';
import { APP_THEME_SUPPORT } from '@shared/appTheme';
import type { ClaudeState } from '@shared/claude';
import type { IntegrationSnapshot, ProviderStatusDto, StorageDto } from '@shared/ipc';
import { formatBytes } from '../format';
import type { LiveSnapshot } from '@shared/live';
import { ACCENT_PRESETS, THEME_OPTIONS } from '@shared/theme';
import type { AppProbeResult } from '@shared/types';
import { setOverlayOpen } from '../overlay';
import { ConnectApplicationsCard } from '../connect/ConnectApplicationsCard';
import { CreateIntegrationCard } from '../builder/MyIntegrations';
import { ExternalApps } from './ExternalApps';
import type { useAppearance } from '../useAppearance';

type Section = 'appearance' | 'storage' | 'integrations' | 'diagnostics';
const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'storage', label: 'Projects & Storage' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'diagnostics', label: 'Advanced diagnostics' },
];

interface Props {
  appearance: ReturnType<typeof useAppearance>;
  appTheme: LiveSnapshot['appTheme'] | null;
  apps: AppProbeResult[];
  integrations: IntegrationSnapshot | null;
  onClose: () => void;
}

/** Settings: appearance, plus the status details that used to sit in the header. */
export function SettingsDialog({ appearance, appTheme, apps, integrations, onClose }: Props) {
  const [section, setSection] = useState<Section>('appearance');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setOverlayOpen(true);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    ref.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    return () => { document.removeEventListener('keydown', esc); setOverlayOpen(false); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Settings" className="panel-card settings" ref={ref}>
        <div className="settings-head">
          <strong>Settings</strong>
          <button className="btn small ghost" aria-label="Close settings" onClick={onClose}>✕</button>
        </div>
        <div className="settings-body">
          <div role="tablist" aria-orientation="vertical" aria-label="Settings sections" className="settings-nav">
            {SECTIONS.map((s) => (
              <button key={s.id} role="tab" aria-selected={section === s.id} onClick={() => setSection(s.id)}>{s.label}</button>
            ))}
          </div>
          <div role="tabpanel" className="settings-content">
            {section === 'appearance' && <AppearanceSettings appearance={appearance} appTheme={appTheme} />}
            {section === 'storage' && <StorageSettings />}
            {section === 'integrations' && <IntegrationSettings apps={apps} />}
            {section === 'diagnostics' && <Diagnostics apps={apps} integrations={integrations} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function AppearanceSettings({ appearance, appTheme }: { appearance: ReturnType<typeof useAppearance>; appTheme: LiveSnapshot['appTheme'] | null }) {
  const s = appearance.settings;
  const paletteName = THEME_OPTIONS.find((o) => o.id === appearance.palette)?.label ?? appearance.palette;
  return (
    <>
      <div className="field">
        <span className="menu-label">Theme</span>
        <div role="radiogroup" aria-label="Theme" className="theme-options">
          {THEME_OPTIONS.map((o) => (
            <button key={o.id} role="radio" aria-checked={s.mode === o.id} className={`theme-option${s.mode === o.id ? ' active' : ''}`}
              onClick={() => void appearance.update({ mode: o.id })}>
              <span className={`theme-swatch swatch-${o.id}`} aria-hidden />
              <span><strong>{o.label}</strong><small>{o.hint}</small></span>
            </button>
          ))}
        </div>
        {s.mode === 'system' && (
          <label className="menu-row">
            <span>When Windows is dark, use</span>
            <select value={s.systemDark} onChange={(e) => void appearance.update({ systemDark: e.target.value as 'artcraft' | 'studioDark' })}>
              <option value="artcraft">ArtCraft Match</option>
              <option value="studioDark">Studio Dark</option>
            </select>
          </label>
        )}
        {s.mode === 'system' && <small>Following Windows: now {paletteName}.</small>}
      </div>
      <div className="field">
        <span className="menu-label">Accent colour</span>
        <div className="accent-row">
          {ACCENT_PRESETS.map((p) => (
            <button key={p.value} aria-label={p.name} aria-pressed={s.accent === p.value} className="accent-dot"
              onClick={() => void appearance.update({ accent: p.value })} style={{ background: p.value, borderColor: s.accent === p.value ? 'var(--text)' : 'transparent' }} />
          ))}
          <label className="accent-custom">
            <input type="color" aria-label="Custom accent" value={s.accent} onChange={(e) => void appearance.update({ accent: e.target.value })} />
            Custom
          </label>
        </div>
      </div>
      <div className="field">
        <span className="menu-label">ArtCraft apps</span>
        <label className="menu-row check">
          <input type="checkbox" checked={s.syncApps} onChange={(e) => void appearance.update({ syncApps: e.target.checked })} />
          <span>Match the open ArtCraft app to this theme</span>
        </label>
        <ul className="sync-list">
          {APP_THEME_SUPPORT.map((a) => (
            <li key={a.id}>
              <span className={`sync-dot ${a.support}`} aria-hidden />
              <strong>{a.name}</strong>
              <small>{a.note}{appTheme?.app === a.id ? ` · now "${appTheme.value}"` : ''}</small>
            </li>
          ))}
        </ul>
        <small>Uses each app's own theme setting. Your artwork, files and edit history are never changed.</small>
      </div>
    </>
  );
}

/** Claude's sign-in state, as the Claude panel shows it. */
function useClaudeState() {
  const [st, setSt] = useState<ClaudeState | null>(null);
  useEffect(() => { void window.studio.claude.state().then(setSt); return window.studio.claude.onChange(setSt); }, []);
  return st;
}
const claudeText = (st: ClaudeState | null) => !st ? 'Checking…'
  : st.status === 'unavailable' ? 'Unavailable on this PC.'
  : st.signedIn === false || st.status === 'signed-out' ? 'Not signed in. Sign in from the Claude panel.'
    : st.signedIn ? `Signed in with the Claude Code sign-in on this PC · ${st.status === 'working' ? 'working' : 'ready'}`
      : 'Sign-in not checked yet. Open the Claude panel to check.';

function StorageSettings() {
  const [info, setInfo] = useState<StorageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void window.studio.projects.storage().then(setInfo); }, []);
  const apply = async (fn: () => Promise<StorageDto | null>) => {
    setBusy(true); setError(null);
    try { const r = await fn(); if (r) setInfo(r); }
    catch (e) { setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setBusy(false); }
  };
  const browse = () => apply(async () => {
    const dir = await window.studio.projects.pickFolder();
    return dir ? window.studio.projects.setDefaultDir(dir) : null;
  });
  return (
    <>
      <div className="field">
        <span className="menu-label">Project folder</span>
        <p className="hint">New projects are created here, each in its own self-contained folder. Pick a drive with plenty of space for large media; external drives and network folders work too.</p>
        {info ? (
          <>
            <div className="asset-meta" aria-label="Current project folder"><strong>{info.defaultDir}</strong>{!info.isCustom && ' (built-in default)'}</div>
            <div className="asset-meta">
              {info.freeBytes !== null && info.totalBytes !== null
                ? `${formatBytes(info.freeBytes)} free of ${formatBytes(info.totalBytes)}`
                : 'Free space is not available for this location.'}
            </div>
            <div className="menu-row">
              <button className="btn small" disabled={busy} onClick={() => void browse()}>Browse…</button>
              <button className="btn small" onClick={() => void window.studio.projects.revealDefaultDir()}>Open folder</button>
              {info.isCustom && <button className="btn small ghost" disabled={busy} onClick={() => void apply(() => window.studio.projects.setDefaultDir(null))}>Use built-in default</button>}
            </div>
          </>
        ) : <div className="asset-meta">Loading…</div>}
        {error && <div className="wf-msg error" role="alert">{error}</div>}
        <p className="hint">Changing this only affects projects you create from now on. Existing projects stay where they are, and your settings, keys and project list stay in CreateCraft's own data folder.</p>
      </div>
    </>
  );
}

function IntegrationSettings({ apps }: { apps: AppProbeResult[] }) {
  const [providers, setProviders] = useState<ProviderStatusDto[] | null>(null);
  useEffect(() => { void window.studio.generate.providers().then(setProviders); }, []);
  const claude = useClaudeState();
  const installed = apps.filter((a) => a.installed).length;
  return (
    <>
      <ConnectApplicationsCard />
      <CreateIntegrationCard />
      <div className="field">
        <span className="menu-label">ArtCraft apps · {installed} of {apps.length} installed</span>
        <ul className="status-list">
          {apps.map((a) => (
            <li key={a.appId}>
              <span className={`chip ${a.connected ? 'ok' : a.installed ? 'real' : 'off'}`}><span className="dot" />{a.connected ? 'Open now' : a.installed ? 'Installed' : 'Not installed'}</span>
              <strong>{a.displayName}</strong>
              <small>{a.version ?? ''}</small>
            </li>
          ))}
        </ul>
        <small>Installed means the app was found on this PC. CreateCraft starts and controls an app when you open a file in it.</small>
      </div>
      <ExternalApps />
      <div className="field">
        <span className="menu-label">Claude</span>
        <p className="asset-meta">{claudeText(claude)}</p>
        <small>Chat, model choice and sign-in are in the Claude panel.</small>
      </div>
      <div className="field">
        <span className="menu-label">AI image providers</span>
        <ul className="status-list">
          {providers?.filter((p) => p.billable).map((p) => (
            <li key={p.id}>
              <span className={`chip ${p.configured ? 'ok' : 'off'}`}><span className="dot" />{p.configured ? 'Key saved' : 'Not set up'}</span>
              <strong>{p.label}</strong>
              <small>{p.lastTest ? `${p.lastTest.ok ? 'Last test passed' : 'Last test failed'} · ${new Date(p.lastTest.at).toLocaleDateString()}` : ''}</small>
            </li>
          ))}
        </ul>
        <small>Keys are added and tested in the AI Generate tab. Every paid request asks for your approval first.</small>
      </div>
    </>
  );
}

function Diagnostics({ apps, integrations }: { apps: AppProbeResult[]; integrations: IntegrationSnapshot | null }) {
  const yes = (b: boolean | undefined) => (b ? 'yes' : 'no');
  const claude = useClaudeState();
  return (
    <>
      <div className="field">
        <span className="menu-label">Services</span>
        <dl className="kv">
          <dt>Claude</dt><dd>{claudeText(claude)}{claude ? ` · model ${claude.model}` : ''}</dd>
          <dt>Key storage</dt><dd>{integrations?.credentialVault.available ? 'Windows protected storage' : 'unavailable'}</dd>
          <dt>Exports</dt><dd>{integrations?.realExport ? 'real (app command-line tools)' : 'mock'}</dd>
          <dt>Window capture</dt><dd>{integrations ? (integrations.windowCapture.available ? 'available' : `not connected${integrations.windowCapture.reason ? `: ${integrations.windowCapture.reason}` : ''}`) : '…'}</dd>
          {integrations?.appAdapters.map((a) => <Fragment key={a.id}><dt>{a.id} workflow steps</dt><dd>{a.isMock ? 'MOCK' : 'real (headless)'}</dd></Fragment>)}
          {integrations?.providers.map((p) => <Fragment key={p.id}><dt>{p.label}</dt><dd>{p.isMock ? 'MOCK' : 'real'}{p.billable ? ', paid' : ''}</dd></Fragment>)}
        </dl>
      </div>
      <div className="field">
        <span className="menu-label">ArtCraft detection</span>
        <dl className="kv">
          {apps.map((a) => <Fragment key={a.appId}><dt>{a.displayName}</dt><dd>installed {yes(a.installed)}{a.version ? ` (${a.version})` : ''} · live {yes(a.connected)}{a.notes.length ? ` · ${a.notes.join('; ')}` : ''}</dd></Fragment>)}
        </dl>
      </div>
      <small className="asset-meta">The detailed activity log is in the Activity panel under the workspace.</small>
    </>
  );
}

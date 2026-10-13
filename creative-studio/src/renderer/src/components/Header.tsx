import { useEffect, useRef, useState } from 'react';
import type { IntegrationSnapshot } from '@shared/ipc';
import { APP_THEME_SUPPORT } from '@shared/appTheme';
import type { LiveSnapshot } from '@shared/live';
import { ACCENT_PRESETS, THEME_OPTIONS } from '@shared/theme';
import type { AppProbeResult, WorkspaceId } from '@shared/types';
import logo from '../assets/logo.png';
import type { useAppearance } from '../useAppearance';

export const WORKSPACES: Array<{ id: WorkspaceId; label: string }> = [
  { id: 'home', label: 'Home' },
  { id: 'media', label: 'Media' },
  { id: 'edit', label: 'Edit' },
  { id: 'generate', label: 'AI Generate' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'effects', label: 'Effects' },
  { id: 'color', label: 'Color' },
  { id: 'audio', label: 'Audio' },
  { id: 'deliver', label: 'Deliver' },
];

interface Props {
  projectName: string;
  onProjectHome: () => void;
  workspace: WorkspaceId;
  onWorkspace: (w: WorkspaceId) => void;
  apps: AppProbeResult[];
  integrations: IntegrationSnapshot | null;
  appearance: ReturnType<typeof useAppearance>;
  claudeOpen: boolean;
  onToggleClaude: () => void;
  appTheme: LiveSnapshot['appTheme'] | null;
}

export function Header({ projectName, onProjectHome, workspace, onWorkspace, apps, integrations, appearance, claudeOpen, onToggleClaude, appTheme }: Props) {
  const installed = apps.filter((a) => a.installed).length;
  const connected = apps.filter((a) => a.connected).length;
  return (
    <header className="header">
      <div className="brand"><img className="brand-logo" src={logo} alt="" /> CreateCraft</div>
      <button className="project-name" title="Projects" onClick={onProjectHome}>Project: <strong>{projectName}</strong> <span aria-hidden>▾</span></button>
      <nav className="workspaces" aria-label="Workspaces">
        {WORKSPACES.map((w) => (
          <button key={w.id} aria-current={workspace === w.id ? 'page' : undefined} onClick={() => onWorkspace(w.id)}>
            {w.label}
          </button>
        ))}
      </nav>
      <div className="header-status">
        <span className={`chip ${connected ? 'ok' : installed ? 'warn' : 'off'}`} title={apps.map((a) => `${a.displayName}: ${a.installed ? `installed ${a.version ?? ''}` : 'not installed'}${a.connected ? ', connected' : ', not connected'}`).join('\n')}>
          <span className="dot" /><span>ArtCraft {installed} installed<span className="chip-extra"> · {connected} live</span></span>
        </span>
        {integrations?.appAdapters.some((a) => a.id === 'photocraft' && !a.isMock) && (
          <span className="chip real" title="Workflow ArtCraft Edit nodes run the installed photocraft-cli for real (headless). Live window control is not connected yet."><span className="dot" /><span>PhotoCraft<span className="chip-extra">: headless edits</span></span></span>
        )}
        <button className={`chip chip-btn ${claudeOpen ? 'on' : 'off'}`} aria-pressed={claudeOpen} onClick={onToggleClaude}
          title={`${claudeOpen ? 'Hide' : 'Show'} the Claude panel. ${integrations?.claude.reason ?? ''}`}>
          <span className="dot" /><span>Claude<span className="chip-extra">{claudeOpen ? ' · hide' : ' · show'}</span></span>
        </button>
        <span className="chip off" title="No provider keys are configured. Costs: $0."><span className="dot" /><span>$0.00<span className="chip-extra"> · no providers</span></span></span>
        <AppearanceMenu appearance={appearance} appTheme={appTheme} />
      </div>
    </header>
  );
}

function AppearanceMenu({ appearance, appTheme }: { appearance: ReturnType<typeof useAppearance>; appTheme: LiveSnapshot['appTheme'] | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const s = appearance.settings;
  const paletteName = THEME_OPTIONS.find((o) => o.id === appearance.palette)?.label ?? appearance.palette;
  return (
    <div className="appearance" ref={ref}>
      <button className="btn small" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>Appearance</button>
      {open && (
        <div role="dialog" aria-label="Appearance" className="panel-card appearance-menu">
          <div className="field">
            <span className="menu-label">Appearance</span>
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
        </div>
      )}
    </div>
  );
}

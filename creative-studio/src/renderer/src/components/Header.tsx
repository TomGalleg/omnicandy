import { useEffect, useRef, useState } from 'react';
import type { IntegrationSnapshot } from '@shared/ipc';
import { ACCENT_PRESETS } from '@shared/theme';
import type { AppProbeResult, ThemeMode, WorkspaceId } from '@shared/types';
import logo from '../assets/logo.png';
import type { useAppearance } from '../useAppearance';

export const WORKSPACES: Array<{ id: WorkspaceId; label: string }> = [
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
  workspace: WorkspaceId;
  onWorkspace: (w: WorkspaceId) => void;
  apps: AppProbeResult[];
  integrations: IntegrationSnapshot | null;
  appearance: ReturnType<typeof useAppearance>;
  claudeOpen: boolean;
  onToggleClaude: () => void;
}

export function Header({ projectName, workspace, onWorkspace, apps, integrations, appearance, claudeOpen, onToggleClaude }: Props) {
  const installed = apps.filter((a) => a.installed).length;
  const connected = apps.filter((a) => a.connected).length;
  return (
    <header className="header">
      <div className="brand"><img className="brand-logo" src={logo} alt="" /> CreateCraft</div>
      <div className="project-name">Project: <strong>{projectName}</strong></div>
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
        <AppearanceMenu appearance={appearance} />
      </div>
    </header>
  );
}

function AppearanceMenu({ appearance }: { appearance: ReturnType<typeof useAppearance> }) {
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
  const modes: Array<{ id: ThemeMode; label: string }> = [
    { id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }, { id: 'system', label: 'System' },
  ];
  return (
    <div className="appearance" ref={ref} style={{ position: 'relative' }}>
      <button className="btn small" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        Appearance
      </button>
      {open && (
        <div role="dialog" aria-label="Appearance" className="panel-card" style={{ position: 'absolute', right: 0, top: 34, width: 280, zIndex: 50, boxShadow: 'var(--shadow)' }}>
          <div className="field">
            Mode
            <div className="workspaces" role="radiogroup" aria-label="Theme mode" style={{ margin: 0 }}>
              {modes.map((m) => (
                <button key={m.id} role="radio" aria-checked={appearance.settings.mode === m.id} aria-current={appearance.settings.mode === m.id ? 'page' : undefined} onClick={() => void appearance.update({ mode: m.id })}>
                  {m.label}
                </button>
              ))}
            </div>
            {appearance.settings.mode === 'system' && <small>Following Windows: currently {appearance.resolved}.</small>}
          </div>
          <div className="field">
            Accent
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {ACCENT_PRESETS.map((p) => (
                <button
                  key={p.value}
                  aria-label={p.name}
                  aria-pressed={appearance.settings.accent === p.value}
                  onClick={() => void appearance.update({ accent: p.value })}
                  style={{ width: 22, height: 22, borderRadius: '50%', background: p.value, cursor: 'pointer', border: appearance.settings.accent === p.value ? '2px solid var(--text)' : '2px solid transparent' }}
                />
              ))}
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="color" aria-label="Custom accent" value={appearance.settings.accent} onChange={(e) => void appearance.update({ accent: e.target.value })} style={{ width: 28, height: 24, padding: 0, border: 0, background: 'none' }} />
                Custom
              </label>
            </div>
            <small>Applies to app UI and the node editor only. Your media is never re-coloured.</small>
          </div>
        </div>
      )}
    </div>
  );
}

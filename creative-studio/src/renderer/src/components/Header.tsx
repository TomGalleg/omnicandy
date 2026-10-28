import { useCallback, useEffect, useRef, useState } from 'react';
import { ADVANCED_NAV, isMoreWorkspace, MORE_NAV, SIMPLE_NAV, type NavMode } from '@shared/navigation';
import type { IntegrationSnapshot } from '@shared/ipc';
import type { LiveSnapshot } from '@shared/live';
import type { AppProbeResult, WorkspaceId } from '@shared/types';
import logo from '../assets/logo.png';
import type { useAppearance } from '../useAppearance';
import { SettingsDialog } from './SettingsDialog';

interface Props {
  projectName: string;
  onProjectHome: () => void;
  workspace: WorkspaceId;
  onWorkspace: (w: WorkspaceId) => void;
  navMode: NavMode;
  onNavMode: (m: NavMode) => void;
  apps: AppProbeResult[];
  integrations: IntegrationSnapshot | null;
  appearance: ReturnType<typeof useAppearance>;
  appTheme: LiveSnapshot['appTheme'] | null;
  /** The Planner tab's live state: the planning AI is thinking, and how many things wait for the owner. */
  plannerBadge?: { busy: boolean; needs: number };
}

/** Brand, project, workspaces and Settings. Status details live in Settings and in each panel. */
export function Header({ projectName, onProjectHome, workspace, onWorkspace, navMode, onNavMode, apps, integrations, appearance, appTheme, plannerBadge }: Props) {
  const [settings, setSettings] = useState(false);
  const closeSettings = useCallback(() => setSettings(false), []);
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more) return;
    const off = (e: Event) => { if (!(e.target instanceof Node) || !moreRef.current?.contains(e.target)) setMore(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMore(false); };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [more]);
  const simple = navMode === 'simplified';
  const moreActive = simple && isMoreWorkspace(workspace);
  const moreLabel = MORE_NAV.find((n) => n.id === workspace)?.label;
  return (
    <header className="header">
      <div className="brand"><img className="brand-logo" src={logo} alt="" /> OmniCandy</div>
      <button className="project-name" title="Projects" onClick={onProjectHome}>Project: <strong>{projectName}</strong> <span aria-hidden>▾</span></button>
      <nav className="workspaces" aria-label="Workspaces">
        {(simple ? SIMPLE_NAV : ADVANCED_NAV).map((w) => (
          <button key={w.id} aria-current={workspace === w.id ? 'page' : undefined} onClick={() => onWorkspace(w.id)}
            aria-label={w.id === 'planner' && plannerBadge ? `${w.label}${plannerBadge.busy ? ', working' : ''}${plannerBadge.needs ? `, ${plannerBadge.needs} waiting for you` : ''}` : undefined}>
            {w.label}
            {w.id === 'planner' && plannerBadge?.busy && <span className="tab-working" title="The planning AI is working" aria-hidden />}
            {w.id === 'planner' && plannerBadge && plannerBadge.needs > 0 && <span className="tab-badge" title="Waiting for you" aria-hidden>{plannerBadge.needs}</span>}
          </button>
        ))}
        {simple && (
          <div className="more-menu" ref={moreRef}>
            <button aria-haspopup="menu" aria-expanded={more} aria-current={moreActive ? 'page' : undefined} onClick={() => setMore((m) => !m)}>
              {moreActive ? `More: ${moreLabel}` : 'More'} <span aria-hidden>▾</span>
            </button>
            {more && (
              <div className="more-list" role="menu" aria-label="More tools">
                {MORE_NAV.map((w) => (
                  <button key={w.id} role="menuitem" aria-current={workspace === w.id ? 'page' : undefined}
                    onClick={() => { onWorkspace(w.id); setMore(false); }}>{w.label}</button>
                ))}
              </div>
            )}
          </div>
        )}
      </nav>
      <div className="header-status">
        <button className="btn small" aria-pressed={!simple} title={simple ? 'Show every tool in the toolbar' : 'Show only the essentials'}
          onClick={() => { onNavMode(simple ? 'advanced' : 'simplified'); setMore(false); }}>{simple ? 'Simplified' : 'Advanced'}</button>
        <button className="btn small" aria-haspopup="dialog" aria-expanded={settings} onClick={() => setSettings(true)}>Settings</button>
      </div>
      {settings && <SettingsDialog appearance={appearance} appTheme={appTheme} apps={apps} integrations={integrations} onClose={closeSettings} />}
    </header>
  );
}

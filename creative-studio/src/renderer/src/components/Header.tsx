import { useCallback, useState } from 'react';
import { NAV } from '@shared/navigation';
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
  apps: AppProbeResult[];
  integrations: IntegrationSnapshot | null;
  appearance: ReturnType<typeof useAppearance>;
  appTheme: LiveSnapshot['appTheme'] | null;
  /** The Planner tab's live state: the planning AI is thinking, and how many things wait for the owner. */
  plannerBadge?: { busy: boolean; needs: number };
}

/** Brand, project, workspaces and Settings. Status details live in Settings and in each panel. */
export function Header({ projectName, onProjectHome, workspace, onWorkspace, apps, integrations, appearance, appTheme, plannerBadge }: Props) {
  const [settings, setSettings] = useState(false);
  const closeSettings = useCallback(() => setSettings(false), []);
  return (
    <header className="header">
      <div className="brand"><img className="brand-logo" src={logo} alt="" /> OmniCandy</div>
      <button className="project-name" title="Projects" onClick={onProjectHome}>Project: <strong>{projectName}</strong> <span aria-hidden>▾</span></button>
      <nav className="workspaces" aria-label="Workspaces">
        {NAV.map((w) => (
          <button key={w.id} aria-current={workspace === w.id ? 'page' : undefined} onClick={() => onWorkspace(w.id)}
            aria-label={w.id === 'planner' && plannerBadge ? `${w.label}${plannerBadge.busy ? ', working' : ''}${plannerBadge.needs ? `, ${plannerBadge.needs} waiting for you` : ''}` : undefined}>
            {w.label}
            {w.id === 'planner' && plannerBadge?.busy && <span className="tab-working" title="The planning AI is working" aria-hidden />}
            {w.id === 'planner' && plannerBadge && plannerBadge.needs > 0 && <span className="tab-badge" title="Waiting for you" aria-hidden>{plannerBadge.needs}</span>}
          </button>
        ))}
      </nav>
      <div className="header-status">
        <button className="btn small" aria-haspopup="dialog" aria-expanded={settings} onClick={() => setSettings(true)}>Settings</button>
      </div>
      {settings && <SettingsDialog appearance={appearance} appTheme={appTheme} apps={apps} integrations={integrations} onClose={closeSettings} />}
    </header>
  );
}

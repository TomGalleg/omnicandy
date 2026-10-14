import { useCallback, useState } from 'react';
import type { IntegrationSnapshot } from '@shared/ipc';
import type { LiveSnapshot } from '@shared/live';
import type { AppProbeResult, WorkspaceId } from '@shared/types';
import logo from '../assets/logo.png';
import type { useAppearance } from '../useAppearance';
import { SettingsDialog } from './SettingsDialog';

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
  appTheme: LiveSnapshot['appTheme'] | null;
}

/** Brand, project, workspaces and Settings. Status details live in Settings and in each panel. */
export function Header({ projectName, onProjectHome, workspace, onWorkspace, apps, integrations, appearance, appTheme }: Props) {
  const [settings, setSettings] = useState(false);
  const closeSettings = useCallback(() => setSettings(false), []);
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
        <button className="btn small" aria-haspopup="dialog" aria-expanded={settings} onClick={() => setSettings(true)}>Settings</button>
      </div>
      {settings && <SettingsDialog appearance={appearance} appTheme={appTheme} apps={apps} integrations={integrations} onClose={closeSettings} />}
    </header>
  );
}

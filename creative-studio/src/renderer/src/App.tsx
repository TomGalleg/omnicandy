import { useCallback, useEffect, useMemo, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import type { IntegrationSnapshot } from '@shared/ipc';
import type { AppProbeResult, ProjectManifest, WorkspaceId } from '@shared/types';
import { AssetBrowser } from './components/AssetBrowser';
import { BottomPanel, type LogEntry } from './components/BottomPanel';
import { ClaudePanel } from './components/ClaudePanel';
import { Header } from './components/Header';
import { WorkspaceView } from './components/Workspaces';
import { useAppearance } from './useAppearance';
import { useLive } from './useLive';

const storage = (() => { try { return window.localStorage; } catch { return undefined; } })();

export function App() {
  const appearance = useAppearance();
  const [workspace, setWorkspace] = useState<WorkspaceId>('media');
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [apps, setApps] = useState<AppProbeResult[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationSnapshot | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const addLog = useCallback((source: string, message: string) => {
    setLog((l) => [...l.slice(-299), { at: new Date(), source, message }]);
  }, []);

  const reloadProject = useCallback(() => {
    window.studio.loadProject().then(setManifest).catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => {
    window.studio.loadProject()
      .then((m) => { setManifest(m); setSelectedId(m.assets[0]?.id ?? null); addLog('project', `Loaded "${m.name}" (${m.assets.length} assets).`); })
      .catch((e: unknown) => setError(String(e)));
    window.studio.integrationStatus().then(setIntegrations).catch(() => {});
    window.studio.probeApps().then((r) => {
      setApps(r);
      addLog('artcraft', `Detected ${r.filter((a) => a.installed).length}/${r.length} ArtCraft apps (installed, not connected).`);
    }).catch(() => {});
  }, [addLog]);

  const liveApi = useLive(addLog);

  const selected = useMemo(() => manifest?.assets.find((a) => a.id === selectedId) ?? null, [manifest, selectedId]);

  const outer = useDefaultLayout({ id: 'cs-outer', storage });
  const center = useDefaultLayout({ id: 'cs-center', storage });

  return (
    <div className="app">
      <Header
        projectName={manifest?.name ?? '…'}
        workspace={workspace}
        onWorkspace={setWorkspace}
        apps={apps}
        integrations={integrations}
        appearance={appearance}
      />
      {error && <div className="notice" role="alert">Could not load project: {error}</div>}
      <div className="main">
        <Group orientation="horizontal" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged}>
          <Panel id="left" defaultSize="20" minSize={220} collapsible>
            <AssetBrowser
              manifest={manifest}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onManifest={setManifest}
              log={addLog}
            />
          </Panel>
          <Separator className="sep" />
          <Panel id="center" minSize="35">
            <Group orientation="vertical" defaultLayout={center.defaultLayout} onLayoutChanged={center.onLayoutChanged}>
              <Panel id="viewer" minSize="30">
                <div className="center">
                  <WorkspaceView
                    workspace={workspace}
                    manifest={manifest}
                    selected={selected}
                    apps={apps}
                    integrations={integrations}
                    resolvedTheme={appearance.resolved}
                    log={addLog}
                    onProjectChanged={reloadProject}
                    liveApi={liveApi}
                  />
                </div>
              </Panel>
              <Separator className="sep" />
              <Panel id="bottom" defaultSize="24" minSize={90} collapsible>
                <BottomPanel selected={selected} log={log} />
              </Panel>
            </Group>
          </Panel>
          <Separator className="sep" />
          <Panel id="right" defaultSize="22" minSize={260} collapsible>
            <ClaudePanel selected={selected} integrations={integrations} liveApi={liveApi} />
          </Panel>
        </Group>
      </div>
    </div>
  );
}

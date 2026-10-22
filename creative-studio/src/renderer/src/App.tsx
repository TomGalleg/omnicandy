import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout, usePanelRef, type PanelSize } from 'react-resizable-panels';
import { EDITOR_APPS, type EditorAppId } from '@shared/appEditors';
import type { IntegrationSnapshot } from '@shared/ipc';
import { parseNavMode, type NavMode } from '@shared/navigation';
import { shouldShowTimeline } from '@shared/timeline';
import type { AppProbeResult, Asset, ProjectManifest, WorkspaceId } from '@shared/types';
import { AssetBrowser } from './components/AssetBrowser';
import { BottomPanel, type LogEntry } from './components/BottomPanel';
import { ClaudePanel } from './components/ClaudePanel';
import { Header } from './components/Header';
import { WorkspaceView } from './components/Workspaces';
import { useAppearance } from './useAppearance';
import { useLive } from './useLive';

const storage = (() => { try { return window.localStorage; } catch { return undefined; } })();
const read = (k: string) => { try { return storage?.getItem(k) ?? null; } catch { return null; } };
const write = (k: string, v: string) => { try { storage?.setItem(k, v); } catch { /* storage unavailable */ } };

/** Width of the vertical tab a docked panel keeps when collapsed. */
const RAIL = 28;

/** A side panel that collapses to its vertical tab; open state and width are remembered. */
function useDock(key: string, defaultOpen: boolean) {
  const ref = usePanelRef();
  const [open, setOpen] = useState(() => { const v = read(`${key}-open`); return v === null ? defaultOpen : v === '1'; });
  const synced = useRef(false);
  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    if (open && p.isCollapsed()) {
      p.expand();
      const w = Number(read(`${key}-width`));
      if (w > RAIL) p.resize(w);
    }
    if (!open && !p.isCollapsed()) p.collapse();
    synced.current = true;
    write(`${key}-open`, open ? '1' : '0');
  }, [open, ref, key]);
  // Dragging the divider can also collapse or expand it.
  const onResize = useCallback((size: PanelSize) => {
    if (!synced.current) return;
    const collapsed = ref.current?.isCollapsed() ?? false;
    if (!collapsed) write(`${key}-width`, String(Math.round(size.inPixels)));
    setOpen(!collapsed);
  }, [ref, key]);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  return { ref, open, toggle, onResize };
}

/** Height the bottom panel keeps when folded: just its header. */
const BOTTOM_HEADER = 36;

/**
 * The bottom panel: a slim Activity strip by default, taller when it shows a timeline. Each context
 * remembers its own height and whether it is folded down to its header.
 */
function useBottom(context: 'timeline' | 'activity') {
  const ref = usePanelRef();
  const key = `cs-bottom-${context}`;
  const [open, setOpen] = useState(() => read(`${key}-open`) !== '0');
  const ready = useRef(false);
  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    ready.current = false;
    if (read(`${key}-open`) === '0') { if (!p.isCollapsed()) p.collapse(); setOpen(false); } else {
      if (p.isCollapsed()) p.expand();
      p.resize(read(`${key}-size`) ?? (context === 'timeline' ? '26%' : '13%'));
      setOpen(true);
    }
    ready.current = true;
  }, [context, key, ref]);
  const onResize = useCallback((size: PanelSize) => {
    if (!ready.current) return;
    const collapsed = ref.current?.isCollapsed() ?? false;
    if (!collapsed && size.inPixels > BOTTOM_HEADER + 4) write(`${key}-size`, `${size.asPercentage.toFixed(1)}%`);
    write(`${key}-open`, collapsed ? '0' : '1');
    setOpen(!collapsed);
  }, [ref, key]);
  const toggle = useCallback(() => {
    const p = ref.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand(); else p.collapse();
  }, [ref]);
  return { ref, open, toggle, onResize };
}

function SideTab({ label, text, open, onToggle, controls, shortcut, side }: {
  label: string; text: string; open: boolean; onToggle: () => void; controls: string; shortcut: string; side: 'left' | 'right';
}) {
  const action = `${open ? 'Hide' : 'Show'} ${label}`;
  return (
    <button className={`side-tab ${side}${open ? ' open' : ''}`} aria-expanded={open} aria-controls={controls}
      aria-label={action} aria-keyshortcuts={shortcut.replace(/\s/g, '').replace('Ctrl', 'Control')} title={`${action} (${shortcut})`} onClick={onToggle}>
      <span className="side-tab-text">{text}</span>
    </button>
  );
}

export function App() {
  const appearance = useAppearance();
  const [workspace, setWorkspace] = useState<WorkspaceId>('home');
  const [navMode, setNavModeState] = useState<NavMode>(() => parseNavMode(read('cs-nav-mode')));
  const setNavMode = useCallback((m: NavMode) => { write('cs-nav-mode', m); setNavModeState(m); }, []);
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [apps, setApps] = useState<AppProbeResult[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationSnapshot | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState<string | null>(null);

  const addLog = useCallback((source: string, message: string) => {
    setLog((l) => [...l.slice(-299), { at: new Date(), source, message }]);
  }, []);

  const reloadProject = useCallback(() => {
    window.studio.loadProject().then(setManifest).catch((e: unknown) => setError(String(e)));
  }, []);

  /** False while a project is being switched, so the old workspace is never saved into the new project. */
  const [viewReady, setViewReady] = useState(false);
  const loadCurrent = useCallback((restore = false) => {
    window.studio.projects.current().then(setProjectKey).catch(() => {});
    window.studio.loadProject()
      .then((m) => {
        setManifest(m);
        const back = restore ? m.view : undefined;
        const asset = back?.assetId && m.assets.some((a) => a.id === back.assetId) ? back.assetId : null;
        setSelectedId(asset ?? m.assets[0]?.id ?? null);
        if (back && back.workspace !== 'home') setWorkspace(back.workspace);
        setError(null);
        setViewReady(true);
        addLog('project', `Loaded "${m.name}" (${m.assets.length} assets).`);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [addLog]);

  // Remember where the user left off in this project (restored when it is opened again).
  useEffect(() => {
    if (!viewReady || workspace === 'home') return;
    const t = setTimeout(() => { void window.studio.setProjectMeta({ view: { workspace, ...(selectedId ? { assetId: selectedId } : {}) } }).catch(() => {}); }, 800);
    return () => clearTimeout(t);
  }, [viewReady, workspace, selectedId]);

  useEffect(() => {
    loadCurrent();
    window.studio.integrationStatus().then(setIntegrations).catch(() => {});
    window.studio.probeApps().then((r) => {
      setApps(r);
      addLog('artcraft', `Detected ${r.filter((a) => a.installed).length}/${r.length} ArtCraft apps (installed, not connected).`);
    }).catch(() => {});
  }, [addLog, loadCurrent]);

  const liveApi = useLive(addLog);

  // When Claude opens a file (possibly in another app), show it: select it and go to that app's tab.
  const live = liveApi.live;
  const claudeOpened = live?.status === 'ready' && live.openedBy === 'claude' && live.asset ? `${live.appId}:${live.asset.id}` : null;
  useEffect(() => {
    if (!claudeOpened || !live?.asset) return;
    const id = live.asset.id;
    if (!manifest?.assets.some((a) => a.id === id)) reloadProject();
    setSelectedId(id);
    setWorkspace(EDITOR_APPS[live.appId].tab);
    // Only when Claude opens something new, not on every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeOpened]);

  // A third-party program (Blender) opened its window for Claude: show it docked in the Software tab.
  useEffect(() => window.studio.external.onLive((s) => { if (s.pid) setWorkspace('software'); }), []);

  // New AI images (from the Generate tab or Claude) appear in the library right away.
  useEffect(() => window.studio.generate.onResult((r) => {
    reloadProject();
    if (r.requestedBy === 'claude') addLog('generate', `Claude: ${r.message}`);
  }), [reloadProject, addLog]);

  /** After switching projects: reload everything tied to the old one. */
  const onSwitched = useCallback((key: string) => {
    setViewReady(false);
    setProjectKey(key);
    loadCurrent(true);
    void liveApi.resync();
  }, [loadCurrent, liveApi]);
  // Media screen: open a file in a chosen ArtCraft app. `chosen` pins that app for that file in the app's tab.
  const [chosen, setChosen] = useState<{ assetId: string; appId: EditorAppId } | null>(null);
  const openIn = useCallback((asset: Asset, appId: EditorAppId) => {
    setChosen({ assetId: asset.id, appId });
    setSelectedId(asset.id);
    setWorkspace(EDITOR_APPS[appId].tab);
    addLog('open', `Opening ${asset.name} in ${EDITOR_APPS[appId].name}.`);
  }, [addLog]);
  const goto = useCallback((w: WorkspaceId, assetId?: string) => { if (assetId) setSelectedId(assetId); setWorkspace(w); }, []);

  const selected = useMemo(() => manifest?.assets.find((a) => a.id === selectedId) ?? null, [manifest, selectedId]);

  const outer = useDefaultLayout({ id: 'cs-outer-docks', storage });
  // Panels moved: the embedded ArtCraft window follows its stage even when only the position changed.
  const onOuterLayout = outer.onLayoutChanged;
  const onLayoutChanged = useCallback((...a: Parameters<typeof onOuterLayout>) => { onOuterLayout(...a); window.dispatchEvent(new Event('resize')); }, [onOuterLayout]);
  // Media starts open, Claude starts minimized; each side tab opens/closes its panel.
  const media = useDock('cs-media', true);
  const claude = useDock('cs-claude', false);
  const toggleMedia = media.toggle, toggleClaude = claude.toggle;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey) return;
      if (e.code === 'KeyM') { e.preventDefault(); toggleMedia(); }
      if (e.code === 'KeyC') { e.preventDefault(); toggleClaude(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleMedia, toggleClaude]);
  const bottom = useBottom(shouldShowTimeline(selected?.kind, workspace) ? 'timeline' : 'activity');

  return (
    <div className="app">
      <Header
        projectName={manifest?.name ?? '…'}
        onProjectHome={() => setWorkspace('home')}
        workspace={workspace}
        onWorkspace={setWorkspace}
        navMode={navMode}
        onNavMode={setNavMode}
        apps={apps}
        integrations={integrations}
        appearance={appearance}
        appTheme={liveApi.live?.appTheme ?? null}
      />
      {error && <div className="notice" role="alert">Could not load project: {error}</div>}
      <div className="main">
        <Group orientation="horizontal" defaultLayout={outer.defaultLayout} onLayoutChanged={onLayoutChanged}>
          <Panel id="left" defaultSize="20" minSize={RAIL + 220} collapsible collapsedSize={RAIL} panelRef={media.ref} onResize={media.onResize}>
            <div className="dock">
              <SideTab side="left" label="media library" text="Media" open={media.open} onToggle={media.toggle} controls="dock-media" shortcut="Ctrl + Shift + M" />
              <div id="dock-media" className="dock-content" hidden={!media.open}>
                <AssetBrowser
                  manifest={manifest}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onManifest={setManifest}
                  log={addLog}
                />
              </div>
            </div>
          </Panel>
          <Separator className="sep" />
          <Panel id="center" minSize="35">
            <Group orientation="vertical" onLayoutChanged={() => window.dispatchEvent(new Event('resize'))}>
              <Panel id="viewer" minSize="30">
                <div className="center">
                  <WorkspaceView
                    key={projectKey ?? 'none'}
                    projectKey={projectKey}
                    onSwitched={onSwitched}
                    onGoto={goto}
                    workspace={workspace}
                    manifest={manifest}
                    selected={selected}
                    apps={apps}
                    integrations={integrations}
                    resolvedTheme={appearance.resolved}
                    log={addLog}
                    onProjectChanged={reloadProject}
                    liveApi={liveApi}
                    onSelectAsset={setSelectedId}
                    onOpenIn={openIn}
                    chosenApp={chosen && chosen.assetId === selectedId ? chosen.appId : null}
                  />
                </div>
              </Panel>
              <Separator className="sep" />
              <Panel id="bottom" defaultSize="13" minSize={90} collapsible collapsedSize={BOTTOM_HEADER} panelRef={bottom.ref} onResize={bottom.onResize}>
                <BottomPanel workspace={workspace} selected={selected} log={log} liveApi={liveApi} manifest={manifest} open={bottom.open} onToggle={bottom.toggle} />
              </Panel>
            </Group>
          </Panel>
          <Separator className="sep" />
          <Panel id="right" defaultSize="22" minSize={RAIL + 260} collapsible collapsedSize={RAIL} panelRef={claude.ref} onResize={claude.onResize}>
            <div className="dock dock-right">
              <div id="dock-claude" className="dock-content" hidden={!claude.open}>
                <ClaudePanel key={projectKey ?? 'none'} selected={selected} integrations={integrations} liveApi={liveApi} />
              </div>
              {/* The tab stays on the far right edge of the window, like the Media tab stays on the far left. */}
              <SideTab side="right" label="your Creative Partner (Claude and other AIs)" text="Creative Partner" open={claude.open} onToggle={claude.toggle} controls="dock-claude" shortcut="Ctrl + Shift + C" />
            </div>
          </Panel>
        </Group>
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { appForTab, appsForFormat, EDITOR_APPS, type EditorApp, type EditorAppId } from '@shared/appEditors';
import type { EditMode } from '@shared/navigation';
import type { Asset, ProjectManifest, WorkspaceId } from '@shared/types';
import { useOverlayOpen } from '../overlay';
import type { LiveApi } from '../useLive';
import { isTaskActive } from './live/LiveParts';
import { quickHost } from '@shared/quickAi';
import { QuickAiPanel } from './QuickAiPanel';

interface Props {
  manifest: ProjectManifest | null;
  selected: Asset | null;
  liveApi: LiveApi;
  onProjectChanged: () => void;
  onSelectAsset: (id: string) => void;
  /** App picked from the Media screen for the selected file; used when it fits this tab and the file type. */
  chosenApp?: EditorAppId | null;
  log: (source: string, msg: string) => void;
  /** Switches tab (and selects a file), used by Quick AI to open results and the full AI Studio. */
  onGoto: (w: WorkspaceId, assetId?: string) => void;
}

type Tab = EditorApp['tab'];

const MODE_LABEL: Record<EditMode, string> = { edit: 'Edit', color: 'Color', effects: 'Effects' };
const MODE_HINT: Record<EditMode, string> = {
  edit: "The file's own editor",
  color: 'LightCraft: exposure, white balance, curves, grading and looks',
  effects: 'EffectCraft: effects, titles and animation',
};

const INTRO = {
  title: 'Pick something to edit',
  text: 'Choose a file on the left. It opens here in the right app: photos in PhotoCraft, vector art in VectorCraft, audio in SoundCraft, video in FilmCraft, layouts in DesignCraft, Word documents (.docx) in WordCraft, PDFs in PdfCraft, spreadsheets (.xlsx) in GridCraft, presentations (.deckcraft, .pptx) in DeckCraft, UI designs (.figcraft) in FigCraft and CAD drawings (.dxf, .dwg) in CADCraft. Photos and videos also get Color (LightCraft) and Effects (EffectCraft) buttons along the top.',
};

/** The modes that can open this file type: Edit always (when an app fits), Color for photos, Effects for pictures and video. */
export function modesFor(format: string): EditMode[] {
  return (['edit', 'color', 'effects'] as const).filter((m) => appForTab(m, format));
}

/** Other apps that can open this file in Edit itself (e.g. a PDF in PDFCraft or VectorCraft). */
function sameModeApps(format: string): EditorApp[] {
  return appsForFormat(format).filter((a) => a.tab === 'edit' || a.tab === 'audio');
}

/**
 * The Edit tab: the selected file opens in its ArtCraft app, shown right here in the big area,
 * where you work with the app's own tools. Photos and video also offer Color and Effects modes,
 * and a file with more than one editor gets an "Open with" list. "Open in its own window" pops
 * the app out. The library file itself is never changed; saving makes a new version.
 */
export function EditWorkspace({ mode, onMode, onOpenIn, ...p }: Props & { mode: EditMode; onMode: (m: EditMode) => void; onOpenIn: (asset: Asset, appId: EditorAppId) => void }) {
  const fmt = p.selected?.sourceFormat ?? '';
  const modes = p.selected ? modesFor(fmt) : [];
  const tab: Tab = modes.includes(mode) ? mode : 'edit';
  const alternatives = p.selected ? sameModeApps(fmt) : [];
  const current = p.selected ? (p.chosenApp && alternatives.some((a) => a.id === p.chosenApp) ? p.chosenApp : appForTab('edit', fmt)?.id) : undefined;
  const extras = p.selected && (modes.length > 1 || alternatives.length > 1) ? (
    <>
      {modes.length > 1 && (
        <div className="mode-strip" role="group" aria-label="Edit mode">
          {modes.map((m) => (
            <button key={m} className="btn small" aria-pressed={tab === m} title={MODE_HINT[m]} onClick={() => onMode(m)}>{MODE_LABEL[m]}</button>
          ))}
        </div>
      )}
      {tab === 'edit' && alternatives.length > 1 && (
        <label className="open-with">Open with{' '}
          <select value={current} onChange={(e) => onOpenIn(p.selected!, e.target.value as EditorAppId)}>
            {alternatives.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      )}
    </>
  ) : null;
  return <AppWorkspace {...p} tab={tab} barExtras={extras} />;
}

function AppWorkspace({ manifest, selected, liveApi, onProjectChanged, tab, chosenApp, log, onGoto, barExtras }: Props & { tab: Tab; barExtras?: ReactNode }) {
  const { live, busy, act } = liveApi;
  const picked = chosenApp ? EDITOR_APPS[chosenApp] : null;
  const app = selected
    ? (picked && (picked.tab === tab || (tab === 'edit' && picked.tab === 'audio')) && picked.formats.includes(selected.sourceFormat.toLowerCase()) ? picked : appForTab(tab, selected.sourceFormat))
    : null;
  const canLive = app?.open === 'live';
  const isOpen = live?.status === 'ready' && !!live.asset;
  const showingThis = isOpen && live!.asset!.id === selected?.id && live!.appId === app?.id;
  const taskActive = isTaskActive(live?.collab.phase ?? 'idle');
  const stageRef = useRef<HTMLDivElement>(null);
  const tried = useRef<string | null>(null);
  const key = selected && app ? `${app.id}:${selected.id}` : null;

  // Open the selected file in the tab's app automatically (unless an automation task is mid-way).
  // Only when you pick a file or tab: once it has been shown, Claude opening something else (and
  // this tab following it) must not reopen it.
  useEffect(() => {
    if (showingThis) { tried.current = key; return; }
    if (!selected || !app || !canLive || busy || taskActive || live?.status === 'starting') return;
    if (tried.current === key) return;
    tried.current = key;
    void act(`Open in ${app.name}`, () => window.studio.live.open(selected.id, app.id));
  }, [selected, app, key, canLive, showingThis, busy, taskActive, live?.status, act]);

  // Tell main where the app should sit; hide it when we leave the tab, it shows another file, or a
  // dialog such as Settings is open (the app's window would cover it).
  const overlay = useOverlayOpen();
  const embedVisible = !!showingThis && !live!.poppedOut && !overlay;
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      void window.studio.live.setViewport({ x: r.left, y: r.top, width: r.width, height: r.height, visible: embedVisible });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    return () => { ro.disconnect(); window.removeEventListener('resize', report); };
  }, [embedVisible]);
  useEffect(() => () => { void window.studio.live.setViewport(null); }, []);

  if (!selected) {
    return <Empty title={INTRO.title}><p>{INTRO.text}</p></Empty>;
  }
  if (selected.kind === 'model') {
    return (
      <Empty title={selected.name}>
        <p>3D models ({selected.sourceFormat.toUpperCase()}) open in your 3D programs, such as Blender, FreeCAD, Revit or Unreal, not in an Edit app. Connect or open one in the Software tab.</p>
        <div className="btn-row"><button className="btn primary" onClick={() => onGoto('software')}>Go to Software</button></div>
      </Empty>
    );
  }

  const appName = app?.name ?? 'No app';
  return (
    <div className="edit">
      <div className="edit-bar">
        <span className={`chip ${showingThis ? 'real' : 'off'}`}><span className="dot" />{appName}</span>
        <strong className="edit-title" title={selected.name}>{selected.name}</strong>
        {barExtras}
        <span className="spacer" />
        {canLive && showingThis && (
          <>
            <button className="btn" disabled={busy || taskActive} onClick={() => void act('Undo', window.studio.live.undo)}>Undo</button>
            <button className="btn primary" disabled={busy || !!live!.collab.activeOperation}
              onClick={() => void act('Save', async () => { const s = await window.studio.live.saveVersion(); onProjectChanged(); return s; })}>Save as new version</button>
            {live!.poppedOut
              ? <button className="btn" disabled={busy} onClick={() => void act('Put back', window.studio.live.dock)}>Put back in OmniCandy</button>
              : <button className="btn" disabled={busy} onClick={() => void act('Open in its own window', window.studio.live.popOut)}>Open in its own window</button>}
          </>
        )}
        {canLive && !showingThis && !busy && live?.status !== 'starting' && (
          <button className="btn primary" disabled={taskActive} onClick={() => { tried.current = key; void act(`Open in ${appName}`, () => window.studio.live.open(selected.id, app!.id)); }}>
            Open in {appName}
          </button>
        )}
      </div>
      <div className="edit-body">
        <div className="edit-stage" ref={stageRef}>
          <Stage asset={selected} app={app} live={liveApi.live} showingThis={!!showingThis} />
        </div>
        {showingThis && app && quickHost(app.id) && <QuickAiPanel appId={app.id} manifest={manifest} open={selected} selected={null} onGoto={onGoto} log={log} />}
      </div>
    </div>
  );
}

/** What sits under the app window: the art itself, with a status line while the app starts or when it's popped out. */
function Stage({ asset, app, live, showingThis }: { asset: Asset; app: EditorApp | null; live: LiveApi['live']; showingThis: boolean }) {
  const viewable = asset.kind === 'image' || asset.kind === 'vector';
  let status: string | null = null;
  if (live?.status === 'starting') status = `Opening in ${app?.name ?? 'the app'}…`;
  else if (live?.status === 'error' && !showingThis) status = live.error ?? 'The app could not be opened.';
  else if (showingThis && live?.poppedOut) status = `${app?.name} is open in its own window.`;
  else if (!app || app.open === 'none') status = app?.note ?? `No ArtCraft app edits ${asset.sourceFormat.toUpperCase()} files yet.`;
  return (
    <div className="stage-art">
      {viewable && <img src={window.studio.assetUrl(asset.id)} alt={asset.name} />}
      {asset.kind === 'video' && <video className="stage-video" controls src={window.studio.assetUrl(asset.id)} />}
      {asset.kind === 'audio' && <div className="stage-audio"><span className="stage-audio-icon" aria-hidden>♪</span><audio controls src={window.studio.assetUrl(asset.id)} /></div>}
      {!viewable && asset.kind !== 'audio' && asset.kind !== 'video' && <div className="stage-format">{asset.sourceFormat.toUpperCase()}</div>}
      {status && <div className="stage-status" role="status">{status}</div>}
    </div>
  );
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-card"><h2>{title}</h2>{children}</div></div>;
}

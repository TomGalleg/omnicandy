import { useEffect, useLayoutEffect, useRef } from 'react';
import { appForTab, EDITOR_APPS, type EditorApp, type EditorAppId } from '@shared/appEditors';
import type { Asset, ProjectManifest } from '@shared/types';
import { useOverlayOpen } from '../overlay';
import type { LiveApi } from '../useLive';
import { isTaskActive } from './live/LiveParts';

interface Props {
  manifest: ProjectManifest | null;
  selected: Asset | null;
  liveApi: LiveApi;
  onProjectChanged: () => void;
  onSelectAsset: (id: string) => void;
  /** App picked from the Media screen for the selected file; used when it fits this tab and the file type. */
  chosenApp?: EditorAppId | null;
  log: (source: string, msg: string) => void;
}

type Tab = EditorApp['tab'];

const INTRO: Record<Tab, { title: string; text: string }> = {
  edit: { title: 'Pick something to edit', text: 'Choose a file on the left. It opens here in the right app: photos in PhotoCraft, vector art in VectorCraft, audio in SoundCraft, video in FilmCraft, layouts in DesignCraft Word documents (.docx) in WordCraft, PDFs in PdfCraft spreadsheets (.xlsx) in GridCraft and presentations (.deckcraft, .pptx) in DeckCraft and UI designs (.figcraft) in FigCraft and CAD drawings (.dxf, .dwg) in CADCraft.' },
  color: { title: 'Pick a photo to colour', text: 'Choose a photo (PNG, JPEG, WebP or TIFF) on the left. It opens here in LightCraft for light and colour work: exposure, white balance, curves, colour grading and looks.' },
  effects: { title: 'Pick a picture or video', text: 'Choose a picture or a video on the left. It opens here in EffectCraft as a composition, ready for effects, titles and animation.' },
  audio: { title: 'Pick a sound', text: 'Choose an audio file (WAV, MP3, FLAC, OGG or AIFF) on the left. It opens here in SoundCraft, with its waveform and clips in the timeline below.' },
};

/** The Edit tab: the selected file opens in its ArtCraft app, shown right here. */
export function EditWorkspace(p: Props) {
  return <AppWorkspace {...p} tab="edit" />;
}

/**
 * Edit / Color / Effects: the selected file opens automatically in the tab's ArtCraft app, shown
 * right here in the big area, where you work with the app's own tools. "Open in its own window"
 * pops the app out. The library file itself is never changed; saving makes a new version.
 */
export function AppWorkspace({ selected, liveApi, onProjectChanged, tab, chosenApp }: Props & { tab: Tab }) {
  const { live, busy, act } = liveApi;
  const picked = chosenApp ? EDITOR_APPS[chosenApp] : null;
  const app = selected
    ? (picked && picked.tab === tab && picked.formats.includes(selected.sourceFormat.toLowerCase()) ? picked : appForTab(tab, selected.sourceFormat))
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
    return <Empty title={INTRO[tab].title}><p>{INTRO[tab].text}</p></Empty>;
  }

  const appName = app?.name ?? 'No app';
  return (
    <div className="edit">
      <div className="edit-bar">
        <span className={`chip ${showingThis ? 'real' : 'off'}`}><span className="dot" />{appName}</span>
        <strong className="edit-title" title={selected.name}>{selected.name}</strong>
        <span className="spacer" />
        {canLive && showingThis && (
          <>
            <button className="btn" disabled={busy || taskActive} onClick={() => void act('Undo', window.studio.live.undo)}>Undo</button>
            <button className="btn primary" disabled={busy || !!live!.collab.activeOperation}
              onClick={() => void act('Save', async () => { const s = await window.studio.live.saveVersion(); onProjectChanged(); return s; })}>Save as new version</button>
            {live!.poppedOut
              ? <button className="btn" disabled={busy} onClick={() => void act('Put back', window.studio.live.dock)}>Put back in OmniCandi</button>
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
          <Stage asset={selected} app={app} tab={tab} live={liveApi.live} showingThis={!!showingThis} />
        </div>
      </div>
    </div>
  );
}

/** What sits under the app window: the art itself, with a status line while the app starts or when it's popped out. */
function Stage({ asset, app, tab, live, showingThis }: { asset: Asset; app: EditorApp | null; tab: Tab; live: LiveApi['live']; showingThis: boolean }) {
  const viewable = asset.kind === 'image' || asset.kind === 'vector';
  let status: string | null = null;
  if (live?.status === 'starting') status = `Opening in ${app?.name ?? 'the app'}…`;
  else if (live?.status === 'error' && !showingThis) status = live.error ?? 'The app could not be opened.';
  else if (showingThis && live?.poppedOut) status = `${app?.name} is open in its own window.`;
  else if (!app && tab === 'color') status = `The Color tab works on photos. ${asset.sourceFormat.toUpperCase()} files open in the Edit tab.`;
  else if (!app && tab === 'effects') status = `The Effects tab works on pictures and video. ${asset.sourceFormat.toUpperCase()} files open in the Edit tab.`;
  else if (!app && tab === 'audio') status = `The Audio tab works on sound files. ${asset.sourceFormat.toUpperCase()} files open in the Edit tab.`;
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

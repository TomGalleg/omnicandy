import { useEffect, useLayoutEffect, useRef } from 'react';
import { editorFor, type EditorApp } from '@shared/appEditors';
import type { Asset, ProjectManifest } from '@shared/types';
import type { LiveApi } from '../useLive';
import { EditTools } from './live/EditTools';
import { isTaskActive } from './live/LiveParts';

interface Props {
  manifest: ProjectManifest | null;
  selected: Asset | null;
  liveApi: LiveApi;
  onProjectChanged: () => void;
  onSelectAsset: (id: string) => void;
  log: (source: string, msg: string) => void;
}

const LIVE = new Set(['photocraft', 'vectorcraft', 'soundcraft']);

/**
 * Edit tab: the selected file opens automatically in its ArtCraft app, shown right here in the
 * big area. Edits on the right apply in the app; "Open in its own window" pops the app out.
 */
export function EditWorkspace({ manifest, selected, liveApi, onProjectChanged, onSelectAsset, log }: Props) {
  const { live, busy, act } = liveApi;
  const app = selected ? editorFor(selected.sourceFormat) : null;
  const canLive = !!app && LIVE.has(app.id);
  const isOpen = live?.status === 'ready' && !!live.asset;
  const showingThis = isOpen && live!.asset!.id === selected?.id;
  const taskActive = isTaskActive(live?.collab.phase ?? 'idle');
  const stageRef = useRef<HTMLDivElement>(null);
  const tried = useRef<string | null>(null);

  // Open the selected file in its app automatically (unless an automation task is mid-way).
  useEffect(() => {
    if (!selected || !canLive || showingThis || busy || taskActive || live?.status === 'starting') return;
    if (tried.current === selected.id) return;
    tried.current = selected.id;
    void act(`Open in ${app!.name}`, () => window.studio.live.open(selected.id));
  }, [selected, canLive, showingThis, busy, taskActive, live?.status, act, app]);

  // Tell main where the app should sit; hide it when we leave the Edit tab or it shows another file.
  const embedVisible = showingThis && !live!.poppedOut;
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
    return <Empty title="Pick something to edit"><p>Choose a file on the left. It opens here in the right app: photos in PhotoCraft, vector art in VectorCraft, audio in SoundCraft.</p></Empty>;
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
              ? <button className="btn" disabled={busy} onClick={() => void act('Put back', window.studio.live.dock)}>Put back in CreateCraft</button>
              : <button className="btn" disabled={busy} onClick={() => void act('Open in its own window', window.studio.live.popOut)}>Open in its own window</button>}
          </>
        )}
        {canLive && !showingThis && !busy && live?.status !== 'starting' && (
          <button className="btn primary" disabled={taskActive} onClick={() => { tried.current = selected.id; void act(`Open in ${appName}`, () => window.studio.live.open(selected.id)); }}>
            Open in {appName}
          </button>
        )}
      </div>
      <div className="edit-body">
        <div className="edit-stage" ref={stageRef}>
          <Stage asset={selected} app={app} live={liveApi.live} showingThis={!!showingThis} />
        </div>
        <aside className="edit-tools" aria-label="Edits">
          {app && canLive
            ? <EditTools app={app} asset={selected} manifest={manifest} liveApi={liveApi} enabled={!!showingThis} onProjectChanged={onProjectChanged} onSelectAsset={onSelectAsset} log={log} />
            : <div className="edit-tools-empty"><h3>Edits</h3><p className="asset-meta">{app?.note ?? `No ArtCraft app edits ${selected.sourceFormat.toUpperCase()} files yet.`}</p></div>}
        </aside>
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
  return (
    <div className="stage-art">
      {viewable && <img src={window.studio.assetUrl(asset.id)} alt={asset.name} />}
      {asset.kind === 'audio' && <div className="stage-audio"><span className="stage-audio-icon" aria-hidden>♪</span><audio controls src={window.studio.assetUrl(asset.id)} /></div>}
      {!viewable && asset.kind !== 'audio' && <div className="stage-format">{asset.sourceFormat.toUpperCase()}</div>}
      {status && <div className="stage-status" role="status">{status}</div>}
    </div>
  );
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-card"><h2>{title}</h2>{children}</div></div>;
}


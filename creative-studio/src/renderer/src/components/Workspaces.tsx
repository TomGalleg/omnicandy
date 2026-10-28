import { useRef, useState } from 'react';
import { appsForFormat, type EditorAppId } from '@shared/appEditors';
import type { IntegrationSnapshot } from '@shared/ipc';
import type { AppProbeResult, Asset, ProjectManifest, WorkspaceId } from '@shared/types';
import { formatBytes, formatDims } from '../format';
import { importDropped, isFileDrag, uploadWithPicker } from '../importFiles';
import type { LiveApi } from '../useLive';
import { AssetThumb, KIND_LABEL } from './AssetBrowser';
import { DeliverWorkspace } from './DeliverWorkspace';
import { SampleMedia } from './SampleMedia';
import { AppWorkspace, EditWorkspace } from './EditWorkspace';
import { GenerateHub } from './GenerateHub';
import { HomeWorkspace } from './HomeWorkspace';
import { SoftwareWorkspace } from './SoftwareWorkspace';
import { WorkflowEditor } from './WorkflowEditor';
import { PlannerWorkspace } from '../planner/PlannerWorkspace';

interface Props {
  workspace: WorkspaceId;
  manifest: ProjectManifest | null;
  selected: Asset | null;
  apps: AppProbeResult[];
  integrations: IntegrationSnapshot | null;
  resolvedTheme: 'dark' | 'light';
  log: (source: string, msg: string) => void;
  onProjectChanged: () => void;
  liveApi: LiveApi;
  onSelectAsset: (id: string) => void;
  projectKey: string | null;
  onSwitched: (key: string) => void;
  onGoto: (w: WorkspaceId, assetId?: string) => void;
  /** Open a file in a chosen ArtCraft app (Media screen). */
  onOpenIn: (asset: Asset, appId: EditorAppId) => void;
  /** The app picked for the selected file, if any. */
  chosenApp?: EditorAppId | null;
}

export function WorkspaceView(p: Props) {
  switch (p.workspace) {
    case 'home': return <HomeWorkspace manifest={p.manifest} projectKey={p.projectKey} onSwitched={p.onSwitched} onGoto={p.onGoto} log={p.log} />;
    case 'media': return <MediaWorkspace manifest={p.manifest} asset={p.selected} onSelect={p.onSelectAsset} onOpenIn={p.onOpenIn} onProjectChanged={p.onProjectChanged} log={p.log} />;
    case 'edit': return <EditWorkspace manifest={p.manifest} selected={p.selected} liveApi={p.liveApi} onProjectChanged={p.onProjectChanged} onSelectAsset={p.onSelectAsset} chosenApp={p.chosenApp} log={p.log} onGoto={p.onGoto} />;
    case 'generate': return <GenerateHub manifest={p.manifest} selected={p.selected} onGoto={p.onGoto} log={p.log} onProjectChanged={p.onProjectChanged} />;
    case 'workflow': return <WorkflowEditor manifest={p.manifest} integrations={p.integrations} colorMode={p.resolvedTheme} log={p.log} onProjectChanged={p.onProjectChanged} />;
    case 'effects': return <AppWorkspace tab="effects" manifest={p.manifest} selected={p.selected} liveApi={p.liveApi} onProjectChanged={p.onProjectChanged} onSelectAsset={p.onSelectAsset} chosenApp={p.chosenApp} log={p.log} onGoto={p.onGoto} />;
    case 'color': return <AppWorkspace tab="color" manifest={p.manifest} selected={p.selected} liveApi={p.liveApi} onProjectChanged={p.onProjectChanged} onSelectAsset={p.onSelectAsset} chosenApp={p.chosenApp} log={p.log} onGoto={p.onGoto} />;
    case 'audio': return <AppWorkspace tab="audio" manifest={p.manifest} selected={p.selected} liveApi={p.liveApi} onProjectChanged={p.onProjectChanged} onSelectAsset={p.onSelectAsset} chosenApp={p.chosenApp} log={p.log} onGoto={p.onGoto} />;
    case 'software': return <SoftwareWorkspace apps={p.apps} />;
    case 'planner': return <PlannerWorkspace manifest={p.manifest} projectKey={p.projectKey} />;
    case 'deliver': return <DeliverWorkspace manifest={p.manifest} selected={p.selected} liveApi={p.liveApi} onSelectAsset={p.onSelectAsset} log={p.log} />;
  }
}

/** PNG rendition PhotoCraft wrote next to a .pcraft version, if any. */
function renditionOf(manifest: ProjectManifest | null, asset: Asset): Asset | undefined {
  return manifest?.assets.find((x) => x.parentId === asset.id && x.kind === 'image');
}

function MediaWorkspace({ manifest, asset, onSelect, onOpenIn, onProjectChanged, log }: { manifest: ProjectManifest | null; asset: Asset | null; onSelect: (id: string) => void; onOpenIn: (a: Asset, app: EditorAppId) => void; onProjectChanged: () => void; log: (source: string, msg: string) => void }) {
  const [dragging, setDragging] = useState(false);
  const [samples, setSamples] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const depth = useRef(0);
  // Files added by the button or a drop: reload the project's list, show what happened, and select the first new file.
  const done = (r: { text: string; error: boolean; result: { imported: Asset[] } }) => {
    setNote({ text: r.text, error: r.error });
    for (const a of r.result.imported) log('import', `Imported ${a.name}; original copied read-only.`);
    onProjectChanged();
    if (r.result.imported[0]) onSelect(r.result.imported[0].id);
  };
  const fail = (e: unknown) => setNote({ text: (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), error: true });
  let preview = <MediaPreview asset={asset} />;
  if (asset?.sourceFormat === 'pcraft') {
    const r = manifest && renditionOf(manifest, asset);
    if (r) preview = <MediaPreview asset={r} label={`${asset.name} · flattened preview`} />;
  }
  const assets = manifest?.assets ?? [];
  return (
    <div
      className="media-screen"
      style={{ position: 'relative' }}
      onDragEnter={(e) => { if (isFileDrag(e)) { depth.current++; setDragging(true); } }}
      onDragOver={(e) => { if (isFileDrag(e)) e.preventDefault(); }}
      onDragLeave={(e) => { if (isFileDrag(e) && --depth.current <= 0) { depth.current = 0; setDragging(false); } }}
      onDrop={(e) => { depth.current = 0; setDragging(false); if (!isFileDrag(e)) return; e.preventDefault(); void importDropped(e.dataTransfer.files).then(done).catch(fail); }}
    >
      {samples && <SampleMedia onClose={() => setSamples(false)} onAdded={(r) => { done(r); }} />}
      {dragging && <div className="as-drop" aria-hidden="true"><strong>Drop to add to your library</strong><span>Pictures, videos and sounds are copied in. Your originals are never changed.</span></div>}
      <div className="media-list" role="list" aria-label="All media in this project">
        <h3>All media · {assets.length}</h3>
        <div className="btn-row">
          <button className="btn small primary" onClick={() => { void uploadWithPicker().then(done).catch(fail); }} title="Choose files from your computer, or drag and drop them anywhere on this screen">⬆ Upload media</button>
          <button className="btn small" onClick={() => setSamples(true)} title="Pictures, real SVG drawings and clips that come with OmniCandy, to add to your project and try the tools on">Sample media</button>
          <span className="asset-meta">or drag files here</span>
        </div>
        {note && <div className={`wf-msg${note.error ? ' error' : ''}`} role="status">{note.text} <button className="btn small ghost" onClick={() => setNote(null)}>Dismiss</button></div>}
        {assets.length === 0 && <p className="asset-meta">No media yet. Upload files or drop them here.</p>}
        {assets.map((a) => {
          const apps = appsForFormat(a.sourceFormat);
          return (
            <div key={a.id} role="listitem" className={`media-row${a.id === asset?.id ? ' selected' : ''}`}>
              <button className="media-row-pic" onClick={() => onSelect(a.id)} title={a.name} aria-label={`Show ${a.name}`}>
                <AssetThumb asset={a} rendition={renditionOf(manifest, a)} />
                <span className="media-row-name">{a.name}</span>
                <span className="asset-meta">{KIND_LABEL[a.kind]} · {a.sourceFormat.toUpperCase()}</span>
              </button>
              <div className="media-row-apps">
                {apps.length === 0
                  ? <span className="asset-meta">No ArtCraft app opens this file type yet.</span>
                  : apps.map((app) => <button key={app.id} className="btn small" title={app.blurb} onClick={() => onOpenIn(a, app.id)}>Open in {app.name}</button>)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="media-preview">{preview}</div>
    </div>
  );
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-card"><h2>{title}</h2>{children}</div>
    </div>
  );
}

function MediaPreview({ asset, label }: { asset: Asset | null; label?: string }) {
  if (!asset) return <Empty title="No asset selected"><p>Pick something from the media browser, or import files.</p></Empty>;
  const viewable = asset.kind === 'image' || asset.kind === 'vector';
  if (asset.kind === 'audio') {
    return (
      <Empty title={asset.name}>
        <p>{formatDims(asset)} · {formatBytes(asset.bytes)}</p>
        <audio controls src={window.studio.assetUrl(asset.id)} style={{ width: '100%' }} />
      </Empty>
    );
  }
  if (asset.kind === 'video') {
    return (
      <div className="viewer">
        <div className="stage-label"><span className="chip">{asset.parentId ? 'Version · read-only' : 'Original · read-only'}</span><span className="chip">{formatDims(asset)}</span></div>
        <div className="preview-stage"><video className="stage-video" controls src={window.studio.assetUrl(asset.id)} /></div>
      </div>
    );
  }
  if (!viewable) {
    return <Empty title={asset.name}><p>{asset.sourceFormat.toUpperCase()} files have no built-in preview. Open them in the Edit tab to work on them in their ArtCraft app.</p></Empty>;
  }
  return (
    <div className="viewer">
      <div className="stage-label"><span className="chip">{label ?? (asset.parentId ? 'Version · read-only' : 'Original · read-only')}</span><span className="chip">{formatDims(asset)}</span></div>
      <div className="preview-stage"><img src={window.studio.assetUrl(asset.id)} alt={asset.name} /></div>
    </div>
  );
}

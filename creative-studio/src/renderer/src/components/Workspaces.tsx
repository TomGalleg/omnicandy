import { useEffect, useState } from 'react';
import type { IntegrationSnapshot } from '@shared/ipc';
import type { AppProbeResult, Asset, ProjectManifest, WorkspaceId } from '@shared/types';
import { formatBytes, formatDims } from '../format';
import { WorkflowEditor } from './WorkflowEditor';

interface Props {
  workspace: WorkspaceId;
  manifest: ProjectManifest | null;
  selected: Asset | null;
  apps: AppProbeResult[];
  integrations: IntegrationSnapshot | null;
  resolvedTheme: 'dark' | 'light';
  log: (source: string, msg: string) => void;
  onProjectChanged: () => void;
}

export function WorkspaceView(p: Props) {
  switch (p.workspace) {
    case 'media': return <MediaWorkspace manifest={p.manifest} asset={p.selected} />;
    case 'edit': return <EditView asset={p.selected} apps={p.apps} integrations={p.integrations} />;
    case 'generate': return <GenerateView integrations={p.integrations} />;
    case 'workflow': return <WorkflowEditor manifest={p.manifest} integrations={p.integrations} colorMode={p.resolvedTheme} log={p.log} onProjectChanged={p.onProjectChanged} />;
    case 'effects': return <Bridge title="Effects" appId="effectcraft" apps={p.apps} what="compositions, layers, effects and keyframes" />;
    case 'color': return <Bridge title="Color" appId="lightcraft" apps={p.apps} what="develop controls, presets and raw processing" />;
    case 'audio': return <Bridge title="Audio" appId="soundcraft" apps={p.apps} what="sessions, tracks, mixing and bounce" />;
    case 'deliver': return <DeliverView manifest={p.manifest} />;
  }
}

/** PNG rendition PhotoCraft wrote next to a .pcraft version, if any. */
function renditionOf(manifest: ProjectManifest | null, asset: Asset): Asset | undefined {
  return manifest?.assets.find((x) => x.parentId === asset.id && x.kind === 'image');
}

function MediaWorkspace({ manifest, asset }: { manifest: ProjectManifest | null; asset: Asset | null }) {
  if (asset?.sourceFormat === 'pcraft') {
    const r = manifest && renditionOf(manifest, asset);
    if (r) return <MediaPreview asset={r} label={`${asset.name} · flattened preview`} />;
  }
  return <MediaPreview asset={asset} />;
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
  if (!viewable) {
    return <Empty title={asset.name}><p>{asset.sourceFormat.toUpperCase()} files have no built-in preview yet. Open them in the matching ArtCraft app once the integration lands.</p></Empty>;
  }
  return (
    <div className="viewer">
      <div className="stage-label"><span className="chip">{label ?? (asset.parentId ? 'Version · read-only' : 'Original · read-only')}</span><span className="chip">{formatDims(asset)}</span></div>
      <div className="preview-stage"><img src={window.studio.assetUrl(asset.id)} alt={asset.name} /></div>
    </div>
  );
}

function AppRows({ apps }: { apps: AppProbeResult[] }) {
  return (
    <div className="app-list">
      {apps.map((a) => (
        <div className="app-row" key={a.appId}>
          <span>{a.displayName} <small>{a.version ?? ''}</small></span>
          <span className={`chip ${a.connected ? 'ok' : a.installed ? 'warn' : 'off'}`}><span className="dot" />{a.connected ? 'Connected' : a.installed ? 'Installed · not connected' : 'Not installed'}</span>
        </div>
      ))}
    </div>
  );
}

function EditView({ asset, apps, integrations }: { asset: Asset | null; apps: AppProbeResult[]; integrations: IntegrationSnapshot | null }) {
  return (
    <div className="viewer">
      <div className="stage-label"><span className="chip off"><span className="dot" />Live view: not connected</span></div>
      <Empty title="Live app view unavailable">
        <p>{integrations?.windowCapture.reason ?? 'Window capture not available.'}</p>
        <p>This area will show the real PhotoCraft window (OS window capture) in a later step. It will never show a static screenshot passed off as live.</p>
        {integrations?.appAdapters.some((a) => a.id === 'photocraft' && !a.isMock) && (
          <p><span className="chip real"><span className="dot" />PhotoCraft headless edits: real</span><br />Use an <strong>ArtCraft Edit</strong> node in the Workflow workspace to apply PhotoCraft adjustments and filters now.</p>
        )}
        {asset && <p>Selected for editing: <strong>{asset.name}</strong></p>}
        <div className="btn-row" style={{ justifyContent: 'center' }}>
          <button className="btn" disabled title="Arrives with the PhotoCraft integration">Open in PhotoCraft</button>
          <button className="btn" disabled title="Arrives with window capture">Pop out view</button>
        </div>
        <AppRows apps={apps} />
      </Empty>
    </div>
  );
}

function GenerateView({ integrations }: { integrations: IntegrationSnapshot | null }) {
  return (
    <div className="generate">
      <div className="panel-card">
        <div className="notice">No providers are configured. Only the <strong>MOCK</strong> provider is available. It makes no network calls and costs nothing.</div>
        <label className="field">Provider
          <select disabled>{integrations?.providers.map((p) => <option key={p.id}>{p.label}{p.isMock ? ' (MOCK)' : ''}</option>)}</select>
        </label>
        <label className="field">Prompt<textarea disabled placeholder="Prompt (generation available after a provider is connected)" /></label>
        <label className="field">Aspect<select disabled><option>1:1</option></select></label>
        <div className="asset-meta">Estimated cost: $0.00 (mock). Billable calls will always ask for consent first.</div>
        <button className="btn primary" disabled>Generate</button>
      </div>
      <Empty title="Results">
        <p>Generated variants will appear here for side-by-side comparison and "send to editor".</p>
        <p className="asset-meta">Midjourney: import from a folder you choose only. No automation of unofficial APIs.</p>
      </Empty>
    </div>
  );
}

function Bridge({ title, appId, apps, what }: { title: string; appId: string; apps: AppProbeResult[]; what: string }) {
  const app = apps.find((a) => a.appId === appId);
  return (
    <Empty title={`${title}: not implemented yet`}>
      <p>This workspace will bridge to <strong>{app?.displayName ?? appId}</strong> for {what}.</p>
      <p>{app ? (app.installed ? `${app.displayName} ${app.version ?? ''} is installed. Its MCP server answered the Phase 0 handshake, but no operations are wired yet.` : `${app.displayName} is not installed.`) : 'Detecting…'}</p>
      <span className="badge-mock">PLACEHOLDER</span>
    </Empty>
  );
}

function DeliverView({ manifest }: { manifest: ProjectManifest | null }) {
  return (
    <div style={{ padding: 20, display: 'grid', gap: 16, alignContent: 'start', height: '100%', overflow: 'auto' }}>
      <div className="panel-card">
        <h2 style={{ fontSize: 15 }}>Source manifest</h2>
        <p className="asset-meta">Originals in this project, with content hashes. Export presets and job queue arrive with the first real export node.</p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--text-3)' }}><th>Name</th><th>Kind</th><th>Size</th><th>SHA-256</th></tr></thead>
          <tbody>
            {manifest?.assets.map((a) => (
              <tr key={a.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 0' }}>{a.name}</td><td>{a.kind}</td><td>{formatBytes(a.bytes)}</td><td className="mono">{a.sha256.slice(0, 16)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ExportsCard />
    </div>
  );
}

function ExportsCard() {
  const [files, setFiles] = useState<Array<{ name: string; bytes: number; modified: string }> | null>(null);
  useEffect(() => { void window.studio.listExports().then(setFiles); }, []);
  return (
    <div className="panel-card">
      <h2 style={{ fontSize: 15 }}>Exports</h2>
      <p className="asset-meta">Files written by Export nodes into the project's exports folder.</p>
      {files?.length === 0 && <p className="asset-meta">No exports yet. Add an Export node after an ArtCraft Edit and run the workflow.</p>}
      {files?.map((f) => (
        <div className="export-row" key={f.name}>
          <span>{f.name} <span className="asset-meta">· {formatBytes(f.bytes)} · {new Date(f.modified).toLocaleString()}</span></span>
          <button className="btn small" onClick={() => void window.studio.revealExport(f.name)}>Show in folder</button>
        </div>
      ))}
    </div>
  );
}

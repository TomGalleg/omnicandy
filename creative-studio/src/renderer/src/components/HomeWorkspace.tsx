import { useCallback, useEffect, useState } from 'react';
import type { ProjectManifest, ProjectSummary } from '@shared/types';
import type { WorkflowGraph } from '@shared/workflow';
import { formatBytes } from '../format';

interface Props {
  manifest: ProjectManifest | null;
  projectKey: string | null;
  onSwitched: (key: string) => void;
  onGoto: (workspace: 'edit' | 'media' | 'workflow' | 'deliver', assetId?: string) => void;
  log: (source: string, msg: string) => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Project Home (all projects) + Project Overview (the open one). */
export function HomeWorkspace({ manifest, projectKey, onSwitched, onGoto, log }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<{ key: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => { void window.studio.projects.list().then(setProjects); }, []);
  useEffect(reload, [reload, projectKey, manifest?.updatedAt]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(errText(e)); } finally { setBusy(false); reload(); }
  };
  const open = (p: ProjectSummary) => run(async () => {
    await window.studio.projects.open(p.id);
    log('project', `Opened "${p.name}".`);
    onSwitched(p.id);
  });
  const create = () => run(async () => {
    const name = newName.trim() || 'Untitled project';
    const key = await window.studio.projects.create(name);
    await window.studio.projects.open(key);
    setNewName('');
    log('project', `Created and opened "${name}". Import files to get started.`);
    onSwitched(key);
  });

  return (
    <div className="home">
      <section className="home-section">
        <div className="home-head">
          <h2>Projects</h2>
          <form className="new-project" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <input aria-label="New project name" placeholder="New project name" value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} />
            <button className="btn primary" type="submit" disabled={busy}>New project</button>
          </form>
        </div>
        {error && <div className="wf-msg error" role="alert">{error}</div>}
        <div className="project-grid">
          {projects?.map((p) => (
            <article key={p.id} className={`project-card${p.isOpen ? ' open' : ''}`}>
              <button className="project-thumb" onClick={() => (p.isOpen ? onGoto('media') : void open(p))} disabled={busy} aria-label={p.isOpen ? `Go to ${p.name}` : `Open ${p.name}`}>
                {p.thumbAssetId ? <img src={window.studio.projects.assetUrl(p.id, p.thumbAssetId)} alt="" /> : <span>No files yet</span>}
              </button>
              <div className="project-body">
                {renaming?.key === p.id ? (
                  <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await window.studio.projects.rename(p.id, renaming.name); setRenaming(null); }); }}>
                    <input autoFocus aria-label="Project name" value={renaming.name} maxLength={80} onChange={(e) => setRenaming({ key: p.id, name: e.target.value })}
                      onBlur={() => setRenaming(null)} onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(null); }} />
                  </form>
                ) : (
                  <strong className="project-name-line" title={p.name}>{p.name}{p.isOpen && <span className="chip real">Open</span>}</strong>
                )}
                <span className="asset-meta">{p.originals} file{p.originals === 1 ? '' : 's'} · {p.versions} version{p.versions === 1 ? '' : 's'} · edited {when(p.updatedAt)}</span>
                <div className="btn-row">
                  {!p.isOpen && <button className="btn small primary" disabled={busy} onClick={() => void open(p)}>Open</button>}
                  <button className="btn small" disabled={busy} onClick={() => setRenaming({ key: p.id, name: p.name })}>Rename</button>
                  <button className="btn small" onClick={() => void window.studio.projects.reveal(p.id)}>Show folder</button>
                  {!p.isOpen && !p.isSample && (
                    <button className="btn small danger" disabled={busy}
                      onClick={() => { if (window.confirm(`Move "${p.name}" to the Recycle Bin? You can restore it from there.`)) void run(() => window.studio.projects.remove(p.id)); }}>Remove</button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
      {manifest && projectKey && <Overview manifest={manifest} projectKey={projectKey} onGoto={onGoto} />}
    </div>
  );
}

function Overview({ manifest, projectKey, onGoto }: { manifest: ProjectManifest; projectKey: string; onGoto: Props['onGoto'] }) {
  const [workflow, setWorkflow] = useState<WorkflowGraph | null>(null);
  const [exportsList, setExports] = useState<Array<{ name: string; bytes: number; modified: string }>>([]);
  useEffect(() => {
    void window.studio.loadWorkflow().then(setWorkflow);
    void window.studio.listExports().then(setExports);
  }, [projectKey, manifest.updatedAt]);

  const originals = manifest.assets.filter((a) => !a.parentId);
  const versions = manifest.assets.filter((a) => a.parentId).slice().sort((a, b) => b.provenance.createdAt.localeCompare(a.provenance.createdAt));
  const byKind = originals.reduce<Record<string, number>>((m, a) => ({ ...m, [a.kind]: (m[a.kind] ?? 0) + 1 }), {});
  const bytes = manifest.assets.reduce((n, a) => n + a.bytes, 0);
  const viewable = (k: string) => k === 'image' || k === 'vector';

  return (
    <section className="home-section">
      <div className="home-head">
        <h2>Overview · {manifest.name}</h2>
        <div className="btn-row">
          <button className="btn small" onClick={() => void window.studio.importAssets().then(() => onGoto('media'))}>Import files…</button>
          <button className="btn small" onClick={() => void window.studio.projects.reveal(projectKey)}>Show folder</button>
        </div>
      </div>
      <div className="overview-grid">
        <div className="panel-card">
          <h3>Files</h3>
          <div className="stat-row">
            <div className="stat"><strong>{originals.length}</strong><span>originals</span></div>
            <div className="stat"><strong>{versions.length}</strong><span>versions</span></div>
            <div className="stat"><strong>{exportsList.length}</strong><span>exports</span></div>
            <div className="stat"><strong>{formatBytes(bytes)}</strong><span>stored</span></div>
          </div>
          <div className="asset-meta">{Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(' · ') || 'No files yet — import some to start.'}</div>
          <div className="asset-meta">Created {when(manifest.createdAt)} · last change {when(manifest.updatedAt)}</div>
          <div className="asset-meta">Originals are never changed; every edit is saved as a new version.</div>
        </div>
        <div className="panel-card">
          <h3>Recent versions</h3>
          {versions.length === 0 && <div className="asset-meta">None yet. Edit a file and press “Save as new version”.</div>}
          <div className="recent-grid">
            {versions.slice(0, 8).map((v) => (
              <button key={v.id} className="recent" title={`${v.name}\n${v.provenance.source}`} onClick={() => onGoto('edit', v.parentId && !viewable(v.kind) ? v.parentId : v.id)}>
                <span className="thumb">{viewable(v.kind) ? <img src={window.studio.assetUrl(v.id)} alt="" /> : <span>{v.sourceFormat.toUpperCase()}</span>}</span>
                <span className="asset-name">{v.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="panel-card">
          <h3>Workflow</h3>
          <div className="asset-meta">{workflow ? `${workflow.nodes.length} step${workflow.nodes.length === 1 ? '' : 's'}, ${workflow.edges.length} connection${workflow.edges.length === 1 ? '' : 's'}` : '…'}</div>
          <button className="btn small" onClick={() => onGoto('workflow')}>Open workflow</button>
        </div>
        <div className="panel-card">
          <h3>Exports</h3>
          {exportsList.length === 0 && <div className="asset-meta">No exports yet.</div>}
          {exportsList.slice(0, 5).map((f) => <div key={f.name} className="asset-meta">{f.name} · {formatBytes(f.bytes)}</div>)}
          <button className="btn small" onClick={() => onGoto('deliver')}>Open Deliver</button>
        </div>
      </div>
    </section>
  );
}

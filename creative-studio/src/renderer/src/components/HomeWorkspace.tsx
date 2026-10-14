import { useCallback, useEffect, useState } from 'react';
import { briefFromPlan, PROJECT_KINDS, projectKindLabel, type ProjectKind, type ProjectPlan } from '@shared/projectPlan';
import type { ProjectManifest, ProjectSummary, WorkspaceId } from '@shared/types';
import type { WorkflowGraph } from '@shared/workflow';
import type { PendingReference } from '@shared/ipc';
import type { WorkflowTemplate } from '@shared/workflowControl';
import { formatBytes } from '../format';

interface Props {
  manifest: ProjectManifest | null;
  projectKey: string | null;
  onSwitched: (key: string) => void;
  onGoto: (workspace: WorkspaceId, assetId?: string) => void;
  log: (source: string, msg: string) => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const workspaceFor = (kind: ProjectKind | undefined): WorkspaceId => PROJECT_KINDS.find((k) => k.id === kind)?.workspace ?? 'media';

/** Project Home (prompt-first creation, recent projects) + Project Overview (the open one). */
export function HomeWorkspace({ manifest, projectKey, onSwitched, onGoto, log }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [location, setLocation] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // AI-first creation
  const [request, setRequest] = useState('');
  const [answers, setAnswers] = useState('');
  const [plan, setPlan] = useState<ProjectPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [refs, setRefs] = useState<PendingReference[]>([]);
  // Blank project
  const [blank, setBlank] = useState(false);
  const [newName, setNewName] = useState('');
  const [blankKind, setBlankKind] = useState<ProjectKind>('mixed');
  const [search, setSearch] = useState('');
  // Templates
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [useRecommended, setUseRecommended] = useState(true);

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
  const createBlank = () => run(async () => {
    const name = newName.trim() || 'Untitled project';
    const key = await window.studio.projects.create(name, location ?? undefined, { kind: blankKind });
    await window.studio.projects.open(key);
    setNewName(''); setLocation(null); setBlank(false);
    log('project', `Created and opened "${name}". Import files to get started.`);
    onSwitched(key);
  });

  const openTemplates = () => {
    setShowTemplates((v) => !v);
    void window.studio.listWorkflowTemplates().then(setTemplates).catch((e) => setError(errText(e)));
  };
  /** A new project whose workflow is the template (file choices stay empty; nothing runs or bills). */
  const startFromTemplate = (t: WorkflowTemplate) => run(async () => {
    const meta = { kind: (t.kind ?? 'mixed') as ProjectKind, brief: `${t.name}: ${t.description}${t.needs ? `

Needs: ${t.needs}` : ''}`, objective: t.description };
    const key = await window.studio.projects.create(t.name, location ?? undefined, meta);
    await window.studio.projects.open(key);
    await window.studio.useWorkflowTemplate(t.id);
    setShowTemplates(false); setLocation(null);
    log('project', `Created "${t.name}" from a template. Import your files, pick them in the Files step, then run the workflow.`);
    onSwitched(key);
    onGoto('workflow');
  });
  /** One real Claude call. Nothing is created and nothing paid starts until the plan is approved. */
  const makePlan = async () => {
    const text = [request.trim(), answers.trim() && `My answers to your questions: ${answers.trim()}`].filter(Boolean).join('\n\n');
    if (text.length < 3) return;
    setPlanning(true); setError(null);
    try { setPlan(await window.studio.claude.planProject(text)); } catch (e) { setError(errText(e)); } finally { setPlanning(false); }
  };
  const approvePlan = () => run(async () => {
    if (!plan) return;
    const meta = { kind: plan.kind, brief: briefFromPlan(request, plan), objective: plan.steps[0] };
    const key = await window.studio.projects.create(plan.name.trim() || 'Untitled project', location ?? undefined, meta);
    await window.studio.projects.open(key);
    log('project', `Created "${plan.name}" from your description.`);
    onSwitched(key);
    const kind = plan.kind;
    const tpl = useRecommended && plan.template ? plan.template : null;
    if (tpl) await window.studio.useWorkflowTemplate(tpl);
    // Start the new project's chat with the planning exchange (saved inside the project folder).
    void window.studio.claude.seed(request.trim(), `${plan.finishedOutput}\n\n${plan.summary}\n\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
    setPlan(null); setRequest(''); setAnswers(''); setLocation(null);
    // Reference files are copied only now, after approval: into Assets/Originals, hashed, never modified.
    let imported = 0;
    if (refs.length) {
      const r = await window.studio.references.import();
      imported = r.imported.length;
      setRefs([]);
      log('project', `Imported ${imported} reference file${imported === 1 ? '' : 's'}${r.errors.length ? `; ${r.errors.length} failed: ${r.errors.join('; ')}` : ''}.`);
    }
    onGoto(imported ? 'media' : tpl ? 'workflow' : workspaceFor(kind));
  });

  const q = search.trim().toLowerCase();
  const shown = projects?.filter((p) => !q || `${p.name} ${p.brief ?? ''} ${projectKindLabel(p.kind)}`.toLowerCase().includes(q));
  const folderLabel = location ? (location.split(/[\\/]/).filter(Boolean).at(-1) ?? location) : null;

  return (
    <div className="home">
      <section className="home-hero">
        <h1>What would you like to create?</h1>
        <textarea aria-label="Describe what you would like to create" rows={3} maxLength={4000} disabled={planning || busy || !!plan}
          placeholder="For example: a cinematic poster from my desert photo, with a bold title and a print-ready export."
          value={request} onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void makePlan(); }} />
        <div className="btn-row">
          <button className="btn primary" disabled={planning || busy || !!plan || request.trim().length < 3} onClick={() => void makePlan()}>
            {planning ? 'Claude is thinking…' : 'Create with Claude'}
          </button>
          <button className="btn" disabled={busy} onClick={() => setBlank((v) => !v)}>New blank project</button>
          <button className="btn" disabled={busy}
            onClick={() => void run(async () => { const key = await window.studio.projects.openExisting(); if (key) { await window.studio.projects.open(key); onSwitched(key); } })}>Open existing project…</button>
          <button className="btn" disabled={busy} aria-pressed={showTemplates} onClick={openTemplates}>Templates</button>
          <button className="btn small ghost" type="button" disabled={busy} title={location ?? 'Uses the project folder from Settings'}
            onClick={() => void window.studio.projects.pickFolder().then((d) => { if (d) setLocation(d); })}>
            {folderLabel ? `Save in: ${folderLabel}` : 'Default folder · Choose…'}
          </button>
          {location && <button className="btn small ghost" type="button" aria-label="Use the default project folder" onClick={() => setLocation(null)}>✕</button>}
        </div>
        <div className="btn-row">
          <button className="btn small" disabled={planning || busy || !!plan} onClick={() => void window.studio.references.pick().then(setRefs).catch((e) => setError(errText(e)))}>Add reference files…</button>
          {refs.map((r) => (
            <span key={r.id} className="chip" title={`${r.kind} · ${formatBytes(r.bytes)}`}>
              {r.name}
              <button className="btn small ghost" type="button" aria-label={`Remove ${r.name}`} disabled={planning || busy}
                onClick={() => void window.studio.references.remove(r.id).then(setRefs)}>✕</button>
            </span>
          ))}
        </div>
        <div className="asset-meta">Claude only plans first. Nothing is created, copied or paid until you approve{refs.length ? `; your ${refs.length} reference file${refs.length === 1 ? '' : 's'} stay where they are until then` : ''}.</div>
        {blank && (
          <form className="new-project" onSubmit={(e) => { e.preventDefault(); void createBlank(); }}>
            <input aria-label="New project name" placeholder="Project name" value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} />
            <select aria-label="Project type" value={blankKind} onChange={(e) => setBlankKind(e.target.value as ProjectKind)}>
              {PROJECT_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <button className="btn primary" type="submit" disabled={busy}>Create project</button>
          </form>
        )}
        {error && <div className="wf-msg error" role="alert">{error}</div>}
        {showTemplates && (
          <div className="plan-card panel-card" role="region" aria-label="Creative templates">
            <h3>Templates</h3>
            <p className="asset-meta">Each template is a real workflow you can edit. Starting one only creates a project and fills in the steps: you choose the files, and nothing runs or bills until you start it and approve any price.</p>
            <ul className="template-list">
              {templates.map((t) => (
                <li key={t.id} className="template-item">
                  <strong>{t.name}</strong>
                  {' '}<span className={`chip ${t.status === 'ready' ? 'real' : ''}`}>{t.builtin ? ({ ready: 'Ready: local apps only', paid: 'Uses paid AI (asks first)', partial: 'Partly manual' } as Record<string, string>)[t.status ?? 'partial'] : 'Saved by you'}</span>
                  <div>{t.description}</div>
                  {t.needs && <div className="asset-meta">{t.needs}</div>}
                  <div className="btn-row"><button className="btn small primary" disabled={busy} onClick={() => void startFromTemplate(t)}>Start a project with this</button></div>
                </li>
              ))}
            </ul>
            <p className="asset-meta">Your own templates: finish a workflow successfully, then Workflow tab → Templates → Save. They appear here while that project is open.</p>
          </div>
        )}
        {plan && (
          <div className="plan-card panel-card" role="region" aria-label="Claude's plan">
            <h3>Claude's plan</h3>
            <div className="plan-fields">
              <label className="plan-field">Project name
                <input value={plan.name} maxLength={80} onChange={(e) => setPlan({ ...plan, name: e.target.value })} />
              </label>
              <label className="plan-field">Type
                <select value={plan.kind} onChange={(e) => setPlan({ ...plan, kind: e.target.value as ProjectKind })}>
                  {PROJECT_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                </select>
              </label>
            </div>
            <p><strong>Finished result:</strong> {plan.finishedOutput}</p>
            <p>{plan.summary}</p>
            {plan.apps.length > 0 && <p><strong>Apps:</strong> {plan.apps.join(', ')}</p>}
            {plan.aiTools.length > 0 && <p><strong>AI tools:</strong> {plan.aiTools.join('; ')} <span className="asset-meta">(every paid image shows its price and asks first)</span></p>}
            {plan.template && templates.length >= 0 && (
              <label className="plan-field"><span><input type="checkbox" checked={useRecommended} onChange={(e) => setUseRecommended(e.target.checked)} />{' '}
                Start from Claude's recommended template: <strong>{plan.template.replace(/^builtin-/, '').replace(/-/g, ' ')}</strong> (you can edit it; nothing runs or bills on its own)</span></label>
            )}
            <ol className="plan-steps">{plan.steps.map((st, i) => <li key={i}>{st}</li>)}</ol>
            {plan.questions.length > 0 && (
              <div className="plan-questions">
                <strong>Claude would like to know:</strong>
                <ul>{plan.questions.map((qq, i) => <li key={i}>{qq}</li>)}</ul>
                <textarea aria-label="Your answers" rows={2} maxLength={1000} placeholder="Your answers (optional)" value={answers} onChange={(e) => setAnswers(e.target.value)} />
                <button className="btn small" disabled={planning || !answers.trim()} onClick={() => void makePlan()}>{planning ? 'Claude is thinking…' : 'Update the plan'}</button>
              </div>
            )}
            {refs.length > 0 && <p className="asset-meta">On approval, {refs.length} reference file{refs.length === 1 ? '' : 's'} will be copied into the project's Assets/Originals (read-only, with checksum and origin).</p>}
            <div className="btn-row">
              <button className="btn primary" disabled={busy || planning} onClick={() => void approvePlan()}>Approve and create project</button>
              <button className="btn" disabled={busy || planning} onClick={() => setPlan(null)}>Change my request</button>
            </div>
          </div>
        )}
      </section>

      <section className="home-section">
        <div className="home-head">
          <h2>Recent projects</h2>
          <input className="search-input" type="search" aria-label="Search projects" placeholder="Search projects" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="project-grid">
          {shown?.map((p) => (
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
                {p.kind && <span className="asset-meta">{projectKindLabel(p.kind)}</span>}
                {p.brief && <span className="project-brief" title={p.brief}>{p.brief.split('\n')[0]}</span>}
                <span className="asset-meta" title={p.folder}>{p.missing ? `Folder not found: ${p.folder}` : `${p.originals} file${p.originals === 1 ? '' : 's'} · ${p.versions} version${p.versions === 1 ? '' : 's'} · edited ${when(p.updatedAt)}`}</span>
                <div className="btn-row">
                  {!p.isOpen && !p.missing && <button className="btn small primary" disabled={busy} onClick={() => void open(p)}>Open</button>}
                  {p.missing && <button className="btn small primary" disabled={busy} onClick={() => void run(async () => { await window.studio.projects.locate(p.id); })}>Locate…</button>}
                  {!p.missing && <button className="btn small" disabled={busy} onClick={() => setRenaming({ key: p.id, name: p.name })}>Rename</button>}
                  {!p.missing && <button className="btn small" onClick={() => void window.studio.projects.reveal(p.id)}>Show folder</button>}
                  {!p.missing && <button className="btn small" disabled={busy} onClick={() => void run(async () => { await window.studio.projects.duplicate(p.id); })}>Duplicate…</button>}
                  {!p.missing && !p.isOpen && !p.isSample && <button className="btn small" disabled={busy} title="Copies and checks every file before the old folder is removed"
                    onClick={() => void run(async () => { await window.studio.projects.move(p.id); })}>Move…</button>}
                  {!p.isOpen && !p.isSample && (
                    <button className="btn small danger" disabled={busy}
                      onClick={() => { if (window.confirm(`Move "${p.name}" to the Recycle Bin? You can restore it from there.`)) void run(() => window.studio.projects.remove(p.id)); }}>Remove</button>
                  )}
                </div>
              </div>
            </article>
          ))}
          {shown && shown.length === 0 && <div className="asset-meta">{q ? 'No projects match your search.' : 'No projects yet.'}</div>}
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
  const latest = manifest.assets.filter((a) => viewable(a.kind)).slice().sort((a, b) => b.provenance.createdAt.localeCompare(a.provenance.createdAt))[0];
  // Results (new versions and AI generations) the user has not approved or rejected yet.
  const review = manifest.assets.filter((a) => a.approval === 'none' && (a.parentId || a.provenance.origin === 'generated'))
    .sort((a, b) => b.provenance.createdAt.localeCompare(a.provenance.createdAt));
  const progress: Array<[string, boolean]> = [
    ['Files added', originals.length > 0],
    ['Edited or generated', versions.length > 0],
    ['Reviewed', manifest.assets.some((a) => a.approval === 'approved')],
    ['Exported', exportsList.length > 0],
  ];
  const resume = manifest.view && manifest.view.workspace !== 'home' && (!manifest.view.assetId || manifest.assets.some((a) => a.id === manifest.view?.assetId))
    ? manifest.view : null;
  const cont = () => {
    if (resume) onGoto(resume.workspace, resume.assetId);
    else onGoto(manifest.assets.length ? 'media' : (PROJECT_KINDS.find((k) => k.id === manifest.kind)?.workspace ?? 'media'));
  };

  return (
    <section className="home-section">
      <div className="home-head">
        <h2>{manifest.name}{manifest.kind && <span className="chip">{projectKindLabel(manifest.kind)}</span>}</h2>
        <div className="btn-row">
          <button className="btn primary" onClick={cont}>Continue creating</button>
          <button className="btn small" onClick={() => void window.studio.importAssets().then(() => onGoto('media'))}>Import files…</button>
          <button className="btn small" onClick={() => void window.studio.projects.reveal(projectKey)}>Show folder</button>
        </div>
      </div>
      {(manifest.brief || manifest.objective) && (
        <div className="overview-grid">
          {manifest.brief && <div className="panel-card"><h3>Creative brief</h3><div className="brief-text">{manifest.brief}</div></div>}
          {manifest.objective && <div className="panel-card"><h3>Claude's current objective</h3><div className="brief-text">{manifest.objective}</div>
            <div className="asset-meta">Claude starts nothing paid on its own; each generation asks for your approval.</div></div>}
        </div>
      )}
      <div className="overview-grid">
        <div className="panel-card">
          <h3>Progress</h3>
          <ul className="progress-list">{progress.map(([label, done]) => <li key={label} className={done ? 'done' : ''}>{done ? '✓' : '○'} {label}</li>)}</ul>
          <div className="stat-row">
            <div className="stat"><strong>{originals.length}</strong><span>originals</span></div>
            <div className="stat"><strong>{versions.length}</strong><span>versions</span></div>
            <div className="stat"><strong>{exportsList.length}</strong><span>exports</span></div>
            <div className="stat"><strong>{formatBytes(bytes)}</strong><span>stored</span></div>
          </div>
          <div className="asset-meta">{Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(' · ') || 'No files yet — import some to start.'}</div>
          <div className="asset-meta">Created {when(manifest.createdAt)} · last change {when(manifest.updatedAt)}</div>
        </div>
        <div className="panel-card">
          <h3>Latest artwork</h3>
          {!latest && <div className="asset-meta">Nothing to show yet.</div>}
          {latest && (
            <button className="recent latest" title={latest.name} onClick={() => onGoto('edit', latest.id)}>
              <span className="thumb"><img src={window.studio.assetUrl(latest.id)} alt="" /></span>
              <span className="asset-name">{latest.name}</span>
            </button>
          )}
        </div>
        <div className="panel-card">
          <h3>Waiting for your review</h3>
          {review.length === 0 && <div className="asset-meta">Nothing is waiting.</div>}
          <div className="recent-grid">
            {review.slice(0, 4).map((v) => (
              <button key={v.id} className="recent" title={v.name} onClick={() => onGoto('media', v.id)}>
                <span className="thumb">{viewable(v.kind) ? <img src={window.studio.assetUrl(v.id)} alt="" /> : <span>{v.sourceFormat.toUpperCase()}</span>}</span>
                <span className="asset-name">{v.name}</span>
              </button>
            ))}
          </div>
          {review.length > 4 && <div className="asset-meta">and {review.length - 4} more in the Media library</div>}
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
          <h3>Recent exports</h3>
          {exportsList.length === 0 && <div className="asset-meta">No exports yet.</div>}
          {exportsList.slice(0, 5).map((f) => <div key={f.name} className="asset-meta">{f.name} · {formatBytes(f.bytes)}</div>)}
          <button className="btn small" onClick={() => onGoto('deliver')}>Open Deliver</button>
        </div>
      </div>
    </section>
  );
}

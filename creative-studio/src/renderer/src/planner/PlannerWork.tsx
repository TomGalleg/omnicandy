import { useContext, useEffect, useMemo, useState } from 'react';
import { EDITOR_APPS } from '@shared/appEditors';
import {
  isClaimLive, PRIORITIES, type AppRef, type ExecPackage, type PlanAsset, type PlannerProject, type PlanReport, type PlanTask, type Priority, type ReportDraft, uncoveredChecks, unmetDependencies,
} from '@shared/planner';
import type { PackageView, PlannerConnectionInfo } from '@shared/plannerApi';
import { PLANNER_CLIENTS } from '@shared/plannerClients';
import { parseReportText, type ReportImportPreview } from '@shared/plannerHandoff';
import type { ProjectManifest } from '@shared/types';
import { describeWorkflowRun, displayStatus, SIMPLE_STATUSES } from '@shared/plannerView';
import { classifyPaste, changesThePlan, describeChange, type SuggestionPreview } from '@shared/plannerPaste';
import { AskPanel, SendPanel } from './PlannerSend';
import { CopyButton, ErrorLine, errMsg, lines, PlainWords, Section, StatusChip, useAction, when, type TabProps } from './plannerUi';

const api = () => window.studio.planner;
const NATIVE = Object.values(EDITOR_APPS).map((a) => ({ id: a.id, name: a.name }));

// ============================================================================================================== tasks
function TaskForm({ p, reload, task, onDone, projectKey, projectName }: { p: PlannerProject; reload: () => Promise<void>; task?: PlanTask; onDone?: () => void; projectKey?: string | null; projectName?: string }) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'normal');
  const [checks, setChecks] = useState(task ? task.completionChecks.map((c) => c.text).join('\n') : '');
  const [deps, setDeps] = useState<string[]>(task?.dependsOn ?? []);
  const [milestone, setMilestone] = useState(task?.milestoneId ?? '');
  const [app, setApp] = useState(task?.appRef ? `${task.appRef.kind}:${task.appRef.id}` : '');
  const [appNote, setAppNote] = useState(task?.appRef?.note ?? '');
  const a = useAction(reload);
  const appRef = (): AppRef | null => (app ? { kind: app.startsWith('native:') ? 'native' : app.startsWith('workflow:') ? 'workflow' : 'external', id: app.slice(app.indexOf(':') + 1), note: appNote } : null);
  const save = () => a.run(async () => {
    if (task) {
      const keep = new Map(task.completionChecks.map((c) => [c.text, c]));
      await api().updateTask(p.id, task.id, { title, description, priority, dependsOn: deps, appRef: appRef(), milestoneId: milestone || null, completionChecks: lines(checks).map((text) => keep.get(text) ?? { id: `chk_${Math.random().toString(36).slice(2, 10)}`, text, kind: 'review' }) }, task.rev);
    } else {
      await api().addTask(p.id, { title, description, priority, dependsOn: deps, milestoneId: milestone || null, checks: lines(checks).map((text) => ({ text })), appRef: appRef() });
      setTitle(''); setDescription(''); setChecks(''); setDeps([]); setApp('');
    }
    onDone?.();
  });
  return (
    <div className="pl-form">
      <label>Task<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" /></label>
      <label>Details<textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label>How will we know it is done? (one check per line: tests, review, dimensions, export, citations...)<textarea rows={2} value={checks} onChange={(e) => setChecks(e.target.value)} /></label>
      <div className="pl-two">
        <label>Priority<select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>{PRIORITIES.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Uses (optional)
          <select value={app} onChange={(e) => setApp(e.target.value)}>
            <option value="">Nothing specific</option>
            <optgroup label="CreateCraft apps">{NATIVE.map((n) => <option key={n.id} value={`native:${n.id}`}>{n.name}</option>)}</optgroup>
            {projectKey && <optgroup label="Workflow"><option value={`workflow:${projectKey}`}>The workflow of {projectName ?? 'this CreateCraft project'}</option></optgroup>}
            {app && !app.startsWith('native:') && app !== `workflow:${projectKey}` && <option value={app}>{app.startsWith('workflow:') ? 'A workflow in another CreateCraft project' : app}</option>}
          </select>
        </label>
      </div>
      {p.milestones.length > 0 && <label>Milestone<select value={milestone} onChange={(e) => setMilestone(e.target.value)}><option value="">None</option>{p.milestones.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label>}
      {app && <label>Note about how it is used<input value={appNote} onChange={(e) => setAppNote(e.target.value)} /></label>}
      {p.tasks.filter((t) => t.id !== task?.id).length > 0 && (
        <fieldset><legend>Waits for</legend>
          {p.tasks.filter((t) => t.id !== task?.id).map((t) => <label key={t.id} className="pl-check"><input type="checkbox" checked={deps.includes(t.id)} onChange={(e) => setDeps(e.target.checked ? [...deps, t.id] : deps.filter((x) => x !== t.id))} />{t.title}</label>)}
        </fieldset>
      )}
      <div><button className="btn primary" disabled={a.busy || !title.trim()} onClick={() => void save()}>{task ? 'Save task' : 'Add task'}</button>{onDone && <button className="btn" onClick={onDone}>Cancel</button>}</div>
      <ErrorLine error={a.error} />
    </div>
  );
}

/** Read-only progress of the workflow a task points at. It never starts, approves or accepts anything: that stays in the Workflow tab and with the owner. */
function WorkflowStatus({ appId, projectKey }: { appId: string; projectKey?: string | null }) {
  const [line, setLine] = useState<string | null>(null);
  const here = !!projectKey && appId === projectKey;
  useEffect(() => {
    if (!here) return;
    let live = true;
    const read = () => { void window.studio.workflowRunState().then((r) => { if (live) setLine(describeWorkflowRun(r)); }).catch(() => {}); };
    read();
    const off = window.studio.onWorkflowEvent(read);
    return () => { live = false; off(); };
  }, [here]);
  return <p className="pl-hint">{here ? `Workflow: ${line ?? 'checking…'}` : 'Workflow in another CreateCraft project. Open that project to see its progress.'}</p>;
}

function TaskRow({ t, p, reload, onSend, projectKey, projectName, inColumn }: { t: PlanTask; p: PlannerProject; reload: () => Promise<void>; onSend?: () => void; projectKey?: string | null; projectName?: string; inColumn?: boolean }) {
  const plain = useContext(PlainWords);
  const [edit, setEdit] = useState(false);
  const a = useAction(reload);
  const waits = unmetDependencies(p, t);
  const live = isClaimLive(t.claim, new Date());
  const ds = displayStatus(t, p);
  const result = plain ? p.reports.find((r) => r.taskId === t.id && r.status === 'submitted') : undefined;
  const pkg = t.packageId ? p.packages.find((k) => k.id === t.packageId) : undefined;
  // Cancelling a package would also drop the other tasks' claims, so Unsend is offered only while nothing in it has started.
  const sentOnly = !!pkg && pkg.state === 'open' && !live && t.status === 'todo' && !p.tasks.some((o) => o.packageId === pkg.id && (isClaimLive(o.claim, new Date()) || o.status === 'reported' || o.status === 'in_progress'));
  const st = (s: 'todo' | 'accepted' | 'cancelled' | 'blocked') => a.run(() => api().setTaskStatus(p.id, t.id, s, '', t.rev));
  if (edit) return <li className="pl-task"><TaskForm p={p} reload={reload} task={t} onDone={() => setEdit(false)} projectKey={projectKey} projectName={projectName} /></li>;
  const idle = t.status !== 'accepted' && t.status !== 'cancelled' && t.status !== 'reported';
  return (
    <li className="pl-task">
      <div><strong>{t.title}</strong> <StatusChip status={t.status} task={t} p={p} inColumn={plain && inColumn} /> {(!plain || t.priority !== 'normal') && <span className="chip">{t.priority}</span>}{t.appRef && <span className="chip">{t.appRef.kind === 'native' ? EDITOR_APPS[t.appRef.id as keyof typeof EDITOR_APPS]?.name ?? t.appRef.id : t.appRef.kind === 'workflow' ? 'Workflow' : t.appRef.id}</span>}</div>
      {t.appRef?.kind === 'workflow' && <WorkflowStatus appId={t.appRef.id} projectKey={projectKey} />}
      {t.description && <p>{t.description}</p>}
      {!plain && waits.length > 0 && <p className="pl-hint">Waiting for: {waits.map((w) => w.title).join(', ')}</p>}
      {!plain && live && <p className="pl-hint">Claimed by {t.claim?.executor.name} until {when(t.claim?.leaseUntil ?? '')}.{t.progressNote ? ` ${t.progressNote}` : ''}</p>}
      {(plain ? (!live && t.status !== 'revision' && t.status !== 'blocked') || live : !live) && t.progressNote && <p className="pl-hint">{t.progressNote}</p>}
      {t.completionChecks.length > 0 && <ul className="pl-checks">{t.completionChecks.map((c) => <li key={c.id}>{!plain && <span className="chip">{c.kind}</span>} {c.text}</li>)}</ul>}
      <div className="pl-actions">
        <button className="btn small" onClick={() => setEdit(true)}>Edit</button>
        {t.status === 'reported' && !plain && <span className="pl-hint">Review the report in Handoffs.</span>}
        {plain && onSend && (t.status === 'todo' || t.status === 'revision') && !live && <button className="btn small primary" onClick={onSend}>{pkg?.state === 'open' ? 'Send again' : 'Send to AI'}</button>}
        {live && <button className="btn small" disabled={a.busy} title={plain ? 'Stop waiting for the AI and put the task back on your list' : undefined} onClick={() => void a.run(() => api().releaseClaim(p.id, t.id))}>{plain ? 'Take back' : 'Release claim'}</button>}
        {plain && (ds.stalled || ds.chip === 'Partly done') && <button className="btn small" disabled={a.busy} title="Put it back on your list so it can be sent again" onClick={() => void st('todo')}>Take back</button>}
        {plain && t.status === 'blocked' && !live && <button className="btn small" disabled={a.busy} title="The problem is solved: put it back on your list" onClick={() => void st('todo')}>Unblock</button>}
        {plain && sentOnly && <button className="btn small" disabled={a.busy} title="Cancels the brief you sent; tasks in it go back to To Do" onClick={() => void a.run(() => api().cancelPackage(p.id, pkg.id))}>Unsend{pkg.tasks.length > 1 ? ` (${pkg.tasks.length} tasks)` : ''}</button>}
        {idle && !live && !ds.stalled && <button className="btn small" disabled={a.busy} title="Mark it done yourself, without a report" onClick={() => void st('accepted')}>Mark done</button>}
        {plain && ds.stalled && <button className="btn small" disabled={a.busy} title="Mark it done yourself" onClick={() => void st('accepted')}>Mark done</button>}
        {(t.status === 'accepted' || t.status === 'cancelled') && <button className="btn small" disabled={a.busy} onClick={() => void st('todo')}>{plain && t.status === 'cancelled' ? 'Bring back' : 'Reopen'}</button>}
        {t.status !== 'cancelled' && t.status !== 'accepted' && <button className="btn small ghost" disabled={a.busy} onClick={() => void st('cancelled')}>{plain ? 'Remove' : 'Cancel task'}</button>}
        {!t.packageId && <button className="btn small ghost danger" disabled={a.busy} onClick={() => void a.run(() => api().removeTask(p.id, t.id))}>Delete</button>}
      </div>
      {result && <ReportCard r={result} p={p} reload={reload} />}
      <ErrorLine error={a.error} />
    </li>
  );
}

export function TasksTab({ p, reload, go, setSendSel, projectKey, projectName }: TabProps) {
  const plain = useContext(PlainWords);
  const [view, setView] = useState<'list' | 'board'>('list');
  const [showRemoved, setShowRemoved] = useState(false);
  const cols: Array<[string, PlanTask['status'][]]> = [['To do', ['todo', 'revision']], ['In progress', ['in_progress']], ['Blocked', ['blocked']], ['Reported, awaiting review', ['reported']], ['Accepted', ['accepted']]];
  const now = new Date();
  const shown = plain && !showRemoved ? p.tasks.filter((t) => t.status !== 'cancelled') : p.tasks;
  return (
    <div className="pl-stack">
      <Section title="Tasks" actions={<div className="pl-actions"><button className="btn small" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button><button className="btn small" aria-pressed={view === 'board'} onClick={() => setView('board')}>Board</button></div>}
        hint={plain ? 'A task is Done when you say so. When an AI finishes, it moves to Needs Review and waits for you.' : "A task is done when you accept it. An executor's report only says the work is finished."}>
        {!p.tasks.length && <p className="pl-hint">No tasks yet.</p>}
        {plain && p.tasks.some((t) => t.status === 'cancelled') && <label className="pl-check"><input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />Show removed tasks</label>}
        {view === 'list' ? <ul className="pl-tasks">{shown.map((t) => <TaskRow key={`${t.id}:${t.rev}`} t={t} p={p} reload={reload} projectKey={projectKey} projectName={projectName} onSend={() => { setSendSel?.([t.id]); go('handoffs'); }} />)}</ul> : plain ? (
          <div className="pl-board">
            {SIMPLE_STATUSES.map((label) => (
              <div key={label} className="pl-col"><h4>{label}</h4><ul className="pl-tasks">{shown.filter((t) => displayStatus(t, p, now).label === label && !displayStatus(t, p, now).removed).map((t) => <TaskRow key={`${t.id}:${t.rev}`} inColumn t={t} p={p} reload={reload} onSend={() => { setSendSel?.([t.id]); go('handoffs'); }} />)}</ul></div>
            ))}
          </div>
        ) : (
          <div className="pl-board">
            {cols.map(([label, sts]) => (
              <div key={label} className="pl-col"><h4>{label}</h4><ul className="pl-tasks">{p.tasks.filter((t) => sts.includes(t.status)).map((t) => <TaskRow key={`${t.id}:${t.rev}`} t={t} p={p} reload={reload} onSend={() => { setSendSel?.([t.id]); go('handoffs'); }} />)}</ul></div>
            ))}
          </div>
        )}
      </Section>
      <Section title="Add a task"><TaskForm p={p} reload={reload} projectKey={projectKey} projectName={projectName} /></Section>
    </div>
  );
}

// ============================================================================================================== assets
export function AssetsTab({ p, reload, manifest, projectKey }: TabProps & { manifest: ProjectManifest | null; projectKey: string | null }) {
  const [health, setHealth] = useState<Record<string, string>>({});
  const [link, setLink] = useState({ title: '', url: '' });
  const [role, setRole] = useState<PlanAsset['role']>('reference');
  const [pickId, setPickId] = useState('');
  const a = useAction(reload);
  useEffect(() => { void api().assetHealth(p.id).then(setHealth).catch(() => {}); }, [p.id, p.revision]);
  const roles: Array<[PlanAsset['role'], string]> = [['reference', 'References'], ['working', 'Working files'], ['deliverable', 'Deliverables (output versions)']];
  const assetRow = (x: PlanAsset) => (
    <li key={x.id} className="pl-asset">
      <strong>{x.title}</strong> {x.group && <span className="chip">{x.group} v{x.version}</span>}
      <span className="pl-hint"> {x.source === 'file' ? x.path : x.source === 'link' ? x.url : `CreateCraft asset ${x.createcraft?.assetId}`}</span>
      {health[x.id] === 'missing' && <span className="pl-warn"> File not found at this path</span>}
      <button className="btn small ghost danger" disabled={a.busy} onClick={() => void a.run(() => api().removeAsset(p.id, x.id))}>Remove</button>
    </li>
  );
  return (
    <div className="pl-stack">
      {roles.map(([r, label]) => (
        <Section key={r} title={label} hint={r === 'deliverable' ? 'Give versions of the same output the same group name to keep them together.' : undefined}>
          {!p.assets.some((x) => x.role === r) && <p className="pl-hint">None yet.</p>}
          <ul>{p.assets.filter((x) => x.role === r).map(assetRow)}</ul>
        </Section>
      ))}
      <Section title="Add an asset" hint="Files are linked where they are, not copied. Nothing is uploaded.">
        <div className="pl-form">
          <label>As<select value={role} onChange={(e) => setRole(e.target.value as PlanAsset['role'])}><option value="reference">Reference</option><option value="working">Working file</option><option value="deliverable">Deliverable</option></select></label>
          <div className="pl-actions"><button className="btn" disabled={a.busy} onClick={() => void a.run(() => api().pickAssets(p.id, role))}>Link files…</button></div>
          <div className="pl-add"><input aria-label="Link title" placeholder="Link title" value={link.title} onChange={(e) => setLink({ ...link, title: e.target.value })} /><input aria-label="Link address" placeholder="https://…" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} />
            <button className="btn small" disabled={a.busy || !link.title.trim() || !link.url.trim()} onClick={() => void a.run(async () => { await api().addAsset(p.id, { role, title: link.title, source: 'link', url: link.url }); setLink({ title: '', url: '' }); })}>Add link</button></div>
          {manifest && projectKey && (
            <div className="pl-add"><select aria-label="CreateCraft asset" value={pickId} onChange={(e) => setPickId(e.target.value)}><option value="">From the open CreateCraft art project…</option>{manifest.assets.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
              <button className="btn small" disabled={a.busy || !pickId} onClick={() => void a.run(async () => { const m = manifest.assets.find((x) => x.id === pickId); if (m) await api().addAsset(p.id, { role, title: m.name, source: 'createcraft', createcraft: { projectKey, assetId: m.id } }); setPickId(''); })}>Link it</button></div>
          )}
        </div>
        <ErrorLine error={a.error} />
      </Section>
    </div>
  );
}

// ============================================================================================================== handoffs
const outcomeText: Record<PlanReport['outcome'], string> = { complete: 'Says it is complete', partial: 'Partly done', blocked: 'Blocked', failed: 'Failed' };

export function ReportCard({ r, p, reload }: { r: PlanReport; p: PlannerProject; reload: () => Promise<void> }) {
  const task = p.tasks.find((t) => t.id === r.taskId);
  const pkg = p.packages.find((k) => k.id === r.packageId);
  const ptask = pkg?.tasks.find((t) => t.id === r.taskId);
  const missing = ptask ? uncoveredChecks(ptask, r) : [];
  const [note, setNote] = useState('');
  const [ack, setAck] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const a = useAction(reload);
  const drift = useMemo(() => r.driftAtSubmit, [r]);
  const review = (d: 'accept' | 'revise' | 'reject') => a.run(() => api().reviewReport(p.id, r.id, d, note, ack));
  return (
    <article className={`pl-report ${r.status}`}>
      <header><strong>{task?.title ?? r.taskId}</strong> <span className="chip">{outcomeText[r.outcome]}</span> <span className="chip">{r.status.replace('_', ' ')}</span> <small className="pl-hint">{r.executor.name} · package {r.packageNumber} · {when(r.submittedAt)}{r.source === 'pasted' ? ' · pasted' : ''}</small></header>
      <p>{r.workPerformed}</p>
      {r.outputs.length > 0 && <ul>{r.outputs.map((o, i) => <li key={i}>{o.description} {o.path && <code>{o.path}</code>}</li>)}</ul>}
      {r.changedFiles.length > 0 && <details><summary>{r.changedFiles.length} changed file(s)</summary><ul>{r.changedFiles.map((f) => <li key={f}><code>{f}</code></li>)}</ul></details>}
      <h4>Verification the executor says it ran</h4>
      {!r.verification.length ? <p className="pl-warn">None reported. Nothing is verified.</p> : <ul>{r.verification.map((v, i) => <li key={i}><span className={`chip ${v.result === 'pass' ? 'ok' : v.result === 'fail' ? 'bad' : 'off'}`}>{v.result.replace('_', ' ')}</span> {v.check}{v.details ? ` - ${v.details}` : ''}</li>)}</ul>}
      {missing.length > 0 && <p className="pl-warn">Not reported on: {missing.map((c) => c.text).join('; ')}</p>}
      {[...r.blockers.map((x) => `Blocker: ${x}`), ...r.limitations.map((x) => `Limit: ${x}`), ...r.unresolvedQuestions.map((x) => `Question: ${x}`)].map((x) => <p key={x} className="pl-hint">{x}</p>)}
      {r.uncertain.length > 0 && <div className="pl-warn"><strong>Read with some guessing:</strong><ul>{r.uncertain.map((x) => <li key={x}>{x}</li>)}</ul></div>}
      {drift.outdated && <div className="pl-warn"><strong>The plan had already changed when this arrived:</strong><ul>{drift.changes.map((c, i) => <li key={i}>{c.change} {c.what}: {c.title}</li>)}</ul></div>}
      {r.hasRawText && <p><button className="btn small" onClick={async () => setRaw(raw === null ? (await api().rawReport(p.id, r.id)) ?? '(not found)' : null)}>{raw === null ? 'Show the original response' : 'Hide the original response'}</button></p>}
      {raw !== null && <pre className="pl-raw">{raw}</pre>}
      {r.status === 'submitted' && (
        <div className="pl-review">
          {r.outcome !== 'complete' && <p className="pl-hint">This report does not claim the work is complete, so it cannot be accepted as done.</p>}
          <label>Your note<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional; sent with a revision request" /></label>
          {pkg && pkg.state === 'open' && <OutdatedGate pkg={pkg} p={p} ack={ack} setAck={setAck} />}
          <div className="pl-actions">
            <button className="btn primary small" disabled={a.busy || r.outcome !== 'complete'} onClick={() => void review('accept')}>Accept as done</button>
            <button className="btn small" disabled={a.busy} onClick={() => void review('revise')}>Ask for changes</button>
            <button className="btn small ghost" disabled={a.busy} onClick={() => void review('reject')}>Reject</button>
          </div>
        </div>
      )}
      {r.review && <p className="pl-hint">Reviewed {when(r.review.at)}{r.review.note ? `: ${r.review.note}` : ''}</p>}
      <ErrorLine error={a.error} />
    </article>
  );
}

function OutdatedGate({ pkg, p, ack, setAck }: { pkg: ExecPackage; p: PlannerProject; ack: boolean; setAck: (v: boolean) => void }) {
  const now = useMemo(() => {
    const cur = p.planVersions[p.planVersions.length - 1]?.snapshot;
    return cur;
  }, [p]);
  if (!now || pkg.planRevision === p.planRevision) return null;
  return <label className="pl-check pl-warn"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />The accepted plan changed (v{pkg.planRevision} to v{p.planRevision}) after this work was handed off. I have looked at what changed and want to accept anyway.</label>;
}

function PackageCard({ k, p, reload }: { k: ExecPackage; p: PlannerProject; reload: () => Promise<void> }) {
  const [view, setView] = useState<PackageView | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const a = useAction(reload);
  const load = async () => { setView(await api().packageView(p.id, k.id)); };
  const outdated = k.planRevision !== p.planRevision;
  return (
    <article className={`pl-package ${k.state}`}>
      <header><strong>Package {k.number}</strong> <span className="chip">{k.state}</span> <span className="chip">plan v{k.planRevision}</span>{outdated && k.state === 'open' && <span className="chip bad">plan has changed since</span>} <small className="pl-hint">{when(k.createdAt)} · id <code>{k.id}</code></small></header>
      <p>{k.objective}</p>
      <ul>{k.tasks.map((t) => { const cur = p.tasks.find((x) => x.id === t.id); return <li key={t.id}>{t.title} {cur && <StatusChip status={cur.status} task={cur} p={p} />}{cur && isClaimLive(cur.claim, new Date()) ? <small className="pl-hint"> claimed by {cur.claim?.executor.name}</small> : null}</li>; })}</ul>
      <div className="pl-actions">
        <button className="btn small" onClick={() => void a.run(load)}>{view ? 'Refresh' : 'Show / copy'}</button>
        {k.state === 'open' && <button className="btn small ghost" disabled={a.busy} onClick={() => void a.run(() => api().cancelPackage(p.id, k.id))}>Cancel package</button>}
      </div>
      {view && (
        <div>
          <div className="pl-actions"><CopyButton text={view.markdown} label="Copy as Markdown" /><CopyButton text={view.json} label="Copy as JSON" /><button className="btn small" onClick={async () => setSaved(await api().savePackage(p.id, k.id))}>Save files…</button>{saved && <small className="pl-hint">Saved {saved}</small>}</div>
          {view.drift.outdated && <div className="pl-warn">The plan changed after this package was made: {view.drift.changes.map((c) => `${c.change} ${c.what} "${c.title}"`).join('; ')}. Prepare a new package so the executor sees the current plan.</div>}
          <pre className="pl-raw">{view.markdown}</pre>
        </div>
      )}
      <ErrorLine error={a.error} />
    </article>
  );
}

function PastePanel({ p, reload }: { p: PlannerProject; reload: () => Promise<void> }) {
  const plain = useContext(PlainWords);
  const [text, setText] = useState('');
  const [prev, setPrev] = useState<ReportImportPreview | null>(null);
  const [sugg, setSugg] = useState<SuggestionPreview | null>(null);
  const [skip, setSkip] = useState<number[]>([]);
  const [unclear, setUnclear] = useState<string | null>(null);
  const [pkgId, setPkgId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const a = useAction(reload);
  const open = p.packages.filter((k) => k.state === 'open');
  const readReport = (r: ReportImportPreview) => {
    setPrev(r); setDraft(r.draft ?? null);
    const k = open.find((x) => x.id === r.packageId) ?? (open.length === 1 ? open[0] : undefined);
    setPkgId(k?.id ?? '');
    setTaskId(k?.tasks.find((t) => t.id === r.taskId)?.id ?? (k?.tasks.length === 1 ? k.tasks[0]?.id ?? '' : ''));
  };
  const preview = () => {
    setDone(null); setSugg(null); setPrev(null); setDraft(null); setUnclear(null); setSkip([]);
    if (!plain) { readReport(parseReportText(text)); return; }
    const c = classifyPaste(text);
    if (c.kind === 'report' && c.report) readReport(c.report);
    else if (c.kind === 'suggestions' && c.suggestions) setSugg(c.suggestions);
    else setUnclear(`${c.why} A task result needs "Work performed" (or the JSON). Plan suggestions need headings such as Requirements, Decisions, Tasks, Questions or Ideas.`);
  };
  const pkg = open.find((k) => k.id === pkgId);
  const apply = () => a.run(async () => {
    if (!prev || !draft) return;
    const r = await api().importReport(p.id, { packageId: pkgId, taskId, executor: prev.executor ?? { kind: 'other', name: 'Pasted report' }, report: draft, uncertain: prev.uncertain, rawText: text });
    setDone(r.duplicate ? 'This exact result was already recorded; nothing changed.' : plain ? 'Saved. The task now says Needs Review: you decide whether it is done.' : 'Report recorded. Review it above.');
    setPrev(null); setDraft(null); setText('');
  });
  const addSuggestions = (accept: boolean) => a.run(async () => {
    if (!sugg) return;
    const pr = await api().importSuggestions(p.id, { proposer: sugg.proposer, note: sugg.note, changes: sugg.changes, rawText: text });
    if (accept) await api().decideProposal(p.id, pr.id, true, sugg.changes.map((_, i) => i).filter((i) => !skip.includes(i)));
    setDone(accept ? 'Added to your plan.' : 'Saved under Needs you. Nothing is in your plan until you accept it.');
    setSugg(null); setText('');
  });
  const picked = sugg ? sugg.changes.filter((_, i) => !skip.includes(i)) : [];
  return (
    <div className="pl-form">
      <textarea aria-label={plain ? 'Pasted answer' : 'Pasted report'} rows={6} value={text} onChange={(e) => { setText(e.target.value); setPrev(null); setSugg(null); setUnclear(null); }}
        placeholder={plain ? 'Paste what the AI said: a task result, or ideas for your plan.' : 'Paste a report from Claude Code, Cowork, ChatGPT or Gemini: the JSON, or a Markdown report.'} />
      <div><button className="btn" disabled={!text.trim()} onClick={preview}>{plain ? 'Check what it says' : 'Preview what it says'}</button></div>
      {done && <p role="status" className="pl-hint">{done}</p>}
      {unclear && <p className="pl-warn" role="status">{unclear}</p>}
      {sugg && (
        <div className="pl-preview">
          <p className="pl-hint">Read as suggestions for your plan{sugg.proposer ? ` from ${sugg.proposer.name}` : ''}. Nothing is added until you press a button.</p>
          {sugg.errors.map((e) => <p key={e} className="pl-error">{e}</p>)}
          {sugg.uncertain.length > 0 && <div className="pl-warn"><strong>Uncertain:</strong><ul>{sugg.uncertain.map((u) => <li key={u}>{u}</li>)}</ul></div>}
          <ul>{sugg.changes.map((c, i) => (
            <li key={i}><label className="pl-check"><input type="checkbox" checked={!skip.includes(i)} onChange={(e) => setSkip(e.target.checked ? skip.filter((x) => x !== i) : [...skip, i])} />{describeChange(c)} {changesThePlan(c) ? <span className="chip warn">changes the plan</span> : <span className="chip off">adds to your list</span>}</label></li>
          ))}</ul>
          <div className="pl-actions">
            <button className="btn primary" disabled={a.busy || !picked.length} onClick={() => void addSuggestions(true)}>Add selected to my plan</button>
            <button className="btn" disabled={a.busy} onClick={() => void addSuggestions(false)}>Save for later</button>
          </div>
        </div>
      )}
      {prev && (
        <div className="pl-preview">
          <p className="pl-hint">{plain ? `Read as the result of a task (${prev.format}). Nothing is saved until you press the button.` : `Read as ${prev.format}. Nothing is applied until you press Apply.`}</p>
          {prev.errors.map((e) => <p key={e} className="pl-error">{e}</p>)}
          {prev.uncertain.length > 0 && <div className="pl-warn"><strong>Uncertain:</strong><ul>{prev.uncertain.map((u) => <li key={u}>{u}</li>)}</ul></div>}
          {draft && (
            <>
              {!open.length && <p className="pl-warn">No task is waiting for a result. Send a task to an AI first.</p>}
              <div className="pl-two">
                <label>{plain ? 'Which brief' : 'Package'}<select value={pkgId} onChange={(e) => { setPkgId(e.target.value); setTaskId(''); }}><option value="">Choose…</option>{open.map((k) => <option key={k.id} value={k.id}>{plain ? k.tasks.map((t) => t.title).join(', ').slice(0, 60) : `Package ${k.number}: ${k.objective.slice(0, 50)}`}</option>)}</select></label>
                <label>Task<select value={taskId} onChange={(e) => setTaskId(e.target.value)}><option value="">Choose…</option>{pkg?.tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
              </div>
              <label>Outcome<select value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value as ReportDraft['outcome'] })}>{(['complete', 'partial', 'blocked', 'failed'] as const).map((o) => <option key={o} value={o}>{o}</option>)}</select></label>
              <p><strong>Work performed:</strong> {draft.workPerformed}</p>
              <p className="pl-hint">{draft.verification.length} check line(s) ({draft.verification.filter((v) => v.result === 'pass').length} pass, {draft.verification.filter((v) => v.result === 'fail').length} fail, {draft.verification.filter((v) => v.result === 'not_run').length} not run) · {draft.outputs.length} output(s) · {draft.proposedChanges.length} suggested change(s)</p>
              <button className="btn primary" disabled={a.busy || !pkgId || !taskId} onClick={() => void apply()}>{plain ? 'Save as the result' : 'Apply as a report'}</button>
            </>
          )}
        </div>
      )}
      <ErrorLine error={a.error} />
    </div>
  );
}

function ConnectPanel() {
  const [info, setInfo] = useState<PlannerConnectionInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void api().connectionInfo().then(setInfo).catch((e) => setErr(errMsg(e))); }, []);
  return (
    <div>
      <p className="pl-hint">Optional. Everything works with copy and paste. A direct connection lets a local AI read the plan, claim tasks and report back itself. Setting one up never starts an AI session, and the AI can never edit the plan or accept its own work.</p>
      <ErrorLine error={err} />
      {info && (
        <>
          {!info.bundleFound && <p className="pl-warn">The connection program was not found at {info.bundlePath}. Run the build to create it.</p>}
          {info.profiles.map((pf) => (
            <details key={pf.id} className="pl-profile">
              <summary><strong>{pf.id === 'brainstorm' ? 'Brainstorming' : 'Executor'}</strong>: {pf.label}</summary>
              <p className="pl-hint">Permissions: {pf.scopes.join(', ')}. No secret is needed; the program runs on this computer and reads the plans folder.</p>
              <p><strong>Claude Code</strong> <CopyButton text={pf.claudeCode} /></p><pre className="pl-raw">{pf.claudeCode}</pre>
              <p><strong>Settings file entry</strong> (Claude Desktop, Gemini CLI settings.json) <CopyButton text={pf.json} /></p><pre className="pl-raw">{pf.json}</pre>
            </details>
          ))}
          <p className="pl-hint">{info.http}</p>
          <p><button className="btn small" onClick={() => void api().openFolder()}>Open the plans folder</button> <small className="pl-hint">{info.folder}</small></p>
        </>
      )}
      <h4>What has been checked</h4>
      <table className="pl-table"><thead><tr><th>Client</th><th>Status</th><th>Details</th></tr></thead>
        <tbody>{PLANNER_CLIENTS.map((c) => <tr key={c.id}><td>{c.name}</td><td><span className={`chip ${c.status === 'verified' ? 'ok' : c.status === 'untested' ? 'warn' : 'off'}`}>{c.status}</span></td><td>{c.how}<br /><small className="pl-hint">{c.evidence} {c.limits} Source: {c.source}.</small></td></tr>)}</tbody></table>
    </div>
  );
}

export function ProposalCard({ p, reload }: { p: PlannerProject; reload: () => Promise<void> }) {
  const pending = p.proposals.filter((x) => x.status === 'pending');
  const [off, setOff] = useState<Record<string, number[]>>({});
  const a = useAction(reload);
  if (!pending.length) return null;
  const describe = (c: PlannerProject['proposals'][number]['changes'][number]) =>
    c.op === 'add_item' ? `Add ${c.itemType}: ${c.title}${c.reason ? ` (why: ${c.reason})` : ''}` : c.op === 'add_task' ? `Add task: ${c.title}` : c.op === 'update_item' ? `Change ${p.items.find((i) => i.id === c.id)?.title ?? c.id}: ${Object.keys(c.patch).join(', ')}` : `Change task ${p.tasks.find((t) => t.id === c.id)?.title ?? c.id}: ${Object.keys(c.patch).join(', ')}`;
  return (
    <Section title="Suggested changes" hint="These are proposals. Nothing below is part of the plan until you accept it.">
      {pending.map((pr) => {
        const skip = off[pr.id] ?? [];
        return (
          <div key={pr.id} className="pl-proposal">
            <p><strong>{pr.proposedBy.name}</strong> <small className="pl-hint">{when(pr.at)} · {pr.source === 'report' ? 'from a report' : pr.source === 'pasted' ? 'pasted by you' : pr.source === 'home' ? 'from the plan you approved on Home' : 'from a connection'}</small></p>
            {pr.note && <p className="pl-hint">{pr.note}</p>}
            <ul>{pr.changes.map((c, i) => <li key={i}><label className="pl-check"><input type="checkbox" checked={!skip.includes(i)} onChange={(e) => setOff({ ...off, [pr.id]: e.target.checked ? skip.filter((x) => x !== i) : [...skip, i] })} />{describe(c)}</label></li>)}</ul>
            <div className="pl-actions">
              <button className="btn small primary" disabled={a.busy} onClick={() => void a.run(() => api().decideProposal(p.id, pr.id, true, pr.changes.map((_, i) => i).filter((i) => !skip.includes(i))))}>Accept selected</button>
              <button className="btn small" disabled={a.busy} onClick={() => void a.run(() => api().decideProposal(p.id, pr.id, false))}>Reject</button>
            </div>
          </div>
        );
      })}
      <ErrorLine error={a.error} />
    </Section>
  );
}

/** One queue for everything that waits for the owner: results to review, suggestions to look at, stalled tasks to take back. */
function ReviewInbox({ p, reload }: { p: PlannerProject; reload: () => Promise<void> }) {
  const results = p.reports.filter((r) => r.status === 'submitted');
  const pending = p.proposals.filter((x) => x.status === 'pending');
  const now = new Date();
  const stalled = p.tasks.filter((t) => displayStatus(t, p, now).stalled);
  const a = useAction(reload);
  const empty = !results.length && !pending.length && !stalled.length;
  return (
    <Section title="Needs you" hint="An AI saying it is finished is not the same as you saying it is done. Nothing changes until you decide.">
      {empty && <p className="pl-hint">Nothing is waiting for you.</p>}
      {stalled.map((t) => (
        <p key={t.id} className="pl-warn">{t.title}: no result arrived and the AI stopped working on it. <button className="btn small" disabled={a.busy} onClick={() => void a.run(() => api().setTaskStatus(p.id, t.id, 'todo', '', t.rev))}>Take back</button></p>
      ))}
      {results.map((r) => <ReportCard key={r.id} r={r} p={p} reload={reload} />)}
      <ProposalCard p={p} reload={reload} />
      <ErrorLine error={a.error} />
    </Section>
  );
}

export function HandoffsTab({ p, reload, sendSel, setSendSel }: TabProps) {
  const ready = p.tasks.filter((t) => ['todo', 'revision'].includes(t.status) && !isClaimLive(t.claim, new Date()));
  const [sel, setSel] = useState<string[]>([]);
  const [objective, setObjective] = useState('');
  const a = useAction(reload);
  const plain = useContext(PlainWords);
  const waiting = p.reports.filter((r) => r.status === 'submitted');
  const done = p.reports.filter((r) => r.status !== 'submitted');
  if (plain) {
    return (
      <div className="pl-stack">
        <ReviewInbox p={p} reload={reload} />
        <SendPanel p={p} reload={reload} sel={sendSel ?? []} setSel={setSendSel ?? (() => {})} />
        <AskPanel p={p} />
        <Section title="Paste back" hint="Paste what the AI answered. You see what it says first. A task result waits for your review; ideas for the plan wait for your OK."><PastePanel p={p} reload={reload} /></Section>
        <details className="pl-section"><summary>Connect an AI directly (optional)</summary><ConnectPanel /></details>
      </div>
    );
  }
  return (
    <div className="pl-stack">
      <Section title="Reports to review" hint="An executor saying the work is finished is not the same as you accepting it.">
        {!waiting.length && <p className="pl-hint">No reports are waiting.</p>}
        {waiting.map((r) => <ReportCard key={r.id} r={r} p={p} reload={reload} />)}
      </Section>
      <Section title="Prepare a handoff" hint="Freezes the accepted plan with the tasks you pick. It only prepares text; no AI is started.">
        {!ready.length && <p className="pl-hint">No task is ready (tasks must be to do, unclaimed, and not waiting on unfinished work).</p>}
        {ready.map((t) => {
          const waits = unmetDependencies(p, t).filter((d) => !sel.includes(d.id));
          return <label key={t.id} className="pl-check"><input type="checkbox" checked={sel.includes(t.id)} onChange={(e) => setSel(e.target.checked ? [...sel, t.id] : sel.filter((x) => x !== t.id))} />{t.title}{waits.length ? <small className="pl-hint"> (also needs: {waits.map((w) => w.title).join(', ')})</small> : null}{t.packageId ? <small className="pl-hint"> (replaces its current package)</small> : null}</label>;
        })}
        <label>Objective (optional)<input value={objective} onChange={(e) => setObjective(e.target.value)} /></label>
        <button className="btn primary" disabled={a.busy || !sel.length} onClick={() => void a.run(async () => { await api().createPackage(p.id, { taskIds: sel, objective }); setSel([]); setObjective(''); })}>Create execution package</button>
        <ErrorLine error={a.error} />
      </Section>
      <Section title="Packages">
        {!p.packages.length && <p className="pl-hint">None yet.</p>}
        {[...p.packages].reverse().map((k) => <PackageCard key={k.id} k={k} p={p} reload={reload} />)}
      </Section>
      <Section title="Paste a report" hint="Bring back work done in Claude Code, Cowork, ChatGPT or Gemini. You see a preview first and the original response is kept."><PastePanel p={p} reload={reload} /></Section>
      {done.length > 0 && <Section title="Reviewed reports">{[...done].reverse().map((r) => <ReportCard key={r.id} r={r} p={p} reload={reload} />)}</Section>}
      <Section title="Connect an AI (optional)"><ConnectPanel /></Section>
    </div>
  );
}

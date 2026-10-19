import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { planDrift, progressOf, unmetDependencies, type ActivityEntry, type PlanItem, type PlannerProject, type ProjectSummary } from '@shared/planner';
import type { ProjectFindingsDto, ProjectPlannerState } from '@shared/plannerApi';
import type { ProjectManifest } from '@shared/types';
import { describeChange } from '@shared/plannerPaste';
import { PlannerChat } from './PlannerChat';
import { AssetsTab, HandoffsTab, ProposalCard, TasksTab } from './PlannerWork';
import { needsYou } from '@shared/plannerView';
import { ErrorLine, errMsg, lines, PlainWords, Section, StatusChip, useAction, when, type TabId, type TabProps } from './plannerUi';

const api = () => window.studio.planner;
const store = (() => { try { return window.localStorage; } catch { return undefined; } })();
// Advanced keeps the original six tabs. The plain view follows one flow: Idea (what is this, with an AI to think it through), Plan (break it
// into chunks you can edit) and Work (do one chunk at a time, review it, approve it), plus Files. Tab ids are shared with Advanced so every
// existing go('handoffs') still works: Idea = plan, Plan = tasks, Work = handoffs.
const TABS: Array<[TabId, string]> = [['overview', 'Overview'], ['plan', 'Plan'], ['tasks', 'Tasks'], ['assets', 'Assets'], ['handoffs', 'Handoffs'], ['history', 'History']];
const SIMPLE_TABS: Array<[TabId, string]> = [['plan', 'Idea'], ['tasks', 'Plan'], ['handoffs', 'Work'], ['assets', 'Files']];
const ADV = 'cs-planner-advanced';
const readAdvanced = () => { try { return store?.getItem(ADV) === '1'; } catch { return false; } };

const ago = (iso: string) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.round(ms / 60_000);
  if (m < 2) return 'just now';
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} days ago`;
  return `${Math.round(d / 30)} months ago`;
};

/** The Planner of the open project: its plan is kept inside the project and restored when the project is opened again. */
export function PlannerWorkspace({ manifest, projectKey }: { manifest: ProjectManifest | null; projectKey: string | null }) {
  const [state, setState] = useState<ProjectPlannerState | null>(null);
  /** An older plan (from the shared planner folder) being looked at instead of this project's plan. */
  const [olderId, setOlderId] = useState<string | null>(null);
  const [project, setProject] = useState<PlannerProject | null>(null);
  const [advanced, setAdvanced] = useState(readAdvanced);
  const [sendSel, setSendSel] = useState<string[]>([]);
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [pickUpDismissed, setPickUpDismissed] = useState<string | null>(null);
  const [rawTab, setRawTab] = useState<TabId>('plan');
  // The plain view has no Overview or History tab: those open Idea.
  const tab: TabId = !advanced && (rawTab === 'overview' || rawTab === 'history') ? 'plan' : rawTab;
  const setTab = setRawTab;
  const toggleAdvanced = (on: boolean) => { setAdvanced(on); try { store?.setItem(ADV, on ? '1' : '0'); } catch { /* storage unavailable */ } };
  const [error, setError] = useState<string | null>(null);
  const olderRef = useRef(olderId);
  olderRef.current = olderId;
  const keyRef = useRef(projectKey);
  keyRef.current = projectKey;

  const refresh = useCallback(async () => {
    const forKey = keyRef.current;
    try {
      const s = await api().forProject();
      if (keyRef.current !== forKey) return; // another project was opened meanwhile
      setState(s);
      const id = olderRef.current ?? s.plan?.id ?? null;
      setProject(id ? await api().get(id) : null);
      setError(null);
    } catch (e) { setError(errMsg(e)); }
  }, []);
  // A different project: nothing of the previous one stays on screen.
  useEffect(() => { setState(null); setProject(null); setOlderId(null); setFocusTaskId(null); setPickUpDismissed(null); setRawTab('plan'); void refresh(); }, [projectKey, refresh]);
  useEffect(() => { void refresh(); }, [olderId, refresh]);
  // Connections and the app write to the same folder: look again every few seconds (cheap: only a changed plan reloads).
  useEffect(() => {
    const t = setInterval(() => {
      const id = olderRef.current ?? null;
      void api().list().then((l) => {
        const mine = id ? l.find((x) => x.id === id) : l.find((x) => x.inThisProject);
        if (mine) setProject((p) => { if (!p || p.id !== mine.id || p.revision !== mine.revision) void api().get(mine.id).then((n) => setProject((cur) => (cur && cur.id !== n.id && !id ? cur : n))).catch(() => {}); return p; });
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, []);

  if (!state) return <div className="planner"><p className="pl-hint" style={{ padding: 16 }}>{error ?? 'Opening the Planner…'}</p></div>;
  if (!state.project) return <div className="planner"><p className="pl-hint" style={{ padding: 16 }}>Open a project to use its Planner.</p></div>;
  if (!project) return <PlannerStart state={state} manifest={manifest} onChanged={refresh} onOpenOlder={setOlderId} error={error} />;

  const props: TabProps = {
    p: project, reload: async () => { setProject(await api().get(project.id)); void api().forProject().then(setState).catch(() => {}); }, go: setTab, sendSel, setSendSel, projectKey, projectName: manifest?.name,
    focusTaskId, setFocusTaskId: (id) => { setFocusTaskId(id); if (id) void api().touchTask(project.id, id, 'opened').then(() => api().get(project.id).then(setProject)).catch(() => {}); },
  };
  const tabs = advanced ? TABS : SIMPLE_TABS;
  const need = needsYou(project);
  const older = state.older;
  const la = project.lastActive;
  const lastTask = la ? project.tasks.find((t) => t.id === la.taskId && t.status !== 'accepted' && t.status !== 'cancelled') : undefined;
  const showPickUp = !advanced && !olderId && !!la && !!lastTask && pickUpDismissed !== `${project.id}:${la.at}`;
  return (
    <PlainWords.Provider value={!advanced}>
    <div className="planner">
      <header className="pl-head">
        {olderId ? <button className="btn small" onClick={() => setOlderId(null)} title="Back to this project's plan">← This project's plan</button> : null}
        <h2 title={project.title}>{project.title}</h2>
        {olderId && <span className="chip warn" title="Made before projects kept their own plan; it lives in the shared planner folder">older plan</span>}
        {advanced && <><span className="chip" title="Changes each time anything in the plan changes">revision {project.revision}</span>
        <span className="chip" title="Changes only when the accepted plan changes">plan v{project.planRevision}</span></>}
        {older.length > 0 && !olderId && (
          <details className="pl-older"><summary>Older plans ({older.length})</summary>
            <ul>{older.map((o) => <li key={o.id}><strong>{o.title}</strong> <small className="pl-hint">{o.tasks} chunk(s)</small> <button className="btn small" onClick={() => setOlderId(o.id)}>Open</button></li>)}</ul>
            <p className="pl-hint">Made before each project kept its own plan. They stay as they were; opening one does not change it.</p>
          </details>
        )}
        <label className="pl-check" title="Shows packages, claims, revisions and the full history"><input type="checkbox" checked={advanced} onChange={(e) => toggleAdvanced(e.target.checked)} />Advanced</label>
        <ExportImport p={project} onImported={(n) => { setOlderId(n.id); void refresh(); }} />
      </header>
      {showPickUp && la && (
        <div className="pl-pickup" role="status" aria-label="Pick up where you left off">
          <div><strong>Pick up where I left off</strong><br /><span>{la.title}</span> <small className="pl-hint">· {la.what} · {ago(la.at)}</small></div>
          <button className="btn primary" onClick={() => { setPickUpDismissed(`${project.id}:${la.at}`); props.setFocusTaskId?.(la.taskId); setTab('handoffs'); }}>Pick up</button>
          <button className="btn small ghost" onClick={() => setPickUpDismissed(`${project.id}:${la.at}`)}>Not now</button>
        </div>
      )}
      <nav className="pl-tabs" role="tablist" aria-label="Planner sections">
        {tabs.map(([t, label]) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{label}{advanced && t === 'handoffs' && attention(project) ? <span className="pl-badge">{attention(project)}</span> : null}{advanced && t === 'plan' && pendingProposals(project) ? <span className="pl-badge">{pendingProposals(project)}</span> : null}</button>)}
      </nav>
      {!advanced && need.total > 0 && (
        <div className="pl-needs" role="status" aria-label="Waiting for you">
          <strong>Needs you</strong>
          {need.reports > 0 && <button className="btn small primary" onClick={() => setTab('handoffs')}>{need.reports} result{need.reports === 1 ? '' : 's'} to review</button>}
          {need.suggestions > 0 && <button className="btn small" onClick={() => setTab('handoffs')}>{need.suggestions} suggestion{need.suggestions === 1 ? '' : 's'} to look at</button>}
          {need.stalled > 0 && <button className="btn small" onClick={() => setTab('handoffs')}>{need.stalled} stalled chunk{need.stalled === 1 ? '' : 's'}</button>}
        </div>
      )}
      <div className="pl-body" role="tabpanel">
        {tab === 'overview' && <Overview {...props} />}
        {tab === 'plan' && <PlanArea {...props} withOverview={!advanced} />}
        {tab === 'tasks' && <><TasksTab {...props} />{!advanced && <div className="pl-stack"><Milestones p={project} reload={props.reload} /></div>}</>}
        {tab === 'assets' && <AssetsTab {...props} manifest={manifest} projectKey={projectKey} />}
        {tab === 'handoffs' && <HandoffsTab {...props} />}
        {tab === 'history' && <HistoryTab {...props} />}
      </div>
    </div>
    </PlainWords.Provider>
  );
}

const attention = (p: PlannerProject) => p.reports.filter((r) => r.status === 'submitted').length;
const pendingProposals = (p: PlannerProject) => p.proposals.filter((x) => x.status === 'pending').length;

function ExportImport({ p, onImported }: { p: PlannerProject; onImported: (p: PlannerProject) => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const go = async (fn: () => Promise<string | null>) => { setOpen(false); try { const r = await fn(); if (r) setMsg(`Saved ${r}`); } catch (e) { setMsg(errMsg(e)); } };
  return (
    <div className="pl-export">
      <button className="btn small" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>Export / import ▾</button>
      {open && (
        <div className="more-list" role="menu">
          <button role="menuitem" onClick={() => go(() => api().exportProject(p.id, 'reference'))}>Export plan (files stay where they are)</button>
          <button role="menuitem" onClick={() => go(() => api().exportProject(p.id, 'bundle'))}>Export plan with linked files bundled</button>
          <button role="menuitem" onClick={() => { setOpen(false); void api().importProject().then((n) => { if (n) onImported(n); }).catch((e) => setMsg(errMsg(e))); }}>Import a plan…</button>
        </div>
      )}
      {msg && <span className="pl-hint" role="status"> {msg}</span>}
    </div>
  );
}

/** A project with no plan yet: start from an idea, or from what the project already holds. Older plans can be brought in. */
function PlannerStart({ state, manifest, onChanged, onOpenOlder, error }: { state: ProjectPlannerState; manifest: ProjectManifest | null; onChanged: () => Promise<void>; onOpenOlder: (id: string) => void; error: string | null }) {
  const a = useAction(onChanged);
  const [findings, setFindings] = useState<ProjectFindingsDto | null>(null);
  const [skip, setSkip] = useState<number[]>([]);
  const hasWork = (manifest?.assets.length ?? 0) > 0;
  const name = state.project?.name ?? 'this project';
  const look = () => a.run(async () => { const f = await api().analyze(); setFindings(f); setSkip([]); });
  const startBlank = () => a.run(async () => { await api().startPlan({}); });
  const startFromFindings = () => a.run(async () => {
    if (!findings) return;
    const plan = await api().startPlan({});
    const picked = findings.changes.map((_, i) => i).filter((i) => !skip.includes(i));
    if (picked.length) await api().applyFindings(plan.id, picked);
  });
  return (
    <div className="planner">
      <div className="pl-body pl-picker">
        <h2>Planner for {name}</h2>
        <p className="pl-hint">An AI creative partner for this project. It works in three steps: <strong>Idea</strong> (think the project through), <strong>Plan</strong> (break it into chunks you can edit) and <strong>Work</strong> (do one chunk at a time, review it, approve it). Your files stay the real work; the plan only keeps track of goals, decisions and progress. It is optional, and it is always here.</p>
        <ErrorLine error={error ?? a.error} />
        {!findings && (
          <Section title="How do you want to start?">
            <div className="pl-actions">
              <button className={`btn ${hasWork ? '' : 'primary'}`} disabled={a.busy} onClick={() => void startBlank()}>Start with an idea</button>
              <button className={`btn ${hasWork ? 'primary' : ''}`} disabled={a.busy} onClick={() => void look()}>Look at what is already here</button>
            </div>
            <p className="pl-hint">{hasWork ? 'This project already has work in it. Looking only reads it: you see what was found and tick what to keep. Nothing in your project is changed, and nothing is assumed to be finished.' : 'This project is empty so far. Looking at it only reads it, and nothing is changed.'}</p>
          </Section>
        )}
        {findings && (
          <Section title="What is already in this project" hint="Read from the project's own files. Nothing was changed. Tick what to add to your plan; nothing is marked as done.">
            <ul>{findings.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            {findings.changes.length > 0 && (
              <>
                <h4>Suggested for your plan</h4>
                <ul>{findings.changes.map((c, i) => (
                  <li key={i}><label className="pl-check"><input type="checkbox" checked={!skip.includes(i)} onChange={(e) => setSkip(e.target.checked ? skip.filter((x) => x !== i) : [...skip, i])} />{describeChange(c)}</label></li>
                ))}</ul>
              </>
            )}
            <div className="pl-actions">
              <button className="btn primary" disabled={a.busy} onClick={() => void startFromFindings()}>Start my plan with these</button>
              <button className="btn" disabled={a.busy} onClick={() => void startBlank()}>Start with an empty plan</button>
              <button className="btn ghost" disabled={a.busy} onClick={() => setFindings(null)}>Back</button>
            </div>
          </Section>
        )}
        {state.older.length > 0 && (
          <Section title="Older plans" hint="Made before each project kept its own plan. Bringing one in copies it into this project; the original stays as it was.">
            <ul className="pl-cards">
              {state.older.map((s: ProjectSummary) => (
                <li key={s.id}>
                  <div className="pl-card"><strong>{s.title}</strong><span>{s.goal || 'No goal written yet'}</span><small>{s.tasks} chunk(s) · {s.accepted} done</small>
                    <span className="pl-actions"><button className="btn small primary" disabled={a.busy} onClick={() => void a.run(async () => { await api().attachOlder(s.id); })}>Bring into this project</button><button className="btn small" onClick={() => onOpenOlder(s.id)}>Just open it</button></span>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}

function Milestones({ p, reload }: { p: PlannerProject; reload: () => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const a = useAction(reload);
  return (
    <Section title="Milestones" hint="Group tasks under a milestone from the task form.">
      {!p.milestones.length && <p className="pl-hint">None yet.</p>}
      <ul>{p.milestones.map((m) => { const pr = progressOf(p.tasks.filter((t) => t.milestoneId === m.id)); return <li key={m.id}><strong>{m.title}</strong>{m.due ? <small className="pl-hint"> due {m.due}</small> : null} <small className="pl-hint">{pr.accepted} of {pr.total} accepted</small> <button className="btn small ghost" disabled={a.busy} onClick={() => void a.run(() => api().removeMilestone(p.id, m.id))}>Remove</button></li>; })}</ul>
      <div className="pl-add"><input aria-label="Milestone title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a milestone" /><input aria-label="Milestone due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} style={{ flex: 'none', minWidth: 0 }} />
        <button className="btn small" disabled={a.busy || !title.trim()} onClick={() => void a.run(async () => { await api().addMilestone(p.id, { title, due }); setTitle(''); setDue(''); })}>Add</button></div>
      <ErrorLine error={a.error} />
    </Section>
  );
}

function Overview({ p, reload, go, setSendSel }: TabProps) {
  const plain = useContext(PlainWords);
  const pr = progressOf(p.tasks);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  useEffect(() => { void api().activity(p.id).then((a) => setActivity(a.slice(-8).reverse())).catch(() => {}); }, [p.id, p.revision]);
  const ready = p.tasks.filter((t) => t.status === 'todo' && !t.packageId && !unmetDependencies(p, t).length);
  const blocked = p.tasks.filter((t) => t.status === 'blocked');
  const review = p.reports.filter((r) => r.status === 'submitted');
  return (
    <div className="pl-grid">
      <Section title="Goal">
        <p>{p.goal || <span className="pl-hint">No goal yet. Add one in the brief below.</span>}</p>
        <div className="pl-progress" role="progressbar" aria-valuenow={pr.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Accepted tasks"><span style={{ width: `${pr.percent}%` }} /></div>
        <p className="pl-hint">{pr.total ? (plain ? `${pr.accepted} of ${pr.total} chunks done · ${pr.reported} waiting for your review · ${pr.inProgress} in progress` : `${pr.accepted} of ${pr.total} tasks accepted by you · ${pr.reported} reported done and waiting for your review · ${pr.inProgress} in progress`) : 'No tasks yet.'}</p>
      </Section>
      {!plain && <Section title="Needs you">
        {!review.length && !pendingProposals(p) && !blocked.length && <p className="pl-hint">Nothing is waiting for you.</p>}
        {review.length > 0 && <p><button className="btn small primary" onClick={() => go('handoffs')}>{review.length} report(s) to review</button></p>}
        {pendingProposals(p) > 0 && <p><button className="btn small" onClick={() => go('plan')}>{pendingProposals(p)} suggested change(s)</button></p>}
        {blocked.map((t) => <p key={t.id} className="pl-warn">Blocked: {t.title}{t.progressNote ? ` - ${t.progressNote}` : ''}</p>)}
      </Section>}
      {plain && blocked.length > 0 && <Section title="Blocked">{blocked.map((t) => <p key={t.id} className="pl-warn">{t.title}{t.progressNote ? ` - ${t.progressNote}` : ''}</p>)}</Section>}
      <Section title="Next actions">
        {!ready.length && <p className="pl-hint">No task is ready to hand off.</p>}
        <ul>{ready.slice(0, 6).map((t) => <li key={t.id}>{t.title}</li>)}</ul>
        {ready.length > 0 && <button className="btn small" onClick={() => { setSendSel?.(ready.map((t) => t.id)); go('handoffs'); }}>{plain ? 'Send to AI…' : 'Prepare a handoff…'}</button>}
      </Section>
      {!plain && <Milestones p={p} reload={reload} />}
      {!plain && <Section title="Recent activity">
        <ul className="pl-log">{activity.map((a) => <li key={a.seq}><small>{when(a.at)}</small> <strong>{a.actor.name}</strong> {a.summary}</li>)}</ul>
      </Section>}
    </div>
  );
}

function ItemEditor({ item, p, reload }: { item: PlanItem; p: PlannerProject; reload: () => Promise<void> }) {
  const [edit, setEdit] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [text, setText] = useState(item.text);
  const [reason, setReason] = useState(item.reason);
  const [answer, setAnswer] = useState(item.answer ?? '');
  const a = useAction(reload);
  const st = (status: PlanItem['status'], opts?: { type?: PlanItem['type']; answer?: string }) => a.run(() => api().setItemStatus(p.id, item.id, status, { ...opts, expectedRev: item.rev }));
  return (
    <li className={`pl-item ${item.status}`}>
      {!edit ? (
        <>
          <div><strong>{item.title}</strong> <span className="chip">{item.type}{item.status !== 'open' && item.status !== 'accepted' ? ` · ${item.status}` : ''}</span> <small className="pl-hint">by {item.createdBy.name}</small></div>
          {item.text && <p>{item.text}</p>}
          {item.reason && <p className="pl-hint">Why: {item.reason}</p>}
          {item.answer && <p>Answer: {item.answer}</p>}
          <div className="pl-actions">
            <button className="btn small" onClick={() => setEdit(true)}>Edit</button>
            {item.type === 'idea' && item.status === 'open' && <>
              <button className="btn small" disabled={a.busy} onClick={() => void st('accepted', { type: 'requirement' })}>Make a requirement</button>
              <button className="btn small" disabled={a.busy} onClick={() => void st('accepted', { type: 'decision' })}>Make a decision</button>
              <button className="btn small ghost" disabled={a.busy} onClick={() => void st('rejected')}>Drop</button>
            </>}
            {item.type === 'question' && item.status === 'open' && (
              <><input aria-label="Answer" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer" /><button className="btn small" disabled={a.busy || !answer.trim()} onClick={() => void st('answered', { answer })}>Answer</button></>
            )}
            {(item.type === 'requirement' || item.type === 'decision') && item.status === 'accepted' && <button className="btn small ghost" disabled={a.busy} title="Keeps it in the history; it leaves the plan" onClick={() => void st('superseded')}>Replace / retire</button>}
            {item.status !== 'accepted' && <button className="btn small ghost danger" disabled={a.busy} onClick={() => void a.run(() => api().removeItem(p.id, item.id))}>Delete</button>}
          </div>
        </>
      ) : (
        <div className="pl-form">
          <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea aria-label="Details" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
          {item.type === 'decision' && <input aria-label="Why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why was this decided?" />}
          <div className="pl-actions">
            <button className="btn small primary" disabled={a.busy || !title.trim()} onClick={() => void a.run(async () => { await api().updateItem(p.id, item.id, { title, text, reason }, item.rev); setEdit(false); })}>Save</button>
            <button className="btn small" onClick={() => setEdit(false)}>Cancel</button>
          </div>
        </div>
      )}
      <ErrorLine error={a.error} />
    </li>
  );
}

function AddItem({ type, p, reload, label }: { type: PlanItem['type']; p: PlannerProject; reload: () => Promise<void>; label: string }) {
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState('');
  const a = useAction(reload);
  const add = () => a.run(async () => { await api().addItem(p.id, { type, title, reason }); setTitle(''); setReason(''); });
  return (
    <div className="pl-add">
      <input aria-label={label} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={label} onKeyDown={(e) => { if (e.key === 'Enter' && title.trim() && type !== 'decision') void add(); }} />
      {type === 'decision' && <input aria-label="Why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why?" />}
      <button className="btn small" disabled={a.busy || !title.trim()} onClick={() => void add()}>Add</button>
      <ErrorLine error={a.error} />
    </div>
  );
}

function Brief({ p, reload, onSaved }: { p: PlannerProject; reload: () => Promise<void>; onSaved?: () => void }) {
  const [f, setF] = useState({ title: p.title, goal: p.goal, description: p.description, scope: p.scope, constraints: p.constraints.join('\n'), deliverables: p.deliverables.join('\n') });
  const base = useRef(p.metaRev);
  const dirty = f.title !== p.title || f.goal !== p.goal || f.description !== p.description || f.scope !== p.scope || f.constraints !== p.constraints.join('\n') || f.deliverables !== p.deliverables.join('\n');
  const a = useAction(reload);
  // Reload the form when someone else changed the brief, unless the user is mid-edit.
  useEffect(() => {
    if (!dirty && base.current !== p.metaRev) { setF({ title: p.title, goal: p.goal, description: p.description, scope: p.scope, constraints: p.constraints.join('\n'), deliverables: p.deliverables.join('\n') }); base.current = p.metaRev; }
  }, [p, dirty]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="pl-form">
      <label>Title<input value={f.title} onChange={set('title')} /></label>
      <label>Goal<textarea rows={2} value={f.goal} onChange={set('goal')} /></label>
      <label>Description<textarea rows={3} value={f.description} onChange={set('description')} /></label>
      <label>Scope (what is in and out)<textarea rows={2} value={f.scope} onChange={set('scope')} /></label>
      <div className="pl-two">
        <label>Constraints (one per line)<textarea rows={3} value={f.constraints} onChange={set('constraints')} /></label>
        <label>Expected deliverables (one per line)<textarea rows={3} value={f.deliverables} onChange={set('deliverables')} /></label>
      </div>
      <div>
        <button className="btn primary" disabled={a.busy || !dirty || !f.title.trim()} onClick={() => void a.run(async () => { await api().update(p.id, { title: f.title, goal: f.goal, description: f.description, scope: f.scope, constraints: lines(f.constraints), deliverables: lines(f.deliverables) }, base.current); base.current = p.metaRev + 1; onSaved?.(); })}>Save changes</button>
        {dirty && <button className="btn" onClick={() => setF({ title: p.title, goal: p.goal, description: p.description, scope: p.scope, constraints: p.constraints.join('\n'), deliverables: p.deliverables.join('\n') })}>Discard</button>}
      </div>
      <ErrorLine error={a.error} />
    </div>
  );
}

/** The Plan screen: the whole plan on the left, the planning chat on the right. The chat stays in view while the left side scrolls. */
function PlanArea(props: TabProps & { withOverview: boolean }) {
  const [savedTick, setSavedTick] = useState(0);
  return (
    <div className="pl-split">
      <div className="pl-left">
        {props.withOverview && <Overview {...props} />}
        <PlanTab {...props} onSaved={() => setSavedTick((n) => n + 1)} />
      </div>
      <PlannerChat key={props.p.id} p={props.p} reload={props.reload} savedTick={savedTick} />
    </div>
  );
}

function PlanTab({ p, reload, onSaved }: TabProps & { onSaved?: () => void }) {
  const plain = useContext(PlainWords);
  const open = (t: PlanItem['type']) => p.items.filter((i) => i.type === t && (i.status === 'open' || i.status === 'accepted' || i.status === 'answered'));
  const group = (t: PlanItem['type'], title: string, hint: string, label: string) => (
    <Section title={title} hint={hint}>
      <ul className="pl-items">{open(t).map((i) => <ItemEditor key={`${i.id}:${i.rev}`} item={i} p={p} reload={reload} />)}</ul>
      {!open(t).length && <p className="pl-hint">None yet.</p>}
      <AddItem type={t} p={p} reload={reload} label={label} />
    </Section>
  );
  return (
    <div className="pl-stack pl-wide">
      {!plain && <ProposalCard p={p} reload={reload} />}
      <Section title="Project brief" hint="Everything except the title is optional."><Brief key={p.id} p={p} reload={reload} onSaved={onSaved} /></Section>
      {group('requirement', 'Accepted requirements', 'What must be true of the result. Executors receive these.', 'Add a requirement')}
      {group('decision', 'Decisions', 'Choices already made, with the reason.', 'Add a decision')}
      {group('question', 'Open questions', 'Not part of the plan until answered.', 'Add a question')}
      {group('idea', 'Ideas', 'Brainstorming. Not requirements until you promote them.', 'Add an idea')}
      {group('reference', 'References', 'Things to look at or stay consistent with.', 'Add a reference')}
    </div>
  );
}

function HistoryTab({ p }: TabProps) {
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  useEffect(() => { void api().activity(p.id).then((a) => setActivity([...a].reverse())).catch(() => {}); }, [p.id, p.revision]);
  return (
    <div className="pl-grid">
      <Section title="Plan versions" hint="A new version is kept each time the accepted plan changes.">
        <ol className="pl-log" reversed>
          {[...p.planVersions].reverse().map((v, i, all) => {
            const before = all[i + 1];
            const d = before ? planDrift(before.snapshot, v.snapshot) : null;
            return (
              <li key={v.planRevision}><strong>v{v.planRevision}</strong> <small>{when(v.at)} · {v.by.name}</small><br />{v.reason}
                {d && d.changes.length > 0 && <ul>{d.changes.map((c, k) => <li key={k} className="pl-hint">{c.change} {c.what}: {c.title}</li>)}</ul>}</li>
            );
          })}
        </ol>
      </Section>
      <Section title="Everything that happened" hint="Who or what made each change.">
        <ul className="pl-log">{activity.map((a) => <li key={a.seq}><small>{when(a.at)} · r{a.revision}</small> <strong>{a.actor.name}</strong> {a.summary} {a.planAffecting && <span className="chip">plan</span>}</li>)}</ul>
      </Section>
      <Section title="Task statuses"><ul>{p.tasks.map((t) => <li key={t.id}>{t.title} <StatusChip status={t.status} task={t} p={p} /></li>)}</ul></Section>
    </div>
  );
}

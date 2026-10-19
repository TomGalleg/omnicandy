import { useCallback, useEffect, useRef, useState } from 'react';
import { progressOf, type ActivityEntry, type PlanItem, type PlannerProject, type ProjectSummary } from '@shared/planner';
import type { ProjectFindingsDto, ProjectPlannerState } from '@shared/plannerApi';
import type { ProjectManifest } from '@shared/types';
import { describeChange } from '@shared/plannerPaste';
import { PlannerChat } from './PlannerChat';
import { AssetsTab, ConnectPanel, PastePanel, TasksTab, WorkTab } from './PlannerWork';
import { AskPanel } from './PlannerSend';
import { needsYou } from '@shared/plannerView';
import { ErrorLine, errMsg, lines, PlainWords, Section, useAction, when, type TabId, type TabProps } from './plannerUi';

const api = () => window.studio.planner;
// One simple flow: Idea (think it through with an AI), Plan (break it into chunks you can edit), Work (do one chunk at a time, review it, approve it).
// Tab ids are the original ones (plan, tasks, handoffs) so every existing go('handoffs') still lands in the right place.
const TABS: Array<[TabId, string]> = [['plan', 'Idea'], ['tasks', 'Plan'], ['handoffs', 'Work']];

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
  const [sendSel, setSendSel] = useState<string[]>([]);
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [pickUpDismissed, setPickUpDismissed] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('plan');
  /** Something opened from the ⋯ menu: the change history, or how to connect an AI tool. */
  const [panel, setPanel] = useState<'history' | 'connect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** "Pick up where I left off" is for coming back: it is not shown for work done in this very session. */
  const sessionStart = useRef(Date.now());
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
  useEffect(() => { setState(null); setProject(null); setOlderId(null); setFocusTaskId(null); setPickUpDismissed(null); setPanel(null); setTab('plan'); sessionStart.current = Date.now(); void refresh(); }, [projectKey, refresh]);
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
  const need = needsYou(project);
  const pr = progressOf(project.tasks.filter((t) => t.status !== 'cancelled'));
  const la = project.lastActive;
  const lastTask = la ? project.tasks.find((t) => t.id === la.taskId && t.status !== 'accepted' && t.status !== 'cancelled') : undefined;
  const showPickUp = !olderId && !!la && !!lastTask && Date.parse(la.at) < sessionStart.current && pickUpDismissed !== `${project.id}:${la.at}`;
  return (
    <PlainWords.Provider value>
    <div className="planner">
      <header className="pl-head">
        {olderId ? <button className="btn small" onClick={() => setOlderId(null)} title="Back to this project's plan">← This project's plan</button> : null}
        <h2 title={project.title}>{project.title}</h2>
        {olderId && <span className="chip warn" title="Made before projects kept their own plan; it lives in the shared planner folder">older plan</span>}
        {pr.total > 0 && <span className="pl-hint" title="Chunks you have approved">{pr.accepted} of {pr.total} chunks done</span>}
        <HeaderMenu p={project} older={olderId ? [] : state.older} onOpenOlder={setOlderId} onImported={(n) => { setOlderId(n.id); void refresh(); }} onPanel={setPanel} />
      </header>
      {showPickUp && la && (
        <div className="pl-pickup" role="status" aria-label="Pick up where you left off">
          <div><strong>Pick up where I left off</strong><br /><span>{la.title}</span> <small className="pl-hint">· {la.what} · {ago(la.at)}</small></div>
          <button className="btn primary" onClick={() => { setPickUpDismissed(`${project.id}:${la.at}`); props.setFocusTaskId?.(la.taskId); setTab('handoffs'); }}>Pick up</button>
          <button className="btn small ghost" onClick={() => setPickUpDismissed(`${project.id}:${la.at}`)}>Not now</button>
        </div>
      )}
      {panel === 'history' && <HistoryPanel p={project} onClose={() => setPanel(null)} />}
      {panel === 'connect' && <div className="pl-panel"><Section title="Connect an AI tool" hint="Optional. Lets a tool such as Claude Code read this plan and report back, without copy and paste." actions={<button className="btn small" onClick={() => setPanel(null)}>Close</button>}><ConnectPanel /></Section></div>}
      <nav className="pl-tabs" role="tablist" aria-label="Planner steps">
        {TABS.map(([t, label]) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{label}{t === 'handoffs' && need.total ? <span className="pl-badge" title="Waiting for you">{need.total}</span> : null}</button>)}
      </nav>
      <div className="pl-body" role="tabpanel">
        {tab === 'plan' && <IdeaTab {...props} manifest={manifest} />}
        {tab === 'tasks' && <PlanTab {...props} />}
        {tab === 'handoffs' && <WorkTab {...props} />}
      </div>
    </div>
    </PlainWords.Provider>
  );
}

/** The one small menu in the header: everything that is not part of the three steps but should never be missing. */
function HeaderMenu({ p, older, onOpenOlder, onImported, onPanel }: { p: PlannerProject; older: ProjectSummary[]; onOpenOlder: (id: string) => void; onImported: (p: PlannerProject) => void; onPanel: (v: 'history' | 'connect') => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const ref = useRef<HTMLDetailsElement>(null);
  const run = async (fn: () => Promise<unknown>) => { if (ref.current) ref.current.open = false; try { const r = await fn(); if (typeof r === 'string' && r) setMsg(`Saved ${r}`); } catch (e) { setMsg(errMsg(e)); } };
  return (
    <div className="pl-export">
      <details ref={ref} className="pl-menu">
        <summary className="btn small" aria-label="More">⋯</summary>
        <div className="more-list" role="menu">
          <button role="menuitem" onClick={() => { if (ref.current) ref.current.open = false; onPanel('history'); }}>What changed…</button>
          <button role="menuitem" onClick={() => { if (ref.current) ref.current.open = false; onPanel('connect'); }}>Connect an AI tool…</button>
          <button role="menuitem" onClick={() => void run(() => api().exportProject(p.id, 'reference'))}>Export this plan…</button>
          <button role="menuitem" onClick={() => void run(() => api().exportProject(p.id, 'bundle'))}>Export with linked files…</button>
          <button role="menuitem" onClick={() => void run(async () => { const n = await api().importProject(); if (n) onImported(n); })}>Import a plan…</button>
          <button role="menuitem" onClick={() => void run(() => api().openFolder())}>Open the plan's folder</button>
          {older.length > 0 && <div className="pl-older-list"><small className="pl-hint">Older plans (made before projects kept their own)</small>{older.map((o) => <button key={o.id} role="menuitem" onClick={() => { if (ref.current) ref.current.open = false; onOpenOlder(o.id); }}>{o.title}</button>)}</div>}
        </div>
      </details>
      {msg && <span className="pl-hint" role="status"> {msg}</span>}
    </div>
  );
}

/** What changed, newest first: who did what. Read-only. */
function HistoryPanel({ p, onClose }: { p: PlannerProject; onClose: () => void }) {
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  useEffect(() => { void api().activity(p.id).then((a) => setActivity([...a].reverse())).catch(() => {}); }, [p.id, p.revision]);
  return (
    <div className="pl-panel">
      <Section title="What changed" hint="Every change to this plan, newest first." actions={<button className="btn small" onClick={onClose}>Close</button>}>
        <ul className="pl-log">{activity.map((a) => <li key={a.seq}><small>{when(a.at)}</small> <strong>{a.actor.name}</strong> {a.summary}</li>)}</ul>
      </Section>
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

/**
 * Idea: the conversation with the AI is the centre. Everything it fills in (and anything you type) sits in short folded sections beside it, each with
 * a count, so nothing is missing and nothing shouts. Files and references for the project are in the last section.
 */
function IdeaTab(props: TabProps & { manifest: ProjectManifest | null }) {
  const { p, reload, manifest, projectKey } = props;
  const [savedTick, setSavedTick] = useState(0);
  const items = (t: PlanItem['type']) => p.items.filter((i) => i.type === t && (i.status === 'open' || i.status === 'accepted' || i.status === 'answered'));
  const group = (t: PlanItem['type'], hint: string, label: string) => (
    <>
      <p className="pl-hint">{hint}</p>
      <ul className="pl-items">{items(t).map((i) => <ItemEditor key={`${i.id}:${i.rev}`} item={i} p={p} reload={reload} />)}</ul>
      {!items(t).length && <p className="pl-hint">None yet.</p>}
      <AddItem type={t} p={p} reload={reload} label={label} />
    </>
  );
  const fold = (title: string, count: number | null, body: React.ReactNode, open = false) => (
    <details className="pl-fold" open={open}><summary>{title}{count !== null ? <span className="pl-count">{count}</span> : null}</summary><div className="pl-fold-body">{body}</div></details>
  );
  return (
    <div className="pl-split">
      <div className="pl-left">
        {p.goal && <p className="pl-goal"><strong>Goal:</strong> {p.goal}</p>}
        {fold('Project brief', null, <Brief key={p.id} p={p} reload={reload} onSaved={() => setSavedTick((n) => n + 1)} />, !p.goal)}
        {fold('Rules and decisions', items('requirement').length + items('decision').length, <>{group('requirement', 'What must be true of the result. The AI gets these every time.', 'Add a rule')}{group('decision', 'Choices already made, with the reason.', 'Add a decision')}</>)}
        {fold('Open questions', items('question').length, group('question', 'Not part of the plan until answered.', 'Add a question'))}
        {fold('Ideas', items('idea').length, group('idea', 'Brainstorming. Not rules until you promote them.', 'Add an idea'))}
        {fold('References and files', items('reference').length + p.assets.length, <>{group('reference', 'Things to look at or stay consistent with.', 'Add a reference')}<AssetsTab {...props} manifest={manifest} projectKey={projectKey ?? null} /></>)}
      </div>
      <div className="pl-right">
        <PlannerChat key={p.id} p={p} reload={reload} savedTick={savedTick} />
        <details className="pl-fold"><summary>Use ChatGPT, Gemini or another AI instead</summary>
          <div className="pl-fold-body">
            <AskPanel p={p} />
            <Section title="Paste the answer" hint="Paste what the AI said. You see what it says first; nothing joins your plan until you press a button."><PastePanel p={p} reload={reload} /></Section>
          </div>
        </details>
      </div>
    </div>
  );
}

/** Plan: the work broken into chunks (editable), and the milestones that group them. */
function PlanTab(props: TabProps) {
  const { p, reload } = props;
  return (
    <div className="pl-stack">
      <TasksTab {...props} />
      <details className="pl-fold"><summary>Milestones<span className="pl-count">{p.milestones.length}</span></summary><div className="pl-fold-body"><Milestones p={p} reload={reload} /></div></details>
    </div>
  );
}

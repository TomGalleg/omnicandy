import { useCallback, useEffect, useRef, useState } from 'react';
import { progressOf, type ActivityEntry, type PlannerProject, type ProjectSummary } from '@shared/planner';
import type { ProjectFindingsDto, ProjectPlannerState } from '@shared/plannerApi';
import type { ProjectManifest } from '@shared/types';
import { describeChange } from '@shared/plannerPaste';
import { PlannerChat } from './PlannerChat';
import { StudioTab } from './StudioTab';
import { TownTab } from './TownTab';
import { ConnectPanel, PastePanel, TasksTab, WorkTab } from './PlannerWork';
import { AskPanel } from './PlannerSend';
import { needsYou } from '@shared/plannerView';
import { shouldRefresh } from '@shared/plannerEvents';
import type { NavMode } from '@shared/navigation';
import { ErrorLine, errMsg, PlainWords, Section, useAction, when, type TabId, type TabProps } from './plannerUi';

const api = () => window.studio.planner;
// One simple flow: Idea (think it through with an AI), Plan (break it into chunks you can edit), Work (do one chunk at a time, review it, approve it).
// Tab ids are the original ones (plan, tasks, handoffs) so every existing go('handoffs') still lands in the right place.
const TABS: Array<[TabId, string]> = [['studio', 'Studio'], ['plan', 'Idea'], ['tasks', 'Plan'], ['handoffs', 'Work'], ['town', 'OmniTown']];
/** Simplified: the plan you talk through (Studio), doing a chunk (Work), and your town (OmniTown, which opens first). Advanced adds the step-by-step Idea and Plan screens. */
const SIMPLE_TABS: readonly TabId[] = ['town', 'studio', 'handoffs'];

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

/** OmniTown (the planner) of the open project: its plan is kept inside the project and restored when the project is opened again. */
export function PlannerWorkspace({ manifest, projectKey, navMode }: { manifest: ProjectManifest | null; projectKey: string | null; navMode: NavMode }) {
  const [state, setState] = useState<ProjectPlannerState | null>(null);
  /** An older plan (from the shared planner folder) being looked at instead of this project's plan. */
  const [olderId, setOlderId] = useState<string | null>(null);
  const [project, setProject] = useState<PlannerProject | null>(null);
  const [sendSel, setSendSel] = useState<string[]>([]);
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [pickUpDismissed, setPickUpDismissed] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('town');
  /** Something opened from the ⋯ menu: the change history, or how to connect an AI tool. */
  const [panel, setPanel] = useState<'history' | 'connect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** "Pick up where I left off" is for coming back: it is not shown for work done in this very session. */
  const sessionStart = useRef(Date.now());
  const olderRef = useRef(olderId);
  olderRef.current = olderId;
  /** Which project's plan this window already started on its own (a project opens straight into the Studio; nothing to choose first). */
  const autoStarted = useRef<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
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
  useEffect(() => { setState(null); setProject(null); setOlderId(null); setFocusTaskId(null); setPickUpDismissed(null); setPanel(null); setTab('town'); sessionStart.current = Date.now(); void refresh(); }, [projectKey, refresh]);
  useEffect(() => { void refresh(); }, [olderId, refresh]);
  useEffect(() => { if (navMode !== 'advanced' && !SIMPLE_TABS.includes(tab)) setTab('town'); }, [navMode, tab]);
  // Changes made here or by a connected tool arrive as events (no polling). Looking again on focus and on a slow timer covers a lost event
  // and the older plans, which live outside the open project's folder and so are not watched.
  const projectRef = useRef(project);
  projectRef.current = project;
  useEffect(() => {
    const look = () => {
      const id = olderRef.current ?? null;
      void api().list().then((l) => {
        const mine = id ? l.find((x) => x.id === id) : l.find((x) => x.inThisProject);
        if (mine) setProject((p) => { if (!p || p.id !== mine.id || p.revision !== mine.revision) void api().get(mine.id).then((n) => setProject((cur) => (cur && cur.id !== n.id && !id ? cur : n))).catch(() => {}); return p; });
      }).catch(() => {});
    };
    const off = api().onEvent((e) => {
      const cur = projectRef.current;
      if (shouldRefresh(e, cur?.id ?? null, cur?.revision ?? 0)) void api().get(e.planId).then((n) => setProject((now) => (now && now.id === n.id && n.revision < now.revision ? now : n))).catch(() => {});
      else if (e.type === 'plan.recovered' && e.planId === cur?.id) setError(e.note);
    });
    const timer = setInterval(look, 30_000);
    window.addEventListener('focus', look);
    return () => { off(); clearInterval(timer); window.removeEventListener('focus', look); };
  }, []);

  useEffect(() => {
    const pid = state?.project?.id;
    if (!pid || state?.plan || olderId || project || autoStarted.current === pid) return;
    autoStarted.current = pid;
    void api().startPlan({}).then(() => refresh()).catch((e) => setStartError(errMsg(e)));
  }, [state, olderId, project, refresh]);

  if (!state) return <div className="planner"><p className="pl-hint" style={{ padding: 16 }}>{error ?? 'Opening OmniTown…'}</p></div>;
  if (!state.project) return <div className="planner"><p className="pl-hint" style={{ padding: 16 }}>Open a project to use its OmniTown.</p></div>;
  if (!project && !startError) return <div className="planner"><p className="pl-hint" style={{ padding: 16 }}>Setting up your town…</p></div>;
  if (!project) return <PlannerStart state={state} manifest={manifest} onChanged={refresh} onOpenOlder={setOlderId} error={startError ?? error} />;

  const props: TabProps = {
    manifest, p: project, reload: async () => { setProject(await api().get(project.id)); void api().forProject().then(setState).catch(() => {}); }, go: setTab, sendSel, setSendSel, projectKey, projectName: manifest?.name,
    focusTaskId, setFocusTaskId: (id) => { setFocusTaskId(id); if (id) void api().touchTask(project.id, id, 'opened').then(() => api().get(project.id).then(setProject)).catch(() => {}); },
  };
  const shownTabs = navMode === 'advanced' ? TABS : TABS.filter(([t]) => SIMPLE_TABS.includes(t));
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
      <nav className="pl-tabs" role="tablist" aria-label="OmniTown steps">
        {shownTabs.map(([t, label]) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{label}{t === 'handoffs' && need.total ? <span className="pl-badge" title="Waiting for you">{need.total}</span> : null}</button>)}
      </nav>
      <div className="pl-body" role="tabpanel">
        {tab === 'studio' && <StudioTab {...props} />}
        {tab === 'town' && <TownTab {...props} />}
        {tab === 'plan' && <IdeaTab {...props} />}
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
    // The conversation starts from what was found, so the AI and the owner both begin from the same facts.
    const facts = findings.lines.filter((l) => !/^Nothing has been made/.test(l));
    const nl = String.fromCharCode(10);
    if (facts.length) await api().chatSave(plan.id, { messages: [{ role: 'assistant', text: ['I looked through this project. Here is what I found:', '', ...facts.map((l) => `- ${l}`), '', 'What would you like to do with it next?'].join(nl) }] });
  });
  return (
    <div className="planner">
      <div className="pl-body pl-picker">
        <h2>OmniTown for {name}</h2>
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
          <Section title="What is already in this project" hint="Read from the project's own files. Nothing was changed, and nothing is marked as done. The conversation starts from this.">
            <ul>{findings.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            {findings.changes.length > 0 && (
              <>
                <h4>Start the plan with</h4>
                <ul>{findings.changes.map((c, i) => (
                  <li key={i}><label className="pl-check"><input type="checkbox" checked={!skip.includes(i)} onChange={(e) => setSkip(e.target.checked ? skip.filter((x) => x !== i) : [...skip, i])} />{describeChange(c)}</label></li>
                ))}</ul>
              </>
            )}
            <div className="pl-actions">
              <button className="btn primary" disabled={a.busy} onClick={() => void startFromFindings()}>Start planning from this</button>
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

/** Idea: just the conversation. The AI asks, you answer; when it understands, it offers to break the project into chunks. */
function IdeaTab(props: TabProps) {
  const { p, reload, go } = props;
  return (
    <div className="pl-idea">
      <PlannerChat key={p.id} p={p} reload={reload} go={go} />
      <details className="pl-fold"><summary>Use ChatGPT, Gemini or another AI instead</summary>
        <div className="pl-fold-body">
          <AskPanel p={p} />
          <Section title="Paste the answer" hint="Paste what the AI said. You see what it says first; nothing joins your plan until you press a button."><PastePanel p={p} reload={reload} /></Section>
        </div>
      </details>
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

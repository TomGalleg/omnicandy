import { useCallback, useEffect, useRef, useState } from 'react';
import { planDrift, PLANNER_TEMPLATES, progressOf, unmetDependencies, type ActivityEntry, type PlanItem, type PlannerProject, type ProjectSummary } from '@shared/planner';
import type { ProjectManifest } from '@shared/types';
import { AssetsTab, HandoffsTab, TasksTab } from './PlannerWork';
import { ErrorLine, errMsg, lines, Section, StatusChip, useAction, when, type TabId, type TabProps } from './plannerUi';

const api = () => window.studio.planner;
const store = (() => { try { return window.localStorage; } catch { return undefined; } })();
const LAST = 'cs-planner-project';
const TABS: Array<[TabId, string]> = [['overview', 'Overview'], ['plan', 'Plan'], ['tasks', 'Tasks'], ['assets', 'Assets'], ['handoffs', 'Handoffs'], ['history', 'History']];

export function PlannerWorkspace({ manifest, projectKey }: { manifest: ProjectManifest | null; projectKey: string | null }) {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [id, setId] = useState<string | null>(() => { try { return store?.getItem(LAST) ?? null; } catch { return null; } });
  const [project, setProject] = useState<PlannerProject | null>(null);
  const [tab, setTab] = useState<TabId>('overview');
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(id);
  idRef.current = id;

  const pick = useCallback((next: string | null) => { setId(next); setProject(null); try { if (next) store?.setItem(LAST, next); else store?.removeItem(LAST); } catch { /* storage unavailable */ } }, []);
  const refresh = useCallback(async () => {
    try {
      const l = await api().list();
      setList(l);
      const cur = idRef.current;
      if (cur && l.some((x) => x.id === cur)) setProject(await api().get(cur));
      else if (cur) pick(null);
      setError(null);
    } catch (e) { setError(errMsg(e)); }
  }, [pick]);
  useEffect(() => { void refresh(); }, [refresh, id]);
  // Connections and the app write to the same folder: look again every few seconds (cheap: only changed projects reload).
  useEffect(() => {
    const t = setInterval(() => {
      void api().list().then((l) => {
        setList(l);
        const cur = idRef.current;
        const s = l.find((x) => x.id === cur);
        if (s) setProject((p) => { if (!p || p.revision !== s.revision) void api().get(s.id).then(setProject).catch(() => {}); return p; });
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, []);

  if (!list) return <div className="planner"><p className="pl-hint" style={{ padding: 16 }}>{error ?? 'Loading plans…'}</p></div>;
  if (!id || !project) return <ProjectPicker list={list} onOpen={pick} onChanged={refresh} error={error} />;

  const props: TabProps = { p: project, reload: async () => { setProject(await api().get(project.id)); setList(await api().list()); }, go: setTab };
  return (
    <div className="planner">
      <header className="pl-head">
        <button className="btn small" onClick={() => pick(null)} title="All plans">← All plans</button>
        <h2 title={project.title}>{project.title}</h2>
        <span className="chip" title="Changes each time anything in the plan changes">revision {project.revision}</span>
        <span className="chip" title="Changes only when the accepted plan changes">plan v{project.planRevision}</span>
        <ExportImport p={project} onImported={(n) => { pick(n.id); void refresh(); }} />
      </header>
      <nav className="pl-tabs" role="tablist" aria-label="Planner sections">
        {TABS.map(([t, label]) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{label}{t === 'handoffs' && attention(project) ? <span className="pl-badge">{attention(project)}</span> : null}{t === 'plan' && pendingProposals(project) ? <span className="pl-badge">{pendingProposals(project)}</span> : null}</button>)}
      </nav>
      <div className="pl-body" role="tabpanel">
        {tab === 'overview' && <Overview {...props} />}
        {tab === 'plan' && <PlanTab {...props} />}
        {tab === 'tasks' && <TasksTab {...props} />}
        {tab === 'assets' && <AssetsTab {...props} manifest={manifest} projectKey={projectKey} />}
        {tab === 'handoffs' && <HandoffsTab {...props} />}
        {tab === 'history' && <HistoryTab {...props} />}
      </div>
    </div>
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

function ProjectPicker({ list, onOpen, onChanged, error }: { list: ProjectSummary[]; onOpen: (id: string) => void; onChanged: () => Promise<void>; error: string | null }) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [tpl, setTpl] = useState<string[]>([]);
  const a = useAction(onChanged);
  const create = async () => {
    const p = await a.run(() => api().create({ title, goal, templates: tpl }));
    if (p) { setTitle(''); setGoal(''); setTpl([]); onOpen(p.id); }
  };
  return (
    <div className="planner">
      <div className="pl-body pl-picker">
        <h2>Project Planner</h2>
        <p className="pl-hint">One current plan for each project, kept while you brainstorm in one place and do the work in another. A title and a goal are enough to start. Nothing here needs an AI or an API key.</p>
        <ErrorLine error={error ?? a.error} />
        <Section title="New plan">
          <div className="pl-form">
            <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is this project?" maxLength={120} /></label>
            <label>Goal (optional)<textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} placeholder="What should exist when it is done?" maxLength={2000} /></label>
            <fieldset><legend>Start from (optional, mix as you like)</legend>
              {PLANNER_TEMPLATES.filter((t) => t.id !== 'blank').map((t) => (
                <label key={t.id} className="pl-check" title={t.blurb}><input type="checkbox" checked={tpl.includes(t.id)} onChange={(e) => setTpl(e.target.checked ? [...tpl, t.id] : tpl.filter((x) => x !== t.id))} />{t.label}</label>
              ))}
            </fieldset>
            <div><button className="btn primary" disabled={a.busy || !title.trim()} onClick={() => void create()}>Create plan</button>
              <button className="btn" disabled={a.busy} onClick={() => void a.run(async () => { const n = await api().importProject(); if (n) onOpen(n.id); })}>Import a plan…</button></div>
          </div>
        </Section>
        <Section title="Your plans">
          {!list.length && <p className="pl-hint">No plans yet.</p>}
          <ul className="pl-cards">
            {list.map((s) => (
              <li key={s.id}>
                <button className="pl-card" onClick={() => onOpen(s.id)}>
                  <strong>{s.title}</strong>
                  <span>{s.goal || 'No goal written yet'}</span>
                  <small>{s.tasks} task(s) · {s.accepted} accepted{s.awaitingReview ? ` · ${s.awaitingReview} report(s) to review` : ''}{s.pendingProposals ? ` · ${s.pendingProposals} suggestion(s)` : ''}</small>
                </button>
              </li>
            ))}
          </ul>
        </Section>
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

function Overview({ p, reload, go }: TabProps) {
  const pr = progressOf(p.tasks);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  useEffect(() => { void api().activity(p.id).then((a) => setActivity(a.slice(-8).reverse())).catch(() => {}); }, [p.id, p.revision]);
  const ready = p.tasks.filter((t) => t.status === 'todo' && !t.packageId && !unmetDependencies(p, t).length);
  const blocked = p.tasks.filter((t) => t.status === 'blocked');
  const review = p.reports.filter((r) => r.status === 'submitted');
  return (
    <div className="pl-grid">
      <Section title="Goal">
        <p>{p.goal || <span className="pl-hint">No goal yet. Add one in Plan.</span>}</p>
        <div className="pl-progress" role="progressbar" aria-valuenow={pr.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Accepted tasks"><span style={{ width: `${pr.percent}%` }} /></div>
        <p className="pl-hint">{pr.total ? `${pr.accepted} of ${pr.total} tasks accepted by you · ${pr.reported} reported done and waiting for your review · ${pr.inProgress} in progress` : 'No tasks yet.'}</p>
      </Section>
      <Section title="Needs you">
        {!review.length && !pendingProposals(p) && !blocked.length && <p className="pl-hint">Nothing is waiting for you.</p>}
        {review.length > 0 && <p><button className="btn small primary" onClick={() => go('handoffs')}>{review.length} report(s) to review</button></p>}
        {pendingProposals(p) > 0 && <p><button className="btn small" onClick={() => go('plan')}>{pendingProposals(p)} suggested change(s)</button></p>}
        {blocked.map((t) => <p key={t.id} className="pl-warn">Blocked: {t.title}{t.progressNote ? ` - ${t.progressNote}` : ''}</p>)}
      </Section>
      <Section title="Next actions">
        {!ready.length && <p className="pl-hint">No task is ready to hand off.</p>}
        <ul>{ready.slice(0, 6).map((t) => <li key={t.id}>{t.title}</li>)}</ul>
        {ready.length > 0 && <button className="btn small" onClick={() => go('handoffs')}>Prepare a handoff…</button>}
      </Section>
      <Milestones p={p} reload={reload} />
      <Section title="Recent activity">
        <ul className="pl-log">{activity.map((a) => <li key={a.seq}><small>{when(a.at)}</small> <strong>{a.actor.name}</strong> {a.summary}</li>)}</ul>
      </Section>
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

function Brief({ p, reload }: { p: PlannerProject; reload: () => Promise<void> }) {
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
        <button className="btn primary" disabled={a.busy || !dirty || !f.title.trim()} onClick={() => void a.run(async () => { await api().update(p.id, { title: f.title, goal: f.goal, description: f.description, scope: f.scope, constraints: lines(f.constraints), deliverables: lines(f.deliverables) }, base.current); base.current = p.metaRev + 1; })}>Save changes</button>
        {dirty && <button className="btn" onClick={() => setF({ title: p.title, goal: p.goal, description: p.description, scope: p.scope, constraints: p.constraints.join('\n'), deliverables: p.deliverables.join('\n') })}>Discard</button>}
      </div>
      <ErrorLine error={a.error} />
    </div>
  );
}

function ProposalCard({ p, reload }: { p: PlannerProject; reload: () => Promise<void> }) {
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
            <p><strong>{pr.proposedBy.name}</strong> <small className="pl-hint">{when(pr.at)} · {pr.source === 'report' ? 'from a report' : 'from a connection'}</small></p>
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

function PlanTab({ p, reload }: TabProps) {
  const open = (t: PlanItem['type']) => p.items.filter((i) => i.type === t && (i.status === 'open' || i.status === 'accepted' || i.status === 'answered'));
  const group = (t: PlanItem['type'], title: string, hint: string, label: string) => (
    <Section title={title} hint={hint}>
      <ul className="pl-items">{open(t).map((i) => <ItemEditor key={`${i.id}:${i.rev}`} item={i} p={p} reload={reload} />)}</ul>
      {!open(t).length && <p className="pl-hint">None yet.</p>}
      <AddItem type={t} p={p} reload={reload} label={label} />
    </Section>
  );
  return (
    <div className="pl-stack">
      <ProposalCard p={p} reload={reload} />
      <Section title="Project brief" hint="Everything except the title is optional."><Brief key={p.id} p={p} reload={reload} /></Section>
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
      <Section title="Task statuses"><ul>{p.tasks.map((t) => <li key={t.id}>{t.title} <StatusChip status={t.status} /></li>)}</ul></Section>
    </div>
  );
}

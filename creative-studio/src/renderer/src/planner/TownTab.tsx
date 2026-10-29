import { useEffect, useMemo, useState } from 'react';
import { PlannerChat } from './PlannerChat';
import mapUrl from '../assets/omnitown-map.jpg';
import researchOffice from '../assets/offices/research-director.jpg';
import mediaOffice from '../assets/offices/media-manager.jpg';
import qualityOffice from '../assets/offices/quality-director.jpg';
import managerOffice from '../assets/offices/general-manager.jpg';
import technicalOffice from '../assets/offices/technical-director.jpg';
import creativeOffice from '../assets/offices/creative-director.jpg';
import productionOffice from '../assets/offices/production-director.jpg';
import softwareOffice from '../assets/offices/software-director.jpg';
import aiOffice from '../assets/offices/ai-director.jpg';
import hallInside from '../assets/offices/town-hall.jpg';
import { TownWalker, type WalkerBadge } from './TownWalker';
import { ACTIVITY_LABEL, directorActivity, type DirectorActivity } from '@shared/townActivity';
import { directorIntents, intentFor, type Intent } from '@shared/townIntent';
import { RunWithAi } from './MeetingRun';
import { requestIntents } from '@shared/townRequests';
import { CAST, type CastMember } from './townCast';
import puffUrl from '../assets/characters/smoke-puff.png';
import { setPresence, stayInside } from './townPresence';
import managerPortrait from '../assets/portraits/general-manager.jpg';
import creativePortrait from '../assets/portraits/creative-director.jpg';
import qualityPortrait from '../assets/portraits/quality-director.jpg';
import mediaPortrait from '../assets/portraits/media-manager.jpg';
import aiPortrait from '../assets/portraits/ai-director.jpg';
import productionPortrait from '../assets/portraits/production-director.jpg';
import softwarePortrait from '../assets/portraits/software-director.jpg';
import researchPortrait from '../assets/portraits/research-director.jpg';
import techPortrait from '../assets/portraits/technical-director.jpg';
import { DIRECTORS, MEETING_KINDS, type DirectorKey, activeAgents, tierFor, type MeetingKind, type TeamChange, type TownAgent, type TownBusiness, type TownMeeting, type TownState } from '@shared/town';
import type { ProposalChange } from '@shared/planner';
import { errMsg, ErrorLine, Section, type TabProps } from './plannerUi';
import { useTown } from './useTown';

const api = () => window.studio.planner;

const KIND_LABEL: Record<MeetingKind, string> = {
  kickoff: 'Project kickoff', planning: 'Planning meeting', brainstorm: 'Creative brainstorming', technical: 'Technical review', progress: 'Progress meeting', emergency: 'Emergency meeting', other: 'Meeting',
};
/** The picture of the inside of an office. Offices without one yet simply show no picture. */
const INTERIORS: Partial<Record<DirectorKey, string>> = { 'research-director': researchOffice, 'media-manager': mediaOffice, 'quality-director': qualityOffice, 'general-manager': managerOffice, 'technical-director': technicalOffice, 'creative-director': creativeOffice, 'production-director': productionOffice, 'ai-director': aiOffice, 'software-director': softwareOffice };
const TIER_LABEL = { studio: 'Studio', workshop: 'Workshop', factory: 'Factory' } as const;
const describe = (c: TeamChange, t: TownState): string => {
  switch (c.op) {
    case 'add_business': return `Open ${c.name}`;
    case 'add_agent': return `Hire ${c.name}${c.specialty ? ` (${c.specialty})` : ''}`;
    case 'update_agent': return `Update ${t.agents.find((a) => a.id === c.agentId)?.name ?? 'a worker'}'s job`;
    case 'move_agent': return `Move ${t.agents.find((a) => a.id === c.agentId)?.name ?? 'a worker'} to ${t.businesses.find((b) => b.id === c.businessId)?.name ?? 'another business'}`;
    case 'retire_agent': return `Retire ${t.agents.find((a) => a.id === c.agentId)?.name ?? 'a worker'}`;
    case 'rename_business': return `Rename a business to ${c.name}`;
  }
};

/** The director's picture. Until a portrait is added for them, their coloured initial stands in. */
const PORTRAITS: Partial<Record<DirectorKey, string>> = { 'general-manager': managerPortrait, 'creative-director': creativePortrait, 'quality-director': qualityPortrait, 'technical-director': techPortrait, 'media-manager': mediaPortrait, 'ai-director': aiPortrait, 'production-director': productionPortrait, 'software-director': softwarePortrait, 'research-director': researchPortrait };
function Portrait({ a }: { a: TownAgent }) {
  const src = a.director ? PORTRAITS[a.director] : undefined;
  return src ? <img className="tw-portrait" src={src} alt={a.name} /> : <span className="tw-portrait"><Avatar a={a} big /></span>;
}

function Avatar({ a, big }: { a: TownAgent; big?: boolean }) {
  return <span className={`tw-avatar${big ? ' big' : ''}`} style={{ background: a.look.accent }} title={`${a.name}${a.specialty ? `: ${a.specialty}` : ''}`}>{a.name.slice(0, 1).toUpperCase()}</span>;
}

/**
 * OmniTown: the people and places of the project. Every worker has a workplace; a workplace grows with the number of people in it. This shows who is
 * on the team. A small badge over a director (a ! for a result waiting for you, a turning gear while a task of theirs is claimed, a red ! when stuck) is
 * drawn only from the plan (see shared/townActivity.ts); nothing is animated to look busy.
 */
export function TownTab(props: TabProps) {
  const { p, reload, go } = props;
  const { town, setTown, note, clearNote } = useTown(p.id);
  // What each director is really doing comes from the plan, never from the town. A claim that runs out takes its badge away, so look again every half minute.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setClock(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const activity = useMemo(() => directorActivity(p, new Date(clock)), [p, clock]);
  /** The people at the table of a meeting that is running with AI help: they walk to the Town Hall until it ends. */
  const [goers, setGoers] = useState<ReadonlySet<string> | null>(null);
  const intents = useMemo(() => {
    const base = directorIntents(p, new Date(clock));
    // A worker whose request is waiting for the owner goes to see the one it is for, unless they have real work of their own.
    for (const [k, v] of Object.entries(requestIntents(p.proposals, town?.agents ?? []))) if (!base[k as DirectorKey]) base[k as DirectorKey] = v;
    for (const a of town?.agents ?? []) if (a.director && goers?.has(a.id)) base[a.director] = { kind: 'meeting' };
    return base;
  }, [p, clock, town, goers]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [talk, setTalk] = useState<string | null>(null);
  /** The main worker whose office is open (full screen), or null for the map. */
  const [office, setOffice] = useState<string | null>(null);
  /** Inside the Town Hall (full screen), where meetings are held. */
  const [inHall, setInHall] = useState(false);
  // Opening a conversation brings it into view (it sits below the town).
  useEffect(() => { if (talk) document.getElementById('tw-talk')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [talk]);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(errMsg(e)); return undefined; } finally { setBusy(false); }
  };
  const apply = (changes: TeamChange[]) => run(async () => { setTown(await api().townApply(p.id, changes)); });

  const active = town?.meetings.filter((m) => !m.endedAt).at(-1) ?? null;
  if (!town) return <div className="pl-stack"><p className="pl-hint">Setting up your town…</p></div>;
  const selected = town.agents.find((a) => a.id === pick) ?? null;
  const inOffice = office ? town.agents.find((a) => a.id === office && a.director && !a.retired) ?? null : null;
  const pending = town.suggestions.filter((s) => s.status === 'pending');
  const helpers = activeAgents(town).filter((a) => !a.director).length;

  return (
    <div className="tw">
      {note && <p className="pl-warn" role="status">{note} <button className="btn small ghost" onClick={clearNote}>Dismiss</button></p>}
      <ErrorLine error={error} />
      <div className="tw-bar">
        <h3>Your town</h3>
        <span className="spacer" />
        <button className="btn small primary" title="Talk through your idea with the General Manager and see the plan take shape" onClick={() => go('studio')}>Talk to the General Manager</button>
        <button className="btn small" disabled={busy} title="Suggests a studio and a specialist helper for each application your tasks name. Nothing is added until you say so." onClick={() => void run(async () => { setTown(await api().townSuggestFromPlan(p.id)); })}>Suggest helpers</button>
        <AddBusiness busy={busy} onAdd={(name) => apply([{ op: 'add_business', name, trade: '' }])} />
      </div>

      {pending.map((s) => (
        <div key={s.id} className="pc-suggest" role="status">
          <span><strong>{s.by}</strong> suggests: {s.changes.map((c) => describe(c, town)).join('; ')}.</span>
          <span className="pl-actions">
            <button className="btn small primary" disabled={busy} onClick={() => void run(async () => { setTown(await api().townDecide(p.id, s.id, true)); })}>Add to the team</button>
            <button className="btn small" disabled={busy} onClick={() => void run(async () => { setTown(await api().townDecide(p.id, s.id, false)); })}>Skip</button>
          </span>
        </div>
      ))}

      {inHall ? (
        <div className="tw-main tw-inoffice">
          <section className="tw-room" aria-label="Inside the Town Hall">
            <img src={hallInside} alt="Inside the Town Hall" />
            <button className="btn small tw-back" onClick={() => setInHall(false)}>← Back to the town</button>
          </section>
          <aside className="tw-side"><p className="pl-hint"><strong>The Town Hall.</strong> This is where your team meets. Call a meeting below, say who should come, and write down what you decide.</p></aside>
        </div>
      ) : inOffice ? (
        <div className="tw-main tw-inoffice">
          <section className="tw-room" aria-label={`Inside ${inOffice.name}'s office`}>
            {INTERIORS[inOffice.director!] ? <img src={INTERIORS[inOffice.director!]} alt={`Inside the ${inOffice.name}'s office`} /> : <div className="tw-room-empty"><strong>{inOffice.name}'s office</strong><p className="pl-hint">This office has not been drawn yet. {inOffice.name} still works here: talk to them from their card.</p></div>}
            {inOffice.director && CAST[inOffice.director] && <>
              <OfficeFigure key={inOffice.id} who={CAST[inOffice.director]!} />
              {/* The desk, drawn again on top of him, so he sits behind it instead of being cut off. */}
              <img className="tw-desk-front" src={INTERIORS[inOffice.director]} alt="" aria-hidden style={{ clipPath: CAST[inOffice.director]!.desk }} />
            </>}
            <button className="btn small tw-back" onClick={() => { setOffice(null); setPick(null); }}>← Back to the town</button>
          </section>
          <aside className="tw-side">
            <WorkerCard town={town} a={inOffice} activity={inOffice.director ? activity[inOffice.director] : undefined} busy={busy} onApply={apply} onTalk={() => setTalk(inOffice.id)} onClose={() => { setOffice(null); setPick(null); }} />
          </aside>
        </div>
      ) : (
        <div className="tw-main">
          <Scene town={town} activity={activity} intents={intents} onPick={(id) => { setPick(id); setOffice(id && town.agents.find((a) => a.id === id)?.director ? id : null); }} pick={pick} onHall={() => { setInHall(true); setPick(null); setOffice(null); }} />
          <aside className="tw-side">
            {selected ? <WorkerCard town={town} a={selected} activity={selected.director ? activity[selected.director] : undefined} busy={busy} onApply={apply} onTalk={() => setTalk(selected.id)} onClose={() => setPick(null)} />
              : <p className="pl-hint">Click an office on the map to go inside and meet the person who works there. The Town Hall in the middle is where meetings happen.</p>}
            <details className="pl-fold"><summary>Hire a helper{helpers ? <span className="pl-count">{helpers}</span> : null}</summary>
              <div className="pl-fold-body"><AddWorker town={town} busy={busy} onAdd={(changes) => apply(changes)} /></div>
            </details>
          </aside>
        </div>
      )}

      {talk && town.agents.find((a) => a.id === talk && !a.retired) && (
        <Section title={`Talking with ${town.agents.find((a) => a.id === talk)!.name}`} actions={<button className="btn small" onClick={() => setTalk(null)}>Close</button>}>
          <div className="tw-talk" id="tw-talk"><PlannerChat key={`${p.id}:${talk}`} p={p} reload={reload} go={go} preview {...(town.agents.find((a) => a.id === talk)!.director === 'general-manager' ? {} : { agent: { id: talk, name: town.agents.find((a) => a.id === talk)!.name } })} /></div>
        </Section>
      )}

      <div id="tw-meet">
        {active ? <MeetingBoard town={town} meeting={active} planId={p.id} busy={busy} run={run} setTown={setTown} reload={reload} onGoing={setGoers} />
          : <CallMeeting town={town} busy={busy} onStart={(topic, kind, ids) => run(async () => { setTown((await api().meetingStart(p.id, { topic, kind, participantIds: ids })).town); })} />}
      </div>

      <PastMeetings town={town} />
    </div>
  );
}

function AddBusiness({ busy, onAdd }: { busy: boolean; onAdd: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <span className="pl-add">
      <input aria-label="New business" value={name} maxLength={60} placeholder="New business, e.g. Sound Studio" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { onAdd(name.trim()); setName(''); } }} />
      <button className="btn small" disabled={busy || !name.trim()} onClick={() => { onAdd(name.trim()); setName(''); }}>Open it</button>
    </span>
  );
}

const NEW_BUILDING = '__new__';

/** Hire an assistant: a name, what they are for, and where they work (an existing building, or a new one opened for them). */
function AddWorker({ town, busy, onAdd }: { town: TownState; busy: boolean; onAdd: (changes: TeamChange[]) => void }) {
  const biz = town.businesses.filter((b) => !town.workplaces.some((w) => w.kind === 'town-hall' && w.businessId === b.id));
  const [name, setName] = useState('');
  const [job, setJob] = useState('');
  const [bid, setBid] = useState('');
  const [building, setBuilding] = useState('');
  const target = bid || (biz[0]?.id ?? NEW_BUILDING);
  const isNew = target === NEW_BUILDING;
  const ready = !!name.trim() && !!job.trim() && (!isNew || !!building.trim());
  const hire = () => {
    const worker = { op: 'add_agent' as const, name: name.trim(), specialty: '', job: job.trim(), businessId: isNew ? '@last' : target };
    onAdd(isNew ? [{ op: 'add_business', name: building.trim(), trade: '' }, worker] : [worker]);
    setName(''); setJob(''); setBuilding('');
  };
  return (
    <section className="pl-form tw-hire" aria-label="Hire an assistant">
      <strong>Hire an assistant</strong>
      <input aria-label="Name" value={name} maxLength={60} placeholder="Name, e.g. Mira" onChange={(e) => setName(e.target.value)} />
      <textarea aria-label="Their job" rows={3} value={job} maxLength={1200} placeholder="What is their job? e.g. Design the logo and brand colours, and explain each choice in plain words." onChange={(e) => setJob(e.target.value)} />
      <select aria-label="Where they work" value={target} onChange={(e) => setBid(e.target.value)}>
        {biz.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        <option value={NEW_BUILDING}>A new building…</option>
      </select>
      {isNew && <input aria-label="New building name" value={building} maxLength={60} placeholder="Name the new building, e.g. Design Studio" onChange={(e) => setBuilding(e.target.value)} />}
      <button className="btn small primary" disabled={busy || !ready} onClick={hire}>Hire</button>
      <small className="pl-hint">They are told their job, the team and your project, and you can talk to them from their card.</small>
    </section>
  );
}

/**
 * The director at their desk. They arrive in a puff of smoke when the office opens, and are marked as inside while it is open, so on leaving they
 * stay in for a few seconds more and then come out of the door in a puff on the map.
 */
function OfficeFigure({ who }: { who: CastMember }) {
  useEffect(() => {
    setPresence(who.start, Infinity);
    return () => setPresence(who.start, Date.now() + stayInside());
  }, [who.start]);
  return <>
    <img className="tw-seated tw-appear" src={who.seated} alt="" aria-hidden style={{ left: `${who.seat.left}%`, top: `${who.seat.top}%`, width: `${who.seat.width}%` }} />
    <span className="tw-puff-room" aria-hidden style={{ left: `${who.seat.left}%`, top: `${who.seat.top + 5}%`, backgroundImage: `url(${puffUrl})` }} />
  </>;
}

/**
 * The OmniTown map. The nine offices and the Town Hall are fixed places on the picture; each is a button over its building. Helpers hired into an
 * office stand under it. Businesses the owner opened themselves (not one of the nine) are listed under the map.
 */
function Scene({ town, activity, intents, pick, onPick, onHall }: { town: TownState; activity: Partial<Record<DirectorKey, DirectorActivity>>; intents: Partial<Record<DirectorKey, Intent>>; pick: string | null; onPick: (id: string | null) => void; onHall: () => void }) {
  const extras = town.businesses.filter((b) => !town.workplaces.some((w) => w.kind === 'town-hall' && w.businessId === b.id) && !town.agents.some((a) => a.director && a.businessId === b.id));
  return (
    <div className="tw-scene" role="group" aria-label="The town" onClick={() => onPick(null)}>
      <div className="tw-map-art" style={{ backgroundImage: `url(${mapUrl})` }}>
        {town.agents.filter((a) => a.director && CAST[a.director] && !a.retired).map((a) => <TownWalker key={a.id} who={CAST[a.director!]!} name={a.name} onOpen={() => onPick(a.id)} badge={badgeFor(activity[a.director!])} intent={intentFor(intents, a.director)} targetDoor={doorOf(intentFor(intents, a.director))} />)}
        <button className="tw-spot hall" style={{ left: '50%', top: '31%' }} onClick={(e) => { e.stopPropagation(); onHall(); }} aria-label="Town Hall: call a meeting" title="Town Hall: call a meeting"><span>Town Hall</span></button>
        {DIRECTORS.map((d) => {
          const boss = town.agents.find((a) => a.director === d.key && !a.retired);
          if (!boss) return null;
          const helpers = activeAgents(town, boss.businessId).filter((a) => a.id !== boss.id);
          return (
            <div key={d.key} className="tw-office" style={{ left: `${d.spot.x}%`, top: `${d.spot.y}%` }} onClick={(e) => e.stopPropagation()}>
              <button className={`tw-spot${boss.id === pick ? ' selected' : ''}`} onClick={() => onPick(boss.id)} aria-label={`${d.title}: ${d.remit}`} title={`${d.title}: ${d.remit}`}><span>{d.title}</span></button>
              {helpers.length > 0 && <div className="tw-crew">{helpers.map((a) => <button key={a.id} className={`tw-person${a.id === pick ? ' selected' : ''}`} onClick={() => onPick(a.id)} aria-label={a.name}><Avatar a={a} /><span>{a.name}</span></button>)}</div>}
            </div>
          );
        })}
      </div>
      {extras.length > 0 && (
        <div className="tw-extras" onClick={(e) => e.stopPropagation()}>
          {extras.map((b: TownBusiness) => {
            const people = activeAgents(town, b.id);
            return (
              <div key={b.id} className="tw-extra"><strong>{b.name}</strong><small>{TIER_LABEL[tierFor(people.length)]} · {people.length} {people.length === 1 ? 'worker' : 'workers'}</small>
                <div className="tw-people">{people.map((a) => <button key={a.id} className={`tw-person${a.id === pick ? ' selected' : ''}`} onClick={() => onPick(a.id)} aria-label={a.name}><Avatar a={a} /><span>{a.name}</span></button>)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The map spot of the office a work visit is for. */
const doorOf = (i: Intent): string | undefined => (i.kind === 'work-visit' ? CAST[i.target]?.start : i.kind === 'meeting' ? 'steps' : undefined);

/** The badge over a director: one line saying what it means, made only from what the plan holds. */
const badgeFor = (a: DirectorActivity | undefined): WalkerBadge | undefined => (a ? { state: a.state, label: `${ACTIVITY_LABEL[a.state]}: ${a.tasks.map((t) => t.title).slice(0, 3).join('; ')}${a.tasks.length > 3 ? ` and ${a.tasks.length - 3} more` : ''}` } : undefined);

function WorkerCard({ town, a, activity, busy, onApply, onTalk, onClose }: { town: TownState; a: TownAgent; activity?: DirectorActivity; busy: boolean; onApply: (c: TeamChange[]) => void; onTalk: () => void; onClose: () => void }) {
  const biz = town.businesses.find((b) => b.id === a.businessId);
  const others = town.businesses.filter((b) => b.id !== a.businessId && !town.workplaces.some((w) => w.kind === 'town-hall' && w.businessId === b.id));
  const [editing, setEditing] = useState(false);
  const [job, setJob] = useState(a.job ?? '');
  return (
    <section className="tw-card" aria-label={a.name}>
      <header><Portrait a={a} /><div><strong>{a.name}</strong><br /><small className="pl-hint">{a.role === 'coordinator' ? 'Project coordinator' : a.director ? 'Main worker' : 'Helper'} · {biz?.name}</small></div><button className="btn small ghost" onClick={onClose} aria-label="Close">×</button></header>
      {activity && <p className={`tw-activity ${activity.state}`} role="status"><strong>{ACTIVITY_LABEL[activity.state]}:</strong> {activity.tasks.map((t) => t.title).join('; ')}</p>}
      <button className="btn small primary" onClick={onTalk}>Talk to {a.name}</button>
      {editing ? (
        <>
          <textarea aria-label="Job" rows={4} value={job} maxLength={1200} onChange={(e) => setJob(e.target.value)} />
          <span className="pl-actions"><button className="btn small primary" disabled={busy} onClick={() => { onApply([{ op: 'update_agent', agentId: a.id, job: job.trim() }]); setEditing(false); }}>Save job</button><button className="btn small" onClick={() => { setJob(a.job ?? ''); setEditing(false); }}>Cancel</button></span>
        </>
      ) : (
        <>
          <p><strong>Job:</strong> {a.job || a.specialty || (a.role === 'coordinator' ? 'Keeps the project organised and suggests next steps.' : 'Not described yet.')}</p>
          <button className="btn small ghost" onClick={() => setEditing(true)}>{a.job ? 'Change the job' : 'Describe the job'}</button>
        </>
      )}
      <p className="pl-hint">Works with: {a.engine.kind === 'default' ? "the project's AI" : `${a.engine.kind}${a.engine.model ? ` (${a.engine.model})` : ''}`}</p>
      {a.role === 'worker' && !a.director && (
        <div className="pl-actions">
          {others.length > 0 && <select aria-label="Move to" defaultValue="" onChange={(e) => { if (e.target.value) onApply([{ op: 'move_agent', agentId: a.id, businessId: e.target.value }]); e.target.value = ''; }}><option value="" disabled>Move to…</option>{others.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
          <button className="btn small" disabled={busy} onClick={() => onApply([{ op: 'retire_agent', agentId: a.id }])}>Retire</button>
        </div>
      )}
    </section>
  );
}

function CallMeeting({ town, busy, onStart }: { town: TownState; busy: boolean; onStart: (topic: string, kind: MeetingKind, ids: string[]) => void }) {
  const [topic, setTopic] = useState('');
  const [kind, setKind] = useState<MeetingKind>('planning');
  const [chosen, setChosen] = useState<string[]>([]);
  const people = activeAgents(town).filter((a) => a.role !== 'coordinator');
  return (
    <Section title="Call a meeting" hint="Bring your team to the Town Hall to work something out. A meeting is a record of who came and what was decided. It does not start any AI by itself.">
      <div className="pl-form">
        <input aria-label="Meeting topic" value={topic} maxLength={200} placeholder="What should we work out? e.g. How should we build the main character?" onChange={(e) => setTopic(e.target.value)} />
        <label>Kind<select value={kind} onChange={(e) => setKind(e.target.value as MeetingKind)}>{MEETING_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
        <fieldset><legend>Who should come (the General Manager always does)</legend>
          {people.length === 0 && <small className="pl-hint">You have no workers yet. You and the General Manager can still meet.</small>}
          {people.map((a) => <label key={a.id} className="pl-check"><input type="checkbox" checked={chosen.includes(a.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))} /><Avatar a={a} /> {a.name}</label>)}
          {people.length > 1 && <button className="btn small ghost" onClick={() => setChosen(chosen.length === people.length ? [] : people.map((a) => a.id))}>{chosen.length === people.length ? 'Nobody else' : 'Everyone'}</button>}
        </fieldset>
        <button className="btn primary" disabled={busy || !topic.trim()} onClick={() => { onStart(topic.trim(), kind, chosen); setTopic(''); setChosen([]); }}>Call the meeting</button>
      </div>
    </Section>
  );
}

function MeetingBoard({ town, meeting, planId, busy, run, setTown, reload, onGoing }: { onGoing: (ids: ReadonlySet<string> | null) => void; town: TownState; meeting: TownMeeting; planId: string; busy: boolean; run: <T>(fn: () => Promise<T>) => Promise<T | undefined>; setTown: (t: TownState) => void; reload: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [chunks, setChunks] = useState('');
  const [sent, setSent] = useState<number | null>(null);
  const who = meeting.participantIds.map((id) => town.agents.find((a) => a.id === id)).filter((a): a is TownAgent => !!a);
  const lines = chunks.split(/\r?\n/).map((l) => l.replace(/^[\s\-*\d.)]+/, '').trim()).filter(Boolean).slice(0, 30);
  return (
    <Section title={`${KIND_LABEL[meeting.kind]}: ${meeting.topic}`} hint="Everyone is at the table. Write down what is said, then turn what you decided into tasks. The tasks wait on the Studio canvas until you add them.">
      <div className="tw-table" aria-label="Meeting table">
        <div className="tw-map" aria-hidden>The project map</div>
        {who.map((a, i) => <span key={a.id} className="tw-seat" style={{ ['--i' as string]: i, ['--n' as string]: who.length }}><Avatar a={a} big /><small>{a.name}</small></span>)}
      </div>
      <ul className="tw-notes">{meeting.notes.map((n, i) => <li key={i}><strong>{n.by}</strong> {n.text}</li>)}{!meeting.notes.length && <li className="pl-hint">Nothing said yet.</li>}</ul>
      <div className="pl-add">
        <input aria-label="Add to the meeting" value={text} maxLength={2000} placeholder="What was said or decided?" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim() && !busy) { const t = text; setText(''); void run(async () => { setTown(await api().meetingNote(planId, meeting.id, { by: 'You', text: t })); }); } }} />
        <button className="btn small" disabled={busy || !text.trim()} onClick={() => { const t = text; setText(''); void run(async () => { setTown(await api().meetingNote(planId, meeting.id, { by: 'You', text: t })); }); }}>Add</button>
      </div>
      <details><summary>Turn what we decided into tasks</summary>
        <div className="pl-fold-body">
          <textarea aria-label="Tasks, one per line" rows={4} value={chunks} placeholder={'One task per line, for example:\nConcept art\nModel the character\nRig it'} onChange={(e) => { setChunks(e.target.value); setSent(null); }} />
          <button className="btn small primary" disabled={busy || !lines.length} onClick={() => void run(async () => {
            const changes: ProposalChange[] = lines.map((title) => ({ op: 'add_task', title: title.slice(0, 200), description: '', priority: 'normal', dependsOn: [], completionChecks: [] }));
            await api().meetingPropose(planId, meeting.id, { note: `From the meeting: ${meeting.topic}`.slice(0, 1000), changes });
            setSent(lines.length); setChunks(''); await reload();
          })}>Suggest {lines.length || ''} task{lines.length === 1 ? '' : 's'} for the plan</button>
          {sent !== null && <p className="pl-hint" role="status">Sent {sent} task{sent === 1 ? '' : 's'} to the Studio canvas as suggestions. Add them there when you are happy.</p>}
        </div>
      </details>
      <RunWithAi town={town} meeting={meeting} planId={planId} setTown={setTown} reload={reload} onGoing={onGoing} />
      <div className="pl-actions"><button className="btn" disabled={busy} onClick={() => void run(async () => { setTown(await api().meetingEnd(planId, meeting.id)); })}>End the meeting</button></div>
    </Section>
  );
}

function PastMeetings({ town }: { town: TownState }) {
  const past = town.meetings.filter((m) => m.endedAt).slice().reverse();
  if (!past.length) return null;
  return (
    <details className="pl-fold"><summary>Earlier meetings<span className="pl-count">{past.length}</span></summary>
      <div className="pl-fold-body">
        {past.map((m) => (
          <article key={m.id} className="tw-past">
            <strong>{m.topic}</strong> <small className="pl-hint">{KIND_LABEL[m.kind]} · {new Date(m.startedAt).toLocaleDateString()} · {m.participantIds.length} people{m.proposalIds.length ? ` · ${m.proposalIds.length} suggestion${m.proposalIds.length === 1 ? '' : 's'} sent` : ''}</small>
            {m.notes.length > 0 && <ul>{m.notes.map((n, i) => <li key={i}><strong>{n.by}</strong> {n.text}</li>)}</ul>}
          </article>
        ))}
      </div>
    </details>
  );
}

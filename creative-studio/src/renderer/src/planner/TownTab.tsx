import { useMemo, useState } from 'react';
import { MEETING_KINDS, activeAgents, tierFor, type MeetingKind, type TeamChange, type TownAgent, type TownBusiness, type TownMeeting, type TownState } from '@shared/town';
import type { ProposalChange } from '@shared/planner';
import { errMsg, ErrorLine, Section, type TabProps } from './plannerUi';
import { useTown } from './useTown';

const api = () => window.studio.planner;

const KIND_LABEL: Record<MeetingKind, string> = {
  kickoff: 'Project kickoff', planning: 'Planning meeting', brainstorm: 'Creative brainstorming', technical: 'Technical review', progress: 'Progress meeting', emergency: 'Emergency meeting', other: 'Meeting',
};
const TIER_LABEL = { studio: 'Studio', workshop: 'Workshop', factory: 'Factory' } as const;
const describe = (c: TeamChange, t: TownState): string => {
  switch (c.op) {
    case 'add_business': return `Open ${c.name}`;
    case 'add_agent': return `Hire ${c.name}${c.specialty ? ` (${c.specialty})` : ''}`;
    case 'move_agent': return `Move ${t.agents.find((a) => a.id === c.agentId)?.name ?? 'a worker'} to ${t.businesses.find((b) => b.id === c.businessId)?.name ?? 'another business'}`;
    case 'retire_agent': return `Retire ${t.agents.find((a) => a.id === c.agentId)?.name ?? 'a worker'}`;
    case 'rename_business': return `Rename a business to ${c.name}`;
  }
};

function Avatar({ a, big }: { a: TownAgent; big?: boolean }) {
  return <span className={`tw-avatar${big ? ' big' : ''}`} style={{ background: a.look.accent }} title={`${a.name}${a.specialty ? `: ${a.specialty}` : ''}`}>{a.name.slice(0, 1).toUpperCase()}</span>;
}

/**
 * OmniTown: the people and places of the project. Every worker has a workplace; a workplace grows with the number of people in it. This shows who is
 * on the team, not what they are doing: nothing here is animated to look busy, because no work is started from here yet.
 */
export function TownTab({ p, reload, go }: TabProps) {
  const { town, setTown, note, clearNote } = useTown(p.id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(errMsg(e)); return undefined; } finally { setBusy(false); }
  };
  const apply = (changes: TeamChange[]) => run(async () => { setTown(await api().townApply(p.id, changes)); });

  const active = town?.meetings.filter((m) => !m.endedAt).at(-1) ?? null;
  if (!town) return <div className="pl-stack"><p className="pl-hint">Setting up your town…</p></div>;
  const selected = town.agents.find((a) => a.id === pick) ?? null;
  const pending = town.suggestions.filter((s) => s.status === 'pending');
  const team = activeAgents(town).filter((a) => a.role !== 'coordinator').length;

  return (
    <div className="tw">
      {note && <p className="pl-warn" role="status">{note} <button className="btn small ghost" onClick={clearNote}>Dismiss</button></p>}
      <ErrorLine error={error} />
      <div className="tw-bar">
        <h3>Your town</h3>
        <span className="spacer" />
        <button className="btn small primary" title="Talk through your idea with the coordinator and see the plan take shape" onClick={() => go('studio')}>Talk to the coordinator</button>
        <button className="btn small" disabled={busy} title="Suggests a studio and a specialist for each application your chunks name. Nothing is added until you say so." onClick={() => void run(async () => { setTown(await api().townSuggestFromPlan(p.id)); })}>Suggest a team</button>
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

      {team === 0 && (
        <p className="tw-intro" role="note">Your team starts with the coordinator, who is all you need to begin: just talk to them in <button className="btn small" onClick={() => go('studio')}>Studio</button>. When your chunks name the applications you will use, press <strong>Suggest a team</strong> and a specialist is added for each.</p>
      )}
      <div className="tw-main">
        <Scene town={town} onPick={setPick} pick={pick} />
        <aside className="tw-side">
          {selected ? <WorkerCard town={town} a={selected} busy={busy} onApply={apply} onClose={() => setPick(null)} />
            : <p className="pl-hint">Pick a worker or a building to see who they are. Every worker has their own place; busier businesses grow into bigger buildings.</p>}
          <details className="pl-fold"><summary>Add people yourself</summary><div className="pl-fold-body"><AddWorker town={town} busy={busy} onAdd={(c) => apply([c])} /></div></details>
        </aside>
      </div>

      {active ? <MeetingBoard town={town} meeting={active} planId={p.id} busy={busy} run={run} setTown={setTown} reload={reload} />
        : team === 0 ? <p className="pl-hint">Meetings are for when your team has more than the coordinator. Until then, talk to the coordinator in Studio.</p>
          : <CallMeeting town={town} busy={busy} onStart={(topic, kind, ids) => run(async () => { setTown((await api().meetingStart(p.id, { topic, kind, participantIds: ids })).town); })} />}

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

function AddWorker({ town, busy, onAdd }: { town: TownState; busy: boolean; onAdd: (c: TeamChange) => void }) {
  const biz = town.businesses.filter((b) => !town.workplaces.some((w) => w.kind === 'town-hall' && w.businessId === b.id));
  const [name, setName] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [bid, setBid] = useState('');
  if (!biz.length) return <p className="pl-hint">Open a business, then hire a worker for it.</p>;
  const target = bid || biz[0]!.id;
  return (
    <div className="pl-form tw-hire">
      <strong>Hire a worker</strong>
      <input aria-label="Worker name" value={name} maxLength={60} placeholder="Name" onChange={(e) => setName(e.target.value)} />
      <input aria-label="What they do" value={specialty} maxLength={200} placeholder="What they do (optional)" onChange={(e) => setSpecialty(e.target.value)} />
      <select aria-label="Business" value={target} onChange={(e) => setBid(e.target.value)}>{biz.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      <button className="btn small" disabled={busy || !name.trim()} onClick={() => { onAdd({ op: 'add_agent', name: name.trim(), specialty: specialty.trim(), businessId: target }); setName(''); setSpecialty(''); }}>Hire</button>
    </div>
  );
}

function Scene({ town, pick, onPick }: { town: TownState; pick: string | null; onPick: (id: string | null) => void }) {
  const box = useMemo(() => {
    const xs = town.workplaces.map((w) => w.x), ys = town.workplaces.map((w) => w.y);
    const min = (a: number[]) => Math.min(0, ...a), max = (a: number[]) => Math.max(0, ...a);
    return { x0: min(xs), x1: max(xs), y0: min(ys), y1: max(ys) };
  }, [town.workplaces]);
  const alone = town.workplaces.length === 1;
  const pos = (x: number, y: number) => alone ? { left: '50%', top: '22%' } : ({ left: `${16 + ((x - box.x0) / Math.max(1, box.x1 - box.x0)) * 68}%`, top: `${6 + ((y - box.y0) / Math.max(1, box.y1 - box.y0)) * 52}%` });
  return (
    <div className={`tw-scene${alone ? ' alone' : ''}`} role="group" aria-label="The town" onClick={() => onPick(null)}>
      {town.workplaces.map((w) => {
        const biz: TownBusiness | undefined = town.businesses.find((b) => b.id === w.businessId);
        const people = activeAgents(town, w.businessId);
        const tier = w.kind === 'town-hall' ? 'hall' : tierFor(people.length);
        return (
          <div key={w.id} className={`tw-building tier-${tier}`} style={pos(w.x, w.y)} onClick={(e) => e.stopPropagation()}>
            <div className="tw-roof" />
            <div className="tw-body">
              <strong>{w.name}</strong>
              <small>{w.kind === 'town-hall' ? 'Planning and meetings' : `${TIER_LABEL[tier as keyof typeof TIER_LABEL]} · ${people.length} ${people.length === 1 ? 'worker' : 'workers'}`}</small>
              {biz?.trade && w.kind !== 'town-hall' && <small className="pl-hint">{biz.trade}</small>}
              <div className="tw-people">{people.map((a) => <button key={a.id} className={`tw-person${a.id === pick ? ' selected' : ''}`} onClick={() => onPick(a.id)} aria-label={a.name}><Avatar a={a} /><span>{a.name}</span></button>)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WorkerCard({ town, a, busy, onApply, onClose }: { town: TownState; a: TownAgent; busy: boolean; onApply: (c: TeamChange[]) => void; onClose: () => void }) {
  const biz = town.businesses.find((b) => b.id === a.businessId);
  const others = town.businesses.filter((b) => b.id !== a.businessId && !town.workplaces.some((w) => w.kind === 'town-hall' && w.businessId === b.id));
  return (
    <section className="tw-card" aria-label={a.name}>
      <header><Avatar a={a} big /><div><strong>{a.name}</strong><br /><small className="pl-hint">{a.role === 'coordinator' ? 'Project coordinator' : 'Worker'} · {biz?.name}</small></div><button className="btn small ghost" onClick={onClose} aria-label="Close">×</button></header>
      {a.specialty && <p>{a.specialty}</p>}
      <p className="pl-hint">Works with: {a.engine.kind === 'default' ? "the project's AI" : `${a.engine.kind}${a.engine.model ? ` (${a.engine.model})` : ''}`}</p>
      {a.role === 'worker' && (
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
        <fieldset><legend>Who should come (the coordinator always does)</legend>
          {people.length === 0 && <small className="pl-hint">You have no workers yet. You and the coordinator can still meet.</small>}
          {people.map((a) => <label key={a.id} className="pl-check"><input type="checkbox" checked={chosen.includes(a.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))} /><Avatar a={a} /> {a.name}</label>)}
          {people.length > 1 && <button className="btn small ghost" onClick={() => setChosen(chosen.length === people.length ? [] : people.map((a) => a.id))}>{chosen.length === people.length ? 'Nobody else' : 'Everyone'}</button>}
        </fieldset>
        <button className="btn primary" disabled={busy || !topic.trim()} onClick={() => { onStart(topic.trim(), kind, chosen); setTopic(''); setChosen([]); }}>Call the meeting</button>
      </div>
    </Section>
  );
}

function MeetingBoard({ town, meeting, planId, busy, run, setTown, reload }: { town: TownState; meeting: TownMeeting; planId: string; busy: boolean; run: <T>(fn: () => Promise<T>) => Promise<T | undefined>; setTown: (t: TownState) => void; reload: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [chunks, setChunks] = useState('');
  const [sent, setSent] = useState<number | null>(null);
  const who = meeting.participantIds.map((id) => town.agents.find((a) => a.id === id)).filter((a): a is TownAgent => !!a);
  const lines = chunks.split(/\r?\n/).map((l) => l.replace(/^[\s\-*\d.)]+/, '').trim()).filter(Boolean).slice(0, 30);
  return (
    <Section title={`${KIND_LABEL[meeting.kind]}: ${meeting.topic}`} hint="Everyone is at the table. Write down what is said, then turn what you decided into chunks. The chunks wait on the Studio canvas until you add them.">
      <div className="tw-table" aria-label="Meeting table">
        <div className="tw-map" aria-hidden>The project map</div>
        {who.map((a, i) => <span key={a.id} className="tw-seat" style={{ ['--i' as string]: i, ['--n' as string]: who.length }}><Avatar a={a} big /><small>{a.name}</small></span>)}
      </div>
      <ul className="tw-notes">{meeting.notes.map((n, i) => <li key={i}><strong>{n.by}</strong> {n.text}</li>)}{!meeting.notes.length && <li className="pl-hint">Nothing said yet.</li>}</ul>
      <div className="pl-add">
        <input aria-label="Add to the meeting" value={text} maxLength={2000} placeholder="What was said or decided?" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim() && !busy) { const t = text; setText(''); void run(async () => { setTown(await api().meetingNote(planId, meeting.id, { by: 'You', text: t })); }); } }} />
        <button className="btn small" disabled={busy || !text.trim()} onClick={() => { const t = text; setText(''); void run(async () => { setTown(await api().meetingNote(planId, meeting.id, { by: 'You', text: t })); }); }}>Add</button>
      </div>
      <details><summary>Turn what we decided into chunks</summary>
        <div className="pl-fold-body">
          <textarea aria-label="Chunks, one per line" rows={4} value={chunks} placeholder={'One chunk per line, for example:\nConcept art\nModel the character\nRig it'} onChange={(e) => { setChunks(e.target.value); setSent(null); }} />
          <button className="btn small primary" disabled={busy || !lines.length} onClick={() => void run(async () => {
            const changes: ProposalChange[] = lines.map((title) => ({ op: 'add_task', title: title.slice(0, 200), description: '', priority: 'normal', dependsOn: [], completionChecks: [] }));
            await api().meetingPropose(planId, meeting.id, { note: `From the meeting: ${meeting.topic}`.slice(0, 1000), changes });
            setSent(lines.length); setChunks(''); await reload();
          })}>Suggest {lines.length || ''} chunk{lines.length === 1 ? '' : 's'} for the plan</button>
          {sent !== null && <p className="pl-hint" role="status">Sent {sent} chunk{sent === 1 ? '' : 's'} to the Studio canvas as suggestions. Add them there when you are happy.</p>}
        </div>
      </details>
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

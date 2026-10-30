import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatProviderInfo } from '@shared/plannerApi';
import { chunkPlan, type ChatProviderId } from '@shared/plannerChat';
import { coordinatorOf, directorTitle, type TownAgent, type TownState } from '@shared/town';
import type { PlanTask } from '@shared/planner';
import { chimePickPrompt, chimePrompt, costText, isPass, parsePick, parseTaskLines, replyPrompt, summaryPrompt } from '@shared/townMeeting';
import hallInside from '../assets/offices/town-hall.jpg';
import { HallPeople, meetingPeople } from './HallPeople';
import { errMsg, ErrorLine } from './plannerUi';

const api = () => window.studio.planner;
const store = (() => { try { return window.localStorage; } catch { return undefined; } })();
const get = (k: string) => { try { return store?.getItem(k) ?? null; } catch { return null; } };
const put = (k: string, v: string) => { try { store?.setItem(k, v); } catch { /* storage unavailable */ } };

/** What the General Manager says when the owner walks into the Town Hall to start a meeting. A fixed line: it costs nothing. */
export const GREETING = 'How can we help you, boss?';
const OWNER = 'You';

/**
 * The Town Hall is the whole meeting, run like an organised one. The owner talks with ONE person at a time, the General Manager to begin with, and that person's
 * answer stays over their head. After each exchange the others work out who, if anyone, has the most important thing the owner should hear; that person gets a !
 * over their head, and when the owner clicks it they start talking until someone else has something more important. The owner can also click anyone to talk to
 * them. Nothing joins the plan: tasks only appear on the Studio canvas. How it asks (the AI, the model) is under the chat, closed unless wanted.
 */
export function TownHall({ town, planId, tasks, setTown, reload, onBack, aside }: { town: TownState; planId: string; /** The plan's tasks, to list the ones added during this meeting. */ tasks: readonly PlanTask[]; setTown: (t: TownState) => void; reload: () => Promise<void>; onBack: () => void; aside?: ReactNode }) {
  const meeting = town.meetings.filter((m) => !m.endedAt).at(-1) ?? null;
  const people = useMemo(() => meetingPeople(town, meeting), [town, meeting]);
  const chair = coordinatorOf(town) ?? people[0] ?? null;
  const notes = useMemo(() => meeting?.notes ?? [], [meeting]);

  // Who the owner is talking with, what they last said, and who (at most one) has something important to say.
  const [currentId, setCurrentId] = useState<string | null>(null);
  const current = people.find((a) => a.id === currentId) ?? chair;
  const [bubble, setBubble] = useState<{ id: string; text: string; tasks?: string[] } | null>(null);
  const [chime, setChime] = useState<{ id: string; text: string; tasks?: string[] } | null>(null);
  /** Titles of tasks the owner added from a bubble in this visit (so the button turns into "Added"). */
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [speaking, setSpeaking] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false); const alive = useRef(true); const round = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; stop.current = true; }; }, []);
  /** A round is out of date once the owner has spoken again, pressed Stop or left. */
  const stale = (r: number) => !alive.current || stop.current || r !== round.current;

  // How it asks: the AI, the model, and whether the others may speak up. Under the chat, closed unless wanted.
  const [showSettings, setShowSettings] = useState(false);
  const [providers, setProviders] = useState<ChatProviderInfo[] | null>(null);
  const [provider, setProvider] = useState<ChatProviderId>(() => (['claude', 'openai', 'gemini'].includes(get('cs-planner-chat-provider') ?? '') ? (get('cs-planner-chat-provider') as ChatProviderId) : 'claude'));
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModel] = useState('');
  const [chimeOn, setChimeOn] = useState(() => get('cs-hall-chime') !== '0');
  useEffect(() => { void api().chatProviders().then(setProviders).catch((e) => setError(errMsg(e))); }, []);
  const info = providers?.find((x) => x.id === provider);
  useEffect(() => {
    if (!info?.ready) { setModels(null); return; }
    let live = true;
    void api().chatModels(provider).then((m) => { if (!live) return; setModels(m); const saved = get(`cs-planner-chat-model-${provider}`); setModel(saved && m.includes(saved) ? saved : m[0] ?? ''); }).catch((e) => { if (live) setError(errMsg(e)); });
    return () => { live = false; };
  }, [provider, info?.ready]);

  const ask = async (agentId: string, text: string) => (await api().chat({ projectId: planId, provider, model, agentId, messages: [{ role: 'user', text }] })).text.trim();
  const notesOf = (t: TownState, id: string) => t.meetings.find((m) => m.id === id)?.notes ?? [];

  /**
   * After an exchange, in the background: one short request, shown to nobody, picks who (if anyone) has the most important thing to say, and that person is asked for it. If they
   * have something, a ! appears over their head. Only one ! at a time, and nothing is shown if the owner has already moved on.
   */
  const checkChime = async (r: number, t: TownState, meetingId: string, talkingWith: TownAgent) => {
    try {
      const sitting = meetingPeople(t, t.meetings.find((m) => m.id === meetingId) ?? null);
      const others = sitting.filter((a) => a.id !== talkingWith.id);
      const mine = notesOf(t, meetingId);
      const recent = [...new Set(mine.slice(-4).map((n) => n.by).filter((b) => b !== OWNER && b !== talkingWith.name))];
      if (!others.length) return;
      const picked = parsePick(await ask((chair ?? talkingWith).id, chimePickPrompt(talkingWith.name, others, recent, mine)), others.map((a) => a.name));
      const who = others.find((a) => a.name === picked);
      if (!who || stale(r)) return;
      const remark = await ask(who.id, chimePrompt(who, talkingWith.name, mine));
      if (stale(r) || isPass(remark)) return;
      const parsed = parseTaskLines(remark);
      setChime({ id: who.id, text: parsed.text, tasks: parsed.tasks }); setProgress(`${who.name} has something important to tell you.`);
    } catch { /* the owner's own message already worked; a failed look-out just means nobody speaks up */ }
  };

  /** The owner says something to the person they are talking with. They answer; then the others get a chance to speak up. */
  const go = async (text: string) => {
    if (!info?.ready || !model) { setShowSettings(true); setError(info && !info.ready ? info.note : 'Still choosing the AI. Try again in a moment.'); setDraft(text); return; }
    const r = ++round.current;
    stop.current = false; setBusy(true); setError(null); setBubble(null); setProgress('');
    try {
      let m = meeting; let t = town;
      if (!m) {
        const started = await api().meetingStart(planId, { topic: text.slice(0, 200), kind: 'brainstorm', participantIds: people.map((a) => a.id).slice(0, 12) });
        t = started.town; m = started.meeting; setTown(t);
        if (chair) { t = await api().meetingNote(planId, m.id, { by: chair.name, text: GREETING }); setTown(t); }
      }
      t = await api().meetingNote(planId, m.id, { by: OWNER, text: text.slice(0, 2000) }); setTown(t);
      const sitting = meetingPeople(t, t.meetings.find((x) => x.id === m!.id) ?? m);
      const who = sitting.find((a) => a.id === current?.id) ?? sitting[0];
      if (!who) return;
      setCurrentId(who.id); setSpeaking(who.id); setProgress(`${who.name} is answering…`);
      const said = await ask(who.id, replyPrompt(m, who, sitting.filter((a) => a.id !== who.id).map((a) => a.name), notesOf(t, m.id)));
      setSpeaking(null);
      if (stale(r)) { if (alive.current) setProgress('Stopped. What was said is kept.'); return; }
      const parsed = parseTaskLines(said);
      t = await api().meetingNote(planId, m.id, { by: who.name, text: parsed.text.slice(0, 2000) || '(no reply)' }); setTown(t);
      setBubble({ id: who.id, text: parsed.text, tasks: parsed.tasks }); setProgress('');
      setBusy(false);
      if (chimeOn && !chime) await checkChime(r, t, m.id, who);
    } catch (e) {
      if (alive.current) { setError(errMsg(e)); setProgress('Stopped because something went wrong. What was said so far is kept.'); }
    } finally {
      if (alive.current && r === round.current) { setBusy(false); setSpeaking(null); }
    }
  };

  /** The General Manager turns what was said into tasks: at most ONE suggestion, which waits on the Studio canvas. */
  const makeTasks = async () => {
    if (!meeting || !chair) return;
    if (!info?.ready || !model) { setShowSettings(true); setError(info && !info.ready ? info.note : 'Still choosing the AI. Try again in a moment.'); return; }
    const r = ++round.current;
    stop.current = false; setBusy(true); setError(null); setSpeaking(chair.id); setProgress(`${chair.name} is turning it into tasks…`);
    try {
      const text = await ask(chair.id, summaryPrompt(meeting, notes));
      if (stale(r)) return;
      const plan = chunkPlan(text);
      if (plan) {
        await api().meetingPropose(planId, meeting.id, { note: `From the meeting: ${meeting.topic}`.slice(0, 1000), changes: plan.chunks });
        await reload();
        setProgress(`Done. ${plan.chunks.length} task${plan.chunks.length === 1 ? '' : 's'} are waiting on the Studio canvas for you to add.`);
      } else {
        setTown(await api().meetingNote(planId, meeting.id, { by: chair.name, text: text.slice(0, 2000) || '(nothing was decided)' }));
        setProgress('Done. Nothing clear was decided, so nothing was suggested.');
      }
    } catch (e) {
      if (alive.current) { setError(errMsg(e)); setProgress('Stopped because something went wrong.'); }
    } finally {
      if (alive.current && r === round.current) { setBusy(false); setSpeaking(null); }
    }
  };

  /** Someone was clicked. The one with a ! starts talking to the owner; anyone else becomes the person the owner talks with. */
  const pick = (id: string) => {
    if (busy) return;
    const who = people.find((a) => a.id === id); if (!who) return;
    round.current++; // anything still being looked up for the last exchange is out of date now
    setSpeaking(null); setCurrentId(id); setProgress('');
    if (chime && chime.id === id) {
      const said = chime.text; const recommended = chime.tasks; setChime(null); setBubble({ id, text: said, tasks: recommended });
      if (meeting) void api().meetingNote(planId, meeting.id, { by: who.name, text: said.slice(0, 2000) }).then(setTown).catch((e) => setError(errMsg(e)));
    } else setBubble(null);
  };

  /**
   * The owner pressed Add task under someone's bubble: it joins the plan now (that press is the owner's approval), owned by the person who recommended it,
   * and shows in the list beside the room. A task the plan already has is not added a second time.
   */
  const addTask = (id: string, title: string) => {
    const who = people.find((a) => a.id === id); if (!who) return;
    void (async () => {
      try {
        setError(null);
        if (!tasks.some((t) => t.status !== 'cancelled' && t.title.trim().toLowerCase() === title.trim().toLowerCase())) {
          const pr = await api().importSuggestions(planId, {
            proposer: { kind: 'other', name: who.name }, note: `Task from ${who.name} in the meeting`, rawText: title,
            changes: [{ op: 'add_task', title: title.slice(0, 200), description: `Recommended by ${who.name} in a meeting.`, priority: 'normal', dependsOn: [], completionChecks: [], assignee: who.director ?? null }],
          });
          await api().decideProposal(planId, pr.id, true, [0]);
          await reload();
        }
        setAdded((s) => new Set(s).add(title));
      } catch (e) { setError(errMsg(e)); }
    })();
  };

  const send = () => { const t = draft.trim(); if (!t || busy) return; setDraft(''); void go(t); };
  const end = () => {
    round.current++;
    // End every open meeting, not just the latest: one left open from before would otherwise take its place and it would look as if nothing ended.
    void (async () => { try { let t = town; for (const m of town.meetings.filter((x) => !x.endedAt)) t = await api().meetingEnd(planId, m.id); setTown(t); setBubble(null); setChime(null); setCurrentId(null); setProgress(''); setAdded(new Set()); } catch (e) { setError(errMsg(e)); } })();
  };

  const fromMeeting = useMemo(() => (meeting ? tasks.filter((t) => t.status !== 'cancelled' && t.createdAt >= meeting.startedAt) : []), [tasks, meeting]);
  const greeting = !meeting && chair && !bubble ? { id: chair.id, text: GREETING } : null;
  const waiting = useMemo(() => new Set(chime ? [chime.id] : []), [chime]);

  return (
    <div className="tw-main tw-inoffice">
      <section className="tw-room" aria-label="Inside the Town Hall">
        <img src={hallInside} alt="Inside the Town Hall" />
        <HallPeople people={people} speaking={speaking} waiting={waiting} current={meeting ? current?.id ?? null : null} open={bubble} added={added} onAddTask={addTask} onPick={pick} onCloseBubble={() => setBubble(null)} greeting={greeting} />
        <button className="btn small tw-back" onClick={onBack}>← Back to the town</button>
        <div className="tw-hall-top">
  <p className="tw-hall-actions">
    {meeting && !busy && <button className="btn small" onClick={() => void makeTasks()} disabled={notes.length < 3} title="The General Manager turns what was said into tasks. They wait on the Studio canvas for you.">Make tasks from this</button>}
    {meeting && !busy && <button className="btn small" onClick={end}>End the meeting</button>}
  </p>
  <details className="tw-hall-settings" open={showSettings} onToggle={(e) => setShowSettings((e.currentTarget as HTMLDetailsElement).open)}>
    <summary>Meeting settings</summary>
    <div className="tw-hall-settings-body">
      <div className="pl-two">
        <label>AI
          <select value={provider} onChange={(e) => { setProvider(e.target.value as ChatProviderId); put('cs-planner-chat-provider', e.target.value); setError(null); }}>
            {(providers ?? []).map((x) => <option key={x.id} value={x.id}>{x.label}{x.ready ? '' : ' (needs a key)'}</option>)}
          </select>
        </label>
        <label>Model
          <select value={model} disabled={!models?.length} onChange={(e) => { setModel(e.target.value); put(`cs-planner-chat-model-${provider}`, e.target.value); }}>
            {(models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
            {!models?.length && <option value="">{info && !info.ready ? '-' : 'loading…'}</option>}
          </select>
        </label>
      </div>
      <label className="pl-check"><input type="checkbox" checked={chimeOn} onChange={(e) => { setChimeOn(e.target.checked); put('cs-hall-chime', e.target.checked ? '1' : '0'); }} /> Let the others speak up when they have something important</label>
      {info && !info.ready && <p className="pl-warn">{info.note}</p>}
      {info?.ready && model && <p className="pl-hint">{costText(chimeOn, info.label, model)} {info.cost}</p>}
    </div>
  </details>
        </div>

        <div className="tw-hall-bar">
          {progress && <p className="tw-hall-status" role="status">{progress}</p>}
          <ErrorLine error={error} />
          <div className="tw-hall-input">
            <textarea aria-label="Say something to the team" rows={2} value={draft} placeholder={meeting && current ? `Say something to ${current.name}…` : 'What should we work out? Type here to start the meeting…'} disabled={busy}
              onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
            {busy
              ? <button className="btn" onClick={() => { stop.current = true; setProgress('Stopping after the reply that is already on its way…'); }}>Stop</button>
              : <button className="btn primary" disabled={!draft.trim()} onClick={send}>Send</button>}
          </div>
        </div>
      </section>
      <aside className="tw-side">
        <p className="pl-hint"><strong>The Town Hall.</strong> {meeting ? 'You are talking with one person at a time. When someone else has something important to tell you, a ! appears over their head: click it to hear them. Click anyone to talk to them instead.' : 'This is where your team meets. Type below to start a meeting.'}</p>
        {meeting && (
          <details className="pl-fold" open><summary>Tasks from this meeting<span className="pl-count">{fromMeeting.length}</span></summary>
            {fromMeeting.length === 0 ? <p className="pl-hint">When someone recommends a task, press Add task under what they say and it lands here.</p> : (
              <ul className="tw-hall-tasks">{fromMeeting.map((t) => <li key={t.id}><strong>{t.title}</strong><small>{t.assignee ? `${directorTitle(t.assignee) ?? t.assignee}` : 'No one yet'} · {t.status === 'accepted' ? 'Done' : 'To do'}</small></li>)}</ul>
            )}
          </details>
        )}
        {meeting && (
          <details className="pl-fold" open><summary>What was said<span className="pl-count">{notes.length}</span></summary>
            <ul className="tw-notes tw-hall-notes">{notes.map((n, i) => <li key={i}><strong>{n.by}</strong> {n.text}</li>)}</ul>
          </details>
        )}
        {aside}
      </aside>
    </div>
  );
}

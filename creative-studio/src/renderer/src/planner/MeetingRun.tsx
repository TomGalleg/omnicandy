import { useEffect, useRef, useState } from 'react';
import type { ChatProviderInfo } from '@shared/plannerApi';
import { chunkPlan, type ChatProviderId } from '@shared/plannerChat';
import { coordinatorOf, type TownAgent, type TownMeeting, type TownState } from '@shared/town';
import { clampMeetingTurns, meetingConfirmText, MEETING_TURNS, summaryPrompt, turnOrder, turnPrompt } from '@shared/townMeeting';
import { errMsg, ErrorLine } from './plannerUi';

const api = () => window.studio.planner;
const store = (() => { try { return window.localStorage; } catch { return undefined; } })();
const get = (k: string) => { try { return store?.getItem(k) ?? null; } catch { return null; } };

/**
 * "Run this meeting with AI": each person at the table speaks in turn (one request each), then the General Manager turns it into tasks. Only starts after the
 * owner confirms what it will do; stops at once on Stop, on leaving the screen, or on the first problem. It adds to the meeting notes and sends at most ONE
 * suggestion to the Studio canvas. It never changes the plan itself. While it runs, the people at the table walk to the Town Hall (`onGoing`).
 */
export function RunWithAi({ town, meeting, planId, setTown, reload, onGoing, onSpeaking, onSaid }: { onSpeaking: (id: string | null) => void; onSaid: (id: string, text: string) => void; town: TownState; meeting: TownMeeting; planId: string; setTown: (t: TownState) => void; reload: () => Promise<void>; onGoing: (ids: ReadonlySet<string> | null) => void }) {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ChatProviderInfo[] | null>(null);
  const [provider, setProvider] = useState<ChatProviderId>(() => (['claude', 'openai', 'gemini'].includes(get('cs-planner-chat-provider') ?? '') ? (get('cs-planner-chat-provider') as ChatProviderId) : 'claude'));
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModel] = useState('');
  const [turns, setTurns] = useState<number>(MEETING_TURNS.default);
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; stop.current = true; onGoing(null); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const people = meeting.participantIds.map((id) => town.agents.find((a) => a.id === id)).filter((a): a is TownAgent => !!a && !a.retired);
  useEffect(() => { if (open && !providers) void api().chatProviders().then(setProviders).catch((e) => setError(errMsg(e))); }, [open, providers]);
  const info = providers?.find((x) => x.id === provider);
  useEffect(() => {
    if (!open || !info?.ready) { setModels(null); return; }
    let live = true;
    void api().chatModels(provider).then((m) => { if (!live) return; setModels(m); const saved = get(`cs-planner-chat-model-${provider}`); setModel(saved && m.includes(saved) ? saved : m[0] ?? ''); }).catch((e) => { if (live) setError(errMsg(e)); });
    return () => { live = false; };
  }, [open, provider, info?.ready]);

  const ask = async (agentId: string, text: string) => {
    const r = await api().chat({ projectId: planId, provider, model, agentId, messages: [{ role: 'user', text }] });
    return r.text.trim();
  };

  const go = async () => {
    stop.current = false; setState('running'); setError(null); setOpen(false);
    onGoing(new Set(people.map((p) => p.id)));
    let notes = [...meeting.notes];
    try {
      const order = turnOrder(people.map((p) => p.id), turns);
      for (let i = 0; i < order.length; i++) {
        if (stop.current || !alive.current) break;
        const who = people.find((p) => p.id === order[i])!;
        setProgress(`${who.name} is speaking (${i + 1} of ${order.length})…`);
        onSpeaking(who.id);
        const said = await ask(who.id, turnPrompt(meeting, who, people.filter((p) => p.id !== who.id).map((p) => p.name), notes));
        if (stop.current || !alive.current) break;
        const t = await api().meetingNote(planId, meeting.id, { by: who.name, text: said.slice(0, 2000) || '(no reply)' });
        if (!alive.current) break;
        onSpeaking(null); onSaid(who.id, said.slice(0, 600));
        setTown(t);
        notes = t.meetings.find((m) => m.id === meeting.id)?.notes ?? notes;
      }
      if (!stop.current && alive.current) {
        const chair = coordinatorOf(town) ?? people[0];
        if (chair) {
          setProgress(`${chair.name} is turning it into tasks…`);
          onSpeaking(chair.id);
          const text = await ask(chair.id, summaryPrompt(meeting, notes));
          if (!stop.current && alive.current) {
            const plan = chunkPlan(text);
            if (plan) {
              await api().meetingPropose(planId, meeting.id, { note: `From the meeting: ${meeting.topic}`.slice(0, 1000), changes: plan.chunks });
              await reload();
              setProgress(`Done. ${plan.chunks.length} task${plan.chunks.length === 1 ? '' : 's'} are waiting on the Studio canvas for you to add.`);
            } else {
              setTown(await api().meetingNote(planId, meeting.id, { by: chair.name, text: text.slice(0, 2000) || '(nothing was decided)' }));
              setProgress('Done. Nothing clear was decided, so nothing was suggested.');
            }
          }
        }
      } else if (stop.current && alive.current) setProgress('Stopped. What was said is in the notes.');
    } catch (e) {
      if (alive.current) { setError(errMsg(e)); setProgress('Stopped because something went wrong. What was said so far is in the notes.'); }
    } finally {
      if (alive.current) setState('done');
      onSpeaking(null);
      onGoing(null);
    }
  };

  if (state === 'running') {
    return (
      <div className="pl-ready" role="status">
        <p className="pl-hint">{progress || 'Starting…'}</p>
        <button className="btn" onClick={() => { stop.current = true; setProgress('Stopping after the reply that is already on its way…'); }}>Stop</button>
      </div>
    );
  }
  return (
    <div>
      {!open && <button className="btn" disabled={!people.length} onClick={() => { setOpen(true); setState('idle'); setError(null); setProgress(''); }}>Run this meeting with AI</button>}
      {state === 'done' && progress && <p className="pl-hint" role="status">{progress}</p>}
      <ErrorLine error={error} />
      {open && (
        <div className="pl-warn" role="alertdialog" aria-label="Run this meeting with AI">
          <p><strong>Run this meeting with AI?</strong> Each person at the table says their piece in turn, then the General Manager turns it into tasks.</p>
          <div className="pl-two">
            <label>AI
              <select value={provider} onChange={(e) => setProvider(e.target.value as ChatProviderId)}>
                {(providers ?? []).map((x) => <option key={x.id} value={x.id}>{x.label}{x.ready ? '' : ' (needs a key)'}</option>)}
              </select>
            </label>
            <label>Model
              <select value={model} disabled={!models?.length} onChange={(e) => setModel(e.target.value)}>
                {(models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
                {!models?.length && <option value="">{info && !info.ready ? '-' : 'loading…'}</option>}
              </select>
            </label>
            <label>Replies
              <select value={turns} onChange={(e) => setTurns(clampMeetingTurns(Number(e.target.value)))}>
                {[4, 6, 8, 12].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          {info && !info.ready && <p className="pl-warn">{info.note}</p>}
          {info?.ready && model && <p className="pl-hint">{meetingConfirmText(turns, people.length, info.label, model)} {info.cost}</p>}
          <p className="pl-actions">
            <button className="btn primary" disabled={!info?.ready || !model} onClick={() => void go()}>Start the meeting</button>
            <button className="btn" onClick={() => setOpen(false)}>Not yet</button>
          </p>
        </div>
      )}
    </div>
  );
}

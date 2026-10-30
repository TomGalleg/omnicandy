import { useEffect, useRef, useState } from 'react';
import type { PlanTask } from '@shared/planner';
import type { ChatMessage } from '@shared/plannerChat';
import type { TownAgent } from '@shared/town';
import { parseTaskLines, TASK_NOTE } from '@shared/townMeeting';
import { plain } from './HallPeople';
import { AiPicker, useAiSettings, useTaskAdder } from './meetingKit';
import { errMsg, ErrorLine } from './plannerUi';
import type { CastMember } from './townCast';

const api = () => window.studio.planner;

/**
 * The chat inside a director's office: the same box as the Town Hall's, along the bottom of the room, talking with just this director. Their answer shows in a
 * speech bubble beside them (long ones scroll), and a task they recommend gets an Add task button under it. The conversation is the one kept with the plan
 * (the General Manager's is the Studio's), so it is the same whichever door the owner uses.
 */
export function OfficeChat({ agent, seat, planId, tasks, reload, onMessages }: { agent: TownAgent; seat: CastMember['seat']; planId: string; tasks: readonly PlanTask[]; reload: () => Promise<void>; onMessages: (m: ChatMessage[]) => void }) {
  const isGm = agent.director === 'general-manager';
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [bubble, setBubble] = useState<{ text: string; tasks: string[] } | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const stop = useRef(false); const alive = useRef(true); const round = useRef(0);
  const ai = useAiSettings(setError);
  const adder = useTaskAdder(planId, tasks, reload, setError);
  useEffect(() => { alive.current = true; return () => { alive.current = false; stop.current = true; }; }, []);

  // What was said before comes back with the room, and the director's last answer is still over their head.
  useEffect(() => {
    let live = true;
    void (isGm ? api().chatLoad(planId) : api().chatLoadFor(planId, agent.id)).then((c) => {
      if (!live) return;
      setMessages(c.messages); onMessages(c.messages);
      const last = [...c.messages].reverse().find((m) => m.role === 'assistant');
      if (last) setBubble({ text: last.text, tasks: [] });
    }).catch(() => {});
    return () => { live = false; };
  }, [planId, agent.id, isGm]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    const text = draft.trim(); if (!text || busy) return;
    if (!ai.ready) { setShowSettings(true); setError(ai.info && !ai.info.ready ? ai.info.note : 'Still choosing the AI. Try again in a moment.'); return; }
    const r = ++round.current;
    const mine: ChatMessage = { role: 'user', text: text.slice(0, 6000) };
    const next = [...messages, mine];
    setDraft(''); setBusy(true); setError(null); setBubble(null); stop.current = false; setMessages(next); onMessages(next);
    const who = isGm ? {} : { who: agent.id };
    void api().chatAppend(planId, { messages: [mine], provider: ai.provider, model: ai.model, ...who }).catch(() => {});
    try {
      // The task hint goes with this request only; it is not kept in the conversation.
      const asked = [...messages.slice(-22), { role: 'user' as const, text: `${mine.text}\n\n${TASK_NOTE.trim()}`.slice(0, 6000) }];
      const reply = (await api().chat({ projectId: planId, provider: ai.provider, model: ai.model, agentId: agent.id, messages: asked })).text.trim();
      if (!alive.current || stop.current || r !== round.current) return;
      const parsed = parseTaskLines(reply);
      const theirs: ChatMessage = { role: 'assistant', text: (parsed.text || reply).slice(0, 6000) };
      const all = [...next, theirs]; setMessages(all); onMessages(all);
      void api().chatAppend(planId, { messages: [theirs], provider: ai.provider, model: ai.model, ...who }).catch(() => {});
      setBubble({ text: theirs.text, tasks: parsed.tasks });
    } catch (e) { if (alive.current) setError(errMsg(e)); } finally { if (alive.current && r === round.current) setBusy(false); }
  };

  const left = seat.left + seat.width / 2 + 1.5;
  const top = Math.max(3, seat.top - 5);
  return (
    <>
      <div className="tw-hall-top">
        <details className="tw-hall-settings" open={showSettings} onToggle={(e) => setShowSettings((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>Chat settings</summary>
          <div className="tw-hall-settings-body">
            <AiPicker s={ai} />
            {ai.info?.ready && ai.model && <p className="pl-hint">Each message you send makes one request to {ai.info.label} ({ai.model}). {ai.info.cost}</p>}
          </div>
        </details>
      </div>

      {(busy || bubble) && (
        <div className={`tw-bubble side ${busy ? 'pill' : 'open'}`} role="status" aria-label={`${agent.name} says`} onClick={busy ? undefined : () => setBubble(null)}
          style={{ left: `${left}%`, top: `${top}%`, width: busy ? '15%' : '36%', maxHeight: `calc(${100 - top}% - 124px)` }}>
          <strong>{agent.name}</strong>
          {busy
            ? <span className="tw-dots" aria-label="is thinking"><i /><i /><i /></span>
            : bubble && (
              <>
                <span className="tw-bubble-text">{plain(bubble.text)}</span>
                {bubble.tasks.length > 0 && (
                  <div className="tw-bubble-tasks" onClick={(e) => e.stopPropagation()}>
                    {bubble.tasks.map((t) => (
                      <div key={t} className="tw-bubble-task"><span>{t}</span>{adder.added.has(t) ? <em>Added to your plan</em> : <button type="button" className="btn small primary" onClick={() => adder.add(agent, t)}>Add task</button>}</div>
                    ))}
                  </div>
                )}
                <small className="tw-bubble-hint">Click to close</small>
              </>
            )}
        </div>
      )}

      <div className="tw-hall-bar">
        <ErrorLine error={error} />
        <div className="tw-hall-input">
          <textarea aria-label={`Say something to ${agent.name}`} rows={2} value={draft} placeholder={`Say something to ${agent.name}…`} disabled={busy}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          {busy
            ? <button className="btn" onClick={() => { stop.current = true; setBusy(false); }}>Stop</button>
            : <button className="btn primary" disabled={!draft.trim()} onClick={() => void send()}>Send</button>}
        </div>
      </div>
    </>
  );
}

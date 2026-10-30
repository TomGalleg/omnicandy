import { useEffect, useRef, useState } from 'react';
import type { PlannerProject } from '@shared/planner';
import { chunkPlan, isReady, MAKE_PLAN_REQUEST, withoutMarker, type ChatMessage, type ChatMode } from '@shared/plannerChat';
import type { TownAgent } from '@shared/town';
import { isNo, isYes, wantsBuild } from '@shared/ownerReply';
import { parseTaskLines, TASK_NOTE } from '@shared/townMeeting';
import { plain } from './HallPeople';
import { AiPicker, useAiSettings, useTaskAdder } from './meetingKit';
import { ChunkList } from './PlannerChat';
import { errMsg, ErrorLine } from './plannerUi';
import type { CastMember } from './townCast';

const api = () => window.studio.planner;

/**
 * The chat inside a director's office: the same box as the Town Hall's, along the bottom of the room, talking with just this director. Their answer shows in a
 * speech bubble beside them (long ones scroll), and a task they recommend gets an Add task button under it. The conversation is the one kept with the plan
 * (the General Manager's is the Studio's), so it is the same whichever door the owner uses.
 *
 * The General Manager's office does everything the Studio chat does: they talk the idea through, say when they understand ("Ready to start building?"), and
 * on "Yes, make the plan" give the tasks as a list to show on the canvas. Every other director recommends a task or two with an Add task button.
 */
export function OfficeChat({ agent, seat, p, reload, onMessages, taskCount = 0, waitingCount = 0, onTasks, onOpenPlan, onBuild, variant = 'room' }: { agent: TownAgent; seat?: CastMember['seat']; p: PlannerProject; reload: () => Promise<void>; onMessages: (m: ChatMessage[]) => void; /** This director's open tasks, and how many have a result waiting for the owner. */ taskCount?: number; waitingCount?: number; onTasks?: () => void; onOpenPlan: () => void;
  /** "Let's build this": starts the build and answers in the director's voice. `ai` is the AI chosen under the chat, or null when none is ready. */ onBuild?: (ai: { provider: 'claude' | 'openai' | 'gemini'; model: string } | null) => Promise<string>;
  /** `room`: laid over the picture of the office. `panel`: a compact box in the side panel beside the town map, for talking with the General Manager without going anywhere. */ variant?: 'room' | 'panel' }) {
  const planId = p.id;
  const isGm = agent.director === 'general-manager';
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [bubble, setBubble] = useState<{ text: string; tasks: string[] } | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const stop = useRef(false); const alive = useRef(true); const round = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ai = useAiSettings(setError);
  const adder = useTaskAdder(planId, p.tasks, reload, setError);
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

  /** An answer the director gives without asking an AI (a plain yes, or the build starting): kept in the conversation like any other. */
  const answerLocally = (said: string, replyText: string, tasks: string[] = []) => {
    const mine: ChatMessage = { role: 'user', text: said.trim().slice(0, 6000) };
    const theirs: ChatMessage = { role: 'assistant', text: replyText.slice(0, 6000) };
    const all = [...messages, mine, theirs]; setMessages(all); onMessages(all); setBubble({ text: theirs.text, tasks });
    const who = isGm ? {} : { who: agent.id };
    void api().chatAppend(planId, { messages: [mine, theirs], provider: ai.provider, model: ai.model, ...who }).catch(() => {});
  };

  /** Say `text` to this director. `mode` is only for the General Manager's "Yes, make the plan", which asks for the tasks instead of more conversation. */
  const submit = async (text: string, mode: ChatMode = 'talk') => {
    if (!text.trim() || busy) return;
    if (!ai.ready) { setShowSettings(true); setError(ai.info && !ai.info.ready ? ai.info.note : 'Still choosing the AI. Try again in a moment.'); return; }
    const r = ++round.current;
    const mine: ChatMessage = { role: 'user', text: text.trim().slice(0, 6000) };
    const next = [...messages, mine];
    setBusy(true); setError(null); setBubble(null); stop.current = false; setMessages(next); onMessages(next);
    const who = isGm ? {} : { who: agent.id };
    void api().chatAppend(planId, { messages: [mine], provider: ai.provider, model: ai.model, ...who }).catch(() => {});
    try {
      // The task hint goes with this request only, and not to the General Manager (they plan with the whole list instead); it is not kept in the conversation.
      const asked = [...messages.slice(-22), { role: 'user' as const, text: (isGm ? mine.text : `${mine.text}\n\n${TASK_NOTE.trim()}`).slice(0, 6000) }];
      const reply = (await api().chat({ projectId: planId, provider: ai.provider, model: ai.model, agentId: agent.id, messages: asked, ...(mode === 'chunks' ? { mode } : {}) })).text.trim();
      if (!alive.current || stop.current || r !== round.current) return;
      const parsed = isGm ? { text: reply, tasks: [] as string[] } : parseTaskLines(reply);
      const theirs: ChatMessage = { role: 'assistant', text: (parsed.text || reply).slice(0, 6000) };
      const all = [...next, theirs]; setMessages(all); onMessages(all);
      void api().chatAppend(planId, { messages: [theirs], provider: ai.provider, model: ai.model, ...who }).catch(() => {});
      setBubble({ text: theirs.text, tasks: parsed.tasks });
    } catch (e) { if (alive.current) setError(errMsg(e)); } finally { if (alive.current && r === round.current) setBusy(false); }
  };
  const send = () => {
    const t = draft.trim(); if (!t || busy) return;
    // A plain yes to something just offered needs no AI: the offered tasks go on this director's list, and they carry on.
    const offered = bubble?.tasks.filter((x) => !adder.added.has(x)) ?? [];
    if (offered.length && isYes(t)) {
      setDraft(''); for (const title of offered) adder.add(agent, title);
      answerLocally(t, `Good. ${offered.length === 1 ? `"${offered[0]}" is` : `${offered.map((x) => `"${x}"`).join(' and ')} are`} on my list now. I will get on with ${offered.length === 1 ? 'it' : 'them'}. Say "let's build this" when you want the team to start working through the list.`);
      return;
    }
    if (offered.length && isNo(t)) { setDraft(''); answerLocally(t, 'Okay, I will leave that. Tell me if you change your mind.'); return; }
    // The General Manager asked "Ready to start building?": a yes makes the plan, no button needed.
    if (ready && isYes(t)) { setDraft(''); void submit(MAKE_PLAN_REQUEST, 'chunks'); return; }
    // "Let's build this": the team starts working through the open tasks, in order, one at a time.
    if (onBuild && wantsBuild(t)) {
      setDraft(''); setBusy(true); setError(null);
      void onBuild(ai.ready ? { provider: ai.provider as 'claude' | 'openai' | 'gemini', model: ai.model } : null).then((said) => { if (alive.current) answerLocally(t, said); }).catch((e) => { if (alive.current) setError(errMsg(e)); }).finally(() => { if (alive.current) setBusy(false); });
      return;
    }
    // If there is no AI ready to answer yet, say so and keep what was typed instead of clearing the box.
    if (!ai.ready) { setShowSettings(true); setError(ai.info && !ai.info.ready ? ai.info.note : 'Still choosing the AI. Try again in a moment.'); return; }
    setDraft(''); void submit(t);
  };

  // The General Manager's plan: a list of tasks to show on the canvas, or the question that comes before it.
  const plan = isGm && bubble ? chunkPlan(bubble.text) : null;
  const ready = isGm && bubble && !plan && isReady(bubble.text);

  /** What the director said: the words, the plan list, the "ready?" question, and the tasks they recommend. The same in the office and in the side panel. */
  const content = bubble && (
    <>
      {plan
        ? (
          <span className="tw-bubble-text tw-bubble-plan" onClick={(e) => e.stopPropagation()}>
            <ChunkList p={p} reload={reload} text={bubble.text} go={() => {}} onChange={() => inputRef.current?.focus()} preview />
            <button type="button" className="btn small" onClick={onOpenPlan}>Look at the plan</button>
          </span>
        )
        : <span className="tw-bubble-text">{plain(withoutMarker(bubble.text))}</span>}
      {ready && (
        <div className="tw-bubble-tasks" onClick={(e) => e.stopPropagation()}>
          <div className="tw-bubble-task"><span>Ready to start building?</span>
            <button type="button" className="btn small primary" onClick={() => void submit(MAKE_PLAN_REQUEST, 'chunks')}>Yes, make the plan</button></div>
          <div className="tw-bubble-task"><span>Or tell me what else to add.</span><button type="button" className="btn small" onClick={() => { setBubble(null); inputRef.current?.focus(); }}>Not yet</button></div>
        </div>
      )}
      {bubble.tasks.length > 0 && (
        <div className="tw-bubble-tasks" onClick={(e) => e.stopPropagation()}>
          {bubble.tasks.map((t) => (
            <div key={t} className="tw-bubble-task"><span>{t}</span>{adder.added.has(t) ? <em>On my list</em> : <em>Say yes and it goes on my list</em>}</div>
          ))}
        </div>
      )}
    </>
  );
  const settings = (
    <details className="tw-hall-settings" open={showSettings} onToggle={(e) => setShowSettings((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Chat settings</summary>
      <div className="tw-hall-settings-body">
        <AiPicker s={ai} />
        {ai.info?.ready && ai.model && <p className="pl-hint">Each message you send makes one request to {ai.info.label} ({ai.model}). {ai.info.cost}</p>}
      </div>
    </details>
  );
  const input = (
    <div className={variant === 'panel' ? 'tw-mchat-input' : 'tw-hall-input'}>
      <textarea ref={inputRef} aria-label={`Say something to ${agent.name}`} rows={2} value={draft} placeholder={`Say something to ${agent.name}…`} disabled={busy}
        onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
      {busy
        ? <button className="btn" onClick={() => { stop.current = true; setBusy(false); }}>Stop</button>
        : <button className="btn primary" disabled={!draft.trim()} onClick={send}>Send</button>}
    </div>
  );

  if (variant === 'panel') {
    return (
      <section className="tw-mchat" aria-label={`Talk to ${agent.name}`}>
        <header><strong>{agent.name}</strong><small className="pl-hint">Tell them what you want to make</small></header>
        <div className="tw-mchat-reply" role="status" aria-live="polite">
          {busy ? <span className="tw-dots" aria-label="is thinking"><i /><i /><i /></span> : content ?? <p className="pl-hint">Ask anything about your project, or describe what you want to make and they will help you plan it.</p>}
        </div>
        <ErrorLine error={error} />
        {input}
        {settings}
      </section>
    );
  }

  const left = (seat?.left ?? 50) + (seat?.width ?? 5) / 2 + 1.5;
  const top = Math.max(3, (seat?.top ?? 30) - 5);
  return (
    <>
      <div className="tw-hall-top">
        {onTasks && <button className="btn small" onClick={onTasks} title={`${agent.name}'s tasks: start one, and review what comes back`}>Tasks{taskCount ? ` (${taskCount})` : ''}{waitingCount ? <span className="pl-badge" title="A result is waiting for you">{waitingCount}</span> : null}</button>}
        {settings}
      </div>

      {(busy || bubble) && (
        <div className={`tw-bubble side ${busy ? 'pill' : 'open'}`} role="status" aria-label={`${agent.name} says`} onClick={busy ? undefined : () => setBubble(null)}
          style={{ left: `${left}%`, top: `${top}%`, width: busy ? '15%' : plan ? '56%' : '36%', maxHeight: `calc(${100 - top}% - 124px)` }}>
          <strong>{agent.name}</strong>
          {busy
            ? <span className="tw-dots" aria-label="is thinking"><i /><i /><i /></span>
            : <>{content}<small className="tw-bubble-hint">Click to close</small></>}
        </div>
      )}

      <div className="tw-hall-bar">
        <ErrorLine error={error} />
        {input}
      </div>
    </>
  );
}

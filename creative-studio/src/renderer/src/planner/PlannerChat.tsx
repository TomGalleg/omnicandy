// The planning conversation (the Idea step). The AI talks the idea through with the owner; when it has enough it asks "Ready to start building?" and the
// page shows "Yes, make the plan". The answer to that is a list of clear tasks, shown as a plain list the owner can tick; they join the plan only when
// the owner presses a button. The conversation is saved with the plan (inside the project), so it is here when the project is opened again.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlannerProject } from '@shared/planner';
import type { ChatProviderInfo } from '@shared/plannerApi';
import { chunkPlan, isReady, MAKE_PLAN_REQUEST, withoutMarker, type ChatMessage, type ChatMode, type ChatProviderId } from '@shared/plannerChat';
import { directorTitle } from '@shared/town';
import { noteText, parseTeamLines, requestProposal, type TeamLine } from '@shared/townRequests';
import { PLANNER_BUSY_EVENT } from '@shared/plannerView';
import { errMsg, ErrorLine, useAction, type TabId } from './plannerUi';

const api = () => window.studio.planner;
const store = (() => { try { return window.localStorage; } catch { return undefined; } })();
const get = (k: string) => { try { return store?.getItem(k) ?? null; } catch { return null; } };
const put = (k: string, v: string) => { try { store?.setItem(k, v); } catch { /* storage unavailable */ } };
const PROVIDER_KEY = 'cs-planner-chat-provider';

/** An answer that breaks the project into chunks: shown as a plain numbered list instead of raw text. */
export function ChunkList({ p, reload, text, go, onChange, preview, by }: { p: PlannerProject; reload: () => Promise<void>; text: string; go: (t: TabId) => void; onChange: () => void; preview?: boolean; /** The worker who wrote the tasks, when it is not the General Manager. */ by?: string }) {
  const plan = useMemo(() => chunkPlan(text), [text]);
  const [skip, setSkip] = useState<number[]>([]);
  const [done, setDone] = useState<number | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [told, setTold] = useState(false);
  const a = useAction(reload);
  if (!plan) return null;
  // Tasks already in the plan, or already waiting as a suggestion, are not added a second time.
  const waiting = p.proposals.filter((x) => x.status === 'pending').flatMap((x) => x.changes).flatMap((c) => (c.op === 'add_task' ? [c.title] : []));
  const have = new Set([...p.tasks.filter((t) => t.status !== 'cancelled').map((t) => t.title), ...waiting].map((t) => t.trim().toLowerCase()));
  const already = plan.chunks.every((c) => have.has(c.title.trim().toLowerCase()));
  const picked = plan.chunks.map((_, i) => i).filter((i) => !skip.includes(i));
  const add = () => a.run(async () => {
    const chosen = picked.map((i) => plan.chunks[i]!);
    // The project summary is set quietly with the tasks; it is tied to the summary as it is now, so it never overwrites something edited since.
    const changes = [...plan.brief.map((c) => (c.op === 'set_brief' ? { ...c, baseMetaRev: p.metaRev } : c)), ...chosen];
    const pr = await api().importSuggestions(p.id, { proposer: { kind: 'other', name: by ?? 'Planning chat' }, note: by ? `Tasks from ${by}` : 'Tasks from the planning chat', changes, rawText: text });
    // In the Studio the tasks stay as suggestions on the canvas until the owner adds them there; elsewhere they join the plan at once, as before.
    if (!preview) await api().decideProposal(p.id, pr.id, true, changes.map((_, i) => i));
    setDone(chosen.length);
    setAdded(chosen.map((c) => c.title));
  });
  return (
    <div className="pl-chunks">
      {plan.intro && <p>{plan.intro}</p>}
      <ol>
        {plan.chunks.map((c, i) => (
          <li key={i}>
            <label className="pl-check"><input type="checkbox" disabled={already || done !== null} checked={!skip.includes(i)} onChange={(e) => setSkip(e.target.checked ? skip.filter((x) => x !== i) : [...skip, i])} /><strong>{c.title}</strong>{c.assignee && <small className="pl-hint"> · {directorTitle(c.assignee) ?? c.assignee}</small>}{c.appRef && <small className="pl-hint"> · uses {c.appRef.id}</small>}</label>
            {c.completionChecks.length > 0 && <ul className="pl-checks">{c.completionChecks.map((k, j) => <li key={j}>{k}</li>)}</ul>}
          </li>
        ))}
      </ol>
      {already || done !== null ? (
        <p role="status" className="pl-hint">{done !== null ? (preview ? `${done} task${done === 1 ? '' : 's'} are waiting in the Plan. Add them there when you are happy.` : `Added ${done} task${done === 1 ? '' : 's'} to your plan.`) : 'These tasks are in your plan, or waiting in the Plan.'} {!preview && <button className="btn small primary" onClick={() => go('tasks')}>See the plan</button>}</p>
      ) : (
        <div className="pl-actions">
          <button className="btn primary" disabled={a.busy || !picked.length} onClick={() => void add()}>{preview ? 'Review these in the Plan' : 'Add these to my plan'}</button>
          <button className="btn" disabled={a.busy} onClick={onChange}>I want to change something</button>
        </div>
      )}
      {by && added.length > 0 && (
        <p className="pl-actions">
          <button className="btn small" disabled={told} title="Adds one plain line to the General Manager's conversation. No AI is called." onClick={() => { setTold(true); void api().chatAppend(p.id, { messages: [{ role: 'user', text: `(From ${by}) I suggested ${added.length} task${added.length === 1 ? '' : 's'}: ${added.slice(0, 6).join('; ')}${added.length > 6 ? '…' : ''}.` }] }).catch(() => setTold(false)); }}>{told ? 'The General Manager knows' : 'Let the General Manager know'}</button>
        </p>
      )}
      <ErrorLine error={a.error} />
    </div>
  );
}

/** What a worker wants to tell or ask another worker. Nothing is sent until the owner presses a button; a request only becomes a suggestion on the Studio canvas. */
function TeamCards({ p, from, lines, reload }: { p: PlannerProject; from: string; lines: TeamLine[]; reload: () => Promise<void> }) {
  const [state, setState] = useState<Record<number, 'sent' | 'skipped'>>({});
  const a = useAction(reload);
  const send = (i: number, line: TeamLine) => a.run(async () => {
    if (line.kind === 'ask') {
      const r = requestProposal(from, line);
      await api().importSuggestions(p.id, { proposer: r.proposer, note: r.note, changes: r.changes, rawText: line.what });
    } else {
      const { town } = await api().townLoad(p.id);
      const to = town.agents.find((x) => x.director === line.to && !x.retired);
      if (!to) throw new Error('That person is not on the team.');
      await api().chatAppend(p.id, { messages: [{ role: 'user', text: noteText(from, line.what) }], ...(line.to === 'general-manager' ? {} : { who: to.id }) });
    }
    setState((s) => ({ ...s, [i]: 'sent' }));
  });
  return (
    <div className="pl-team-cards">
      {lines.map((l, i) => state[i] === 'skipped' ? null : (
        <p key={i} className="pl-warn" role="status">
          <strong>{from}</strong> {l.kind === 'ask' ? 'wants to ask' : 'wants to tell'} <strong>{directorTitle(l.to)}</strong>: {l.what}
          {state[i] === 'sent'
            ? <small className="pl-hint"> {l.kind === 'ask' ? 'Sent to the Plan as a suggestion. Add it there to give it to them.' : `Sent. ${directorTitle(l.to)} will see it the next time you talk.`}</small>
            : <span className="pl-actions"> <button className="btn small primary" disabled={a.busy} onClick={() => void send(i, l)}>{l.kind === 'ask' ? 'Send the request' : 'Send the note'}</button> <button className="btn small" onClick={() => setState((s) => ({ ...s, [i]: 'skipped' }))}>Skip</button></span>}
        </p>
      ))}
      <ErrorLine error={a.error} />
    </div>
  );
}

/** `preview`: the Studio keeps what the AI suggests as dashed cards until the owner adds them. */
export function PlannerChat({ p, reload, go, preview, agent }: { p: PlannerProject; reload: () => Promise<void>; go: (t: TabId) => void; preview?: boolean; /** Talk to this worker instead of the coordinator: they answer from their own job, and keep their own conversation. */ agent?: { id: string; name: string } }) {
  const agentId = agent?.id;
  const [providers, setProviders] = useState<ChatProviderInfo[] | null>(null);
  const [provider, setProvider] = useState<ChatProviderId>(() => (['claude', 'openai', 'gemini'].includes(get(PROVIDER_KEY) ?? '') ? (get(PROVIDER_KEY) as ChatProviderId) : 'claude'));
  const [models, setModels] = useState<string[] | null>(null);
  const [modelErr, setModelErr] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The index of the "Ready to start building?" message the owner said "not yet" to. */
  const [notYet, setNotYet] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { void api().chatProviders().then(setProviders).catch((e) => setModelErr(errMsg(e))); }, []);
  // The conversation kept with this plan comes back when the plan is opened.
  useEffect(() => {
    let live = true;
    void (agentId ? api().chatLoadFor(p.id, agentId) : api().chatLoad(p.id)).then((c) => {
      if (!live) return;
      setMessages(c.messages);
      if (c.provider && ['claude', 'openai', 'gemini'].includes(c.provider)) setProvider(c.provider as ChatProviderId);
    }).catch(() => {});
    return () => { live = false; };
  }, [p.id, agentId]);
  const save = (next: ChatMessage[]) => { void api().chatSave(p.id, { messages: next, provider, model }).catch(() => {}); };
  const info = providers?.find((x) => x.id === provider);
  useEffect(() => {
    setModels(null); setModelErr(null);
    if (!info?.ready) return;
    let live = true;
    void api().chatModels(provider).then((m) => {
      if (!live) return;
      setModels(m);
      const saved = get(`cs-planner-chat-model-${provider}`);
      setModel(saved && m.includes(saved) ? saved : m[0] ?? '');
    }).catch((e) => { if (live) setModelErr(errMsg(e)); });
    return () => { live = false; };
  }, [provider, info?.ready]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [messages.length, busy]);
  // The Planner tab shows a live dot while a request is running, even if the owner has moved to another screen meanwhile.
  const tellTab = (b: boolean) => window.dispatchEvent(new CustomEvent(PLANNER_BUSY_EVENT, { detail: { busy: b } }));

  const ask = async (text: string, mode: ChatMode = 'talk') => {
    if (!text.trim() || busy || !model) return;
    const next: ChatMessage[] = [...messages, { role: 'user', text: text.trim() }];
    setMessages(next); setInput(''); setNotYet(null); setBusy(true); setError(null); tellTab(true);
    // The owner's message is saved before the AI answers, so a failed request or a crash never loses it.
    void api().chatAppend(p.id, { messages: [{ role: 'user', text: text.trim() }], provider, model, ...(agent ? { who: agent.id } : {}) }).catch(() => {});
    try {
      const r = await api().chat({ projectId: p.id, provider, model, messages: next, mode, ...(agent ? { agentId: agent.id } : {}) });
      const all: ChatMessage[] = [...next, { role: 'assistant', text: r.text }];
      setMessages(all);
      void api().chatAppend(p.id, { messages: [{ role: 'assistant', text: r.text }], provider, model, ...(agent ? { who: agent.id } : {}) }).catch(() => {});
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); tellTab(false); }
  };

  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  const readyNow = !agent && !!last && last.role === 'assistant' && isReady(last.text) && !chunkPlan(last.text) && notYet !== lastIdx && !busy;
  const hasChunks = p.tasks.some((t) => t.status !== 'cancelled');

  return (
    <div className="pl-chat-main">
      <div className="pl-chat" ref={listRef} aria-live="polite">
        {!messages.length && (
          <div className="pl-hello">
            {agent ? <><h3>Say hello to {agent.name}</h3><p className="pl-hint">{agent.name} knows their job, the team and your project. Ask what you need.</p></> : <><h3>What do you want to make?</h3><p className="pl-hint">Tell me in your own words. I will ask a few questions, and when I understand it, I will break the project into clear steps for you.</p></>}
          </div>
        )}
        {messages.map((m, i) => {
          const plan = m.role === 'assistant' ? chunkPlan(m.text) : null;
          const team = m.role === 'assistant' && agent ? parseTeamLines(m.text) : null;
          const mine = team?.lines.filter((l) => directorTitle(l.to) !== agent?.name) ?? [];
          return (
            <div key={i} className={`pl-msg ${m.role}`}>
              <strong>{m.role === 'user' ? 'You' : agent?.name ?? 'General Manager'}</strong>
              {plan ? <ChunkList p={p} reload={reload} text={m.text} go={go} onChange={() => inputRef.current?.focus()} preview={preview} by={agent?.name} /> : <p className="pl-msg-text">{withoutMarker(team ? team.text : m.text)}</p>}
              {mine.length > 0 && agent && <TeamCards p={p} from={agent.name} lines={mine} reload={reload} />}
            </div>
          );
        })}
        {readyNow && (
          <div className="pl-ready" role="status">
            <button className="btn primary" disabled={busy} onClick={() => void ask(MAKE_PLAN_REQUEST, 'chunks')}>Yes, make the plan</button>
            <button className="btn" onClick={() => { setNotYet(lastIdx); inputRef.current?.focus(); }}>Not yet, I want to add something</button>
          </div>
        )}
        {busy && <p className="pl-hint">{agent?.name ?? 'The General Manager'} is thinking…</p>}
      </div>
      <ErrorLine error={error ?? modelErr} />
      <div className="pl-composer">
        <textarea ref={inputRef} aria-label="Message to the planning AI" rows={3} value={input}
          placeholder={!info?.ready ? 'Add a key for this AI first, or pick Claude' : messages.length ? (hasChunks ? 'Ask for more tasks or changes…' : 'Your answer…') : 'For example: a short film about…, a poster for…, an app that…'} disabled={!info?.ready || busy}
          onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(input); } }} />
        <button className="btn primary pl-send" disabled={busy || !input.trim() || !model || !info?.ready} onClick={() => void ask(input)}>Send</button>
      </div>
      <details className="pl-about">
        <summary>{info ? `How I think · ${info.label}` : 'How I think'}</summary>
        <div className="pl-two">
          <label>AI
            <select value={provider} onChange={(e) => { setProvider(e.target.value as ChatProviderId); put(PROVIDER_KEY, e.target.value); setError(null); }}>
              {(providers ?? []).map((x) => <option key={x.id} value={x.id}>{x.label}{x.ready ? '' : ' (needs a key)'}</option>)}
              {!providers && <option value={provider}>{provider}</option>}
            </select>
          </label>
          <label>Model
            <select value={model} disabled={!models?.length} onChange={(e) => { setModel(e.target.value); put(`cs-planner-chat-model-${provider}`, e.target.value); }}>
              {(models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
              {!models?.length && <option value="">{info && !info.ready ? '—' : modelErr ? 'unavailable' : 'loading…'}</option>}
            </select>
          </label>
        </div>
        {info && !info.ready && <p className="pl-warn">{info.note}</p>}
        {info?.ready && <p className="pl-hint">{info.cost} A short summary of your plan (no file locations) is sent with your messages. The conversation is saved with this project's plan.</p>}
        {messages.length > 0 && !agent && <p><button className="btn small ghost" onClick={() => { setMessages([]); setError(null); save([]); }}>Start the conversation over</button></p>}
      </details>
    </div>
  );
}

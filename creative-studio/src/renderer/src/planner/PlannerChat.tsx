// The planning chat beside the project brief. One message goes to the chosen AI only when the owner presses a button (the offer after
// saving the brief, or Send). The answer is text; anything it suggests is shown with tick boxes and joins the plan only when the owner
// adds it, exactly like Paste back. The chat itself is kept on this screen only (it is not saved with the plan).
import { useEffect, useMemo, useRef, useState } from 'react';
import { describeChange, changesThePlan, parseSuggestionText } from '@shared/plannerPaste';
import type { PlannerProject } from '@shared/planner';
import type { ChatProviderInfo } from '@shared/plannerApi';
import { starterMessage, type ChatMessage, type ChatProviderId } from '@shared/plannerChat';
import { errMsg, ErrorLine, Section, useAction } from './plannerUi';

const api = () => window.studio.planner;
const store = (() => { try { return window.localStorage; } catch { return undefined; } })();
const get = (k: string) => { try { return store?.getItem(k) ?? null; } catch { return null; } };
const put = (k: string, v: string) => { try { store?.setItem(k, v); } catch { /* storage unavailable */ } };
const PROVIDER_KEY = 'cs-planner-chat-provider';

function Suggestions({ p, reload, text }: { p: PlannerProject; reload: () => Promise<void>; text: string }) {
  const sugg = useMemo(() => parseSuggestionText(text), [text]);
  const [skip, setSkip] = useState<number[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const a = useAction(reload);
  if (!sugg.changes.length) return null;
  const picked = sugg.changes.filter((_, i) => !skip.includes(i)).length;
  const add = (accept: boolean) => a.run(async () => {
    // A brief suggestion is tied to the brief as it is now: if you edit the brief before accepting, it is not applied over your edit.
    const changes = sugg.changes.map((c) => (c.op === 'set_brief' ? { ...c, baseMetaRev: p.metaRev } : c));
    const pr = await api().importSuggestions(p.id, { proposer: { kind: 'other', name: 'Planning chat' }, note: 'From the planning chat', changes, rawText: text });
    if (accept) await api().decideProposal(p.id, pr.id, true, sugg.changes.map((_, i) => i).filter((i) => !skip.includes(i)));
    setDone(accept ? 'Added to your plan.' : 'Saved under Needs you (AI area). Nothing is in your plan until you accept it.');
  });
  return (
    <div className="pl-preview">
      <p className="pl-hint">Suggestions in this answer: brief, milestones, rules, decisions, tasks, questions, ideas and references. Untick what you do not want. Nothing is added until you press a button.</p>
      {sugg.errors.map((e) => <p key={e} className="pl-error">{e}</p>)}
      <ul>{sugg.changes.map((c, i) => (
        <li key={i}><label className="pl-check"><input type="checkbox" disabled={!!done} checked={!skip.includes(i)} onChange={(e) => setSkip(e.target.checked ? skip.filter((x) => x !== i) : [...skip, i])} />{describeChange(c)} {changesThePlan(c) ? <span className="chip warn">changes the plan</span> : <span className="chip off">adds to your list</span>}</label></li>
      ))}</ul>
      {done ? <p role="status" className="pl-hint">{done}</p> : (
        <div className="pl-actions">
          <button className="btn small primary" disabled={a.busy || !picked} onClick={() => void add(true)}>Add selected to my plan</button>
          <button className="btn small" disabled={a.busy} onClick={() => void add(false)}>Save for later</button>
        </div>
      )}
      <ErrorLine error={a.error} />
    </div>
  );
}

export function PlannerChat({ p, reload, savedTick }: { p: PlannerProject; reload: () => Promise<void>; savedTick: number }) {
  const [providers, setProviders] = useState<ChatProviderInfo[] | null>(null);
  const [provider, setProvider] = useState<ChatProviderId>(() => (['claude', 'openai', 'gemini'].includes(get(PROVIDER_KEY) ?? '') ? (get(PROVIDER_KEY) as ChatProviderId) : 'claude'));
  const [models, setModels] = useState<string[] | null>(null);
  const [modelErr, setModelErr] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const seen = useRef(savedTick);

  useEffect(() => { void api().chatProviders().then(setProviders).catch((e) => setModelErr(errMsg(e))); }, []);
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
  // Saving the brief offers help; it never starts a request by itself.
  useEffect(() => {
    if (savedTick !== seen.current) { seen.current = savedTick; if (!messages.length) setOffer(true); }
  }, [savedTick, messages.length]);

  const ask = async (text: string) => {
    if (!text.trim() || busy || !model) return;
    const next: ChatMessage[] = [...messages, { role: 'user', text: text.trim() }];
    setMessages(next); setInput(''); setOffer(false); setBusy(true); setError(null);
    try {
      const r = await api().chat({ projectId: p.id, provider, model, messages: next });
      setMessages([...next, { role: 'assistant', text: r.text }]);
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <div className="pl-chatwrap">
    <Section title="Plan with an AI" hint="Chat to fill in your plan: project brief, milestones, rules, decisions, tasks, questions, ideas and references. You choose what joins your plan.">
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
      {info?.ready && <details className="pl-about"><summary>Cost and privacy</summary><p className="pl-hint">{info.cost} A short summary of your plan (no file locations) is sent with your messages.</p></details>}
      <ErrorLine error={modelErr} />
      {offer && info?.ready && model && (
        <p className="pl-offer" role="status">Brief saved. <button className="btn small primary" disabled={busy} onClick={() => void ask(starterMessage(p))}>Ask {info.label} to help plan this</button> <button className="btn small ghost" onClick={() => setOffer(false)}>Not now</button></p>
      )}
      <div className="pl-chat" ref={listRef} aria-live="polite">
        {!messages.length && (
          <p className="pl-hint">
            Nothing sent yet. Press the button to have {info?.label ?? 'the AI'} fill in your plan, or type a message below.{' '}
            <button className="btn small primary" disabled={busy || !info?.ready || !model} onClick={() => void ask(starterMessage(p))}>Fill in my plan with {info?.label ?? 'AI'}</button>
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`pl-msg ${m.role}`}>
            <strong>{m.role === 'user' ? 'You' : info?.label ?? 'AI'}</strong>
            <p className="pl-msg-text">{m.text}</p>
            {m.role === 'assistant' && <Suggestions p={p} reload={reload} text={m.text} />}
          </div>
        ))}
        {busy && <p className="pl-hint">{info?.label ?? 'The AI'} is thinking…</p>}
      </div>
      <ErrorLine error={error} />
      <div className="pl-composer">
        <textarea aria-label="Message to the planning AI" rows={3} value={input} placeholder={info?.ready ? 'Ask a question or describe what you need…' : 'Add a key for this AI first, or pick Claude'} disabled={!info?.ready || busy}
          onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(input); } }} />
        <button className="btn primary pl-send" disabled={busy || !input.trim() || !model || !info?.ready} onClick={() => void ask(input)}>Send</button>
      </div>
      {messages.length > 0 && <p className="pl-hint"><button className="btn small ghost" onClick={() => { setMessages([]); setError(null); }}>Clear this chat</button> The chat is not saved with your plan.</p>}
    </Section>
    </div>
  );
}

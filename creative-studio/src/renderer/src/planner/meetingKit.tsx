import { useEffect, useState } from 'react';
import type { PlanTask } from '@shared/planner';
import type { ChatProviderInfo } from '@shared/plannerApi';
import type { ChatProviderId } from '@shared/plannerChat';
import type { DirectorKey } from '@shared/town';
import { errMsg } from './plannerUi';

/** What the Town Hall and every office share: which AI answers, and adding a recommended task to the plan. */
const api = () => window.studio.planner;
const store = (() => { try { return window.localStorage; } catch { return undefined; } })();
const get = (k: string) => { try { return store?.getItem(k) ?? null; } catch { return null; } };
export const put = (k: string, v: string) => { try { store?.setItem(k, v); } catch { /* storage unavailable */ } };
export const readSetting = get;

export interface AiSettings {
  providers: ChatProviderInfo[] | null; provider: ChatProviderId; setProvider: (p: ChatProviderId) => void;
  models: string[] | null; model: string; setModel: (m: string) => void;
  info: ChatProviderInfo | undefined;
  /** True once there is an AI that can answer and a model to ask. */
  ready: boolean;
}

/** The AI and model chosen for chats. Remembered between visits and shared with the Studio's chat, so one choice covers every room. */
export function useAiSettings(onError: (m: string) => void): AiSettings {
  const [providers, setProviders] = useState<ChatProviderInfo[] | null>(null);
  const [provider, setProviderState] = useState<ChatProviderId>(() => (['claude', 'openai', 'gemini'].includes(get('cs-planner-chat-provider') ?? '') ? (get('cs-planner-chat-provider') as ChatProviderId) : 'claude'));
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModelState] = useState('');
  useEffect(() => { void api().chatProviders().then(setProviders).catch((e) => onError(errMsg(e))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const info = providers?.find((x) => x.id === provider);
  useEffect(() => {
    if (!info?.ready) { setModels(null); return; }
    let live = true;
    void api().chatModels(provider).then((m) => { if (!live) return; setModels(m); const saved = get(`cs-planner-chat-model-${provider}`); setModelState(saved && m.includes(saved) ? saved : m[0] ?? ''); }).catch((e) => { if (live) onError(errMsg(e)); });
    return () => { live = false; };
  }, [provider, info?.ready]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    providers, provider, models, model, info, ready: !!info?.ready && !!model,
    setProvider: (p) => { setProviderState(p); put('cs-planner-chat-provider', p); },
    setModel: (m) => { setModelState(m); put(`cs-planner-chat-model-${provider}`, m); },
  };
}

/** The two choices, as they appear under the chat. */
export function AiPicker({ s }: { s: AiSettings }) {
  return (
    <>
      <div className="pl-two">
        <label>AI
          <select value={s.provider} onChange={(e) => s.setProvider(e.target.value as ChatProviderId)}>
            {(s.providers ?? []).map((x) => <option key={x.id} value={x.id}>{x.label}{x.ready ? '' : ' (needs a key)'}</option>)}
          </select>
        </label>
        <label>Model
          <select value={s.model} disabled={!s.models?.length} onChange={(e) => s.setModel(e.target.value)}>
            {(s.models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
            {!s.models?.length && <option value="">{s.info && !s.info.ready ? '-' : 'loading…'}</option>}
          </select>
        </label>
      </div>
      {s.info && !s.info.ready && <p className="pl-warn">{s.info.note}</p>}
    </>
  );
}

/**
 * Adding a task a person recommended: the owner pressing Add task is the approval, so it joins the plan now, owned by the person who recommended it. A task the
 * plan already has is not added a second time. `added` holds the titles added in this visit, so the button can turn into "Added to your plan".
 */
export function useTaskAdder(planId: string, tasks: readonly PlanTask[], reload: () => Promise<void>, onError: (m: string) => void) {
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const add = (who: { name: string; director?: DirectorKey | null }, title: string) => {
    void (async () => {
      try {
        if (!tasks.some((t) => t.status !== 'cancelled' && t.title.trim().toLowerCase() === title.trim().toLowerCase())) {
          const pr = await api().importSuggestions(planId, {
            proposer: { kind: 'other', name: who.name }, note: `Task from ${who.name} in the meeting`, rawText: title,
            changes: [{ op: 'add_task', title: title.slice(0, 200), description: `Recommended by ${who.name}.`, priority: 'normal', dependsOn: [], completionChecks: [], assignee: who.director ?? null }],
          });
          await api().decideProposal(planId, pr.id, true, [0]);
          await reload();
        }
        setAdded((s) => new Set(s).add(title));
      } catch (e) { onError(errMsg(e)); }
    })();
  };
  return { added, add, reset: () => setAdded(new Set()) };
}

import { useEffect, useState } from 'react';
import type { DirectorOutcome } from '@shared/directorToolbox';
import { TOOLBOXES } from '@shared/directorToolbox';
import type { ActivityEntry } from '@shared/teamAccess';
import type { DirectorKey } from '@shared/town';
import { LIBRARY_CHANGED } from './DirectorPictures';
import { errMsg, type TabProps } from './plannerUi';

const api = () => window.studio;

const PROVIDERS = ['claude', 'openai', 'gemini'] as const;
const PROVIDER_LABEL: Record<(typeof PROVIDERS)[number], string> = { claude: 'Claude', openai: 'ChatGPT (OpenAI)', gemini: 'Gemini' };
const chosenProvider = (): (typeof PROVIDERS)[number] => { try { const v = localStorage.getItem('cs-planner-chat-provider'); return PROVIDERS.find((x) => x === v) ?? 'claude'; } catch { return 'claude'; } };

/**
 * Lets a director with tools do one of their open tasks. The owner chooses the task and sees what is asked of them (a dialog names each risky action); what comes back
 * is checked against the project's real files, and the task then waits in the plan for the owner's review. A director without tools yet shows nothing here.
 */
export function DirectorWork({ p, director, name, reload }: Pick<TabProps, 'p' | 'reload'> & { director: DirectorKey; name: string }) {
  const [running, setRunning] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<DirectorOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<ActivityEntry[]>([]);
  const provider = chosenProvider();
  const refreshLog = () => { void api().director.activity().then((l) => setLog(l.slice(-6).reverse())).catch(() => undefined); };
  useEffect(refreshLog, [running]);
  if (!TOOLBOXES[director].works) return null;

  const todo = p.tasks.filter((t) => t.status === 'todo' && !t.claim && (t.assignee ?? 'general-manager') === director);
  const start = async (taskId: string) => {
    setRunning(taskId); setError(null); setOutcome(null);
    try { setOutcome(await api().director.run({ director, taskId, provider })); await reload(); } catch (e) { setError(errMsg(e)); } finally { setRunning(null); window.dispatchEvent(new Event(LIBRARY_CHANGED)); }
  };

  return (
    <section className="pl-card tw-director-work" aria-label={`Let ${name} do a task`}>
      <h4>Let {name} do a task</h4>
      <p className="pl-hint">{TOOLBOXES[director].does} It works with {PROVIDER_LABEL[provider]}. It asks you before anything risky or anything that costs money, and you can stop it at any time.</p>
      {todo.length === 0 && <p className="pl-hint">No open tasks for {name} yet.</p>}
      <ul className="pl-list">
        {todo.slice(0, 6).map((t) => (
          <li key={t.id}>
            <span>{t.title}</span>{' '}
            <button className="btn small primary" disabled={!!running} onClick={() => void start(t.id)}>{running === t.id ? 'Working…' : `Let ${name} do this`}</button>
          </li>
        ))}
      </ul>
      {running && <button className="btn small" onClick={() => void api().director.stop()}>Stop</button>}
      {error && <p className="pl-error" role="alert">{error}</p>}
      {outcome && <p className={outcome.status === 'made' ? 'pl-ok' : 'pl-hint'} role="status">{outcome.summary}{outcome.status === 'made' ? ' It is waiting in the Plan for your review.' : ''}</p>}
      {log.length > 0 && (
        <details className="pl-fold"><summary>What {name} asked for and did<span className="pl-count">{log.length}</span></summary>
          <ul className="tw-notes">{log.map((e, i) => <li key={i}><strong>{e.outcome === 'refused' ? 'Refused' : e.outcome === 'failed' ? 'Failed' : 'Done'}</strong> {e.label}{e.target ? ` (${e.target})` : ''}{e.outcome === 'refused' ? ` — ${e.why}` : ''}</li>)}</ul>
        </details>
      )}
    </section>
  );
}

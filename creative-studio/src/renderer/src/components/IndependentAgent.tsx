import { useEffect, useMemo, useState } from 'react';
import type { AgentUiState } from '@shared/agentHarness';
import { presentUnifiedAgent, validateUnifiedAgentRequest } from '@shared/unifiedAgentPresentation';

// The existing IPC agent endpoint currently supports OpenAI models only.
// Do not advertise other providers until their backend routes are wired.
const models = ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'];
const initial: AgentUiState = { status: 'idle', model: models[0]!, goal: '', result: '', events: [] };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Existing independent agent controls, using the shared renderer presentation contract. */
export function IndependentAgent() {
  const [state, setState] = useState<AgentUiState>(initial);
  const [model, setModel] = useState(models[0]!);
  const [goal, setGoal] = useState('');
  const [error, setError] = useState('');
  const [requestPending, setRequestPending] = useState(false);
  const presentation = useMemo(() => presentUnifiedAgent(state), [state]);
  const validationError = validateUnifiedAgentRequest(goal, model);
  const busy = presentation.busy || requestPending;

  useEffect(() => {
    let active = true;
    void window.studio.agent.state().then((next) => { if (active) setState(next); })
      .catch((e) => { if (active) setError(errorText(e)); });
    const unsubscribe = window.studio.agent.onChange((next) => { if (active) setState(next); });
    return () => { active = false; unsubscribe(); };
  }, []);

  const run = () => {
    if (busy || validationError) return;
    setError('');
    setRequestPending(true);
    void window.studio.agent.run(goal.trim(), model)
      .then(setState).catch((e) => setError(errorText(e)))
      .finally(() => setRequestPending(false));
  };
  const stop = () => {
    setError('');
    void window.studio.agent.stop().catch((e) => setError(errorText(e)));
  };
  const resume = () => {
    setError('');
    void window.studio.agent.resume().then(setState).catch((e) => setError(errorText(e)));
  };

  return <div className="claude-section">
    <div className="asset-meta">Uses the existing CreateCraft agent and your OpenAI API key. Model calls may incur charges. Other AI providers are not yet connected to this panel.</div>
    <div className="claude-row">
      <select aria-label="Independent AI model" value={model} disabled={busy} onChange={(e) => setModel(e.target.value)}>
        {models.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <span className="chip" role="status">{presentation.status}</span>
    </div>
    <textarea aria-label="Independent AI instruction" value={goal} disabled={busy}
      onChange={(e) => setGoal(e.target.value)} placeholder="Describe what you want to do in a connected app" rows={5} maxLength={4000} />
    <div className="btn-row">
      <button className="btn primary" disabled={busy || !presentation.canRun || !!validationError} onClick={run}>Run with OpenAI</button>
      <button className="btn" disabled={!presentation.canStop} onClick={stop}>Stop</button>
      <button className="btn" disabled={!presentation.canResume} onClick={resume}>Resume after manual edits</button>
    </div>
    {!busy && goal.length > 0 && validationError && <div className="notice" role="alert">{validationError}</div>}
    {error && <div className="notice" role="alert">{error}</div>}
    {presentation.result && <div className="notice" role="status">{presentation.result}</div>}
    <div role="log" aria-label="AI activity" aria-live="polite" style={{ maxHeight: 300, overflowY: 'auto' }}>
      {presentation.activities.map((activity, index) => <div className="asset-meta" key={index}>
        <span className={activity.failed ? 'warn' : ''}>{activity.label}</span>
      </div>)}
    </div>
  </div>;
}

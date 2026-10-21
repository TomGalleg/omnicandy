import { useEffect, useState } from 'react';
import type { AgentUiState } from '@shared/agentHarness';

const models = ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'];
const initial: AgentUiState = { status: 'idle', model: models[0]!, goal: '', result: '', events: [] };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
/** Uses CreateCraft's own agent runtime, not the Claude SDK. */
export function IndependentAgent() {
  const [state, setState] = useState<AgentUiState>(initial);
  const [model, setModel] = useState(models[0]!);
  const [goal, setGoal] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    void window.studio.agent.state().then(setState).catch(e => setError(errorText(e)));
    return window.studio.agent.onChange(setState);
  }, []);
  const busy = state.status === 'working';
  const run = () => {
    if (busy || !goal.trim()) return;
    setError('');
    void window.studio.agent.run(goal.trim(), model).then(setState).catch(e => setError(errorText(e)));
  };
  return <div className="claude-section">
    <div className="asset-meta">Runs approved CreateCraft application tools without Claude Code. Uses your OpenAI API key; model calls may incur charges.</div>
    <div className="claude-row">
      <select aria-label="Independent AI model" value={model} disabled={busy} onChange={e => setModel(e.target.value)}>
        {models.map(m => <option key={m} value={m}>{m}</option>)}
      </select>
      <span className="chip">{state.status}</span>
    </div>
    <textarea aria-label="Independent AI instruction" value={goal} disabled={busy} onChange={e => setGoal(e.target.value)} placeholder="Describe what you want to do in a connected app" rows={5} />
    <div className="btn-row">
      <button className="btn primary" disabled={busy || !goal.trim()} onClick={run}>Run with OpenAI</button>
      <button className="btn" disabled={!busy} onClick={() => void window.studio.agent.stop().catch(e => setError(errorText(e)))}>Stop</button>
      <button className="btn" disabled={state.status !== 'paused'} onClick={() => { setError(''); void window.studio.agent.resume().then(setState).catch(e => setError(errorText(e))); }}>Resume after manual edits</button>
    </div>
    {error && <div className="notice" role="alert">{error}</div>}
    {state.result && <div className="notice" role="status">{state.result}</div>}
    <div role="log" aria-live="polite" style={{ maxHeight: 300, overflowY: 'auto' }}>
      {state.events.map((event, i) => <div className="asset-meta" key={`${i}-${event.callId ?? event.kind}`}>
        <strong>{event.tool ?? event.kind}:</strong> {event.text.slice(0, 500)}
      </div>)}
    </div>
  </div>;
}

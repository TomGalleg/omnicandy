import { useEffect, useMemo, useState } from 'react';
import type { AgentUiState, AgentPlanStep } from '@shared/agentHarness';
import { presentUnifiedAgent, validateUnifiedAgentRequest } from '@shared/unifiedAgentPresentation';
import { AGENT_BUDGET_LIMITS, validateAgentBudget } from '@shared/agentBudget';
import { AGENT_PROVIDER_IDS, AGENT_PROVIDERS, DEFAULT_LOCAL_ENDPOINT, validateProviderSelection, type AgentProviderId, type AgentProviderSelection } from '@shared/agentProvider';
import { recoveryUiFixture, type RecoveryFixture } from './recoveryUiFixture';

const initial: AgentUiState = { status: 'idle', model: AGENT_PROVIDERS.openai.models[0]!, goal: '', result: '', events: [] };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Existing independent agent controls, using the shared renderer presentation contract. */
export function IndependentAgent() {
  const [state, setState] = useState<AgentUiState>(initial);
  const [provider, setProvider] = useState<AgentProviderId>('openai');
  const [model, setModel] = useState<string>(AGENT_PROVIDERS.openai.models[0]!);
  const [endpoint, setEndpoint] = useState(DEFAULT_LOCAL_ENDPOINT);
  const [goal, setGoal] = useState('');
  const [maxTurns, setMaxTurns] = useState<number>(AGENT_BUDGET_LIMITS.maxTurns.default);
  const [maxToolCalls, setMaxToolCalls] = useState<number>(AGENT_BUDGET_LIMITS.maxToolCalls.default);
  const [error, setError] = useState('');
  const [requestPending, setRequestPending] = useState(false);
  const [draftSteps, setDraftSteps] = useState<AgentPlanStep[]>([]);
  const [editingPlan, setEditingPlan] = useState(false);
  const [recoveryFixture, setRecoveryFixture] = useState<RecoveryFixture>('off');
  const fixture = recoveryUiFixture(recoveryFixture);
  const previewActive = import.meta.env.DEV && !state.recovery && recoveryFixture !== 'off';
  const recoveryToDisplay = state.recovery ?? (previewActive ? fixture.info : undefined);
  const presentation = useMemo(() => presentUnifiedAgent(state), [state]);
  const budgetError = validateAgentBudget({ maxTurns, maxToolCalls });
  const selection: AgentProviderSelection = provider === 'local' ? { provider, endpoint } : { provider };
  const validationError = validateUnifiedAgentRequest(goal, model) ?? validateProviderSelection(selection, model) ?? budgetError;
  const changeProvider = (next: AgentProviderId) => { setProvider(next); setModel(AGENT_PROVIDERS[next].models[0] ?? ''); };
  const providerLabel = AGENT_PROVIDERS[provider].label;
  const busy = presentation.busy || requestPending;
  const canEditPlan = !busy && (state.status === 'paused' || state.status === 'limit');

  useEffect(() => {
    let active = true;
    void window.studio.agent.state().then((next) => { if (active) setState(next); })
      .catch((e) => { if (active) setError(errorText(e)); });
    const unsubscribe = window.studio.agent.onChange((next) => { if (active) setState(next); });
    return () => { active = false; unsubscribe(); };
  }, []);

  const startPlanEdit = () => { setDraftSteps((state.plan?.steps ?? []).map(step => ({...step}))); setEditingPlan(true); setError(''); };
  const updateStep = (index: number, patch: Partial<AgentPlanStep>) =>
    setDraftSteps(current => current.map((step, i) => i === index ? { ...step, ...patch } : step));
  const savePlan = () => {
    if (!canEditPlan) return;
    setRequestPending(true); setError('');
    void window.studio.agent.updatePlan(draftSteps).then((next) => { setState(next); setEditingPlan(false); })
      .catch((e) => setError(errorText(e))).finally(() => setRequestPending(false));
  };
  const run = () => {
    if (busy || validationError) return;
    setError('');
    setRequestPending(true);
    void window.studio.agent.run(goal.trim(), model, { maxTurns, maxToolCalls }, selection)
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
    <div className="asset-meta">Uses the existing CreateCraft agent with the AI provider you choose. OpenAI and Gemini use the API key saved in Settings (it never leaves the app's secure storage) and calls may incur charges. A local model runs on this PC through a localhost endpoint. Continue Task keeps the provider the task started with.</div>
    <div className="claude-row">
      <select aria-label="Independent AI provider" value={provider} disabled={busy} onChange={(e) => changeProvider(e.target.value as AgentProviderId)}>
        {AGENT_PROVIDER_IDS.map((id) => <option key={id} value={id}>{AGENT_PROVIDERS[id].label}</option>)}
      </select>
      {provider === 'local'
        ? <input aria-label="Independent AI local model name" placeholder="Model name" value={model} disabled={busy} maxLength={80} onChange={(e) => setModel(e.target.value)} />
        : <select aria-label="Independent AI model" value={model} disabled={busy} onChange={(e) => setModel(e.target.value)}>
            {AGENT_PROVIDERS[provider].models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>}
      <span className="chip" role="status">{presentation.status}</span>
    </div>
    {provider === 'local' && <div className="claude-row">
      <label>Local endpoint <input aria-label="Independent AI local endpoint" value={endpoint} disabled={busy} maxLength={200} onChange={(e) => setEndpoint(e.target.value)} /></label>
    </div>}
    <div className="claude-row">
      <label>Max model turns <input type="number" aria-label="Independent AI maximum model turns" value={maxTurns} disabled={busy}
        min={AGENT_BUDGET_LIMITS.maxTurns.min} max={AGENT_BUDGET_LIMITS.maxTurns.max} step={1}
        onChange={(e) => setMaxTurns(e.target.valueAsNumber)} /></label>
      <label>Max tool calls <input type="number" aria-label="Independent AI maximum tool calls" value={maxToolCalls} disabled={busy}
        min={AGENT_BUDGET_LIMITS.maxToolCalls.min} max={AGENT_BUDGET_LIMITS.maxToolCalls.max} step={1}
        onChange={(e) => setMaxToolCalls(e.target.valueAsNumber)} /></label>
    </div>
    {budgetError && <div className="asset-meta" role="alert">{budgetError}</div>}
    <textarea aria-label="Independent AI instruction" value={goal} disabled={busy}
      onChange={(e) => setGoal(e.target.value)} placeholder="Describe what you want to do in a connected app" rows={5} maxLength={4000} />
    {state.usage && <div className="asset-meta" role="status" aria-label="Independent AI token usage">Tokens reported by the provider: {state.usage.input.toLocaleString()} in, {state.usage.output.toLocaleString()} out{state.provider ? ` (${AGENT_PROVIDERS[state.provider.provider].label})` : ''}</div>}
    <div className="btn-row">
      <button className="btn primary" disabled={busy || !presentation.canRun || !!validationError} onClick={run}>Run with {providerLabel}</button>
      <button className="btn" disabled={!presentation.canStop} onClick={stop}>Stop</button>
      <button className="btn" disabled={!presentation.canResume} onClick={resume}>Continue Task</button>
    </div>
    {import.meta.env.DEV && <details className="agent-recovery-preview-controls">
      <summary>Developer recovery UI preview (no commands executed)</summary>
      <label>Simulated scenario: <select aria-label="Simulated recovery scenario" disabled={!!state.recovery} value={recoveryFixture} onChange={e => setRecoveryFixture(e.target.value as RecoveryFixture)}>
        <option value="off">Off — live agent only</option>
        <option value="unresolved">Unresolved edit — no read-back</option>
        <option value="matching">Matching mock read-back</option>
        <option value="mismatch">Mismatching mock read-back</option>
        <option value="unreadable">Unreadable journal</option>
      </select></label>
      {previewActive && <p className="asset-meta">TEST DISPLAY ONLY — real agent and edit guards are unchanged. Do not use this preview to approve recovery.</p>}
    </details>}
    {recoveryToDisplay && <section className="agent-recovery-panel" role="status" aria-label="Unresolved edit recovery">
      <strong>{previewActive ? 'SIMULATED recovery — UI TEST ONLY' : 'Unresolved edit — recovery required'}</strong>
      <p>{recoveryToDisplay.message}</p>
      {recoveryToDisplay.tool && <div className="asset-meta">Tool: {recoveryToDisplay.tool}</div>}
      {recoveryToDisplay.command && <div className="asset-meta">Command: {recoveryToDisplay.command}</div>}
      {recoveryToDisplay.startedAt && <div className="asset-meta">Recorded: {recoveryToDisplay.startedAt}</div>}
      {recoveryToDisplay.expected && <div className="agent-recovery-expected">
        <strong>Recorded expected outcome</strong>
        {recoveryToDisplay.expected.kind === 'photocraft.shape.edit.rect' && <div>Layer {recoveryToDisplay.expected.layer}: rectangle [{recoveryToDisplay.expected.rect.join(', ')}]</div>}
        {recoveryToDisplay.expected.kind === 'blender.object.transform' && <div>Blender object {recoveryToDisplay.expected.object} in {recoveryToDisplay.expected.file}: {Object.entries(recoveryToDisplay.expected.values).map(([axis, v]) => `${axis}=${v}`).join(', ')}</div>}
        {recoveryToDisplay.expected.kind === 'blender.object.color' && <div>Blender object {recoveryToDisplay.expected.object} in {recoveryToDisplay.expected.file}: colour {recoveryToDisplay.expected.color}</div>}
      </div>}
      <div className="asset-meta">{!previewActive ? 'Actual outcome: not independently verified. Editing stays guarded until reconciliation succeeds.' : fixture.actual}</div>
      {previewActive && <div className="asset-meta">{fixture.explanation}</div>}
      {!previewActive && presentation.canResume && <div className="asset-meta">Use Continue Task to inspect current application state. Do not repeat the uncertain edit.</div>}
    </section>}
    {state.plan && <details open className="agent-task-plan">
      <summary>Task plan ({state.plan.steps.filter(step => step.status === 'completed').length}/{state.plan.steps.length} completed)</summary>
      <div className="asset-meta">{state.plan.goal}</div>
      {!editingPlan && <>
        {state.plan.steps.map(step => <div key={step.id} className="agent-plan-step">
          <span className="chip">{step.status}</span> <span>{step.title}</span>
          {step.evidence && <div className="asset-meta">Evidence: {step.evidence}</div>}
        </div>)}
        {canEditPlan && <button className="btn" onClick={startPlanEdit}>Edit plan</button>}
      </>}
      {editingPlan && <div className="agent-plan-editor">
        {draftSteps.map((step, index) => <div className="agent-plan-step" key={step.id}>
          <div className="claude-row">
            <input aria-label={`Step ${index + 1} title`} maxLength={180} value={step.title} disabled={!canEditPlan} onChange={e => updateStep(index, {title:e.target.value})}/>
            <select aria-label={`Step ${index + 1} status`} value={step.status} disabled={!canEditPlan} onChange={e => updateStep(index, {status:e.target.value as AgentPlanStep['status']})}>
              {(['pending','active','completed','blocked'] as const).map(status => <option key={status} value={status}>{status}</option>)}
            </select>
          </div>
          {step.status === 'completed' && <textarea aria-label={`Step ${index + 1} evidence`} placeholder="What verified this step?" maxLength={1000} value={step.evidence ?? ''} disabled={!canEditPlan} onChange={e => updateStep(index, {evidence:e.target.value})} rows={2}/>}
          <div className="btn-row">
            <button className="btn" disabled={!canEditPlan || index === 0} onClick={() => setDraftSteps(items => {const next=[...items];[next[index - 1],next[index]]=[next[index]!,next[index - 1]!];return next;})}>Up</button>
            <button className="btn" disabled={!canEditPlan || index === draftSteps.length - 1} onClick={() => setDraftSteps(items => {const next=[...items];[next[index],next[index + 1]]=[next[index + 1]!,next[index]!];return next;})}>Down</button>
            <button className="btn" disabled={!canEditPlan} onClick={() => setDraftSteps(items => items.filter((_, i) => i !== index))}>Remove</button>
          </div>
        </div>)}
        <div className="btn-row">
          <button className="btn" disabled={!canEditPlan || draftSteps.length >= 20} onClick={() => setDraftSteps(items => [...items, {id:`step_${Date.now()}_${items.length}`,title:'New step',status:'pending'}])}>Add step</button>
          <button className="btn primary" disabled={!canEditPlan || draftSteps.some(step => !step.title.trim() || (step.status === 'completed' && !step.evidence?.trim()))} onClick={savePlan}>Save plan</button>
          <button className="btn" onClick={() => setEditingPlan(false)}>Cancel</button>
        </div>
      </div>}
    </details>}
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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentUiState, AgentPlanStep } from '@shared/agentHarness';
import { presentUnifiedAgent, validateUnifiedAgentRequest } from '@shared/unifiedAgentPresentation';
import { AGENT_BUDGET_LIMITS, validateAgentBudget } from '@shared/agentBudget';
import { AGENT_PROVIDERS, DEFAULT_LOCAL_ENDPOINT, validateProviderSelection, type AgentProviderId, type AgentProviderSelection } from '@shared/agentProvider';
import { recoveryUiFixture, type RecoveryFixture } from './recoveryUiFixture';

const initial: AgentUiState = { status: 'idle', model: AGENT_PROVIDERS.openai.models[0]!, goal: '', result: '', events: [] };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Existing independent agent controls, using the shared renderer presentation contract. */
export function IndependentAgent({ provider }: { provider: AgentProviderId }) {
  const [state, setState] = useState<AgentUiState>(initial);
  const [model, setModel] = useState<string>(AGENT_PROVIDERS[provider].models[0] ?? '');
  const [endpoint, setEndpoint] = useState(DEFAULT_LOCAL_ENDPOINT);
  const [goal, setGoal] = useState('');
  const [maxTurns, setMaxTurns] = useState<number>(AGENT_BUDGET_LIMITS.maxTurns.default);
  const [maxToolCalls, setMaxToolCalls] = useState<number>(AGENT_BUDGET_LIMITS.maxToolCalls.default);
  const [strict, setStrict] = useState(false);
  const [error, setError] = useState('');
  const [requestPending, setRequestPending] = useState(false);
  const [draftSteps, setDraftSteps] = useState<AgentPlanStep[]>([]);
  const [editingPlan, setEditingPlan] = useState(false);
  const [recoveryFixture, setRecoveryFixture] = useState<RecoveryFixture>('off');
  const fixture = recoveryUiFixture(recoveryFixture);
  const previewActive = import.meta.env.DEV && !state.recovery && recoveryFixture !== 'off';
  const recoveryToDisplay = state.recovery ?? (previewActive ? fixture.info : undefined);
  const presentation = useMemo(() => presentUnifiedAgent(state), [state]);
  // New activity scrolls into view, like a chat: the feed keeps the newest line at the bottom, next to the instruction box.
  const feedRef = useRef<HTMLDivElement>(null);
  const chatLength = state.chat?.length ?? 0;
  useEffect(() => { const el = feedRef.current; if (el) el.scrollTop = el.scrollHeight; }, [chatLength, presentation.result]);
  const budgetError = validateAgentBudget({ maxTurns, maxToolCalls });
  const selection: AgentProviderSelection = provider === 'local' ? { provider, endpoint } : { provider };
  const validationError = validateUnifiedAgentRequest(goal, model) ?? validateProviderSelection(selection, model) ?? budgetError;
  // The provider is chosen in the Creative Partner panel header; picking another one starts from that provider's first model.
  useEffect(() => { setModel(AGENT_PROVIDERS[provider].models[0] ?? ''); }, [provider]);
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
  // Chat, like Claude's panel: Enter sends. The first message starts a task; later ones continue the same conversation
  // (also after it was paused, limited or finished). Stop interrupts the AI's current work and keeps the conversation.
  const send = () => {
    const text = goal.trim();
    if (!text || busy || validationError) return;
    setError('');
    setRequestPending(true);
    setGoal('');
    void window.studio.agent.send(text, model, { maxTurns, maxToolCalls, ...(strict ? { strictVerification: true } : {}) }, selection)
      .then(setState).catch((e) => { setError(errorText(e)); setGoal((g) => g || text); })
      .finally(() => setRequestPending(false));
  };
  const interrupt = () => { setError(''); void window.studio.agent.interrupt().catch((e) => setError(errorText(e))); };
  const newChat = () => { setError(''); void window.studio.agent.stop().then(setState).catch((e) => setError(errorText(e))); };
  // The Planner's "Send to AI" can fill the box for the user; it never sends anything (the user presses Send).
  useEffect(() => {
    const fill = (e: Event) => { const t = (e as CustomEvent<{ text?: unknown }>).detail?.text; if (typeof t === 'string' && t) setGoal(t); };
    window.addEventListener('createcraft:claude-prefill', fill);
    return () => window.removeEventListener('createcraft:claude-prefill', fill);
  }, []);
  const chat = state.chat ?? [];

  return <div className="agent-panel">
  <div className="claude-section">
    <div className="claude-row">
      {provider === 'local'
        ? <input aria-label="Independent AI local model name" placeholder="Model name" value={model} disabled={busy} maxLength={80} onChange={(e) => setModel(e.target.value)} />
        : <select aria-label="Independent AI model" value={model} disabled={busy} onChange={(e) => setModel(e.target.value)}>
            {AGENT_PROVIDERS[provider].models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>}
      <button className="btn small" disabled={busy || (!chat.length && !state.goal)} onClick={newChat}>New chat</button>
    </div>
    <div className="asset-meta">Tell {providerLabel} what you want in a connected app. It works step by step and asks you before it changes your work. OpenAI and Gemini use the API key saved in Settings and calls may incur charges.</div>
    <details className="agent-limits">
      <summary>Limits and usage</summary>
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
      <label className="asset-meta"><input type="checkbox" aria-label="Strict verification" checked={strict} disabled={busy} onChange={(e) => setStrict(e.target.checked)} /> Strict verification: every plan step must be proven before the task can finish. Slower, and smaller models stall more often. Off = works the way Claude does.</label>
      {budgetError && <div className="asset-meta" role="alert">{budgetError}</div>}
      {state.usage && <div className="asset-meta" role="status" aria-label="Independent AI token usage">Tokens reported by the provider: {state.usage.input.toLocaleString()} in, {state.usage.output.toLocaleString()} out{state.provider ? ` (${AGENT_PROVIDERS[state.provider.provider].label})` : ''}</div>}
    </details>
  </div>
  <div className="chat agent-chat" ref={feedRef} aria-label="Conversation" aria-live="polite">
    {!chat.length && <div className="msg system">
      Tell {providerLabel} what you want, for example "build a low-poly castle in Blender" or "make the roofs red". It makes the changes in the connected app while you watch.
      Use Stop or take control any time. Nothing is saved until the app saves it.
    </div>}
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
          {recoveryToDisplay.expected.kind === 'blender.script.run' && <div>Blender script run in {recoveryToDisplay.expected.file}</div>}
          {recoveryToDisplay.expected.kind === 'blender.scene.batch' && <div>Blender batch {recoveryToDisplay.expected.batch_id} (chunk {recoveryToDisplay.expected.chunk + 1} of {recoveryToDisplay.expected.total}, {recoveryToDisplay.expected.objects} object(s)) in {recoveryToDisplay.expected.file}</div>}
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
    {chat.map((m) => (
      <div key={m.id} className={`msg ${m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : m.role === 'error' ? 'error' : m.role === 'system' ? 'system' : 'activity'}`}>{m.text}</div>
    ))}
    {busy && <div className="msg activity">{providerLabel} is working…</div>}
    {!busy && presentation.latestProblem && presentation.canResume && <div className="msg error" aria-label="Why the task stopped">{presentation.latestProblem}</div>}
    {!busy && validationError && goal.length > 0 && <div className="msg error" role="alert">{validationError}</div>}
    {error && <div className="msg error" role="alert">{error}</div>}
  </div>
  <div className="composer">
    <label className="sr-only" htmlFor="agent-input">Message {providerLabel}</label>
    <textarea id="agent-input" aria-label="Independent AI instruction" value={goal} placeholder={`Ask ${providerLabel} to change something…`} maxLength={4000}
      onChange={(e) => setGoal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
    {busy
      ? <button className="btn danger" disabled={!presentation.canStop} onClick={interrupt}>Stop</button>
      : <button className="btn primary" disabled={!goal.trim() || !!validationError} onClick={send}>Send</button>}
  </div>
  </div>;
}

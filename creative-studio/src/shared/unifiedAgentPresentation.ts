import type { AgentUiState } from './agentHarness';

/** Pure, credential-free presentation model for the existing agent: IPC stays authoritative. */
export interface UnifiedAgentPresentation {
  status: AgentUiState['status'];
  model: string;
  goal: string;
  result: string;
  busy: boolean;
  canRun: boolean;
  canStop: boolean;
  canResume: boolean;
  activities: Array<{ kind: 'tool' | 'result' | 'error' | 'stop'; label: string; failed: boolean }>;
}

/** Do not render raw tool arguments or tool results in the activity timeline: they may contain file data or secrets. */
export function presentUnifiedAgent(state: AgentUiState): UnifiedAgentPresentation {
  const busy = state.status === 'working';
  return {
    status: state.status,
    model: state.model,
    goal: state.goal,
    result: state.result,
    busy,
    canRun: !busy,
    canStop: busy,
    canResume: state.status === 'paused',
    activities: state.events.filter((event) => event.kind !== 'model').slice(-50).map((event) => ({
      kind: event.kind as 'tool' | 'result' | 'error' | 'stop',
      label: event.kind === 'tool' ? `Running ${safeToolName(event.tool)}`
        : event.kind === 'result' ? `${safeToolName(event.tool)}: ${event.isError ? 'failed' : 'finished'}`
        : event.kind === 'stop' ? 'Agent stopped'
        : 'Agent error',
      failed: event.kind === 'error' || (event.kind === 'result' && !!event.isError),
    })),
  };
}

function safeToolName(value: string | undefined): string {
  return value && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(value) ? value : 'tool';
}

/** Renderer-facing guard only; IPC must recheck task state and credentials. */
export function validateUnifiedAgentRequest(goal: string, model: string): string | null {
  if (!goal.trim()) return 'Enter a task.';
  if (goal.length > 4000) return 'Task must be 4,000 characters or fewer.';
  if (!model.trim() || model.length > 80) return 'Select a valid model.';
  return null;
}

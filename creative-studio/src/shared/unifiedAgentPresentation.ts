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
  activities: Array<{ kind: 'tool' | 'result' | 'error' | 'stop'; label: string; failed: boolean; /** A fixed, plain-language explanation of a failed call (never the raw tool output). */ reason?: string }>;
  /** Why the latest failed call failed, in the same fixed wording, so the user is not left guessing. */
  latestProblem?: string;
  /** The newest activity label, for a one-line "now" display while the full list is collapsed. */
  now?: string;
}

/**
 * Plain-language reason for a failed tool call. Only fixed sentences are ever produced from the error text (it is matched, never shown),
 * so file content or secrets that a tool result might contain cannot reach the screen.
 */
export function explainFailure(text: string): string | undefined {
  if (/not connected|stop and wait for the user|disconnected|no external application is connected/i.test(text)) return 'An application is not connected. Open the Software list and connect it, then press Continue Task.';
  if (/no connected application matches|matches several connected applications/i.test(text)) return 'The AI used the wrong application name or key; it can correct this itself.';
  if (/permission|did not allow|declined|not approved/i.test(text)) return 'A permission request was declined or is waiting for you.';
  if (/identical tool call already failed twice/i.test(text)) return 'The AI repeated a failing call and stopped to avoid a loop.';
  if (/edits remain blocked|uncertain|recovery lock|may have partially succeeded/i.test(text)) return 'An earlier edit is waiting to be verified (recovery lock); the AI must read the state back before editing.';
  if (/invalid parameter|unknown parameter|unknown setting|missing required|validation|must be|is required for|invalid-params|not advertised/i.test(text)) return 'A command was refused because its settings were not valid.';
  if (/cannot see images|picture limit|one every few seconds/i.test(text)) return 'A viewport picture was not taken (this model cannot see images, or the picture limit was reached).';
  if (/script_refused|script_syntax|script_error/i.test(text)) return 'A Blender script was refused or failed; the project was not changed.';
  if (/timeout|timed out|did not answer/i.test(text)) return 'The application did not answer in time.';
  return undefined;
}

/** Do not render raw tool arguments or tool results in the activity timeline: they may contain file data or secrets. */
export function presentUnifiedAgent(state: AgentUiState): UnifiedAgentPresentation {
  const busy = state.status === 'working';
  const activities = state.events.filter((event) => event.kind !== 'model').slice(-50).map((event) => {
    const failed = event.kind === 'error' || (event.kind === 'result' && !!event.isError);
    const reason = failed ? explainFailure(event.text) : undefined;
    return {
      kind: event.kind as 'tool' | 'result' | 'error' | 'stop',
      label: event.kind === 'tool' ? `Running ${safeToolName(event.tool)}`
        : event.kind === 'result' ? `${safeToolName(event.tool)}: ${event.isError ? 'failed' : 'finished'}`
        : event.kind === 'stop' ? 'Agent stopped'
        : 'Agent error',
      failed,
      ...(reason ? { reason } : {}),
    };
  });
  return {
    status: state.status,
    model: state.model,
    goal: state.goal,
    result: state.result,
    busy,
    canRun: !busy,
    canStop: busy,
    canResume: state.status === 'paused' || state.status === 'limit',
    activities,
    latestProblem: [...activities].reverse().find((a) => a.reason)?.reason,
    now: activities.at(-1)?.label,
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

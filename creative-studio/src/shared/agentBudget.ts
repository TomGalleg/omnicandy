/** Bounds for the independent agent's execution budget. Defaults stay conservative for paid APIs; the main process re-validates every value. */
export const AGENT_BUDGET_LIMITS = {
  maxTurns: { default: 20, min: 1, max: 100 },
  maxToolCalls: { default: 50, min: 1, max: 250 },
} as const;
/** strictVerification: keep the long verification rulebook (every plan step needs an evidence_verify, completion is gated). Off by default: the AI works the way Claude's panel does. */
export interface AgentBudget { maxTurns?: number; maxToolCalls?: number; strictVerification?: boolean }

/** Renderer-side guard with the same limits as the main-process schema. Returns an error message or null. */
export function validateAgentBudget(budget: AgentBudget): string | null {
  for (const key of ['maxTurns', 'maxToolCalls'] as const) {
    const value = budget[key];
    if (value === undefined) continue;
    const { min, max } = AGENT_BUDGET_LIMITS[key];
    if (!Number.isInteger(value) || value < min || value > max)
      return `${key === 'maxTurns' ? 'Model turns' : 'Tool calls'} must be a whole number from ${min} to ${max}.`;
  }
  return null;
}

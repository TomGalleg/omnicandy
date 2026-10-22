import { z } from 'zod';
import { AGENT_BUDGET_LIMITS } from '@shared/agentBudget';

/** Bounded execution budgets. Defaults deliberately remain conservative for paid APIs. */
export function clampAgentBudgets(turns?: number, calls?: number) {
  const clamp = (value: number | undefined, limits: { default: number; min: number; max: number }) =>
    value === undefined || !Number.isFinite(value) ? limits.default : Math.max(limits.min, Math.min(Math.floor(value), limits.max));
  return { maxTurns: clamp(turns, AGENT_BUDGET_LIMITS.maxTurns), maxToolCalls: clamp(calls, AGENT_BUDGET_LIMITS.maxToolCalls) };
}
/** IPC input: out-of-range, fractional or unknown values are rejected rather than silently raised. */
export const agentBudgetSchema = z.object({
  maxTurns: z.number().int().min(AGENT_BUDGET_LIMITS.maxTurns.min).max(AGENT_BUDGET_LIMITS.maxTurns.max).optional(),
  maxToolCalls: z.number().int().min(AGENT_BUDGET_LIMITS.maxToolCalls.min).max(AGENT_BUDGET_LIMITS.maxToolCalls.max).optional(),
}).strict();

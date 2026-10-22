import type { AgentUiState, AgentUsage } from '@shared/agentHarness';
import { DEFAULT_AGENT_PROVIDER, type AgentProviderSelection } from '@shared/agentProvider';
import type { AgentBudget } from '@shared/agentBudget';
import type { Message } from './types';
import type { TaskPlan } from './taskPlan';
import type { TaskCheckpoint } from './taskCheckpoint';
import type { EditIntent } from './editIntentJournal';
import { recoveryPresentation } from './recoveryPresentation';

/** Everything Continue Task needs, as restored from the encrypted checkpoint. Holds no credentials. */
export type PausedAgent = { goal: string; model: string; messages: Message[]; plan?: TaskPlan; uncertainEdit?: string;
  provider?: AgentProviderSelection; budget?: AgentBudget; usage?: AgentUsage };

/** The production IPC agentState handler uses this conversion after loading the
 * project's encrypted checkpoint and write-ahead journal. No edit is executed.
 * A missing or unreadable journal must never be represented as a clean task. */
export function recoveryIpcState(restored:
  | { kind: 'task'; task: TaskCheckpoint; intent: EditIntent | null; uncertainEdit?: string; notice: string }
  | { kind: 'orphan'; notice: string }
  | { kind: 'empty' },
  current: AgentUiState,
): { state: AgentUiState; paused: PausedAgent | null } {
  if (restored.kind === 'empty') return { state: current, paused: null };
  if (restored.kind === 'orphan') return {
    state: { ...current, status: 'failed', result: restored.notice, recovery: recoveryPresentation(null, true) }, paused: null,
  };
  const { task } = restored;
  return {
    paused: { goal: task.goal, model: task.model, messages: task.messages,
      plan: task.plan, uncertainEdit: restored.uncertainEdit,
      ...(task.provider ? { provider: task.provider } : {}), ...(task.budget ? { budget: task.budget } : {}), ...(task.usage ? { usage: task.usage } : {}) },
    state: { status: task.status, model: task.model, goal: task.goal,
      result: restored.notice, events: [], plan: task.plan, recovery: recoveryPresentation(restored.intent),
      provider: task.provider ?? DEFAULT_AGENT_PROVIDER, ...(task.budget ? { budget: task.budget } : {}), ...(task.usage ? { usage: task.usage } : {}) },
  };
}

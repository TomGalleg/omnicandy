import type { AgentUiState } from '@shared/agentHarness';
import type { Message } from './types';
import type { TaskPlan } from './taskPlan';
import type { TaskCheckpoint } from './taskCheckpoint';
import type { EditIntent } from './editIntentJournal';
import { recoveryPresentation } from './recoveryPresentation';

/** The production IPC agentState handler uses this conversion after loading the
 * project's encrypted checkpoint and write-ahead journal. No edit is executed.
 * A missing or unreadable journal must never be represented as a clean task. */
export function recoveryIpcState(restored:
  | { kind: 'task'; task: TaskCheckpoint; intent: EditIntent | null; uncertainEdit?: string; notice: string }
  | { kind: 'orphan'; notice: string }
  | { kind: 'empty' },
  current: AgentUiState,
): { state: AgentUiState; paused: { goal: string; model: string; messages: Message[]; plan?: TaskPlan; uncertainEdit?: string } | null } {
  if (restored.kind === 'empty') return { state: current, paused: null };
  if (restored.kind === 'orphan') return {
    state: { ...current, status: 'failed', result: restored.notice, recovery: recoveryPresentation(null, true) }, paused: null,
  };
  const { task } = restored;
  return {
    paused: { goal: task.goal, model: task.model, messages: task.messages,
      plan: task.plan, uncertainEdit: restored.uncertainEdit },
    state: { status: task.status, model: task.model, goal: task.goal,
      result: restored.notice, events: [], plan: task.plan, recovery: recoveryPresentation(restored.intent) },
  };
}

/** Renderer-safe view of the independent agent; never contains credentials. */
export interface AgentUiEvent { kind: 'model' | 'tool' | 'result' | 'error' | 'stop'; text: string; callId?: string; tool?: string; isError?: boolean }
export interface AgentPlanStep { id: string; title: string; status: 'pending' | 'active' | 'completed' | 'blocked'; evidence?: string }
export interface AgentTaskPlan { goal: string; steps: AgentPlanStep[] }
export interface AgentRecoveryInfo {
  status: 'unresolved' | 'unreadable';
  tool?: 'app_command' | 'external_command';
  command?: string;
  startedAt?: string;
  expected?: { kind: 'photocraft.shape.edit.rect'; layer: number; rect: [number,number,number,number] };
  message: string;
}
export interface AgentUiState {
  status: 'idle' | 'working' | 'completed' | 'paused' | 'cancelled' | 'limit' | 'failed';
  model: string;
  goal: string;
  result: string;
  events: AgentUiEvent[];
  plan?: AgentTaskPlan;
  recovery?: AgentRecoveryInfo;
}

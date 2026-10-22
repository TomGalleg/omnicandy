/** Renderer-safe view of the independent agent; never contains credentials. */
export interface AgentUiEvent { kind: 'model' | 'tool' | 'result' | 'error' | 'stop'; text: string; callId?: string; tool?: string; isError?: boolean }
/** One line of the chat view of a task (see agentChat.ts). */
export interface AgentChatItem { id: string; role: 'user' | 'assistant' | 'activity' | 'error' | 'system'; text: string }
export interface AgentPlanStep { id: string; title: string; status: 'pending' | 'active' | 'completed' | 'blocked'; evidence?: string }
export interface AgentTaskPlan { goal: string; steps: AgentPlanStep[] }
export interface AgentRecoveryInfo {
  status: 'unresolved' | 'unreadable';
  tool?: string;
  command?: string;
  startedAt?: string;
  /** The recorded expected outcome, in a form that can be shown to the user and compared with a trusted read-back. */
  expected?: { kind: 'photocraft.shape.edit.rect'; layer: number; rect: [number,number,number,number] }
    | { kind: 'blender.object.transform'; file: string; object: string; values: Record<string, number> }
    | { kind: 'blender.object.color'; file: string; object: string; color: string }
    | { kind: 'blender.scene.batch'; file: string; batch_id: string; chunk: number; total: number; objects: number }
    | { kind: 'blender.script.run'; file: string };
  message: string;
}
export interface AgentUsage { input: number; output: number }
export interface AgentUiState {
  status: 'idle' | 'working' | 'completed' | 'paused' | 'cancelled' | 'limit' | 'failed';
  model: string;
  goal: string;
  result: string;
  events: AgentUiEvent[];
  /** The conversation as the panel shows it: what you said, what the AI said and did, and why it stopped. */
  chat?: AgentChatItem[];
  plan?: AgentTaskPlan;
  recovery?: AgentRecoveryInfo;
  /** Provider the task runs on (Continue Task keeps it). Never contains credentials. */
  provider?: import('./agentProvider').AgentProviderSelection;
  /** Execution budget in force for this task. */
  budget?: import('./agentBudget').AgentBudget;
  /** Provider-reported tokens only, summed across runs of this task; absent when the provider reported none. */
  usage?: AgentUsage;
}

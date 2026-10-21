/** Renderer-safe view of the independent agent; never contains credentials. */
export interface AgentUiEvent { kind: 'model' | 'tool' | 'result' | 'error' | 'stop'; text: string; callId?: string; tool?: string; isError?: boolean }
export interface AgentUiState {
  status: 'idle' | 'working' | 'completed' | 'paused' | 'cancelled' | 'limit' | 'failed';
  model: string;
  goal: string;
  result: string;
  events: AgentUiEvent[];
}

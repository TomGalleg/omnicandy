export type JsonSchema = Record<string, unknown>;
export interface ToolCall { id: string; name: string; args: unknown }
export interface ToolResult { text: string; isError?: boolean; verified?: boolean; imageDataUrl?: string }
export interface ToolDef { name: string; description: string; parameters: JsonSchema; execute: (args: unknown) => Promise<ToolResult> }
export type Message =
  | { role: 'user'; content: string; imageDataUrl?: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };
export interface ProviderReply { text: string | null; toolCalls: ToolCall[]; usage?: { input: number; output: number } }
export interface ModelProvider { readonly id: string; readonly supportsVision: boolean; complete(input: { system: string; messages: Message[]; tools: Pick<ToolDef, 'name' | 'description' | 'parameters'>[]; signal: AbortSignal }): Promise<ProviderReply> }
export interface AgentEvent { kind: 'model' | 'tool' | 'result' | 'error' | 'stop'; text: string; callId?: string; tool?: string; isError?: boolean }
export interface AgentOutcome { status: 'completed' | 'cancelled' | 'paused' | 'limit' | 'failed'; text: string; messages: Message[]; events: AgentEvent[] }

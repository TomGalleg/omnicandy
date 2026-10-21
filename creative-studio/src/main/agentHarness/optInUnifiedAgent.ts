import type { LiveTaskController } from '../liveTask';
import type { AgentEvent, AgentOutcome, ModelProvider } from './types';
import type { UnifiedToolRegistry } from './unifiedToolRegistry';
import { createUnifiedAgentRegistry } from './unifiedProviderRouting';
import { runAgent } from './loop';

/**
 * Opt-in entry point for existing ModelProvider implementations.
 * No provider is instantiated here; this function does not manage credentials,
 * register IPC, alter Claude sessions, or bypass application controllers.
 */
export function runOptInUnifiedAgent(options: {
  enabled: boolean;
  goal: string;
  provider: ModelProvider;
  tools: UnifiedToolRegistry;
  controller: LiveTaskController;
  signal?: AbortSignal;
  maxTurns?: number;
  maxToolCalls?: number;
  onEvent?: (event: AgentEvent) => void;
}): Promise<AgentOutcome> {
  if (!options.enabled) {
    throw new Error('Unified provider routing is disabled; explicit opt-in is required.');
  }
  if (!options.goal.trim()) {
    throw new Error('A nonempty goal is required.');
  }
  return runAgent({
    goal: options.goal,
    provider: options.provider,
    registry: createUnifiedAgentRegistry(options.tools),
    ctl: options.controller,
    signal: options.signal,
    maxTurns: options.maxTurns,
    maxToolCalls: options.maxToolCalls,
    onEvent: options.onEvent,
  });
}

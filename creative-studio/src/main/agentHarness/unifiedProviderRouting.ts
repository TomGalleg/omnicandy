import { ToolRegistry } from './registry';
import type { ToolDef } from './types';
import type { UnifiedToolRegistry } from './unifiedToolRegistry';

/**
 * Adapts the common application registry to the existing agent loop without
 * changing provider, authentication, or application-controller behavior.
 * This is a snapshot bridge, not a new authorization decision point.
 */
export function createUnifiedAgentRegistry(unified: UnifiedToolRegistry): ToolRegistry {
  const snapshot = unified.snapshot();
  const routed: ToolDef[] = snapshot.map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    // Re-enter the source registry so it can reject stale or missing tools.
    execute: (args: unknown) => unified.call(snapshot, definition.name, args),
  }));
  return new ToolRegistry(routed);
}

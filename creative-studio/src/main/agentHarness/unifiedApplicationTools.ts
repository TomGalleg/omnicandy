import type { LiveTaskController } from '../liveTask';
import type { ProjectStore } from '../projectStore';
import { externalTools } from './externalTools';
import { nativeToolRegistry } from './nativeTools';
import type { ToolDef } from './types';
import { combineToolRegistries, type UnifiedToolRegistry } from './unifiedToolRegistry';

/**
 * One composition point for existing native and external tool implementations.
 * This only registers handlers: the native controller and integration manager
 * continue to enforce all locks, approvals, permissions and execution policy.
 */
export function buildUnifiedApplicationTools(
  ctl: LiveTaskController,
  store: ProjectStore,
  options: {
    native?: Parameters<typeof nativeToolRegistry>[2];
    external?: Parameters<typeof externalTools>[0];
    additional?: readonly ToolDef[];
  } = {},
): UnifiedToolRegistry {
  const native = nativeToolRegistry(ctl, store, options.native);
  return combineToolRegistries(
    native,
    options.external ? externalTools(options.external) : undefined,
    options.additional,
  );
}

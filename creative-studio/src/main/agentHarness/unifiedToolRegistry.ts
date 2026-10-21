import { ToolRegistry } from './registry';
import type { ToolDef, ToolResult } from './types';

/** A model-neutral tool descriptor, without closures or execution privileges. */
export type AdvertisedTool = Readonly<Pick<ToolDef, 'name' | 'description' | 'parameters'>>;

/**
 * Combines tool definitions supplied by different application/control domains.
 * This layer never invokes applications directly and never grants permissions.
 * Existing controllers remain authoritative when a registered handler executes.
 */
export class UnifiedToolRegistry {
  private readonly registry = new ToolRegistry();
  private readonly sources = new Map<string, string>();

  addSource(source: string, definitions: readonly ToolDef[]): this {
    if (!source.trim() || source.length > 80) throw new Error('Invalid tool source.');
    const seen = new Set<string>();
    // Check the entire batch before adding any tools; a collision must never
    // partially install a provider's tool set.
    for (const definition of definitions) {
      if (seen.has(definition.name) || this.sources.has(definition.name)) {
        throw new Error(`Duplicate tool name: ${definition.name}`);
      }
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(definition.name)) {
        throw new Error(`Invalid tool name: ${definition.name}`);
      }
      seen.add(definition.name);
    }
    for (const definition of definitions) {
      this.registry.add(definition);
      this.sources.set(definition.name, source);
    }
    return this;
  }

  /** Snapshot is an immutable *selection*; controllers recheck access at run time. */
  snapshot(): readonly ToolDef[] { return this.registry.snapshot(); }

  /** Keep implementation closures out of model-facing provider payloads. */
  advertise(snapshot: readonly ToolDef[] = this.snapshot()): AdvertisedTool[] {
    return snapshot.map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  sourceOf(name: string): string | undefined { return this.sources.get(name); }

  async call(snapshot: readonly ToolDef[], name: string, args: unknown): Promise<ToolResult> {
    return this.registry.call(snapshot, name, args);
  }
}

/** Wrap existing registries without rebuilding native/external tool definitions. */
export function combineToolRegistries(
  native: ToolRegistry,
  external?: readonly ToolDef[],
  additional?: readonly ToolDef[],
): UnifiedToolRegistry {
  const registry = new UnifiedToolRegistry().addSource('native', native.snapshot());
  if (external) registry.addSource('external', external);
  if (additional) registry.addSource('additional', additional);
  return registry;
}

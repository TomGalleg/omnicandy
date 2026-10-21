import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { tool } from './registry';
import { combineToolRegistries, UnifiedToolRegistry } from './unifiedToolRegistry';
import { ToolRegistry } from './registry';
import { createUnifiedAgentRegistry } from './unifiedProviderRouting';
import { ScriptedProvider } from './providers/scripted';

const args = z.object({ id: z.string() }).strict();

async function simulateProvider(providerId: string, registry: ToolRegistry) {
  const provider = new ScriptedProvider([{ text: null, toolCalls: [{ id: 'call1', name: 'app_commands', args: { id: providerId } }] }]);
  const tools = registry.snapshot();
  const reply = await provider.complete({
    system: 'Use approved tools only', messages: [{ role: 'user', content: 'Inspect a command' }],
    tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    signal: new AbortController().signal,
  });
  return Promise.all(reply.toolCalls.map((call) => registry.call(tools, call.name, call.args)));
}

describe('unified provider routing (offline; no live-provider migration)', () => {
  it('advertises identical tools and routes scripted provider calls through one handler', async () => {
    const native = vi.fn(async ({ id }: { id: string }) => `native:${id}`);
    const external = vi.fn(async ({ id }: { id: string }) => `external:${id}`);
    const unified = combineToolRegistries(new ToolRegistry([
      tool('app_commands', 'Inspect native app command', args, native),
    ]), [tool('external_commands', 'Inspect external adapter command', args, external)]);
    const registry = createUnifiedAgentRegistry(unified);
    expect(registry.snapshot().map((item) => item.name)).toEqual(['app_commands', 'external_commands']);
    expect(registry.snapshot().map((item) => item.parameters)).toEqual(unified.advertise().map((item) => item.parameters));
    for (const id of ['claude', 'gpt', 'gemini', 'local']) {
      const results = await simulateProvider(id, registry);
      expect(results).toHaveLength(1);
      const result = results[0]!;
      expect(result.text).toBe(`native:${id}`);
      expect(result.isError).not.toBe(true);
    }
    expect(native).toHaveBeenCalledTimes(4);
    expect(external).not.toHaveBeenCalled();
  });

  it('preserves execution errors and verification information', async () => {
    const unified = new UnifiedToolRegistry().addSource('external', [{
      name: 'external_command', description: 'Run approved adapter operation', parameters: {},
      execute: async () => ({ text: 'Adapter confirmed output', verified: true }),
    }, {
      name: 'denied_command', description: 'Denied by manager', parameters: {},
      execute: async () => ({ text: 'Permission denied', isError: true, verified: false }),
    }]);
    const registry = createUnifiedAgentRegistry(unified);
    const snapshot = registry.snapshot();
    expect(await registry.call(snapshot, 'external_command', {})).toMatchObject({ verified: true });
    expect(await registry.call(snapshot, 'denied_command', {})).toMatchObject({ isError: true, verified: false });
  });

  it('rejects unknown tools before any controller handler executes', async () => {
    const handler = vi.fn(async () => ({ text: 'unexpected' }));
    const unified = new UnifiedToolRegistry().addSource('native', [{
      name: 'app_commands', description: 'List commands', parameters: {}, execute: handler,
    }]);
    const registry = createUnifiedAgentRegistry(unified);
    expect((await registry.call(registry.snapshot(), 'shell', {})).isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});

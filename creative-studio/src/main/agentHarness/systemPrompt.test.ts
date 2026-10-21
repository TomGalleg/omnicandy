import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSystemPrompt, runAgent } from './loop';
import { addExternalTools } from './externalTools';
import { ToolRegistry, tool } from './registry';
import type { ModelProvider, ProviderReply } from './types';
import type { LiveTaskController } from '../liveTask';
import type { IntegrationManager } from '../integrations/manager';

const ctl = { snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null } }), claudeDone: () => undefined } as unknown as LiveTaskController;
const backend = { list: async () => [], execute: async () => { throw new Error('not used'); } } as unknown as IntegrationManager;
const native = () => new ToolRegistry([
  tool('get_status', 'status', z.object({}).strict(), async () => '{}'),
  tool('app_commands', 'commands', z.object({}).strict(), async () => ''),
]);
const final: ProviderReply = { text: 'done', toolCalls: [] };

/** A provider that records what the model would be sent. */
const recorder = () => {
  const seen: Array<{ system: string; tools: string[] }> = [];
  const provider: ModelProvider = { id: 'rec', supportsVision: false, complete: async (i) => { seen.push({ system: i.system, tools: i.tools.map((t) => t.name) }); return final; } };
  return { seen, provider };
};

describe('system prompt follows the registered tools', () => {
  it('explains external discovery when the external tools are registered', async () => {
    const { seen, provider } = recorder();
    await runAgent({ goal: 'make 3 spheres in Blender', provider, ctl, registry: addExternalTools(native(), backend) });
    const s = seen[0]!.system;
    expect(s).toMatch(/call external_apps first/);
    expect(s).toContain('external_commands');
    expect(s).toContain('external_command');
    expect(s).toMatch(/Never invent external commands/);
    expect(s).toMatch(/get_status and app_commands describe only the native/);
    expect(seen[0]!.tools).toEqual(expect.arrayContaining(['external_apps', 'external_commands', 'external_command']));
  });
  it('does not mention external tools in a native-only run', async () => {
    const { seen, provider } = recorder();
    await runAgent({ goal: 'x', provider, ctl, registry: native() });
    expect(seen[0]!.system).not.toMatch(/external/i);
    expect(seen[0]!.system).toBe(buildSystemPrompt(['get_status', 'app_commands']));
    expect(seen[0]!.system).toMatch(/Call get_status before editing/);
  });
  it('needs all three external tools before it claims external support', () => {
    expect(buildSystemPrompt(['external_apps'])).not.toMatch(/external/i);
    expect(buildSystemPrompt(['external_apps', 'external_commands', 'external_command'])).toMatch(/external_apps first/);
  });
});

describe('tool advertisement diagnostics', () => {
  it('records the advertised tool names once, at the start of the run, and nothing else', async () => {
    const { provider } = recorder();
    const out = await runAgent({ goal: 'secret goal text', provider, ctl, registry: addExternalTools(native(), backend) });
    const ev = out.events.filter((e) => e.tool === 'tools');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.kind).toBe('model');
    expect(ev[0]!.text).toBe('Tools available to the model: get_status, app_commands, external_apps, external_commands, external_command');
    expect(out.events[0]).toBe(ev[0]);
    expect(JSON.stringify(out.events)).not.toContain('secret goal text');
  });
  it('is emitted to the live event callback too, and only once across several turns', async () => {
    const seenEvents: string[] = [];
    const script: ProviderReply[] = [{ text: null, toolCalls: [{ id: 'c1', name: 'get_status', args: {} }] }, final];
    let i = 0;
    const provider: ModelProvider = { id: 's', supportsVision: false, complete: async () => script[i++]! };
    await runAgent({ goal: 'x', provider, ctl, registry: native(), onEvent: (e) => seenEvents.push(`${e.kind}:${e.tool ?? ''}`) });
    expect(seenEvents.filter((e) => e === 'model:tools')).toHaveLength(1);
    expect(seenEvents[0]).toBe('model:tools');
    expect(seenEvents).toContain('tool:get_status');
  });
});

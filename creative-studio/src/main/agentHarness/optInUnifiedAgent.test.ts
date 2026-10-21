import { describe, expect, it, vi } from 'vitest';
import { UnifiedToolRegistry } from './unifiedToolRegistry';
import { ScriptedProvider } from './providers/scripted';
import { runOptInUnifiedAgent } from './optInUnifiedAgent';
import type { LiveTaskController } from '../liveTask';

function fakeController() {
  const done = vi.fn();
  const controller = {
    snapshot: () => ({ collab: { lockOwner: null, phase: 'idle', activeOperation: null } }),
    claudeDone: done,
  } as unknown as LiveTaskController;
  return { controller, done };
}

describe('opt-in unified agent (offline only)', () => {
  it('requires opt-in before calling a provider or controller', () => {
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const { controller, done } = fakeController();
    expect(() => runOptInUnifiedAgent({ enabled: false, goal: 'inspect', provider,
      tools: new UnifiedToolRegistry(), controller })).toThrow(/opt-in/i);
    expect(done).not.toHaveBeenCalled();
  });

  it('reuses unified tool handlers without special provider-specific execution', async () => {
    const handle = vi.fn(async () => ({ text: 'inspected', verified: true }));
    const tools = new UnifiedToolRegistry().addSource('native', [{
      name: 'app_commands', description: 'Inspect command', parameters: { type: 'object' }, execute: handle,
    }]);
    const provider = new ScriptedProvider([
      { text: null, toolCalls: [{ id: 'c1', name: 'app_commands', args: {} }] },
      { text: 'Finished inspection', toolCalls: [] },
    ]);
    const { controller, done } = fakeController();
    const output = await runOptInUnifiedAgent({ enabled: true, goal: 'inspect', provider, tools, controller });
    expect(output.status).toBe('completed');
    expect(output.messages.some((m) => m.role === 'tool' && m.content === 'inspected')).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('does not route unknown calls to application handlers', async () => {
    const handle = vi.fn(async () => ({ text: 'should not run' }));
    const tools = new UnifiedToolRegistry().addSource('native', [{
      name: 'app_commands', description: 'Inspect command', parameters: { type: 'object' }, execute: handle,
    }]);
    const provider = new ScriptedProvider([
      { text: null, toolCalls: [{ id: 'c2', name: 'unregistered', args: {} }] },
      { text: 'Tool unavailable', toolCalls: [] },
    ]);
    const { controller } = fakeController();
    const output = await runOptInUnifiedAgent({ enabled: true, goal: 'inspect', provider, tools, controller });
    expect(output.messages.some((m) => m.role === 'tool')).toBe(true);
    expect(handle).not.toHaveBeenCalled();
  });
});

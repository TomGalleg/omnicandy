import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, tool } from './registry';
import { combineToolRegistries, UnifiedToolRegistry } from './unifiedToolRegistry';

const simple = (name: string, handler = vi.fn(async () => 'ok')) =>
  tool(name, `Describe ${name}`, z.object({ count: z.number().int().min(1) }).strict(), handler);

describe('unified provider-independent tool registry', () => {
  it('combines native, external and extra tools without modifying execution handlers', async () => {
    const nativeCall = vi.fn(async () => 'native');
    const externalCall = vi.fn(async () => 'external');
    const base = new ToolRegistry([simple('app_command', nativeCall)]);
    const unified = combineToolRegistries(base, [simple('external_command', externalCall)], [simple('planner_action')]);
    const snapshot = unified.snapshot();
    expect(unified.advertise(snapshot).map(x => x.name)).toEqual(['app_command', 'external_command', 'planner_action']);
    expect(unified.sourceOf('external_command')).toBe('external');
    expect((await unified.call(snapshot, 'external_command', { count: 2 })).text).toBe('external');
    expect(externalCall).toHaveBeenCalledOnce();
    expect(nativeCall).not.toHaveBeenCalled();
  });

  it('does not expose executable handlers to providers', () => {
    const unified = new UnifiedToolRegistry().addSource('native', [simple('get_status')]);
    const metadata = unified.advertise()[0]!;
    expect(metadata).toHaveProperty('parameters');
    expect(metadata).not.toHaveProperty('execute');
  });

  it('refuses duplicates atomically rather than shadowing existing controls', () => {
    const unified = new UnifiedToolRegistry().addSource('native', [simple('get_status')]);
    expect(() => unified.addSource('external', [simple('list_apps'), simple('get_status')])).toThrow('Duplicate tool name');
    expect(unified.snapshot().map(x => x.name)).toEqual(['get_status']);
  });

  it('preserves Zod validation and rejects unadvertised tool calls', async () => {
    const handler = vi.fn(async () => 'ran');
    const unified = new UnifiedToolRegistry().addSource('native', [simple('apply_edit', handler)]);
    const snapshot = unified.snapshot();
    expect((await unified.call(snapshot, 'apply_edit', { count: 0 })).isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect((await unified.call(snapshot, 'external_command', { count: 1 })).isError).toBe(true);
  });

  it('rejects malformed tool names', () => {
    expect(() => new UnifiedToolRegistry().addSource('native', [simple('Dangerous.Name')])).toThrow('Invalid tool name');
  });
});

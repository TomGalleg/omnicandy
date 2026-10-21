import { describe, expect, it, vi } from 'vitest';
import { LivePhotoCraft } from './photocraftLive';

/** A LivePhotoCraft whose MCP bridge is a mock, so no application is started. */
function withBridge(callTool: (name: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>) {
  const app = new LivePhotoCraft({ installDir: 'unused', secretsDir: 'unused', readRoot: 'unused', writeRoot: 'unused' });
  Object.assign(app as object, { mcp: { alive: true, callTool }, gui: { exitCode: null } });
  return app;
}

describe('LivePhotoCraft.run result propagation', () => {
  it('keeps the engine result of command_run for the controller, calling it once with the same arguments', async () => {
    const callTool = vi.fn(async () => ({ layer: 'L7', created: true }));
    const app = withBridge(callTool);
    await app.run({ command: 'layer.newFillLayer.solidColor', params: { color: '#ff0000' } });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('command_run', { id: 'layer.newFillLayer.solidColor', params: { color: '#ff0000' }, wait: true }, 300_000);
    expect(app.lastResult).toEqual({ layer: 'L7', created: true });
  });

  it('still rejects with the engine error and leaves no stale result', async () => {
    const app = withBridge(vi.fn(async () => { throw new Error('radius out of range'); }));
    await expect(app.run({ command: 'filter.blur.shapeBlur', params: {} })).rejects.toThrow('radius out of range');
    expect(app.lastResult).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { hasOpenBlank, openBlank } from './openBlank';

const recorder = (fail: string[] = []) => {
  const calls: string[] = [];
  return { calls, run: async (c: string) => { calls.push(c); if (fail.includes(c)) throw new Error(`${c} failed`); } };
};

describe('openBlank', () => {
  it('covers the four programs', () => {
    for (const id of ['blender', 'unreal', 'resolve', 'autodesk.fusion']) expect(hasOpenBlank(id)).toBe(true);
    expect(hasOpenBlank('freecad')).toBe(false);
  });
  it('Blender: makes a scene then opens its window', async () => {
    const r = recorder();
    await openBlank('blender', 'Blender', r.run);
    expect(r.calls).toEqual(['scene.create_basic', 'scene.open_window']);
  });
  it('Unreal: creates a blank project then starts the editor; shows an open editor instead of failing', async () => {
    const r = recorder();
    await openBlank('unreal', 'Unreal', r.run);
    expect(r.calls).toEqual(['project.create', 'editor.launch']);
    const r2 = recorder(['editor.launch']);
    expect(await openBlank('unreal', 'Unreal', r2.run)).toMatch(/already open/);
    expect(r2.calls).toEqual(['project.create', 'editor.launch', 'editor.show']);
  });
  it('Resolve and Fusion: start, then a blank document; a failed document step is reported, not thrown', async () => {
    const r = recorder();
    await openBlank('resolve', 'Resolve', r.run);
    expect(r.calls).toEqual(['app.launch', 'project.create_scratch']);
    const f = recorder(['script.run']);
    expect(await openBlank('autodesk.fusion', 'Fusion', f.run)).toMatch(/not made/);
    await expect(openBlank('resolve', 'Resolve', recorder(['app.launch']).run)).rejects.toThrow();
  });
});

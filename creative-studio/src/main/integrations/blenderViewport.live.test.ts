// REAL Blender window (CS_LIVE_TESTS=1): scene.viewport draws the 3D view offscreen, without a render, without changing the
// project, and without disturbing the user's own viewport.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandResult, Permission } from '@shared/integrations';
import { createIntegrationManager } from './index';
import { setBlenderLiveHooks } from './adapters/blenderLive';

const on = process.env.CS_LIVE_TESTS === '1';
const PNG = '89504e470d0a1a0a';

describe.skipIf(!on)('Blender viewport pictures (real Blender window)', { timeout: 300_000 }, () => {
  let tmp: string;
  let granted: Record<string, Permission[]> = {};
  let m: ReturnType<typeof createIntegrationManager>;
  let key = '';
  let dir = '';
  const pids: number[] = [];
  const data = (r: CommandResult) => r.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const sha = async (f: string) => createHash('sha256').update(await fs.readFile(path.join(dir, f))).digest('hex');
  const shot = async (p: Record<string, unknown>) => {
    const r = await m.execute(key, 'scene.viewport', p);
    expect(r.error, r.error?.message).toBeUndefined();
    const file = data(r).image.path as string;
    const bytes = await fs.readFile(file);
    expect(bytes.subarray(0, 8).toString('hex')).toBe(PNG);
    if (process.env.CS_VIEWPORT_OUT) await fs.copyFile(file, path.join(process.env.CS_VIEWPORT_OUT, `${String(p.view ?? 'iso')}${p.focus ? '-' + String(p.focus) : ''}.png`));
    return { r, bytes, hash: createHash('sha256').update(bytes).digest('hex') };
  };

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-viewport-'));
    m = createIntegrationManager({
      workDir: async (id) => path.join(tmp, id),
      permissions: { load: async () => granted, save: async (g) => { granted = g; } },
      approve: async () => 'always',
    });
    setBlenderLiveHooks({ onSpawn: (pid) => pids.push(pid) });
    key = (await m.scan()).apps.find((a) => a.adapterId === 'blender')!.key;
    await m.connect(key);
    dir = path.join(tmp, 'blender');
  });
  afterAll(async () => {
    setBlenderLiveHooks(null);
    await m.disconnect(key);
    for (const pid of pids) { try { process.kill(pid); } catch { /* already closed */ } }
    await m.shutdown();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('draws real pictures of the open window from several views, at the requested size, with material colors', async () => {
    expect((await m.execute(key, 'scene.create_basic', { file_name: 'v1.blend' })).error).toBeUndefined();
    const built = await m.execute(key, 'scene.build', { file_name: 'v1.blend', spec: { batch_id: 'v-castle', objects: [
      { id: 'tower-a', kind: 'cylinder', loc: [3, 3, 0], origin: 'base', shape: { radius: 1, depth: 5, segments: 24 }, material: { name: 'stone', color: '#8a8d91' } },
      { id: 'roof-a', kind: 'cone', parent_id: 'tower-a', loc: [0, 0, 5], origin: 'base', shape: { radius: 1.4, depth: 2 }, material: { name: 'tile', color: '#c02020' } },
      { id: 'wall', kind: 'box', loc: [-1, 3, 1.5], shape: { size: [6, 0.5, 3] }, material: { name: 'stone' } },
    ] } });
    expect(built.error, built.error?.message).toBeUndefined();
    const before = await sha('v1.blend');
    const iso = await shot({});
    expect(data(iso.r)).toMatchObject({ view: 'iso', source: 'open-window', proof: false });
    expect(data(iso.r).image).toMatchObject({ width: 800, height: 600 });
    expect(data(iso.r).objects).toBeGreaterThanOrEqual(3);
    expect(iso.bytes.length).toBeGreaterThan(4000); // not an empty image
    expect(iso.bytes.length).toBeLessThan(2_000_000);
    const views: Record<string, string> = { iso: iso.hash };
    for (const v of ['front', 'top', 'right', 'camera']) views[v] = (await shot({ view: v, size: 512 })).hash;
    expect(new Set(Object.values(views)).size).toBe(5); // every view is a different picture
    const small = await shot({ size: 256 });
    expect(data(small.r).image).toMatchObject({ width: 256, height: 192 });
    const roof = await shot({ view: 'front', focus: 'tower-a', size: 400 }); // frames the tower and its roof child only
    expect(data(roof.r)).toMatchObject({ focus: 'tower-a', objects: 2 });
    expect(roof.hash).not.toBe(views.front);
    // a picture changes nothing: not the saved project, not the files left behind
    expect(await sha('v1.blend')).toBe(before);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp.blend'))).toEqual([]);
  });

  it('refuses unknown views and objects with clear errors, and leaves the window working', async () => {
    const bad = await m.execute(key, 'scene.viewport', { view: 'underneath' });
    expect(bad.ok).toBe(false);
    expect(bad.error?.message).toMatch(/invalid view underneath/);
    const ghost = await m.execute(key, 'scene.viewport', { focus: 'no-such-object' });
    expect(ghost.error?.message).toMatch(/no object with cc_id or name no-such-object/);
    expect((await m.execute(key, 'scene.viewport', { size: 5000 })).error?.kind).toBe('invalid-params'); // above the largest allowed side
    expect((await shot({ view: 'back', size: 300 })).bytes.length).toBeGreaterThan(1000);
    expect((await m.execute(key, 'scene.inspect', { file_name: 'v1.blend' })).ok).toBe(true);
  });

  it('shows hand edits that are not saved yet, and says so: it is the open window, not the saved project', async () => {
    const a = await shot({ view: 'top', size: 400 });
    expect((await m.execute(key, 'object.transform', { file_name: 'v1.blend', name: 'wall', x: 6 })).error).toBeUndefined();
    const b = await shot({ view: 'top', size: 400 });
    expect(b.hash).not.toBe(a.hash);
    expect(data(b.r).source).toBe('open-window');
  });

  it('needs the open window: without one it says so and nothing is drawn', async () => {
    setBlenderLiveHooks(null);
    const bare = createIntegrationManager({ workDir: async (id) => path.join(tmp, 'bare', id), permissions: { load: async () => granted, save: async () => undefined }, approve: async () => 'always' });
    const k = (await bare.scan()).apps.find((a) => a.adapterId === 'blender')!.key;
    const r = await bare.execute(k, 'scene.viewport', {});
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/need the open Blender window/);
    await bare.shutdown();
    setBlenderLiveHooks({ onSpawn: (pid) => pids.push(pid) });
  });
});

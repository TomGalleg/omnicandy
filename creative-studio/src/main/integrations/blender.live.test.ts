// REAL Blender (background mode). Runs only with CS_LIVE_TESTS=1 and an installed Blender.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission } from '@shared/integrations';
import { createIntegrationManager } from './index';
import { setBlenderLiveHooks } from './adapters/blenderLive';

const on = process.env.CS_LIVE_TESTS === '1';

describe.skipIf(!on)('Blender integration (real Blender)', { timeout: 180_000 }, () => {
  let tmp: string;
  let granted: Record<string, Permission[]> = {};
  const asked: string[] = [];
  const mgr = () => createIntegrationManager({
    workDir: async (id) => path.join(tmp, id),
    permissions: { load: async () => granted, save: async (g) => { granted = g; } },
    approve: async (r) => { asked.push(r.command.id); return 'always'; },
  });
  let m: ReturnType<typeof mgr>;
  let key = '';
  beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-blender-')); m = mgr(); });
  afterAll(async () => { await m.shutdown(); await fs.rm(tmp, { recursive: true, force: true }); });

  it('detects Blender with its real version', async () => {
    const scan = await m.scan();
    console.log('DISCOVERY', JSON.stringify(scan.apps.map((a) => ({ name: a.name, adapter: a.adapterId, version: a.version, status: a.status, source: a.source, exe: a.exePath })), null, 1), 'not found:', scan.missing.map((x) => x.name).join(', '));
    const b = scan.apps.find((a) => a.adapterId === 'blender');
    expect(b, 'Blender not found on this PC').toBeTruthy();
    key = b!.key;
    expect(b!.version).toMatch(/^\d+\.\d+/);
    expect(['available', 'incompatible']).toContain(b!.status);
    expect(b!.methods[0]).toBe('scripting');
  });

  it('connects through the adapter and passes the health check', async () => {
    const info = await m.connect(key);
    expect(info.status).toBe('connected');
  });

  it('creates a cube, camera and light scene, saves it and verifies it by re-opening', async () => {
    const r = await m.execute(key, 'scene.create_basic', { file_name: 'cc-room.blend', cube_size: 2 });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(r.outputs[0]!.path.endsWith('cc-room.blend')).toBe(true);
    expect(r.outputs[0]!.bytes).toBeGreaterThan(1000);
    expect(r.evidence.join(' ')).toMatch(/1 mesh, 1 camera, 1 light/);
    expect(asked).toContain('scene.create_basic');
  });

  it('inspects the saved file and renders a still', async () => {
    const i = await m.execute(key, 'scene.inspect', { file_name: 'cc-room.blend' });
    expect(i.ok).toBe(true);
    expect((i.data as { count: number }).count).toBe(3);
    const r = await m.execute(key, 'scene.render_still', { file_name: 'cc-room.blend', width: 320, height: 180 });
    expect(r.error).toBeUndefined();
    expect(r.outputs[0]!.kind).toBe('png');
    const png = await fs.readFile(r.outputs[0]!.path);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
  });

  it('builds, edits, animates and renders a scene with the scene commands', async () => {
    const f = 'cc-edit.blend';
    const run = async (cmd: string, p: Record<string, unknown>) => { const r = await m.execute(key, cmd, { file_name: f, ...p }); expect(r.error, `${cmd}: ${r.error?.message}`).toBeUndefined(); return r; };
    expect((await m.execute(key, 'scene.create_basic', { file_name: f })).ok).toBe(true);
    await run('object.add', { type: 'sphere', name: 'Ball', x: 3, size: 1.5, color: '#ff0000', metallic: 0.2 });
    await run('object.add', { type: 'cylinder', name: 'Post', x: -3, size: 2, color: '#00aa00' });
    await run('object.transform', { name: 'Cube', ry: 45, sx: 1.5 });
    await run('material.set', { name: 'Cube', color: '#3366ff', roughness: 0.3 });
    await run('object.modifier', { name: 'Ball', kind: 'subsurf', amount: 2, smooth_shade: true });
    await run('object.duplicate', { name: 'Ball', new_name: 'Ball2', y: 3 });
    await run('scene.set', { width: 480, height: 270, frame_end: 12, world_color: '#222244' });
    await run('animation.keyframe', { name: 'Ball', frame: 1, x: 3 });
    await run('animation.keyframe', { name: 'Ball', frame: 12, x: -3 });
    const i = await run('scene.set', {});
    const d = (i.data as { details: Array<{ name: string; location: number[]; rotation_deg: number[]; scale: number[]; materials?: Array<{ color: number[] }>; modifiers?: string[]; keyframed?: string[] }> }).details;
    const by = Object.fromEntries(d.map((o) => [o.name, o]));
    expect(by.Ball!.location[0]).toBeCloseTo(-3, 1); // after the last keyframe evaluation the saved value is the last set
    expect(by.Ball!.modifiers).toContain('SUBSURF');
    expect(by.Ball!.keyframed).toContain('location');
    expect(by.Ball2).toBeTruthy();
    expect(by.Cube!.rotation_deg[1]).toBeCloseTo(45, 0);
    expect(by.Cube!.scale[0]).toBeCloseTo(1.5, 2);
    expect(by.Cube!.materials![0]!.color[2]).toBeGreaterThan(0.9);
    await run('object.delete', { name: 'Ball2' });
    const still = await m.execute(key, 'scene.render_still', { file_name: f, width: 320, height: 180 });
    expect(still.error).toBeUndefined();
    const vid = await m.execute(key, 'scene.render_animation', { file_name: f, width: 320, height: 180, frame_end: 4 });
    expect(vid.error, vid.error?.message).toBeUndefined();
    expect(vid.outputs[0]!.path.endsWith('.mp4')).toBe(true);
    expect(vid.outputs[0]!.bytes).toBeGreaterThan(500);
    expect((await m.execute(key, 'object.transform', { file_name: f, name: 'Nope', x: 1 })).error).toBeTruthy();
  });

  it('remembers a connection across restarts and forgets it when the user disconnects', async () => {
    let saved: string[] = [];
    const make = () => createIntegrationManager({
      workDir: async (id) => path.join(tmp, id),
      permissions: { load: async () => granted, save: async (g) => { granted = g; } },
      approve: async () => 'always',
      connected: { load: async () => saved, save: async (k) => { saved = k; } },
    });
    const first = make();
    const k = (await first.scan()).apps.find((a) => a.adapterId === 'blender')!.key;
    await first.connect(k);
    expect(saved).toContain(k);
    await first.shutdown(); // quitting OmniCandi keeps it remembered
    expect(saved).toContain(k);
    const second = make(); // a new OmniCandi run
    await second.autoConnect();
    expect((await second.scan()).apps.find((a) => a.key === k)!.status).toBe('connected');
    await second.disconnect(k); // the user disconnects on purpose
    expect(saved).not.toContain(k);
    await second.shutdown();
  });

  it('works in one always-open Blender window that can be docked, and reads hand edits', async () => {
    const pids: number[] = [];
    setBlenderLiveHooks({ onSpawn: (pid) => pids.push(pid) });
    try {
      const f = 'cc-live.blend';
      const r1 = await m.execute(key, 'scene.create_basic', { file_name: f });
      expect(r1.error, r1.error?.message).toBeUndefined();
      expect(pids.length).toBe(1); // the window was started once and reported for docking
      const r2 = await m.execute(key, 'object.add', { file_name: f, type: 'sphere', name: 'LiveBall', x: 2, color: '#ff8800' });
      expect(r2.error, r2.error?.message).toBeUndefined();
      expect(pids.length).toBe(1); // same window reused
      const i = await m.execute(key, 'scene.inspect', { file_name: f });
      expect((i.data as { details: Array<{ name: string }> }).details.some((o) => o.name === 'LiveBall')).toBe(true);
      const t = await m.execute(key, 'object.transform', { file_name: f, name: 'LiveBall', z: 3, look_at: 'Cube' });
      expect(t.error, t.error?.message).toBeUndefined();
      const still = await m.execute(key, 'scene.render_still', { file_name: f, width: 320, height: 180 });
      expect(still.error, still.error?.message).toBeUndefined();
      const bad = await m.execute(key, 'object.transform', { file_name: f, name: 'Nope', x: 1 });
      expect(bad.error).toBeTruthy();
      const w = await m.execute(key, 'scene.open_window', { file_name: f });
      expect(w.error, w.error?.message).toBeUndefined();
      expect(pids.length).toBe(1);
    } finally {
      setBlenderLiveHooks(null);
      await m.disconnect(key); // leaves the window to the user: detach, not kill
      await m.connect(key);
      for (const pid of pids) { try { process.kill(pid); } catch { /* already closed */ } }
    }
  });

  it('reports failures accurately: bad file, bad params, missing app', async () => {
    expect((await m.execute(key, 'scene.inspect', { file_name: 'nope.blend' })).error?.kind).toBe('invalid-params');
    expect((await m.execute(key, 'scene.create_basic', { cube_size: -1 })).error?.kind).toBe('invalid-params');
    const noBlender = mgr();
    expect((await noBlender.execute('c:\\no\\blender.exe', 'scene.create_basic')).error?.kind).toBe('missing-app');
  });

  it('survives repeated disconnect and reconnect', async () => {
    for (let i = 0; i < 2; i++) {
      expect((await m.disconnect(key))!.status).toBe('available');
      expect((await m.connect(key)).status).toBe('connected');
    }
    expect((await m.execute(key, 'scene.inspect', { file_name: 'cc-room.blend' })).ok).toBe(true);
  });
});

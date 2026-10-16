// REAL Blender (background mode). Runs only with CS_LIVE_TESTS=1 and an installed Blender.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission } from '@shared/integrations';
import { createIntegrationManager } from './index';

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

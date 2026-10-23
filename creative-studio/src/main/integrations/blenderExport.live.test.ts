// REAL Blender through the real adapter: mesh.export in every format, joined and separate. OPT-IN: skipped unless CS_LIVE_TESTS=1 and Blender
// is installed. Everything lives in a fresh folder under the OS temp directory.
// Run it with: CS_LIVE_TESTS=1 npx vitest run src/main/integrations/blenderExport.live.test.ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission } from '@shared/integrations';
import { createIntegrationManager } from './index';

const on = process.env.CS_LIVE_TESTS === '1';

describe.skipIf(!on)('mesh.export against the real Blender', { timeout: 600_000 }, () => {
  let tmp: string, key = '';
  let granted: Record<string, Permission[]> = {};
  let m: ReturnType<typeof createIntegrationManager>;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-export-live-'));
    expect(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    m = createIntegrationManager({ workDir: async (id) => { const d = path.join(tmp, id); await fs.mkdir(d, { recursive: true }); return d; }, permissions: { load: async () => granted, save: async (g) => { granted = g; } }, approve: async () => 'always' });
    const b = (await m.scan()).apps.find((a) => a.adapterId === 'blender');
    expect(b, 'Blender is not installed').toBeTruthy();
    key = b!.key;
    await m.connect(key);
    expect((await m.execute(key, 'scene.create_basic', { file_name: 'scene.blend', cube_size: 2 })).ok).toBe(true);
    expect((await m.execute(key, 'object.add', { file_name: 'scene.blend', type: 'sphere', name: 'Ball', size: 1, x: 3 })).ok).toBe(true);
    expect((await m.execute(key, 'object.modifier', { file_name: 'scene.blend', name: 'Ball', kind: 'subsurf', amount: 2 })).ok).toBe(true);
  });
  afterAll(async () => { await m.shutdown(); await fs.rm(tmp, { recursive: true, force: true }); });

  for (const format of ['glb', 'fbx', 'obj', 'stl'] as const) {
    it(`exports ${format} as one merged mesh, proven from the finished file`, async () => {
      const r = await m.execute(key, 'mesh.export', { file_name: 'scene.blend', format, name: `all-${format}` });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      expect(r.verified).toBe(true);
      expect(r.outputs).toHaveLength(1);
      expect(path.resolve(r.outputs[0]!.path).startsWith(path.resolve(tmp) + path.sep)).toBe(true);
      expect(r.outputs[0]!.kind).toBe(format); // a kind the library now imports as a 3D model
      expect(r.outputs[0]!.bytes).toBeGreaterThan(200);
      expect(r.data).toMatchObject({ format, joined: true, source_objects: 2 });
    });
  }
  it('applies modifiers by default (the smoothed sphere has far more triangles than a cube)', async () => {
    const withMods = await m.execute(key, 'mesh.export', { file_name: 'scene.blend', format: 'stl', name: 'mods', objects: 'Ball' });
    const without = await m.execute(key, 'mesh.export', { file_name: 'scene.blend', format: 'stl', name: 'nomods', objects: 'Ball', apply_modifiers: false });
    expect(Number((withMods.data as { triangles: number }).triangles)).toBeGreaterThan(Number((without.data as { triangles: number }).triangles) * 3);
  });
  it('keeps objects separate when asked, exports a chosen object only, and refuses a name that does not exist', async () => {
    const sep = await m.execute(key, 'mesh.export', { file_name: 'scene.blend', format: 'glb', name: 'separate', join: false });
    expect(sep.ok).toBe(true);
    expect(sep.message).toMatch(/2 mesh\(es\)/);
    const one = await m.execute(key, 'mesh.export', { file_name: 'scene.blend', format: 'glb', name: 'cube-only', objects: 'Cube' });
    expect(one.data).toMatchObject({ source_objects: 1 });
    const bad = await m.execute(key, 'mesh.export', { file_name: 'scene.blend', format: 'glb', name: 'bad', objects: 'Nope' });
    expect(bad.ok).toBe(false);
    expect(bad.error?.message).toMatch(/do not exist: Nope/);
    expect((await m.execute(key, 'mesh.export', { file_name: 'scene.blend', format: 'dae' })).error?.kind).toBe('invalid-params');
  });
  it('does not change the project file', async () => {
    const f = path.join(tmp, 'blender', 'scene.blend');
    const before = await fs.readFile(f);
    expect((await m.execute(key, 'mesh.export', { file_name: 'scene.blend', format: 'glb', name: 'again' })).ok).toBe(true);
    expect((await fs.readFile(f)).equals(before)).toBe(true);
  });
});

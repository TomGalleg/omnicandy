// REAL FreeCAD. Runs only with CS_LIVE_TESTS=1 AND an installed FreeCAD (FreeCADCmd.exe found by discovery).
// It installs the FreeCAD package into a throw-away store, then drives the real FreeCADCmd. Without FreeCAD
// every test is reported as SKIPPED (never as passed). Nothing outside a temp folder is touched.
//
//   CS_LIVE_TESTS=1 [CS_FREECAD_BIN="E:\FreeCAD 1.1in"] npx vitest run src/main/integrations/freecad.live.test.ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission } from '@shared/integrations';
import { packAdapter } from '../../../scripts/pack-adapter.mjs';
import { AdapterPackages, createIntegrationManager } from './index';

const on = process.env.CS_LIVE_TESTS === '1';

describe.skipIf(!on)('FreeCAD adapter against REAL FreeCAD', { timeout: 300_000 }, () => {
  let tmp: string;
  let granted: Record<string, Permission[]> = {};
  let m: ReturnType<typeof createIntegrationManager>;
  let key = '';
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-freecad-live-'));
    m = createIntegrationManager({
      workDir: async (id) => path.join(tmp, 'work', id),
      permissions: { load: async () => granted, save: async (g) => { granted = g; } },
      approve: async () => 'always',
      // Discovery finds FreeCAD in standard places. A custom install folder is given like "Add location" does it.
      userPaths: async () => (process.env.CS_FREECAD_BIN ? [process.env.CS_FREECAD_BIN] : []),
    });
    const pk = new AdapterPackages(path.join(tmp, 'integrations'), m);
    const file = path.join(tmp, 'freecad.ccadapter');
    await fs.writeFile(file, packAdapter({ dir: path.resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'freecad-adapter') }).bytes);
    await pk.install(file, { permissions: ['read-info', 'execute-scripts', 'write-files'], allowUnsigned: true });
    const found = (await m.scan()).apps.find((a) => a.adapterId === 'freecad');
    if (found) key = found.key;
  });
  afterAll(async () => {
    await m.shutdown();
    if (process.env.CS_LIVE_KEEP) console.log('kept: ' + path.join(tmp, 'work', 'freecad'));
    else await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  const work = () => path.join(tmp, 'work', 'freecad');

  it('finds a real FreeCAD and connects', async (t) => {
    if (!key) t.skip();
    const info = await m.connect(key);
    expect(['limited', 'connected']).toContain(info.status);
    expect(info.version).toMatch(/^1\.1\.\d+$/);
  });

  it('creates, inspects, edits, saves and exports a parametric model and verifies each result', async (t) => {
    if (!key) t.skip();
    expect((await m.execute(key, 'app.health')).ok).toBe(true);
    const created = await m.execute(key, 'doc.create', { name: 'LiveBracket', shape: 'plate_with_hole', length: 60, width: 40, height: 5, hole_diameter: 10 });
    expect(created.ok, created.message).toBe(true);
    expect(Number(created.data?.volume_mm3)).toBeCloseTo(60 * 40 * 5 - Math.PI * 25 * 5, 1);
    const inspected = await m.execute(key, 'doc.inspect', { document: 'LiveBracket.FCStd' });
    expect(inspected.ok, inspected.message).toBe(true);
    const changed = await m.execute(key, 'param.set', { document: 'LiveBracket.FCStd', name: 'length', value: 80, output: 'LiveBracket long' });
    expect(changed.ok, changed.message).toBe(true);
    expect(Number(changed.data?.volume_after_mm3)).toBeCloseTo(80 * 40 * 5 - Math.PI * 25 * 5, 1);
    const added = await m.execute(key, 'geometry.add', { document: 'LiveBracket long.FCStd', shape: 'cylinder', label: 'Boss', radius: 6, height: 12, x: 10, y: 10, z: 5, output: 'LiveBracket boss' });
    expect(added.ok, added.message).toBe(true);
    const step = await m.execute(key, 'export.step', { document: 'LiveBracket boss.FCStd' }, { background: false });
    expect(step.ok, step.message).toBe(true);
    const stl = await m.execute(key, 'export.stl', { document: 'LiveBracket boss.FCStd', tolerance_mm: 0.1 }, { background: false });
    expect(stl.ok, stl.message).toBe(true);
    for (const f of ['LiveBracket.FCStd', 'LiveBracket long.FCStd', 'LiveBracket boss.FCStd', 'LiveBracket boss.step', 'LiveBracket boss.stl']) {
      expect((await fs.stat(path.join(work(), f))).size, f).toBeGreaterThan(100);
    }
    // A real .FCStd is a zip that contains Document.xml.
    const head = await fs.readFile(path.join(work(), 'LiveBracket.FCStd'));
    expect(head.subarray(0, 2).toString()).toBe('PK');
    expect(head.includes(Buffer.from('Document.xml'))).toBe(true);
  });

  it('edits properties, adds every primitive, and reports real FreeCAD errors accurately', async (t) => {
    if (!key) t.skip();
    await m.execute(key, 'doc.create', { name: 'LiveEdit', shape: 'box', length: 20, width: 20, height: 20 });
    const sphere = await m.execute(key, 'geometry.add', { document: 'LiveEdit.FCStd', shape: 'sphere', label: 'Ball', radius: 5, output: 'LiveEdit s' });
    expect(sphere.ok, sphere.message).toBe(true);
    const cone = await m.execute(key, 'geometry.add', { document: 'LiveEdit s.FCStd', shape: 'cone', label: 'Tip', radius: 6, radius2: 2, height: 9, x: 30, output: 'LiveEdit sc' });
    expect(cone.ok, JSON.stringify(cone)).toBe(true);
    expect(Number(cone.data?.volume_mm3)).toBeCloseTo(Math.PI * 9 * (36 + 12 + 4) / 3, 1);
    const prop = await m.execute(key, 'object.set_property', { document: 'LiveEdit sc.FCStd', object: String(sphere.data?.object), property: 'Radius', value: '8', output: 'LiveEdit big' });
    expect(prop.ok, prop.message).toBe(true);
    expect(Number(prop.data?.volume_after_mm3)).toBeCloseTo(4 / 3 * Math.PI * 512, 1);
    const moved = await m.execute(key, 'object.set_property', { document: 'LiveEdit big.FCStd', object: 'Cone', property: 'Placement.Base.z', value: '15', output: 'LiveEdit moved' });
    expect(moved.ok, moved.message).toBe(true);
    const driven = await m.execute(key, 'object.set_property', { document: 'LiveEdit.FCStd', object: 'Box', property: 'Length', value: '30' });
    expect(driven.error?.message).toMatch(/param\.set/);
    expect((await m.execute(key, 'doc.inspect', { document: 'Missing.FCStd' })).error?.kind).toBe('invalid-params');
    const dup = await m.execute(key, 'doc.save_as', { document: 'LiveEdit.FCStd', output: 'LiveEdit' });
    expect(dup.error?.message).toMatch(/already exists/);
    const copy = await m.execute(key, 'doc.save_as', { document: 'LiveEdit moved.FCStd', output: 'LiveEdit copy' });
    expect(copy.ok, copy.message).toBe(true);
    expect((await fs.readdir(work())).filter((n) => n.startsWith('_cc_tmp'))).toEqual([]);
  });
});

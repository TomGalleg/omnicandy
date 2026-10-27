// LIVE test against a running Fusion with a document open and Preferences > General > API > "Fusion MCP Server" on.
// Read-only tests run whenever the server answers. Tests that change the open document (create a body, set a parameter,
// export, undo) run only with OMNICANDY_FUSION_LIVE_WRITE=1: they touch whatever document happens to be open, so they
// are opt-in. Everything they create lives in a new, separate component and is left for the user to discard or keep;
// nothing is saved to disk inside Fusion itself (document.save is never called here).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationManager } from './index';
import { FUSION_DEFAULT_ENDPOINT, fusionFactory } from './adapters/fusion';

const endpoint = process.env.OMNICANDY_FUSION_MCP_URL || FUSION_DEFAULT_ENDPOINT;
const exe = process.env.OMNICANDY_FUSION_EXE || '';
const writeOk = process.env.OMNICANDY_FUSION_LIVE_WRITE === '1';
const up = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const haveExe = exe ? await fs.stat(exe).then(() => true, () => false) : false;

describe.skipIf(!up || !haveExe)('Fusion adapter against the live program', { timeout: 120_000 }, () => {
  let tmp: string;
  beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-fusion-live-')); });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  async function manager() {
    const m = new IntegrationManager({
      workDir: async (id) => { const d = path.join(tmp, id); await fs.mkdir(d, { recursive: true }); return d; },
      permissions: { load: async () => ({}), save: async () => undefined },
      approve: async () => 'always',
      discovery: { env: { ProgramFiles: 'C:\\x' }, exists: async (p) => p.toLowerCase() === exe.toLowerCase(), listDir: async () => [], run: async () => '' },
      userPaths: async () => [exe],
    });
    m.register(fusionFactory, { builtin: true });
    const scan = await m.scan();
    const key = scan.apps[0]!.key;
    await m.connect(key);
    return { m, key };
  }

  it('detects Fusion, reports licensing and open documents', async () => {
    const { m, key } = await manager();
    const info = await m.execute(key, 'app.info');
    expect(info.error).toBeUndefined();
    expect(info.verified).toBe(true);
    expect(info.data?.licensing).toBeDefined();
    expect(Array.isArray(info.data?.openDocuments)).toBe(true);
  });

  it('reads the active design through the enforced read-only script', async () => {
    const { m, key } = await manager();
    const r = await m.execute(key, 'document.inspect');
    expect(r.error).toBeUndefined();
    expect(r.verified).toBe(true);
    expect(typeof r.data?.document === 'string' || r.data?.document === null).toBe(true);
    expect(Array.isArray(r.data?.components)).toBe(true);
  });

  it('searches the live Fusion API reference for a real class', async () => {
    const { m, key } = await manager();
    const r = await m.execute(key, 'api.search', { search_pattern: '^ExtrudeFeature$', category: 'class' });
    expect(r.error).toBeUndefined();
    expect((r.data?.classes as Array<{ name: string }>).some((c) => c.name === 'ExtrudeFeature')).toBe(true);
  });

  it('captures a verified viewport screenshot', async () => {
    const { m, key } = await manager();
    const r = await m.execute(key, 'viewport.capture', { file_name: 'live-probe', direction: 'iso-top-right', width: 320, height: 240 });
    expect(r.error).toBeUndefined();
    expect(r.verified).toBe(true);
    expect(r.outputs[0]!.bytes).toBeGreaterThan(0);
  });

  it.skipIf(!writeOk)('creates a verified box, cylinder and sphere, exports STEP and STL, reports a missing parameter honestly, and undoes', async () => {
    const { m, key } = await manager();

    const missing = await m.execute(key, 'parameter.set', { name: 'omnicandy_live_test_no_such_param', expression: '1' });
    expect(missing.ok).toBe(false);
    expect(missing.error?.message).toMatch(/No user parameter/);

    const box = await m.execute(key, 'component.create_primitive', { kind: 'box', name: 'OmniCandyLiveBox', width: 2, depth: 3, height: 4 });
    expect(box.error, JSON.stringify(box.error)).toBeUndefined();
    expect(box.data?.volume).toBeCloseTo(24, 2);

    const cyl = await m.execute(key, 'component.create_primitive', { kind: 'cylinder', name: 'OmniCandyLiveCylinder', radius: 2, height: 5 });
    expect(cyl.error, JSON.stringify(cyl.error)).toBeUndefined();
    expect(cyl.data?.volume as number).toBeCloseTo(Math.PI * 4 * 5, 1);

    const sphere = await m.execute(key, 'component.create_primitive', { kind: 'sphere', name: 'OmniCandyLiveSphere', radius: 3 });
    expect(sphere.error, JSON.stringify(sphere.error)).toBeUndefined();
    expect(sphere.data?.volume as number).toBeCloseTo((4 / 3) * Math.PI * 27, 0);

    const step = await m.execute(key, 'export.step', { file_name: 'live-export' });
    expect(step.error, JSON.stringify(step.error)).toBeUndefined();
    expect(step.outputs[0]!.bytes).toBeGreaterThan(0);

    const stl = await m.execute(key, 'export.stl', { file_name: 'live-export' });
    expect(stl.error, JSON.stringify(stl.error)).toBeUndefined();
    expect(stl.outputs[0]!.bytes).toBeGreaterThan(0);

    for (let i = 0; i < 3; i++) await m.execute(key, 'edit.undo');
  });
});

// FreeCAD installable adapter (fixtures/freecad-adapter) driven through the REAL package store, the REAL
// restricted child process and the REAL integration manager.
//
// !! FreeCAD is NOT installed on the machine that ran these tests. The program is replaced by a clearly marked
// !! TEST DOUBLE (fixtures/freecad-mock): a tiny FreeCADCmd.exe launcher plus a Python imitation of the parts of the
// !! FreeCAD API the adapter uses. So these tests prove the package, its security behaviour, its argument checking,
// !! its job script's logic and the way it talks to a FreeCADCmd-shaped program. They do NOT prove that the Python in
// !! freecad_job.py works against real FreeCAD. That is freecad.live.test.ts (CS_LIVE_TESTS=1, needs FreeCAD).
import { execFile, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalAnswer, ApprovalRequest, Permission } from '@shared/integrations';
import { packAdapter } from '../../../scripts/pack-adapter.mjs';
import type { DiscoveryEnv } from './discovery';
import { AdapterPackages, createIntegrationManager, type IntegrationManager } from './index';

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const root = path.resolve(import.meta.dirname, '..', '..', '..');
const SRC = path.join(root, 'fixtures', 'freecad-adapter');
const MOCK = path.join(root, 'fixtures', 'freecad-mock');

let python: string | null = null;
try { python = execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8', timeout: 20000 }).trim() || null; } catch { python = null; }
const canRun = process.platform === 'win32' && !!python;

let tmp: string;
let exe: string;
const rigs: IntegrationManager[] = [];
const pem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KEY = pem();
let signedPkg: string;
let unsignedPkg: string;

beforeAll(async () => {
  if (!canRun) return;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-freecad-'));
  const mockDir = path.join(tmp, 'FreeCAD 1.0 (MOCK)', 'bin');
  await fs.mkdir(mockDir, { recursive: true });
  await fs.cp(path.join(MOCK, 'pylib'), path.join(mockDir, 'pylib'), { recursive: true });
  const cs = (await fs.readFile(path.join(MOCK, 'FreeCADCmd.cs'), 'utf8')).replace('__PYTHON__', python!);
  const csFile = path.join(tmp, 'FreeCADCmd.cs');
  await fs.writeFile(csFile, cs);
  exe = path.join(mockDir, 'FreeCADCmd.exe');
  execFileSync(CSC, ['-nologo', `-out:${exe}`, csFile], { timeout: 60000 });
  signedPkg = path.join(tmp, 'freecad-signed.ccadapter');
  await fs.writeFile(signedPkg, packAdapter({ dir: SRC, privateKeyPem: KEY }).bytes);
  unsignedPkg = path.join(tmp, 'freecad-unsigned.ccadapter');
  await fs.writeFile(unsignedPkg, packAdapter({ dir: SRC }).bytes);
}, 120_000);

afterAll(async () => {
  await Promise.all(rigs.map((m) => m.shutdown().catch(() => undefined)));
  if (tmp) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
});

function fakeDiscovery(): DiscoveryEnv {
  return { env: { PATH: '' }, run: async () => '', exists: (p) => fs.stat(p).then(() => true, () => false), listDir: async () => [] };
}

interface Rig { mgr: IntegrationManager; pk: AdapterPackages; asked: ApprovalRequest[]; answer: { value: ApprovalAnswer }; work: string; root: string; userPaths: string[] }
async function rig(): Promise<Rig> {
  const rt = await fs.mkdtemp(path.join(tmp, 'root-'));
  const work = path.join(rt, 'work');
  const asked: ApprovalRequest[] = [];
  const answer = { value: 'once' as ApprovalAnswer };
  const stored: Record<string, Permission[]> = {};
  const userPaths = [exe];
  const mgr = createIntegrationManager({
    workDir: async (id) => path.join(work, id),
    permissions: { load: async () => ({ ...stored }), save: async (g) => { Object.assign(stored, g); } },
    approve: async (r) => { asked.push(r); return answer.value; },
    discovery: fakeDiscovery(),
    userPaths: async () => userPaths,
  });
  rigs.push(mgr);
  return { mgr, pk: new AdapterPackages(path.join(rt, 'integrations'), mgr), asked, answer, work, root: rt, userPaths };
}

async function install(r: Rig, perms: Permission[] = ['read-info', 'execute-scripts', 'write-files'], file = signedPkg) {
  const review = await r.pk.review(file);
  expect(review.problems).toEqual([]);
  await r.pk.install(file, { permissions: perms.filter((p) => review.permissions.includes(p)), trustPublisher: true, allowUnsigned: file === unsignedPkg });
  const scan = await r.mgr.scan();
  const app = scan.apps.find((a) => a.adapterId === 'freecad');
  if (!app) throw new Error(`FreeCAD adapter not found: ${JSON.stringify(scan.apps.map((a) => [a.adapterId, a.exePath]))}`);
  return app;
}

const wd = (r: Rig) => path.join(r.work, 'freecad');
const sha = async (p: string) => createHash('sha256').update(await fs.readFile(p)).digest('hex');
async function waitJob(r: Rig, id: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const j = r.mgr.job(id); if (j && j.status !== 'running') return j; await new Promise((res) => setTimeout(res, 60)); }
  throw new Error('job did not finish');
}

describe.skipIf(!canRun)('FreeCAD package (against a clearly marked FreeCAD TEST DOUBLE)', () => {
  it('is a valid, signed package whose manifest matches the SDK and replaces the placeholder', async () => {
    const r = await rig();
    expect(r.mgr.factory('freecad')?.manifest.maturity).toBe('stub');
    const review = await r.pk.review(signedPkg);
    expect(review.problems).toEqual([]);
    expect(review.signature).toBe('valid');
    expect(review.permissions.sort()).toEqual(['execute-scripts', 'read-info', 'write-files']);
    await install(r);
    const f = r.mgr.factory('freecad')!;
    expect(f.manifest.source).toBe('package');
    expect(f.manifest.trust).toBe('trusted-publisher');
    expect(f.manifest.commands.map((c) => c.id)).toEqual(['app.health', 'doc.create', 'doc.inspect', 'geometry.add', 'object.set_property', 'param.set', 'doc.save_as', 'export.step', 'export.stl']);
    expect(f.manifest.commands.every((c) => !c.destructive)).toBe(true);
    expect(f.manifest.commands.filter((c) => c.longRunning).map((c) => c.id)).toEqual(['export.step', 'export.stl']);
    await r.pk.uninstall('freecad');
    expect(r.mgr.factory('freecad')?.manifest.maturity).toBe('stub'); // the placeholder is back
  }, 60_000);

  it('detects the program, reads its version and connects (limited = experimental package)', async () => {
    const r = await rig();
    const app = await install(r);
    expect(app.version).toBe('1.0.2');
    expect(app.status).toBe('available');
    const info = await r.mgr.connect(app.key);
    expect(info.status).toBe('limited');
    expect(info.origin).toBe('package');
  }, 60_000);

  it('refuses a FreeCAD that is too old and says why', async () => {
    const r = await rig();
    const dir = path.dirname(exe);
    await fs.writeFile(path.join(dir, 'mockversion.txt'), '0.19.4');
    try {
      const app = await install(r);
      expect(app.status).toBe('incompatible');
      expect(app.statusDetail).toMatch(/0\.19\.4.*older/);
      await expect(r.mgr.connect(app.key)).rejects.toThrow(/older/);
    } finally { await fs.rm(path.join(dir, 'mockversion.txt'), { force: true }); }
  }, 60_000);

  it('health check, create parametric model, inspect, change a parameter, add geometry, edit a property, save a copy', async () => {
    const r = await rig();
    const app = await install(r);
    const k = app.key;

    const health = await r.mgr.execute(k, 'app.health');
    expect(health.ok, health.message).toBe(true);
    expect(health.verified).toBe(true);
    expect(health.message).toMatch(/1000 mm3/);

    const created = await r.mgr.execute(k, 'doc.create', { name: 'Bracket', shape: 'plate_with_hole', length: 60, width: 40, height: 5, hole_diameter: 10 });
    expect(created.ok, created.message).toBe(true);
    expect(created.verified).toBe(true);
    const first = path.join(wd(r), 'Bracket.FCStd');
    expect(created.outputs.map((o) => o.path)).toEqual([first]);
    const expected = 60 * 40 * 5 - Math.PI * 25 * 5;
    expect(Number(created.data?.volume_mm3)).toBeCloseTo(expected, 2);
    expect(created.data?.parameters).toEqual({ length: 60, width: 40, height: 5, hole_diameter: 10 });
    expect(created.evidence.join(' ')).toMatch(/reopened Bracket\.FCStd/);
    const originalHash = await sha(first);

    const inspected = await r.mgr.execute(k, 'doc.inspect', { document: 'Bracket.FCStd' });
    expect(inspected.ok, inspected.message).toBe(true);
    const objs = inspected.data?.objects as Array<{ name: string; expressions?: unknown[] }>;
    expect(objs.map((o) => o.name).sort()).toEqual(['Hole', 'Params', 'Plate', 'PlateWithHole']);
    expect(objs.find((o) => o.name === 'Plate')?.expressions?.length).toBe(3);

    // A property that a parameter drives must be changed through the parameter (honest error, no silent override).
    const driven = await r.mgr.execute(k, 'object.set_property', { document: 'Bracket.FCStd', object: 'Plate', property: 'Length', value: '70' });
    expect(driven.ok).toBe(false);
    expect(driven.error?.kind).toBe('invalid-params');
    expect(driven.error?.message).toMatch(/param\.set/);

    const widened = await r.mgr.execute(k, 'param.set', { document: 'Bracket.FCStd', name: 'length', value: 80, output: 'Bracket long' });
    expect(widened.ok, widened.message).toBe(true);
    expect(Number(widened.data?.volume_after_mm3)).toBeCloseTo(80 * 40 * 5 - Math.PI * 25 * 5, 2);
    expect(Number(widened.data?.volume_before_mm3)).toBeCloseTo(expected, 2);

    const added = await r.mgr.execute(k, 'geometry.add', { document: 'Bracket long.FCStd', shape: 'cylinder', label: 'Boss', radius: 6, height: 12, x: 10, y: 10, z: 5, output: 'Bracket boss' });
    expect(added.ok, added.message).toBe(true);
    expect(Number(added.data?.volume_mm3)).toBeCloseTo(Math.PI * 36 * 12, 2);
    expect(added.data?.object_count).toBe(5);

    const edited = await r.mgr.execute(k, 'object.set_property', { document: 'Bracket boss.FCStd', object: 'Cylinder', property: 'Radius', value: '8', output: 'Bracket boss wide' });
    expect(edited.ok, edited.message).toBe(true);
    expect(Number(edited.data?.volume_after_mm3)).toBeCloseTo(Math.PI * 64 * 12, 2);

    const copy = await r.mgr.execute(k, 'doc.save_as', { document: 'Bracket boss wide.FCStd', output: 'Final' });
    expect(copy.ok, copy.message).toBe(true);
    expect(copy.outputs[0]!.bytes).toBeGreaterThan(100);

    // Nothing earlier was touched: every edit made a new file.
    expect(await sha(first)).toBe(originalHash);
    expect((await fs.readdir(wd(r))).filter((n) => n.endsWith('.FCStd')).sort()).toEqual(['Bracket boss wide.FCStd', 'Bracket boss.FCStd', 'Bracket long.FCStd', 'Bracket.FCStd', 'Final.FCStd']);
  }, 120_000);

  it('exports STEP and STL, verified by reading them back, as foreground runs and as jobs', async () => {
    const r = await rig();
    const app = await install(r);
    const k = app.key;
    await r.mgr.execute(k, 'doc.create', { name: 'Cyl', shape: 'cylinder', radius: 10, height: 20 });
    const vol = Math.PI * 100 * 20;

    const step = await r.mgr.execute(k, 'export.step', { document: 'Cyl.FCStd' }, { background: false });
    expect(step.ok, step.message).toBe(true);
    expect(step.verified).toBe(true);
    expect(step.outputs[0]!.path).toBe(path.join(wd(r), 'Cyl.step'));
    expect(Number(step.data?.volume_mm3)).toBeCloseTo(vol, 2);
    expect(step.evidence.join(' ')).toMatch(/STEP header present/);

    const start = await r.mgr.execute(k, 'export.stl', { document: 'Cyl.FCStd', tolerance_mm: 0.05 });
    expect(start.data?.status).toBe('running'); // long-running commands return a job handle
    const job = await waitJob(r, String(start.data?.jobId));
    expect(job.status).toBe('succeeded');
    expect(job.result?.verified).toBe(true);
    expect(Number(job.result?.data?.triangles)).toBeGreaterThan(3);
    expect((await fs.stat(path.join(wd(r), 'Cyl.stl'))).size).toBeGreaterThan(80);
    expect(job.stage).toBeTruthy();
    // Existing files are never overwritten.
    const again = await r.mgr.execute(k, 'export.step', { document: 'Cyl.FCStd' }, { background: false });
    expect(again.ok).toBe(false);
    expect(again.error?.message).toMatch(/already exists/);
  }, 120_000);

  it('cancels a running export, leaves no half-written file and stays usable', async () => {
    const r = await rig();
    const app = await install(r);
    const k = app.key;
    await r.mgr.execute(k, 'doc.create', { name: 'Slow', shape: 'box' });
    await fs.writeFile(path.join(wd(r), 'mock_delay.txt'), '40'); // test-double switch: the export "takes" 40 s
    const start = await r.mgr.execute(k, 'export.step', { document: 'Slow.FCStd' });
    const id = String(start.data?.jobId);
    await new Promise((res) => setTimeout(res, 1500));
    expect(r.mgr.job(id)?.status).toBe('running');
    const t0 = Date.now();
    expect(r.mgr.cancelJob(id)).toBe(true);
    const job = await waitJob(r, id, 15_000);
    expect(job.status).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(10_000);
    const names = await fs.readdir(wd(r));
    expect(names.filter((n) => n.endsWith('.step') || n.startsWith('_cc_tmp'))).toEqual([]);
    await fs.rm(path.join(wd(r), 'mock_delay.txt'));
    const ok = await r.mgr.execute(k, 'export.step', { document: 'Slow.FCStd' }, { background: false });
    expect(ok.ok, ok.message).toBe(true);
  }, 90_000);

  it('reports errors accurately: crash of FreeCAD, bad names, missing files, impossible geometry, missing program', async () => {
    const r = await rig();
    const app = await install(r);
    const k = app.key;
    await r.mgr.execute(k, 'doc.create', { name: 'Err', shape: 'box' });

    const noDoc = await r.mgr.execute(k, 'doc.inspect', { document: 'Nope.FCStd' });
    expect(noDoc.error?.kind).toBe('invalid-params');
    expect(noDoc.error?.message).toMatch(/No document "Nope\.FCStd"/);

    const hole = await r.mgr.execute(k, 'doc.create', { name: 'Bad', shape: 'plate_with_hole', length: 20, width: 20, height: 3, hole_diameter: 25 });
    expect(hole.error?.kind).toBe('invalid-params');
    expect(hole.error?.message).toMatch(/hole_diameter/);
    expect((await fs.readdir(wd(r))).some((n) => n.startsWith('Bad'))).toBe(false);

    const prop = await r.mgr.execute(k, 'object.set_property', { document: 'Err.FCStd', object: 'Box', property: 'Color', value: '1' });
    expect(prop.error?.kind).toBe('unsupported');
    expect(prop.error?.message).toMatch(/Supported: Length/);
    const noObj = await r.mgr.execute(k, 'object.set_property', { document: 'Err.FCStd', object: 'Ghost', property: 'Length', value: '1' });
    expect(noObj.error?.message).toMatch(/no object "Ghost"/);
    const badParam = await r.mgr.execute(k, 'param.set', { document: 'Err.FCStd', name: 'depth', value: 5 });
    expect(badParam.error?.message).toMatch(/Known: height, length, width/);
    const range = await r.mgr.execute(k, 'doc.create', { name: 'Huge', length: 1e9 });
    expect(range.error?.kind).toBe('invalid-params'); // stopped by the manager before the adapter

    // FreeCAD itself dying mid-job (test double: mock_crash.txt) is reported, not hidden.
    await fs.writeFile(path.join(wd(r), 'mock_crash.txt'), '1');
    const crash = await r.mgr.execute(k, 'export.step', { document: 'Err.FCStd' }, { background: false });
    expect(crash.ok).toBe(false);
    expect(crash.error?.message).toMatch(/did not report a result \(exit 3\)/);
    await fs.rm(path.join(wd(r), 'mock_crash.txt'));
    expect((await r.mgr.execute(k, 'doc.inspect', { document: 'Err.FCStd' })).ok).toBe(true);

    // The program disappearing after it was found (an uninstall, an unplugged drive) is a clear "missing-app".
    const r2 = await rig();
    const copyDir = path.join(r2.root, 'bin');
    await fs.cp(path.dirname(exe), copyDir, { recursive: true });
    r2.userPaths.length = 0;
    r2.userPaths.push(path.join(copyDir, 'FreeCADCmd.exe'));
    const app2 = await install(r2);
    await fs.rm(copyDir, { recursive: true, force: true });
    const gone = await r2.mgr.execute(app2.key, 'app.health');
    expect(gone.error?.kind).toBe('missing-app');
  }, 120_000);

  it('confines every file to the project work folder (traversal, absolute and unusual names are refused)', async () => {
    const r = await rig();
    const app = await install(r);
    const k = app.key;
    await r.mgr.execute(k, 'doc.create', { name: 'Safe', shape: 'box' });
    const evil = ['..\\Safe.FCStd', '../Safe.FCStd', 'sub/Safe.FCStd', 'C:\\Windows\\x.FCStd', '\\\\server\\share\\x.FCStd', 'Safe.FCStd.exe', 'Safe.step', '.FCStd', 'a..b.FCStd'];
    for (const name of evil) {
      const res = await r.mgr.execute(k, 'doc.inspect', { document: name });
      expect(res.ok, name).toBe(false);
      expect(res.error?.kind, name).toBe('invalid-params');
    }
    for (const out of ['..\\x', '../x', 'a/b', 'C:\\x', 'x.exe\0', 'x:y']) {
      const res = await r.mgr.execute(k, 'doc.save_as', { document: 'Safe.FCStd', output: out });
      expect(res.ok, out).toBe(false);
      expect(res.error?.kind, out).toBe('invalid-params');
    }
    const outside = path.join(r.root, 'x.FCStd');
    expect(await fs.stat(outside).then(() => true, () => false)).toBe(false);
  }, 60_000);

  it('the job script refuses unsafe paths by itself, even if main.js were bypassed', async () => {
    const body = await fs.readFile(path.join(SRC, 'freecad_job.py'), 'utf8');
    const cwd = await fs.mkdtemp(path.join(tmp, 'job-'));
    await fs.writeFile(path.join(tmp, 'secret.FCStd'), 'x');
    const run = async (command: string, params: Record<string, unknown>) => {
      const head = `import base64 as _b, json as _j\nCOMMAND = ${JSON.stringify(command)}\nPARAMS = _j.loads(_b.b64decode("${Buffer.from(JSON.stringify(params)).toString('base64')}").decode("utf-8"))\n`;
      const file = path.join(cwd, '_cc_job.py');
      await fs.writeFile(file, head + body);
      const out = await new Promise<string>((res) => execFile(python!, [file], { cwd, env: { PYTHONPATH: path.join(path.dirname(exe), 'pylib'), SystemRoot: process.env.SystemRoot } }, (_e, so) => res(String(so))));
      return JSON.parse(/CREATECRAFT_RESULT (\{.*\})/.exec(out)![1]!) as { ok: boolean; kind?: string; error?: string };
    };
    for (const name of ['..\\secret.FCStd', '../secret.FCStd', 'C:\\x.FCStd', 'a/b.FCStd', 'secret.FCStd\0']) {
      const res = await run('doc.inspect', { document: name });
      expect(res.ok, name).toBe(false);
      expect(res.kind, name).toBe('invalid-params');
    }
    const res = await run('doc.create', { name: '..\\evil', shape: 'box', length: 1, width: 1, height: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/letters, digits/);
    // Parameters are data: a hostile value cannot become code.
    const hostile = await run('doc.create', { name: 'Ok', shape: "box'); import os; os.system('echo pwned') #", length: 1, width: 1, height: 1 });
    expect(hostile.ok).toBe(false);
    expect(hostile.kind).toBe('invalid-params');
    expect(await fs.readdir(cwd)).toEqual(['_cc_job.py']);
  }, 60_000);

  it('enforces the approved permission ceiling and the per-run approval', async () => {
    const r = await rig();
    const app = await install(r, ['read-info', 'write-files']); // execute-scripts NOT approved
    const denied = await r.mgr.execute(app.key, 'doc.create', { name: 'Nope' });
    expect(denied.ok).toBe(false);
    expect(denied.error?.kind).toBe('permission-denied');
    expect(denied.error?.message).toMatch(/not allowed to use: run scripts/i);
    expect(await fs.stat(path.join(wd(r), 'Nope.FCStd')).then(() => true, () => false)).toBe(false);

    const r2 = await rig();
    const app2 = await install(r2);
    r2.answer.value = 'deny';
    const refused = await r2.mgr.execute(app2.key, 'doc.create', { name: 'No' });
    expect(refused.error?.kind).toBe('permission-denied');
    expect(r2.asked.at(-1)?.needed.sort()).toEqual(['execute-scripts', 'write-files']);
    expect(await fs.stat(path.join(wd(r2), 'No.FCStd')).then(() => true, () => false)).toBe(false);
  }, 60_000);

  it('an unsigned build is asked about every time and runs no code on a scan', async () => {
    const r = await rig();
    const app = await install(r, ['read-info', 'execute-scripts', 'write-files'], unsignedPkg);
    expect(app.trust).toBe('unsigned');
    r.answer.value = 'always';
    await r.mgr.execute(app.key, 'doc.create', { name: 'U1' });
    await r.mgr.execute(app.key, 'doc.create', { name: 'U2' });
    expect(r.asked.filter((a) => a.command.id === 'doc.create').length).toBe(2);
    expect(r.asked.every((a) => a.untrusted)).toBe(true);
  }, 60_000);

  it('turns itself off when its job script is edited after install, and Repair restores it', async () => {
    const r = await rig();
    await install(r);
    const st = r.pk.store;
    const dir = await fs.readdir(path.join(r.root, 'integrations', 'adapters', 'freecad'));
    const ver = dir.find((n) => /^\d/.test(n))!;
    const script = path.join(r.root, 'integrations', 'adapters', 'freecad', ver, 'freecad_job.py');
    await fs.appendFile(script, '\nimport os; os.system("calc")\n');
    const v = await st.verify('freecad');
    expect(v.install).toBeFalsy();
    expect(v.detail).toMatch(/freecad_job\.py/);
    const fixed = await r.pk.repair('freecad');
    expect(fixed.state).toBe('ok');
    expect(await fs.readFile(script, 'utf8')).not.toMatch(/calc/);
  }, 60_000);

  it('uninstall removes the commands again and leaves project files in place', async () => {
    const r = await rig();
    const app = await install(r);
    await r.mgr.execute(app.key, 'doc.create', { name: 'Keep' });
    await r.pk.uninstall('freecad');
    expect(r.mgr.factory('freecad')?.manifest.commands).toEqual([]);
    expect(await fs.stat(path.join(wd(r), 'Keep.FCStd')).then(() => true, () => false)).toBe(true);
  }, 60_000);
});

describe('FreeCAD test double availability', () => {
  it.skipIf(canRun)('is skipped when Windows or Python is not available', () => {
    expect(canRun).toBe(false);
  });
});

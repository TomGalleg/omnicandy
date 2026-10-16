// End to end with REAL parts: package install through the Universal Installation Manager, a real child process playing the
// SIMULATED application SimCAD that loads the installed plugin, the authenticated pipe, the restricted adapter process and
// the integration manager. Covers external-only, internal-only and hybrid packages through the same API.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalAnswer, ApprovalRequest, Permission } from '@shared/integrations';
import { packAdapter } from '../../../scripts/pack-adapter.mjs';
import type { DiscoveryEnv } from './discovery';
import { AdapterPackages, createIntegrationManager, type IntegrationManager } from './index';

const FIX = path.resolve(__dirname, '../../../fixtures');
let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-hyb-')); });
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const toStop: Array<() => Promise<void>> = [];
afterEach(async () => { for (const s of toStop.splice(0).reverse()) { await Promise.race([s().catch(() => undefined), sleep(15_000)]); } }, 40_000);
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); });

const fakeDiscovery = (): DiscoveryEnv => ({ env: { PATH: '' }, run: async () => '', exists: (p) => fs.stat(p).then(() => true, () => false), listDir: async () => [] });

async function pack(fixture: string, over: { version?: string } = {}) {
  let dir = path.join(FIX, fixture);
  if (over.version) {
    const d2 = await fs.mkdtemp(path.join(tmp, 'pk-'));
    await fs.cp(dir, d2, { recursive: true });
    const m = JSON.parse(await fs.readFile(path.join(d2, 'adapter.json'), 'utf8')) as { version: string; integration?: { plugin?: { version: string } } };
    m.version = over.version;
    await fs.writeFile(path.join(d2, 'adapter.json'), JSON.stringify(m));
    dir = d2;
  }
  const packed = packAdapter({ dir });
  const file = path.join(tmp, `${fixture}-${Math.random().toString(36).slice(2, 7)}.ccadapter`);
  await fs.writeFile(file, packed.bytes);
  return file;
}

interface Rig { mgr: IntegrationManager; pk: AdapterPackages; root: string; sim: string; asked: ApprovalRequest[]; running: { value: boolean }; answer: { value: ApprovalAnswer } }
async function rig(): Promise<Rig> {
  const root = await fs.mkdtemp(path.join(tmp, 'rig-'));
  const asked: ApprovalRequest[] = [];
  const answer = { value: 'once' as ApprovalAnswer };
  const stored: Record<string, Permission[]> = {};
  const running = { value: false };
  const mgr = createIntegrationManager({
    workDir: async (id) => path.join(root, 'work', id),
    permissions: { load: async () => ({ ...stored }), save: async (g) => { Object.assign(stored, g); } },
    approve: async (r) => { asked.push(r); return answer.value; },
    discovery: fakeDiscovery(),
  });
  const sim = path.join(root, 'simcad');
  const pk = new AdapterPackages(path.join(root, 'integrations'), mgr, undefined, { installEnv: { vars: {}, simHostRoot: sim }, isRunning: async () => running.value });
  toStop.push(async () => { await mgr.shutdown(); await pk.shutdown(); });
  return { mgr, pk, root, sim, asked, running, answer };
}

interface Sim { proc: ChildProcess; stop(): Promise<void>; out: string }
async function startSim(r: Rig, edition = 'Pro'): Promise<Sim> {
  const proc = spawn(process.execPath, [path.join(FIX, 'simcad', 'simcad.js'), '--root', r.sim, '--edition', edition, '--version', '1.2'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const sim: Sim = { proc, out: '', stop: async () => { if (proc.exitCode === null && proc.signalCode === null) { proc.kill(); await new Promise((res) => proc.once('exit', res)); } } };
  proc.stdout!.on('data', (d: Buffer) => { sim.out += d.toString(); });
  proc.stderr!.on('data', (d: Buffer) => { sim.out += d.toString(); });
  await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error('SimCAD did not start: ' + sim.out)), 8000); const iv = setInterval(() => { if (sim.out.includes('SIMCAD READY')) { clearTimeout(t); clearInterval(iv); res(); } }, 20); });
  toStop.push(sim.stop);
  r.running.value = true;
  return sim;
}

const APPROVE = (perms: Permission[]) => ({ permissions: perms, allowUnsigned: true, installPlugin: true });
async function appKeyOf(r: Rig, adapterId: string): Promise<string> {
  const scan = await r.mgr.scan();
  const app = scan.apps.find((a) => a.adapterId === adapterId);
  if (!app) throw new Error('not listed: ' + JSON.stringify(scan.apps.map((a) => a.adapterId)));
  return app.key;
}


describe('hybrid integration: connector + add-in', () => {
  it('review shows the plan; install needs the add-in approval', async () => {
    const r = await rig();
    const file = await pack('hybrid-sample');
    const rev = await r.pk.review(file);
    expect(rev.problems).toEqual([]);
    expect(rev.integrationType).toBe('hybrid');
    expect(rev.integration!.simulated).toBe(true);
    expect(rev.integration!.steps.map((s) => s.kind)).toEqual(['close-host', 'adapter', 'plugin-files', 'restart-host', 'verify']);
    expect(rev.permissions).toEqual(['modify-project', 'read-project']);
    expect(rev.warnings.join()).toMatch(/SIMULATED/);
    await expect(r.pk.install(file, { permissions: rev.permissions, allowUnsigned: true })).rejects.toThrow(/not approved installing the add-in/);
    expect((await r.pk.listing()).installed).toEqual([]);
    expect(await fs.stat(path.join(r.sim, 'plugins')).catch(() => null)).toBeNull();
  });

  it('install, restart the program, connect, run a real command and verify the result, cancel a job, survive a restart, repair, uninstall', async () => {
    const r = await rig();
    const file = await pack('hybrid-sample');
    // SimCAD is open while we try to install: refused, nothing changed.
    r.running.value = true;
    await expect(r.pk.install(file, APPROVE(['read-project', 'modify-project']))).rejects.toThrow(/Close SimCAD/);
    expect(await fs.stat(path.join(r.sim, 'plugins')).catch(() => null)).toBeNull();
    r.running.value = false;

    // Clean install of both halves.
    const inst = await r.pk.install(file, APPROVE(['read-project', 'modify-project']));
    expect(inst.integrationType).toBe('hybrid');
    expect(inst.pluginState).toBe('restart-needed');
    expect((await fs.readdir(path.join(r.sim, 'plugins'))).sort()).toEqual(['cc-bridge.json', 'ccbridge-client.js', 'simcad-hybrid.plugin.js']);

    // Installed is NOT connected: the program has not loaded the add-in yet.
    const key = await appKeyOf(r, 'sample.simcad.hybrid');
    await expect(r.mgr.connect(key)).rejects.toThrow(/has to be open/);
    expect((await r.mgr.list()).find((a) => a.key === key)!.status).toBe('not-running');
    const notYet = await r.mgr.execute(key, 'simcad.describe');
    expect(notYet.ok).toBe(false);

    // Start the simulated program: it loads the add-in, which dials the authenticated pipe.
    const sim = await startSim(r);
    expect(sim.out).toMatch(/plugins=simcad-hybrid.plugin.js/);
    const session = await r.pk.bridge.waitForSession('simcad.bridge.hybrid', 8000);
    expect(session?.capabilities.sort()).toEqual(['scene.add_box', 'scene.describe', 'scene.reset', 'scene.slow_build']);
    const info = await r.mgr.connect(key);
    expect(['connected', 'limited']).toContain(info.status);
    const v = await r.mgr.verify(key);
    expect(v.ok).toBe(true);
    expect(v.detail).toMatch(/answered a real check from inside the program/);
    expect((await r.pk.listing()).installed[0]!.pluginState).toBe('connected');

    // A real command through the companion, verified by asking again.
    const add = await r.mgr.execute(key, 'simcad.add_box_verified', { name: 'Bracket', size: 2.5 });
    expect(add.ok).toBe(true);
    expect(add.verified).toBe(true);
    expect(add.message).toMatch(/confirmed it is in the scene/);
    expect(add.evidence.join()).toMatch(/describe lists/);
    const d = await r.mgr.execute(key, 'simcad.describe');
    expect((d.data as { count: number }).count).toBe(1);
    expect(r.asked.length).toBeGreaterThan(0); // the user is asked before the add-in changes anything

    // Invalid settings never reach the program.
    const bad = await r.mgr.execute(key, 'simcad.add_box_verified', { name: 'x', size: -5 });
    expect(bad.ok).toBe(false);
    expect(bad.error!.kind).toBe('invalid-params');
    const inj = await r.mgr.execute(key, 'simcad.add_box_verified', { name: '"; process.exit(1); //', size: 1 });
    expect(inj.ok).toBe(true); // treated as plain text
    expect(sim.proc.exitCode).toBeNull();

    // A long job: progress arrives and cancel really stops it.
    const job = await r.mgr.execute(key, 'simcad.slow_build', { steps: 300 });
    const jobId = (job.data as { jobId: string }).jobId;
    await sleep(500);
    expect(r.mgr.job(jobId)!.status).toBe('running');
    expect(r.mgr.job(jobId)!.stage).toMatch(/Built \d+ of 300/);
    r.mgr.cancelJob(jobId);
    for (let i = 0; i < 40 && r.mgr.job(jobId)!.status === 'running'; i++) await sleep(100);
    expect(r.mgr.job(jobId)!.status).toBe('cancelled');
    // ...and the program is still usable afterwards.
    expect((await r.mgr.execute(key, 'simcad.describe')).ok).toBe(true);

    // The program closes: the integration must stop saying Connected.
    await sim.stop();
    r.running.value = false;
    for (let i = 0; i < 40 && r.pk.bridge.session('simcad.bridge.hybrid'); i++) await sleep(100);
    const gone = await r.mgr.execute(key, 'simcad.describe');
    expect(gone.ok).toBe(false);
    expect((await r.mgr.verify(key)).ok).toBe(false);

    // Open it again (an application restart): the add-in reconnects by itself.
    await r.mgr.disconnect(key);
    await startSim(r);
    expect(await r.pk.bridge.waitForSession('simcad.bridge.hybrid', 8000)).toBeTruthy();
    const again = await r.mgr.execute(key, 'simcad.describe');
    expect(again.ok).toBe(true);
    expect((again.data as { count: number }).count).toBe(0); // the simulated program started with an empty scene

    // Damage the installation and repair it (the program must be closed first).
    await toStop[toStop.length - 1]!();
    r.running.value = false;
    await fs.writeFile(path.join(r.sim, 'plugins', 'simcad-hybrid.plugin.js'), '// broken');
    await fs.rm(path.join(r.sim, 'plugins', 'ccbridge-client.js'));
    expect((await r.pk.listing()).installed[0]!.pluginState).toBe('missing-files');
    const fixed = await r.pk.repair('sample.simcad.hybrid');
    expect(['installed', 'restart-needed', 'connected']).toContain(fixed.pluginState);
    expect(await fs.readFile(path.join(r.sim, 'plugins', 'simcad-hybrid.plugin.js'), 'utf8')).not.toBe('// broken');
    await startSim(r);
    expect(await r.pk.bridge.waitForSession('simcad.bridge.hybrid', 8000)).toBeTruthy();
    expect((await r.mgr.execute(key, 'simcad.describe')).ok).toBe(true);
    await toStop[toStop.length - 1]!();
    r.running.value = false;

    // Uninstall removes the add-in, the pairing secret and the connector; the (simulated) program folder is otherwise untouched.
    const rep = await r.pk.uninstall('sample.simcad.hybrid');
    expect(rep.kept).toEqual([]);
    expect(await fs.readdir(path.join(r.sim, 'plugins')).catch(() => [])).toEqual([]);
    expect(await fs.readdir(path.join(r.root, 'integrations', 'bridge', 'pairing')).catch(() => [])).toEqual([]);
    expect((await r.pk.listing()).installed).toEqual([]);
    expect((await r.mgr.scan()).apps.some((a) => a.adapterId === 'sample.simcad.hybrid')).toBe(false);
  }, 90_000);

  it('a program started with the old add-in secret removed cannot connect (uninstalled add-in is refused)', async () => {
    const r = await rig();
    const file = await pack('hybrid-sample');
    await r.pk.install(file, APPROVE(['read-project', 'modify-project']));
    const cfg = path.join(r.sim, 'plugins', 'cc-bridge.json');
    const saved = await fs.readFile(cfg, 'utf8');
    await r.pk.uninstall('sample.simcad.hybrid');
    // Someone puts the stolen plugin files back by hand.
    await fs.mkdir(path.join(r.sim, 'plugins'), { recursive: true });
    for (const f of ['ccbridge-client.js']) await fs.copyFile(path.join(FIX, 'hybrid-sample', 'plugin', f), path.join(r.sim, 'plugins', f));
    await fs.copyFile(path.join(FIX, 'hybrid-sample', 'plugin', 'simcad-bridge.plugin.js'), path.join(r.sim, 'plugins', 'simcad-hybrid.plugin.js'));
    await fs.writeFile(cfg, saved);
    await r.pk.bridge.start();
    await startSim(r);
    await sleep(1200);
    expect(r.pk.bridge.session('simcad.bridge.hybrid')).toBeNull();
  }, 30_000);

  it('a failure after the add-in was copied takes the add-in out again (no half installs)', async () => {
    const r = await rig();
    const file = await pack('hybrid-sample');
    const orig = r.pk.store.install.bind(r.pk.store);
    r.pk.store.install = async () => { throw new Error('disk full (simulated)'); };
    await expect(r.pk.install(file, APPROVE(['read-project', 'modify-project']))).rejects.toThrow(/disk full/);
    r.pk.store.install = orig;
    expect(await fs.readdir(path.join(r.sim, 'plugins')).catch(() => [])).toEqual([]);
    expect(await fs.readdir(path.join(r.root, 'integrations', 'bridge', 'pairing')).catch(() => [])).toEqual([]);
    expect((await r.pk.listing()).installed).toEqual([]);
    // And a normal install still works afterwards.
    await expect(r.pk.install(file, APPROVE(['read-project', 'modify-project']))).resolves.toBeTruthy();
  });

  it('an update replaces the add-in files and keeps working', async () => {
    const r = await rig();
    await r.pk.install(await pack('hybrid-sample'), APPROVE(['read-project', 'modify-project']));
    const up = await r.pk.install(await pack('hybrid-sample', { version: '1.1.0' }), APPROVE(['read-project', 'modify-project']));
    expect(up.version).toBe('1.1.0');
    await startSim(r);
    const key = await appKeyOf(r, 'sample.simcad.hybrid');
    expect(await r.pk.bridge.waitForSession('simcad.bridge.hybrid', 8000)).toBeTruthy();
    expect((await r.mgr.execute(key, 'simcad.describe')).ok).toBe(true);
  }, 30_000);

  it('the Lite edition registers fewer capabilities, and the rest are refused as unsupported', async () => {
    const r = await rig();
    await r.pk.install(await pack('hybrid-sample'), APPROVE(['read-project', 'modify-project']));
    await startSim(r, 'Lite');
    const key = await appKeyOf(r, 'sample.simcad.hybrid');
    const s = await r.pk.bridge.waitForSession('simcad.bridge.hybrid', 8000);
    expect(s!.capabilities).toEqual(['scene.describe']);
    expect(s!.edition).toBe('Lite');
    expect((await r.mgr.execute(key, 'simcad.describe')).ok).toBe(true);
    const add = await r.mgr.execute(key, 'simcad.add_box_verified', { name: 'a', size: 1 });
    expect(add.ok).toBe(false);
    expect(add.message).toMatch(/not made|has not made|not one of|available/);
  }, 30_000);

  it('the adapter process has no way to reach the add-in outside the permissions the user approved', async () => {
    const r = await rig();
    // Install with read access only: the modifying capability must be refused by the host, not by the manifest.
    await r.pk.install(await pack('hybrid-sample'), APPROVE(['read-project']));
    await startSim(r);
    const key = await appKeyOf(r, 'sample.simcad.hybrid');
    await r.pk.bridge.waitForSession('simcad.bridge.hybrid', 8000);
    const add = await r.mgr.execute(key, 'simcad.add_box_verified', { name: 'a', size: 1 });
    expect(add.ok).toBe(false);
    expect(add.error!.kind).toBe('permission-denied');
    expect((await r.mgr.execute(key, 'simcad.describe')).ok).toBe(true);
  }, 30_000);
});

describe('internal-only integration: add-in without connector code', () => {
  it('runs every command through the bridge, with no adapter process', async () => {
    const r = await rig();
    const file = await pack('internal-sample');
    const rev = await r.pk.review(file);
    expect(rev.integrationType).toBe('internal');
    expect(rev.integration!.steps.map((s) => s.kind)).toEqual(['close-host', 'plugin-files', 'restart-host', 'verify']);
    const inst = await r.pk.install(file, APPROVE(['read-project', 'modify-project']));
    expect(inst.integrationType).toBe('internal');
    expect(inst.pluginState).toBe('restart-needed');
    const key = await appKeyOf(r, 'sample.simcad.internal');
    expect((await r.mgr.execute(key, 'scene.describe')).ok).toBe(false); // not open yet: no false "connected"
    await startSim(r);
    await r.pk.bridge.waitForSession('simcad.bridge.internal', 8000);
    const add = await r.mgr.execute(key, 'scene.add_box', { name: 'Plate', size: 3 });
    expect(add.ok).toBe(true);
    expect(add.evidence.join()).toMatch(/SimCAD returned object id/);
    const list = await r.mgr.execute(key, 'scene.describe');
    expect((list.data as { objects: Array<{ name: string }> }).objects[0]!.name).toBe('Plate');
    const reset = await r.mgr.execute(key, 'scene.reset');
    expect(reset.ok).toBe(true);
    expect(r.asked.some((q) => q.command.id === 'scene.reset' && q.destructive)).toBe(true);
  }, 30_000);

  it('an unknown plugin file in the destination is never removed by uninstall', async () => {
    const r = await rig();
    await r.pk.install(await pack('internal-sample'), APPROVE(['read-project', 'modify-project']));
    await fs.writeFile(path.join(r.sim, 'plugins', 'someone-elses.plugin.js'), '// not ours');
    await r.pk.uninstall('sample.simcad.internal');
    expect(await fs.readdir(path.join(r.sim, 'plugins'))).toEqual(['someone-elses.plugin.js']);
  });
});

describe('external-only integration through the same manager', () => {
  it('still installs, connects and runs (manifest version 1)', async () => {
    const r = await rig();
    const file = await pack('sample-adapter');
    const rev = await r.pk.review(file);
    expect(rev.integrationType).toBe('external');
    expect(rev.integration).toBeNull();
    const inst = await r.pk.install(file, { permissions: rev.permissions, allowUnsigned: true });
    expect(inst.integrationType).toBe('external');
    expect(inst.pluginState).toBe('none');
    const key = await appKeyOf(r, 'sample.textkit');
    const res = await r.mgr.execute(key, 'text.stats', { text: 'one two three' });
    expect(res.ok).toBe(true);
    expect((res.data as { words: number }).words).toBe(3);
    await r.pk.uninstall('sample.textkit');
  }, 30_000);
});

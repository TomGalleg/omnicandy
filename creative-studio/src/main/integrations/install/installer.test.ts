// Manifest v2 and the PluginInstaller: approved destinations, ledger, rollback, repair, uninstall, elevation, host-open checks.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packAdapter } from '../../../../scripts/pack-adapter.mjs';
import { integrationTypeOf, parsePackage, readPackageSource, type PackageManifest } from '../packageFormat';
import { ALL_PROFILES, VENDOR_PROFILES, profileById, resolveDestination, yearOf } from './hostProfiles';
import { InstallError, PluginInstaller, type Elevator } from './pluginInstaller';

const FIX = path.resolve(__dirname, '../../../../fixtures');
let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-inst-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

async function load(fixture: string) {
  const dir = path.join(FIX, fixture);
  const packed = packAdapter({ dir });
  const file = path.join(tmp, `${fixture}-${Math.random().toString(36).slice(2, 6)}.ccadapter`);
  await fs.writeFile(file, packed.bytes);
  const src = await readPackageSource(file);
  const parsed = parsePackage(src.files);
  if (!parsed.manifest) throw new Error(parsed.problems.join('; '));
  return { file, files: src.files, manifest: parsed.manifest, problems: parsed.problems };
}

const clone = (m: PackageManifest): PackageManifest => JSON.parse(JSON.stringify(m)) as PackageManifest;

async function rig(opts: { running?: { value: boolean }; elevator?: Elevator } = {}) {
  const root = await fs.mkdtemp(path.join(tmp, 'r-'));
  const sim = path.join(root, 'simcad');
  const inst = new PluginInstaller(path.join(root, 'integrations'), {
    env: { vars: { APPDATA: path.join(root, 'AppData'), PROGRAMDATA: path.join(root, 'ProgramData') }, simHostRoot: sim },
    isRunning: async () => !!opts.running?.value,
    elevator: opts.elevator,
    bridge: { endpointFile: path.join(root, 'bridge', 'endpoint.json'), pairingDir: path.join(root, 'bridge', 'pairing') },
  });
  return { root, sim, plugins: path.join(sim, 'plugins'), inst };
}

const APPROVE = { permissions: [], installPlugin: true };

describe('manifest version 2', () => {
  it('reads the hybrid and internal samples and keeps version 1 packages working', async () => {
    const h = await load('hybrid-sample');
    expect(h.problems).toEqual([]);
    expect(integrationTypeOf(h.manifest)).toBe('hybrid');
    const i = await load('internal-sample');
    expect(i.problems).toEqual([]);
    expect(integrationTypeOf(i.manifest)).toBe('internal');
    expect(i.manifest.runtime).toBeUndefined();
    const v1 = await load('sample-adapter');
    expect(v1.manifest.manifestVersion).toBe(1);
    expect(v1.problems).toEqual([]);
    expect(integrationTypeOf(v1.manifest)).toBe('external');
    const f = await load('freecad-adapter');
    expect(f.problems).toEqual([]);
  });

  async function problemsOf(edit: (m: Record<string, unknown>) => void, fixture = 'hybrid-sample'): Promise<string[]> {
    const dir = await fs.mkdtemp(path.join(tmp, 'neg-'));
    await fs.cp(path.join(FIX, fixture), dir, { recursive: true });
    const mf = JSON.parse(await fs.readFile(path.join(dir, 'adapter.json'), 'utf8')) as Record<string, unknown>;
    edit(mf);
    await fs.writeFile(path.join(dir, 'adapter.json'), JSON.stringify(mf));
    const packed = packAdapter({ dir });
    const file = path.join(dir, 'x.ccadapter');
    await fs.writeFile(file, packed.bytes);
    const p = parsePackage((await readPackageSource(file)).files);
    return p.problems;
  }
  type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it('refuses manifests that try to widen what an installer would do', async () => {
    expect((await problemsOf((m) => { (m.integration as Obj).plugin.preInstall = 'cmd /c calc'; })).join()).toMatch(/unrecognized|preInstall/i);
    expect((await problemsOf((m) => { (m.integration as Obj).plugin.files[0].to = '../escape.js'; })).join()).toMatch(/escape|\.\./i);
    expect((await problemsOf((m) => { (m.integration as Obj).plugin.files[0].to = 'C:/Windows/evil.js'; })).join()).toMatch(/absolute|drive|C:/i);
    expect((await problemsOf((m) => { m.manifestVersion = 1; })).join()).toMatch(/manifestVersion 2|Unrecognized/i);
    expect((await problemsOf((m) => { delete m.runtime; })).join()).toMatch(/needs runtime\.entry/);
    expect((await problemsOf((m) => { m.manifestVersion = 3; })).join()).toMatch(/unsupported manifestVersion/);
    expect((await problemsOf((m) => { (m.integration as Obj).type = 'external'; })).join()).toMatch(/external integration cannot declare/);
    expect((await problemsOf((m) => { delete (m.integration as Obj).communication; })).join()).toMatch(/needs integration\.communication/);
    expect((await problemsOf((m) => { (m.integration as Obj).plugin.files[0].from = 'nope.js'; })).join()).toMatch(/not listed in files/);
  });

  it('refuses internal packages that carry adapter code and commands without a capability', async () => {
    expect((await problemsOf((m) => { m.runtime = { entry: 'main.js' }; }, 'internal-sample')).join()).toMatch(/carries no adapter code/);
    expect((await problemsOf((m) => { ((m.commands as Obj[])[0]!).id = 'scene.other'; }, 'internal-sample')).join()).toMatch(/no matching communication capability/);
  });

  it('adds the plugin capabilities to the permissions the user reviews', async () => {
    const { requestedPermissions } = await import('../packageFormat');
    const i = await load('internal-sample');
    expect(requestedPermissions(i.manifest)).toEqual(['modify-project', 'read-project']);
  });
});

describe('host profiles', () => {
  it('has profiles for every Autodesk and Adobe program; only Revit 2027 (a real, live-tested add-in) is marked supported', () => {
    const ids = ['autodesk.revit', 'autodesk.autocad', 'autodesk.fusion', 'autodesk.inventor', 'autodesk.3dsmax', 'adobe.photoshop', 'adobe.illustrator', 'adobe.premiere', 'adobe.aftereffects', 'adobe.indesign'];
    for (const id of ids) {
      const p = profileById(id)!;
      expect(p, id).toBeTruthy();
      expect(p.readiness).toBe(id === 'autodesk.revit' ? 'supported' : 'groundwork');
      expect(p.technologies.length).toBeGreaterThan(0);
      expect(p.destinations.length).toBeGreaterThan(0);
      expect(p.docs.length + p.vendorInstall.length).toBeGreaterThan(0);
    }
    expect(VENDOR_PROFILES.filter((p) => p.readiness === 'supported').map((p) => p.id)).toEqual(['autodesk.revit']);
    expect(VENDOR_PROFILES.filter((p) => p.readiness !== 'supported').every((p) => p.readiness === 'groundwork')).toBe(true);
    expect(ALL_PROFILES.filter((p) => p.readiness === 'simulated-test').map((p) => p.id)).toEqual(['simcad']);
  });

  it('resolves destination folders from the installer\'s own table only', () => {
    const env = { vars: { APPDATA: 'C:\\Users\\Tom\\AppData\\Roaming', PROGRAMDATA: 'C:\\ProgramData' }, simHostRoot: 'D:\\sim' };
    const revit = profileById('autodesk.revit')!;
    const user = revit.destinations.find((d) => d.id === 'revit-addins-user')!;
    expect(resolveDestination(user, env, '2027')).toBe(path.resolve('C:/Users/Tom/AppData/Roaming/Autodesk/Revit/Addins/2027'));
    expect(resolveDestination(user, env, '27.0')).toContain('2027');
    expect(resolveDestination(user, env, null)).toBeNull();
    const machine = revit.destinations.find((d) => d.id === 'revit-addins-machine')!;
    expect(machine.admin).toBe(true);
    expect(resolveDestination(machine, { vars: {}, simHostRoot: 'x' }, '2027')).toBeNull();
    expect(yearOf('2025.3.1')).toBe('2025');
    expect(yearOf('abc')).toBeNull();
  });
});

describe('PluginInstaller', () => {
  it('plans the steps a person sees, from the installer\'s rules', async () => {
    const { inst, sim } = await rig({ running: { value: false } });
    const h = await load('hybrid-sample');
    const plan = await inst.plan(h.manifest, h.files);
    expect(plan.problems).toEqual([]);
    expect(plan.blockers).toEqual([]);
    expect(plan.view.type).toBe('hybrid');
    expect(plan.view.simulated).toBe(true);
    expect(plan.view.destinations[0]!.path).toBe(path.join(sim, 'plugins'));
    expect(plan.view.steps.map((s) => s.kind)).toEqual(['close-host', 'adapter', 'plugin-files', 'restart-host', 'verify']);
    expect(plan.view.restartHost).toBe(true);
    expect(plan.files.map((f) => f.to)).toEqual(['simcad-hybrid.plugin.js', 'ccbridge-client.js', 'cc-bridge.json']);
  });

  it('installs verified files and a pairing file, and verify() sees them', async () => {
    const { inst, plugins, root } = await rig();
    const h = await load('hybrid-sample');
    const l = await inst.install(h.manifest, h.files, APPROVE);
    expect(l.state).toBe('installed');
    expect((await fs.readdir(plugins)).sort()).toEqual(['cc-bridge.json', 'ccbridge-client.js', 'simcad-hybrid.plugin.js']);
    const cfg = JSON.parse(await fs.readFile(path.join(plugins, 'cc-bridge.json'), 'utf8')) as { secret: string; pluginId: string };
    expect(cfg.pluginId).toBe('simcad.bridge.hybrid');
    expect(cfg.secret).toMatch(/^[0-9a-f]{64}$/);
    const pair = JSON.parse(await fs.readFile(path.join(root, 'bridge', 'pairing', 'simcad.bridge.hybrid.json'), 'utf8')) as { secret: string };
    expect(pair.secret).toBe(cfg.secret);
    expect((await inst.verify(h.manifest.id)).state).toBe('restart-needed');
    await inst.clearRestart(h.manifest.id);
    expect((await inst.verify(h.manifest.id)).state).toBe('installed');
  });

  it('needs the user\'s approval for the plugin folder', async () => {
    const { inst, plugins } = await rig();
    const h = await load('hybrid-sample');
    await expect(inst.install(h.manifest, h.files, { permissions: [] })).rejects.toThrow(/not approved/);
    expect(await fs.stat(plugins).catch(() => null)).toBeNull();
  });

  it('never writes outside the approved folder or an unapproved file type, whatever the manifest says', async () => {
    const { inst, sim } = await rig();
    const h = await load('hybrid-sample');
    const bad = clone(h.manifest);
    bad.integration!.plugin!.files[0]!.to = 'evil.exe';
    const p1 = await inst.plan(bad, h.files);
    expect(p1.problems.join()).toMatch(/not an allowed file type/);
    await expect(inst.install(bad, h.files, APPROVE)).rejects.toThrow(/allowed file type/);
    const bad2 = clone(h.manifest);
    bad2.integration!.plugin!.files[0]!.to = '../outside.js';
    expect((await inst.plan(bad2, h.files)).problems.join()).toMatch(/leave the plugin folder/);
    const bad3 = clone(h.manifest);
    bad3.integration!.plugin!.destination = 'c-windows-system32';
    expect((await inst.plan(bad3, h.files)).problems.join()).toMatch(/not an approved plugin folder/);
    const bad4 = clone(h.manifest);
    bad4.integration!.host!.profile = 'made.up';
    expect((await inst.plan(bad4, h.files)).problems.join()).toMatch(/no installation profile/);
    const bad5 = clone(h.manifest);
    bad5.integration!.plugin!.technology = 'cep';
    expect((await inst.plan(bad5, h.files)).problems.join()).toMatch(/does not load cep/);
    const bad6 = clone(h.manifest);
    bad6.integration!.plugin!.files.push({ from: 'plugin/ccbridge-client.js', to: 'cc-bridge.json' });
    expect((await inst.plan(bad6, h.files)).problems.join()).toMatch(/reserved/);
    expect(await fs.readdir(sim).catch(() => [])).toEqual([]);
  });

  it('will not overwrite a different file it did not install', async () => {
    const { inst, plugins } = await rig();
    const h = await load('hybrid-sample');
    await fs.mkdir(plugins, { recursive: true });
    await fs.writeFile(path.join(plugins, 'ccbridge-client.js'), 'someone else\'s file');
    await expect(inst.install(h.manifest, h.files, APPROVE)).rejects.toThrow(/will not overwrite/);
    expect((await fs.readdir(plugins)).sort()).toEqual(['ccbridge-client.js']);
    expect(await fs.readFile(path.join(plugins, 'ccbridge-client.js'), 'utf8')).toBe('someone else\'s file');
    expect(await inst.ledger(h.manifest.id)).toBeNull();
  });

  it('blocks while the program is open when it must be closed, and never closes it', async () => {
    const running = { value: true };
    const { inst, plugins } = await rig({ running });
    const h = await load('hybrid-sample');
    const plan = await inst.plan(h.manifest, h.files);
    expect(plan.view.hostRunning).toBe(true);
    expect(plan.blockers.join()).toMatch(/Close SimCAD/);
    await expect(inst.install(h.manifest, h.files, APPROVE)).rejects.toThrow(/Close SimCAD.*first/);
    expect(await fs.stat(plugins).catch(() => null)).toBeNull();
    running.value = false;
    await expect(inst.install(h.manifest, h.files, APPROVE)).resolves.toBeTruthy();
  });

  it('rolls everything back when cancelled part-way, including a file that was replaced', async () => {
    const { inst, plugins, root } = await rig();
    const h = await load('hybrid-sample');
    await inst.install(h.manifest, h.files, APPROVE);
    const before = await fs.readFile(path.join(plugins, 'ccbridge-client.js'));
    const pairBefore = await fs.readFile(path.join(root, 'bridge', 'pairing', 'simcad.bridge.hybrid.json'), 'utf8');
    // An update that is cancelled after the first file was already replaced.
    const upd = clone(h.manifest); upd.version = '1.1.0';
    const files2 = new Map(h.files); files2.set('plugin/ccbridge-client.js', Buffer.from('// new client\n'));
    const ac = new AbortController();
    await expect(inst.install(upd, files2, APPROVE, { signal: ac.signal, onProgress: (p) => { if (p.done === 2) ac.abort(); } })).rejects.toMatchObject({ kind: 'cancelled' });
    expect((await fs.readFile(path.join(plugins, 'ccbridge-client.js'))).equals(before)).toBe(true);
    expect((await inst.verify(h.manifest.id)).state).not.toBe('missing-files');
    expect(await fs.readFile(path.join(root, 'bridge', 'pairing', 'simcad.bridge.hybrid.json'), 'utf8')).toBe(pairBefore);
    expect((await fs.readdir(plugins)).filter((f) => f.endsWith('.ccpart'))).toEqual([]);
  });

  it('a fresh install that is cancelled leaves nothing behind', async () => {
    const { inst, sim, root } = await rig();
    const h = await load('hybrid-sample');
    const ac = new AbortController();
    await expect(inst.install(h.manifest, h.files, APPROVE, { signal: ac.signal, onProgress: (p) => { if (p.done === 1) ac.abort(); } })).rejects.toBeInstanceOf(InstallError);
    expect(await fs.readdir(path.join(sim, 'plugins')).catch(() => [])).toEqual([]);
    expect(await fs.readdir(path.join(root, 'bridge', 'pairing')).catch(() => [])).toEqual([]);
    expect(await inst.ledger(h.manifest.id)).toBeNull();
  });

  it('undoes an interrupted install at the next start (crash recovery)', async () => {
    const { inst, plugins, root } = await rig();
    const h = await load('hybrid-sample');
    const l = await inst.install(h.manifest, h.files, APPROVE);
    // Pretend the process died after writing: the ledger still says "installing".
    const ledgerFile = path.join(root, 'integrations', 'plugins', h.manifest.id, 'ledger.json');
    await fs.writeFile(ledgerFile, JSON.stringify({ ...l, state: 'installing' }));
    expect(await inst.recover()).toEqual([h.manifest.id]);
    expect(await fs.readdir(plugins).catch(() => [])).toEqual([]);
    expect(await inst.ledger(h.manifest.id)).toBeNull();
  });

  it('detects changed and missing files, and repair puts them back', async () => {
    const { inst, plugins } = await rig();
    const h = await load('hybrid-sample');
    await inst.install(h.manifest, h.files, APPROVE);
    await fs.writeFile(path.join(plugins, 'simcad-hybrid.plugin.js'), '// tampered');
    expect((await inst.verify(h.manifest.id)).state).toBe('modified');
    await fs.rm(path.join(plugins, 'ccbridge-client.js'));
    expect((await inst.verify(h.manifest.id)).state).toBe('missing-files');
    await inst.repair(h.manifest, h.files, APPROVE);
    const v = await inst.verify(h.manifest.id);
    expect(['installed', 'restart-needed']).toContain(v.state);
    expect(await fs.readFile(path.join(plugins, 'simcad-hybrid.plugin.js'), 'utf8')).not.toBe('// tampered');
  });

  it('uninstall removes exactly what was installed and keeps files the user changed', async () => {
    const { inst, plugins, root } = await rig();
    const h = await load('hybrid-sample');
    await inst.install(h.manifest, h.files, APPROVE);
    await fs.writeFile(path.join(plugins, 'other-plugin.js'), 'not ours');
    await fs.writeFile(path.join(plugins, 'simcad-hybrid.plugin.js'), '// the user edited this');
    const r = await inst.uninstall(h.manifest.id);
    expect(r.kept).toEqual(['simcad-hybrid.plugin.js']);
    expect(r.removed.sort()).toEqual(['cc-bridge.json', 'ccbridge-client.js']);
    expect((await fs.readdir(plugins)).sort()).toEqual(['other-plugin.js', 'simcad-hybrid.plugin.js']);
    expect(await fs.readdir(path.join(root, 'bridge', 'pairing')).catch(() => [])).toEqual([]);
    expect(await inst.ledger(h.manifest.id)).toBeNull();
    // A clean uninstall removes the folders it created.
    const { inst: i2, sim: s2 } = await rig();
    await i2.install(h.manifest, h.files, APPROVE);
    await i2.uninstall(h.manifest.id);
    expect(await fs.stat(path.join(s2, 'plugins')).catch(() => null)).toBeNull();
  });

  describe('administrator rights', () => {
    const adminManifest = (m: PackageManifest) => {
      const c = clone(m);
      c.integration!.plugin!.destination = 'simcad-machine-plugins';
      c.integration!.plugin!.admin = 'required';
      return c;
    };

    it('refuses a manifest that claims no admin rights for a protected folder', async () => {
      const { inst } = await rig();
      const h = await load('hybrid-sample');
      const c = clone(h.manifest); c.integration!.plugin!.destination = 'simcad-machine-plugins';
      expect((await inst.plan(c, h.files)).problems.join()).toMatch(/needs them/);
    });

    it('does nothing without the user\'s approval, and nothing without an elevator', async () => {
      const writes: string[] = [];
      const elevator: Elevator = { write: async (fs_) => { for (const f of fs_) { writes.push(f.abs); await fs.mkdir(path.dirname(f.abs), { recursive: true }); await fs.writeFile(f.abs, f.data); } }, remove: async (ps) => { for (const p of ps) await fs.rm(p, { force: true }); } };
      const h = await load('hybrid-sample');
      const m = adminManifest(h.manifest);
      const a = await rig({ elevator });
      await expect(a.inst.install(m, h.files, APPROVE)).rejects.toMatchObject({ kind: 'needs-elevation' });
      expect(writes).toEqual([]);
      const b = await rig();
      await expect(b.inst.install(m, h.files, { ...APPROVE, elevate: true })).rejects.toThrow(/cannot request them safely/);
      expect(await fs.stat(path.join(b.sim, 'machine-plugins')).catch(() => null)).toBeNull();
    });

    it('writes through the elevator only after approval, and uninstall removes through it', async () => {
      const writes: string[] = []; const removed: string[] = [];
      const elevator: Elevator = {
        write: async (fs_) => { for (const f of fs_) { writes.push(f.abs); await fs.mkdir(path.dirname(f.abs), { recursive: true }); await fs.writeFile(f.abs, f.data); } },
        remove: async (ps) => { for (const p of ps) { removed.push(p); await fs.rm(p, { force: true }); } },
      };
      const h = await load('hybrid-sample');
      const m = adminManifest(h.manifest);
      const { inst, sim } = await rig({ elevator });
      await inst.install(m, h.files, { ...APPROVE, elevate: true });
      expect(writes.length).toBe(3);
      expect(writes.every((w) => w.startsWith(path.join(sim, 'machine-plugins')))).toBe(true);
      await inst.uninstall(m.id);
      expect(removed.length).toBe(3);
    });
  });

  it('a vendor-workflow plugin copies nothing: OmniCandy only guides', async () => {
    const { inst, sim } = await rig();
    const h = await load('hybrid-sample');
    const m = clone(h.manifest);
    m.integration!.plugin!.mechanism = 'vendor-workflow';
    m.integration!.plugin!.files = [];
    m.integration!.plugin!.vendorWorkflow = { title: 'Install the add-in with the vendor installer', steps: ['Open the vendor installer.', 'Choose the add-in.'] };
    const plan = await inst.plan(m, h.files);
    expect(plan.files).toEqual([]);
    expect(plan.view.steps.some((s) => s.kind === 'vendor-workflow')).toBe(true);
    await expect(inst.install(m, h.files, APPROVE)).rejects.toThrow(/vendor/);
    expect(await fs.readdir(sim).catch(() => [])).toEqual([]);
  });
});

// Universal Connect service on the REAL manager, REAL package store/trust system and REAL bundled FreeCAD connector,
// with a fake machine (temporary files, a fake registry) and clearly fake test adapters for the programs themselves.
// What this proves: classification, offers, browse, forget, first run, connect-then-verify, and that each program's
// outcome is independent. It does NOT prove that any real program works: that is blender/freecad `.live.test.ts`.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADAPTER_SDK_VERSION, type AdapterManifest, type Permission } from '@shared/integrations';
import type { ConnectEntry } from '@shared/connect';
import { runSetup, type AdapterDecision } from '@shared/connectFlow';
import { packAdapter } from '../../../scripts/pack-adapter.mjs';
import { ConnectService } from './connect';
import type { DiscoveryEnv } from './discovery';
import { AdapterPackages, createIntegrationManager } from './index';
import type { AdapterFactory, ExternalAdapter, HealthResult } from './sdk';
import { ExternalState } from './state';

// Simulates Windows (backslash paths, registry text, a compiled mock program): not meaningful on other systems.
const onWindows = process.platform === 'win32';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const BUNDLED = path.join(root, 'resources', 'adapters');
const HKLM = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-connect-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); });

/** A program on the fake machine: an (empty) .exe file. */
async function exeAt(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await fs.writeFile(p, 'MZ');
  return p;
}

interface Behaviour { health: Array<HealthResult | Error>; version: string }
function fakeAdapter(id: string, exe: string, maturity: AdapterManifest['maturity'], b: Behaviour): AdapterFactory {
  const manifest: AdapterManifest = {
    id, platforms: ['win32', 'linux'], name: `Fake ${id}`, vendor: 'Test', sdkVersion: ADAPTER_SDK_VERSION, maturity, exeNames: [exe], displayNames: [`^Fake ${id}`],
    versions: { min: '1.0', max: '9.9' }, methods: ['scripting'], capabilities: ['connect', 'disconnect', 'healthCheck', 'executeCommand'],
    commands: [{ id: 'ping', label: 'Ping', description: 'pings', params: {}, permissions: ['read-info', 'execute-scripts'] }],
  };
  const adapter = (): ExternalAdapter => ({
    probe: async () => ({ version: b.version }),
    connect: async () => undefined,
    disconnect: async () => undefined,
    healthCheck: async () => { const n = b.health.length > 1 ? b.health.shift()! : b.health[0]!; if (n instanceof Error) throw n; return n; },
    execute: async () => ({ message: 'pong', outputs: [] }),
    dispose: async () => undefined,
  });
  return { manifest, create: adapter };
}

interface Rig { svc: ConnectService; mgr: ReturnType<typeof createIntegrationManager>; pk: AdapterPackages; state: ExternalState; dir: string; behaviours: Record<string, Behaviour>; registry: Array<Record<string, string>> }

async function rig(opts: { catalog?: string[]; adapters?: Array<{ id: string; exe: string; maturity: AdapterManifest['maturity'] }> } = {}): Promise<Rig> {
  const dir = await fs.mkdtemp(path.join(tmp, 'rig-'));
  const state = new ExternalState(path.join(dir, 'secrets', 'external-apps.json'));
  const registry: Array<Record<string, string>> = [];
  const discovery: DiscoveryEnv = {
    env: { PATH: '' },
    exists: (p) => fs.stat(p).then(() => true, () => false),
    listDir: async () => [],
    run: async (file, args) => (file === 'reg' && args[1] === HKLM
      ? registry.map((v, i) => `HKEY_LOCAL_MACHINE\\${HKLM.slice(5)}\\App${i}\r\n${Object.entries(v).map(([k, x]) => `    ${k}    REG_SZ    ${x}`).join('\r\n')}\r\n`).join('\r\n')
      : ''),
  };
  const holder: { svc?: ConnectService } = {};
  const mgr = createIntegrationManager({
    workDir: async (id) => path.join(dir, 'work', id),
    permissions: { load: async () => (await state.read()).grants, save: async (g) => { await state.update((s) => { s.grants = g; }); } },
    approve: async () => 'once',
    discovery,
    userPaths: async () => (await state.read()).paths,
    extraTargets: async () => (await holder.svc?.extraTargets()) ?? [],
    remembered: { load: async () => (await state.read()).remembered, save: async (r) => { await state.update((s) => { s.remembered = r; }); } },
  });
  const behaviours: Record<string, Behaviour> = {};
  for (const a of opts.adapters ?? []) {
    behaviours[a.id] = { health: [{ ok: true, detail: `${a.id} answered` }], version: '2.5' };
    mgr.register(fakeAdapter(a.id, a.exe, a.maturity, behaviours[a.id]!));
  }
  const pk = new AdapterPackages(path.join(dir, 'integrations'), mgr);
  const service = new ConnectService({ manager: mgr, packages: pk, state, catalogDirs: opts.catalog ?? [BUNDLED] });
  holder.svc = service;
  return { svc: service, mgr, pk, state, dir, behaviours, registry };
}

const entryOf = (o: { entries: ConnectEntry[] }, exe: string) => o.entries.find((e) => path.basename(e.exePath).toLowerCase() === exe.toLowerCase());

describe('overview and classification', () => {
  it('shows a never-seen FreeCAD as "connector available" from the bundled signed package, and flags first run', async () => {
    const r = await rig();
    const p = await exeAt(path.join(tmp, 'p1', 'FreeCAD 1.1', 'bin'), 'FreeCADCmd.exe');
    await r.state.addPath(p);
    const o = await r.svc.overview();
    expect(o.firstRun).toBe(true);
    const e = entryOf(o, 'FreeCADCmd.exe')!;
    expect(e).toBeTruthy();
    expect(e.group).toBe('needs-adapter');
    expect(e.adapterState).toBe('available');
    expect(e.selectable).toBe(true);
    expect(e.offer).toMatchObject({ source: 'bundled', adapterId: 'freecad', signature: 'valid', publisherTrusted: false });
    expect(e.offer!.permissions.sort()).toEqual(['execute-scripts', 'read-info', 'write-files']);
    expect(e.forgettable).toBe(true);
    // Listing a connector installs nothing and trusts nothing.
    expect((await r.pk.listing()).installed).toHaveLength(0);
    expect((await r.pk.listing()).trustedPublishers).toHaveLength(0);
    await r.svc.markOnboarded();
    expect((await r.svc.overview({ rescan: false })).firstRun).toBe(false);
  }, 20_000);

  it('a program with only a placeholder is "not supported yet" and cannot be selected', async () => {
    const r = await rig();
    await r.state.addPath(await exeAt(path.join(tmp, 'p2', 'Autodesk'), 'Revit.exe'));
    const e = entryOf(await r.svc.overview(), 'Revit.exe')!;
    expect(e).toMatchObject({ group: 'unsupported', adapterState: 'planned', selectable: false });
    expect(e.explanation).toMatch(/cannot control it yet/);
    expect(e.explanation).toMatch(/Nothing is wrong/);
  });

  it('classifies experimental, ready, and an unsupported version side by side', async () => {
    const r = await rig({ adapters: [{ id: 'real', exe: 'real.exe', maturity: 'verified' }, { id: 'exp', exe: 'exp.exe', maturity: 'experimental' }] });
    r.behaviours.real!.version = '3.1';
    r.behaviours.exp!.version = '0.5'; // older than the supported 1.0-9.9
    const d = path.join(tmp, 'p3');
    await r.state.addPath(await exeAt(d, 'real.exe'));
    await r.state.addPath(await exeAt(d, 'exp.exe'));
    const o = await r.svc.overview();
    expect(entryOf(o, 'real.exe')).toMatchObject({ group: 'ready', adapterState: 'installed', experimental: false, selectable: true });
    expect(entryOf(o, 'exp.exe')).toMatchObject({ group: 'incompatible', experimental: true, selectable: false });
    expect(entryOf(o, 'exp.exe')!.explanation).toMatch(/older than the supported/);
  }, 30_000); // a full scan can exceed the 5 s default when many test files run in parallel

  it('finds a program that only a connector-to-install knows (a catalog package with no placeholder)', async () => {
    const cat = path.join(tmp, 'cat-acme');
    await fs.mkdir(cat, { recursive: true });
    const src = path.join(tmp, 'acme-src');
    await fs.cp(path.join(root, 'fixtures', 'freecad-adapter'), src, { recursive: true });
    const m = JSON.parse(await fs.readFile(path.join(src, 'adapter.json'), 'utf8'));
    Object.assign(m, { id: 'acme.draw', name: 'Acme Draw' });
    Object.assign(m.application, { name: 'Acme Draw', exeNames: ['AcmeDraw.exe'], displayNames: ['Acme Draw'] });
    await fs.writeFile(path.join(src, 'adapter.json'), JSON.stringify(m));
    await fs.writeFile(path.join(cat, 'acme.ccadapter'), packAdapter({ dir: src }).bytes);
    const r = await rig({ catalog: [cat] });
    await r.state.addPath(await exeAt(path.join(tmp, 'p4'), 'AcmeDraw.exe'));
    const e = entryOf(await r.svc.overview(), 'AcmeDraw.exe')!;
    expect(e).toBeTruthy();
    expect(e.group).toBe('needs-adapter');
    expect(e.offer).toMatchObject({ adapterId: 'acme.draw', signature: 'unsigned' });
  });

  it('shows ONE row for one FreeCAD installation found through two of its programs, with the richest version', async () => {
    const r = await rig();
    const bin = path.join(tmp, 'p6', 'FreeCAD 1.1', 'bin');
    const gui = await exeAt(bin, 'FreeCAD.exe');
    await exeAt(bin, 'FreeCADCmd.exe');
    r.registry.push({ DisplayName: 'FreeCAD 1.1.4', DisplayVersion: '1.1.4', Publisher: 'FreeCAD Team', DisplayIcon: gui });
    await r.state.addPath(path.join(bin, 'FreeCADCmd.exe'));
    const o = await r.svc.overview();
    const rows = o.entries.filter((e) => /^FreeCAD/i.test(path.basename(e.exePath)));
    expect(rows).toHaveLength(1);
    expect(path.basename(rows[0]!.exePath)).toBe('FreeCADCmd.exe'); // the program the connector drives
    expect(rows[0]).toMatchObject({ version: '1.1.4', publisher: 'FreeCAD Team', group: 'needs-adapter' });
  });

  it('does not offer a damaged package', async () => {
    const cat = path.join(tmp, 'cat-bad');
    await fs.mkdir(cat, { recursive: true });
    const good = await fs.readFile(path.join(BUNDLED, (await fs.readdir(BUNDLED))[0]!));
    const bad = Buffer.from(good);
    bad[Math.floor(bad.length / 3)] = bad[Math.floor(bad.length / 3)]! ^ 0xff;
    await fs.writeFile(path.join(cat, 'bad.ccadapter'), bad);
    const r = await rig({ catalog: [cat] });
    await r.state.addPath(await exeAt(path.join(tmp, 'p5', 'bin'), 'FreeCADCmd.exe'));
    const e = entryOf(await r.svc.overview(), 'FreeCADCmd.exe')!;
    expect(e.offer).toBeNull();
    expect(e.group).toBe('unsupported');
  });
});

describe('connect and verify (fake test adapters; nothing here proves a real program)', () => {
  async function setup(maturity: AdapterManifest['maturity'], health: Behaviour['health']) {
    const r = await rig({ adapters: [{ id: 'one', exe: 'one.exe', maturity }] });
    r.behaviours.one!.health = health;
    await r.state.addPath(await exeAt(path.join(tmp, `c-${Math.random().toString(36).slice(2)}`), 'one.exe'));
    const o = await r.svc.overview();
    return { r, key: entryOf(o, 'one.exe')!.key };
  }

  it('reports verified only after the connection test passed, with the checked facts', async () => {
    const { r, key } = await setup('verified', [{ ok: true, detail: 'built a cube' }]);
    const out = await r.svc.connectAndVerify(key);
    expect(out).toMatchObject({ state: 'verified', status: 'connected' });
    expect(out.evidence.join(' ')).toMatch(/answered a real health check/);
    expect((await r.mgr.list()).find((a) => a.key === key)!.status).toBe('connected');
  });

  it('an experimental connector is "verified-limited", never plain connected', async () => {
    const { r, key } = await setup('experimental', [{ ok: true, detail: 'ok' }]);
    const out = await r.svc.connectAndVerify(key);
    expect(out.state).toBe('verified-limited');
    expect(out.headline).toMatch(/experimental/);
    expect((await r.mgr.list()).find((a) => a.key === key)!.status).toBe('limited');
  });

  it('a program that is not running is "blocked" with an instruction, not a vague failure', async () => {
    const { r, key } = await setup('experimental', [{ ok: false, detail: 'Resolve is not running.', state: 'not-running' }]);
    const out = await r.svc.connectAndVerify(key);
    expect(out).toMatchObject({ state: 'blocked', status: 'not-running' });
    expect(out.detail).toMatch(/Open /);
    expect(out.technical).toMatch(/not running/);
  });

  it('a connection that passes connect but fails the verification is NOT reported as connected, and is disconnected', async () => {
    // connect() health check passes, the verification health check fails.
    const { r, key } = await setup('verified', [{ ok: true, detail: 'ok' }, { ok: false, detail: 'second check failed' }]);
    const out = await r.svc.connectAndVerify(key);
    expect(out.state).toBe('failed');
    expect(out.technical).toMatch(/second check failed/);
    expect((await r.mgr.list()).find((a) => a.key === key)!.status).not.toBe('connected');
  });

  it('an adapter that throws during the test fails calmly', async () => {
    const { r, key } = await setup('verified', [new Error('boom')]);
    const out = await r.svc.connectAndVerify(key);
    expect(out.state).toBe('failed');
    expect(out.technical).toMatch(/boom/);
    expect(out.headline).toMatch(/Could not connect/);
  });
});

describe('Browse for Application', () => {
  it('adds a portable program by its file, remembers it and lists it', async () => {
    const r = await rig({ adapters: [{ id: 'port', exe: 'port.exe', maturity: 'verified' }] });
    const p = await exeAt(path.join(tmp, 'portable', 'Port'), 'port.exe');
    const res = await r.svc.browse(p);
    expect(res.kind).toBe('added');
    const e = entryOf(await r.svc.overview({ rescan: false }), 'port.exe')!;
    expect(e).toMatchObject({ installType: 'portable', forgettable: true, group: 'ready' });
    expect((await r.state.read()).paths).toEqual([p]);
  });

  it('accepts the program folder, also when the program is in its bin subfolder', async () => {
    const r = await rig({ adapters: [{ id: 'port', exe: 'port.exe', maturity: 'verified' }] });
    const folder = path.join(tmp, 'portable2', 'Port 2');
    await exeAt(path.join(folder, 'bin'), 'port.exe');
    const res = await r.svc.browse(folder);
    expect(res.kind).toBe('added');
    expect((await r.mgr.scan()).apps.some((a) => a.exePath.toLowerCase().endsWith('port.exe'))).toBe(true);
  });

  it('explains a program OmniCandi has no connector for and saves nothing', async () => {
    const r = await rig();
    const p = await exeAt(path.join(tmp, 'portable3'), 'notepad.exe');
    const res = await r.svc.browse(p);
    expect(res.kind).toBe('no-match');
    expect((res as { message: string }).message).toMatch(/no connector for/);
    expect((await r.state.read()).paths).toEqual([]);
  });

  it('rejects non-programs, missing paths and folders with nothing usable', async () => {
    const r = await rig();
    const txt = path.join(tmp, 'readme.txt');
    await fs.writeFile(txt, 'x');
    expect((await r.svc.browse(txt)).kind).toBe('no-match');
    expect((await r.svc.browse(path.join(tmp, 'does-not-exist.exe'))).kind).toBe('no-match');
    const empty = path.join(tmp, 'empty-folder');
    await fs.mkdir(empty, { recursive: true });
    expect((await r.svc.browse(empty)).kind).toBe('no-match');
    expect((await r.state.read()).paths).toEqual([]);
  });

  it('does not add the same program twice', async () => {
    const r = await rig({ adapters: [{ id: 'port', exe: 'port.exe', maturity: 'verified' }] });
    const p = await exeAt(path.join(tmp, 'portable4'), 'port.exe');
    expect((await r.svc.browse(p)).kind).toBe('added');
    expect((await r.svc.browse(p)).kind).toBe('already-known');
    expect((await r.state.read()).paths).toEqual([p]);
  });

  it('a portable FreeCAD (placeholder only) becomes "connector available" through Browse', async () => {
    const r = await rig();
    const p = await exeAt(path.join(tmp, 'portable5', 'FreeCAD', 'bin'), 'FreeCADCmd.exe');
    const res = await r.svc.browse(path.dirname(path.dirname(p)));
    expect(res.kind).toBe('added');
    expect(entryOf(await r.svc.overview({ rescan: false }), 'FreeCADCmd.exe')).toMatchObject({ group: 'needs-adapter', installType: 'portable' });
  });
});

describe('Forget Application', () => {
  it('removes the saved location and the permissions, disconnects, and leaves the program files alone', async () => {
    const r = await rig({ adapters: [{ id: 'fg', exe: 'fg.exe', maturity: 'verified' }] });
    const p = await exeAt(path.join(tmp, 'forget1'), 'fg.exe');
    await r.svc.browse(p);
    const key = entryOf(await r.svc.overview({ rescan: false }), 'fg.exe')!.key;
    await r.state.update((s) => { s.grants[key] = ['read-info']; });
    expect((await r.svc.connectAndVerify(key)).state).toBe('verified');
    const res = await r.svc.forget(key);
    expect(res.stillDetected).toBe(false);
    expect(res.message).toMatch(/not touched/);
    const st = await r.state.read();
    expect(st.paths).toEqual([]);
    expect(st.grants[key]).toBeUndefined();
    expect((await r.mgr.list()).some((a) => a.key === key)).toBe(false);
    await expect(fs.stat(p)).resolves.toBeTruthy(); // the "software" is still there
    expect((await r.svc.overview({ rescan: false })).entries.some((e) => e.key === key)).toBe(false);
  });

  it('forgets a remembered path; if Windows still lists the program it comes back and says so honestly', async () => {
    const r = await rig({ adapters: [{ id: 'fg', exe: 'fg.exe', maturity: 'verified' }] });
    const dir = path.join(tmp, 'forget2');
    const p = await exeAt(dir, 'fg.exe');
    r.registry.push({ DisplayName: 'Fake fg', DisplayVersion: '2.5', DisplayIcon: p });
    let o = await r.svc.overview();
    const key = entryOf(o, 'fg.exe')!.key;
    expect(entryOf(o, 'fg.exe')!.forgettable).toBe(true); // remembered from the registry find
    const res = await r.svc.forget(key);
    expect(res.stillDetected).toBe(true);
    expect(res.message).toMatch(/Windows still lists it/);
    // ...but once the record is gone, the forgotten location does not bring it back.
    r.registry.length = 0;
    await r.state.update((s) => { s.remembered = []; });
    o = await r.svc.overview();
    expect(o.entries.some((e) => e.key === key)).toBe(false);
  });

  it('refuses to forget something that is not in the list', async () => {
    const r = await rig();
    await expect(r.svc.forget('c:\\nowhere\\x.exe')).rejects.toThrow(/not in the list/);
  });
});

describe('multi-application setup: separate outcomes', () => {
  it('installs FreeCAD for real (review, trust), while a second program fails and a third succeeds, without cross-contamination', async () => {
    const r = await rig({ adapters: [{ id: 'good', exe: 'good.exe', maturity: 'verified' }, { id: 'bad', exe: 'bad.exe', maturity: 'verified' }] });
    r.behaviours.bad!.health = [{ ok: false, detail: 'refuses to start' }];
    const d = path.join(tmp, 'multi');
    await r.state.addPath(await exeAt(d, 'good.exe'));
    await r.state.addPath(await exeAt(d, 'bad.exe'));
    await r.state.addPath(await exeAt(path.join(d, 'FreeCAD', 'bin'), 'FreeCADCmd.exe'));
    const o = await r.svc.overview();
    const chosen = ['bad.exe', 'FreeCADCmd.exe', 'good.exe'].map((n) => entryOf(o, n)!);
    expect(chosen.every((e) => e.selectable)).toBe(true);

    const trusted: string[] = [];
    const runs = await runSetup(chosen, {
      askAdapter: async (e): Promise<AdapterDecision> => ({ approval: { permissions: e.offer!.permissions, trustPublisher: true } }),
      installAdapter: async (e, approval) => { trusted.push(e.offer!.adapterId); await r.pk.install(e.offer!.path!, approval); },
      refresh: async () => (await r.svc.overview({ rescan: false })).entries,
      connect: (k) => r.svc.connectAndVerify(k),
      onUpdate: () => undefined,
      isCancelled: () => false,
    });
    const by = Object.fromEntries(runs.map((x) => [x.name, x]));
    expect(by['Fake bad']!.outcome).toBe('failed');
    expect(by['Fake good']!.outcome).toBe('verified');
    // FreeCAD: the connector was installed (its own decision and trust), but the fake .exe cannot be driven, so it is NOT connected.
    expect(by.FreeCAD!.adapter).toBe('done');
    expect(by.FreeCAD!.outcome).not.toBe('verified');
    expect(trusted).toEqual(['freecad']);
    const list = await r.mgr.list();
    expect(list.find((a) => a.adapterId === 'good')!.status).toBe('connected');
    expect(list.find((a) => a.adapterId === 'bad')!.status).not.toBe('connected');
    expect(list.find((a) => a.adapterId === 'freecad')!.status).not.toBe('connected');
    // Trust was recorded for exactly the publisher the user approved for FreeCAD.
    expect((await r.pk.listing()).trustedPublishers).toHaveLength(1);
  });
});

describe('external state', () => {
  it('keeps concurrent updates and the first-run flag', async () => {
    const s = new ExternalState(path.join(tmp, 'state-a', 'x.json'));
    await Promise.all([s.addPath('C:\\a\\a.exe'), s.addPath('C:\\b\\b.exe'), s.update((x) => { x.grants.k = ['read-info' as Permission]; }), s.markOnboarded()]);
    const v = await s.read();
    expect(v.paths.sort()).toEqual(['C:\\a\\a.exe', 'C:\\b\\b.exe']);
    expect(v.grants.k).toEqual(['read-info']);
    expect(v.onboarded).toBe(true);
  });

  it.skipIf(!onWindows)('removing by program path also removes the folder or bin-parent the user chose, but never a parent drive', async () => {
    const s = new ExternalState(path.join(tmp, 'state-b', 'x.json'));
    await s.update((x) => { x.paths = ['E:\\FreeCAD 1.1', 'E:\\']; x.remembered = ['E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe', 'E:\\Other\\o.exe']; });
    expect(await s.removePath('E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe')).toBe(true);
    const v = await s.read();
    expect(v.paths).toEqual(['E:\\']);
    expect(v.remembered).toEqual(['E:\\Other\\o.exe']);
    expect(await s.removePath('E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe')).toBe(false);
  });

  it('survives a missing or corrupt file', async () => {
    const f = path.join(tmp, 'state-c', 'x.json');
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, '{not json');
    expect(await new ExternalState(f).read()).toEqual({ grants: {}, paths: [], remembered: [], onboarded: false, connected: [] });
  });
});

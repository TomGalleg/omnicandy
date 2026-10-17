import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADAPTER_SDK_VERSION, compareVersions, versionSupported, type AdapterManifest, type ApprovalAnswer, type Permission } from '@shared/integrations';
import { discoverApps, parseRegQuery, type DiscoveryEnv } from './discovery';
import { createIntegrationManager, IntegrationManager } from './index';
import { AdapterError, validateManifest, type AdapterFactory, type ExternalAdapter } from './sdk';

// Simulates Windows (backslash paths, registry text, a compiled mock program): not meaningful on other systems.
const onWindows = process.platform === 'win32';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-int-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const noPerms = { load: async () => ({}), save: async () => undefined };

/** A fake machine: files that exist, registry output, running processes. */
function fakeEnv(opts: { files?: string[]; reg?: string; tasks?: string; dirs?: Record<string, string[]> } = {}): DiscoveryEnv {
  const files = new Set((opts.files ?? []).map((f) => f.toLowerCase()));
  return {
    env: { ProgramFiles: 'C:\\Program Files', PATH: '' },
    exists: async (p) => files.has(p.toLowerCase()),
    listDir: async (p) => (opts.dirs?.[p] ?? []).map((n) => ({ name: n, dir: true })),
    run: async (file, args) => (file === 'reg' && args[1] === 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' ? opts.reg ?? '' : file === 'tasklist' ? opts.tasks ?? '' : ''),
  };
}

const manifest = (over: Partial<AdapterManifest> = {}): AdapterManifest => ({
  id: 'mock.app', platforms: ['win32', 'linux'], name: 'Mock App', vendor: 'Test', sdkVersion: ADAPTER_SDK_VERSION, maturity: 'experimental',
  exeNames: ['mockapp.exe'], displayNames: ['^Mock App'], versions: { min: '2.0', max: '3.9' },
  methods: ['scripting'], capabilities: ['executeCommand', 'connect', 'disconnect'],
  commands: [
    { id: 'make', label: 'Make', description: 'makes a file', params: { name: { type: 'string', description: 'n', default: 'out.txt' }, n: { type: 'number', description: 'n', default: 1, min: 0, max: 10 } }, permissions: ['launch', 'write-files'], timeoutMs: 400 },
    { id: 'wipe', label: 'Wipe', description: 'destructive', params: {}, permissions: ['modify-project'], destructive: true },
    { id: 'hang', label: 'Hang', description: 'never ends', params: {}, permissions: [], timeoutMs: 150 },
    { id: 'crash', label: 'Crash', description: 'throws', params: {}, permissions: [] },
    { id: 'liar', label: 'Liar', description: 'claims a file', params: {}, permissions: [] },
  ],
  ...over,
});

interface MockState { failProbe: boolean; failHealth: boolean; version: string }

function mockFactory(m: AdapterManifest, calls: string[], state: MockState): AdapterFactory {
  const make = (): ExternalAdapter => ({
    probe: async () => { calls.push('probe'); if (state.failProbe) throw new Error('cannot start'); return { version: state.version }; },
    connect: async () => { calls.push('connect'); },
    disconnect: async () => { calls.push('disconnect'); },
    healthCheck: async () => { calls.push('health'); return state.failHealth ? { ok: false, detail: 'not healthy' } : { ok: true, detail: 'ok' }; },
    dispose: async () => { calls.push('dispose'); },
    execute: async (cmd, params, ctx) => {
      calls.push(`exec:${cmd.id}`);
      if (cmd.id === 'make') { const f = path.join(ctx.workDir, String(params.name)); await fs.writeFile(f, 'data'); return { message: 'made', outputs: [f] }; }
      if (cmd.id === 'hang') return new Promise(() => undefined);
      if (cmd.id === 'crash') throw new Error('boom');
      if (cmd.id === 'liar') return { message: 'done', outputs: [path.join(ctx.workDir, 'missing.bin')] };
      if (cmd.id === 'wipe') throw new AdapterError('app-error', 'app said no');
      return { message: 'ok', outputs: [] };
    },
  });
  return { manifest: m, create: make };
}

async function setup(opts: { answer?: ApprovalAnswer; state?: Partial<MockState> } = {}) {
  const exe = path.join(tmp, `mockapp-${Math.random().toString(36).slice(2)}`, 'mockapp.exe');
  await fs.mkdir(path.dirname(exe), { recursive: true });
  await fs.writeFile(exe, 'x');
  const calls: string[] = [];
  const asked: Array<{ needed: Permission[]; destructive: boolean }> = [];
  let stored: Record<string, Permission[]> = {};
  const mgr = new IntegrationManager({
    workDir: async (id) => path.join(tmp, 'work', id),
    permissions: { load: async () => stored, save: async (g) => { stored = g; } },
    approve: async (r) => { asked.push({ needed: r.needed, destructive: r.destructive }); return opts.answer ?? 'always'; },
    discovery: fakeEnv({ files: [exe] }),
    userPaths: async () => [exe],
  });
  mgr.register(mockFactory(manifest(), calls, { failProbe: false, failHealth: false, version: '2.5.0', ...opts.state }));
  const scan = await mgr.scan();
  return { mgr, calls, asked, scan, key: scan.apps[0]!.key, grants: () => stored };
}

describe('versions and manifests', () => {
  it('compares and ranges', () => {
    expect(compareVersions('4.0.2', '4.0')).toBe(1);
    expect(compareVersions('3.6', '4.0')).toBe(-1);
    expect(versionSupported('4.0', { min: '3.6' })).toBe('ok');
    expect(versionSupported('2.9', { min: '3.6' })).toBe('too-old');
    expect(versionSupported('5.0', { max: '4.9' })).toBe('too-new');
    expect(versionSupported(null, { min: '3.6' })).toBe('unknown');
  });
  it('rejects bad manifests', () => {
    expect(validateManifest(manifest({ sdkVersion: 99 }), 1).join()).toMatch(/SDK 99/);
    expect(validateManifest(manifest({ id: 'Bad Id' }), 1).join()).toMatch(/id must/);
    expect(validateManifest(manifest({ maturity: 'stub' }), 1).join()).toMatch(/stub adapter must not declare commands/);
    expect(validateManifest(manifest(), 1)).toEqual([]);
  });
  it('the built-in manager registers Blender and the vendor stubs and refuses duplicates', () => {
    const m = createIntegrationManager({ workDir: async () => tmp, permissions: noPerms, approve: async () => 'deny' });
    const ids = m.manifests().map((x) => x.id);
    expect(ids).toContain('blender');
    expect(ids).toEqual(expect.arrayContaining(['autodesk.revit', 'adobe.photoshop', 'freecad', 'godot', 'davinci.resolve', 'unreal', 'unity']));
    expect(m.manifests().filter((x) => x.maturity === 'stub').every((x) => x.commands.length === 0)).toBe(true);
    expect(() => m.register({ manifest: m.manifests()[0]!, create: () => ({}) as ExternalAdapter })).toThrow(/already registered/);
  });
});

describe('discovery', () => {
  it('parses reg output', () => {
    const rows = parseRegQuery('HKEY_LOCAL_MACHINE\\X\\Blender\r\n    DisplayName    REG_SZ    Blender 4.0\r\n    DisplayVersion    REG_SZ    4.0.2\r\n');
    expect(rows[0]!.values).toMatchObject({ DisplayName: 'Blender 4.0', DisplayVersion: '4.0.2' });
  });
  it.skipIf(!onWindows)('finds apps from the registry, common folders and user paths, and never reports others', async () => {
    const reg = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Blender\r\n    DisplayName    REG_SZ    Blender 4.0\r\n    Publisher    REG_SZ    Blender Foundation\r\n    DisplayVersion    REG_SZ    4.0.2\r\n    InstallLocation    REG_SZ    D:\\Apps\\Blender\r\n'
      + 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other\r\n    DisplayName    REG_SZ    Some Game\r\n';
    const env = fakeEnv({ files: ['D:\\Apps\\Blender\\blender.exe', 'C:\\Program Files\\Autodesk\\Revit 2024\\Revit.exe', 'C:\\Portable\\FreeCAD\\bin\\FreeCAD.exe'], reg, dirs: { 'C:\\Program Files': ['Autodesk'], 'C:\\Program Files\\Autodesk': ['Revit 2024'] } });
    const found = await discoverApps([{ exeNames: ['blender.exe'], displayNames: ['^Blender'] }, { exeNames: ['Revit.exe'], displayNames: ['^Autodesk Revit'] }, { exeNames: ['FreeCAD.exe'], displayNames: ['^FreeCAD'] }], env, ['C:\\Portable\\FreeCAD\\bin\\FreeCAD.exe']);
    const by = Object.fromEntries(found.map((a) => [path.basename(a.exePath), a.source]));
    expect(by).toEqual({ 'blender.exe': 'registry', 'Revit.exe': 'common-dir', 'FreeCAD.exe': 'user' });
    expect(found.find((a) => a.source === 'registry')).toMatchObject({ publisher: 'Blender Foundation', version: '4.0.2' });
  });
  it('reports a missing application as missing, not as an error', async () => {
    const mgr = new IntegrationManager({ workDir: async () => tmp, permissions: noPerms, approve: async () => 'deny', discovery: fakeEnv() });
    mgr.register(mockFactory(manifest(), [], { failProbe: false, failHealth: false, version: '2.5' }));
    const r = await mgr.scan();
    expect(r.apps).toEqual([]);
    expect(r.missing.map((m) => m.adapterId)).toEqual(['mock.app']);
    expect((await mgr.execute('nope', 'make')).error?.kind).toBe('missing-app');
  });
});

describe('lifecycle and status', () => {
  it('connect, repeated connect/disconnect, status', async () => {
    const t = await setup();
    expect(t.scan.apps[0]).toMatchObject({ status: 'available', version: '2.5.0', adapterId: 'mock.app' });
    for (let i = 0; i < 3; i++) {
      expect((await t.mgr.connect(t.key)).status).toBe('limited'); // experimental adapter
      expect((await t.mgr.connect(t.key)).status).toBe('limited'); // idempotent
      expect((await t.mgr.disconnect(t.key))!.status).toBe('available');
    }
    expect(t.calls.filter((c) => c === 'connect')).toHaveLength(3);
  });
  it('incompatible, and a failed health check needs repair', async () => {
    const old = await setup({ state: { version: '1.0' } });
    expect(old.scan.apps[0]!.status).toBe('incompatible');
    await expect(old.mgr.connect(old.key)).rejects.toThrow(/older than/);
    const sick = await setup({ state: { failHealth: true } });
    await expect(sick.mgr.connect(sick.key)).rejects.toThrow(/not healthy/);
    expect((await sick.mgr.list())[0]!.status).toBe('needs-repair');
  });
  it('stubs are unsupported, offer no commands and cannot connect', async () => {
    const exe = path.join(tmp, 'Revit.exe');
    await fs.writeFile(exe, 'x');
    const mgr = createIntegrationManager({ workDir: async () => tmp, permissions: noPerms, approve: async () => 'always', discovery: fakeEnv({ files: [exe] }), userPaths: async () => [exe] });
    const scan = await mgr.scan();
    const app = scan.apps.find((a) => a.adapterId === 'autodesk.revit')!;
    expect(app).toMatchObject({ status: 'unsupported', commands: [] });
    await expect(mgr.connect(app.key)).rejects.toThrow(/placeholder/);
    expect((await mgr.execute(app.key, 'anything')).error?.kind).toBe('unsupported');
  });
});

describe('execution', () => {
  it('runs, verifies outputs and asks only for missing permissions', async () => {
    const t = await setup();
    const r = await t.mgr.execute(t.key, 'make', { name: 'a.txt' });
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(r.outputs[0]).toMatchObject({ bytes: 4, kind: 'txt' });
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]!.needed).toEqual(['launch', 'write-files']);
    expect(t.grants()[t.key]).toEqual(['launch', 'write-files']);
    await t.mgr.execute(t.key, 'make', { name: 'b.txt' });
    expect(t.asked).toHaveLength(1); // granted before, not asked again
  });
  it('validates params and unknown commands', async () => {
    const t = await setup();
    expect((await t.mgr.execute(t.key, 'make', { n: 99 })).error).toMatchObject({ kind: 'invalid-params' });
    expect((await t.mgr.execute(t.key, 'make', { bogus: 1 })).error?.kind).toBe('invalid-params');
    expect((await t.mgr.execute(t.key, 'nonexistent')).error?.kind).toBe('unsupported');
    expect(t.asked).toHaveLength(0);
  });
  it('denied permission runs nothing; destructive commands always ask', async () => {
    const denied = await setup({ answer: 'deny' });
    const r = await denied.mgr.execute(denied.key, 'make');
    expect(r.error?.kind).toBe('permission-denied');
    expect(denied.calls).not.toContain('exec:make');
    const t = await setup({ answer: 'always' });
    await t.mgr.execute(t.key, 'wipe');
    const second = await t.mgr.execute(t.key, 'wipe');
    expect(t.asked.filter((a) => a.destructive)).toHaveLength(2);
    expect(second.error).toMatchObject({ kind: 'app-error', message: 'app said no' });
  });
  it('times out, recovers from crashes, and does not trust claimed outputs', async () => {
    const t = await setup();
    expect((await t.mgr.execute(t.key, 'hang')).error?.kind).toBe('timeout');
    expect((await t.mgr.execute(t.key, 'crash')).error?.kind).toBe('internal');
    expect((await t.mgr.list())[0]!.status).toBe('available'); // session dropped; the next call reconnects
    expect(await t.mgr.execute(t.key, 'liar')).toMatchObject({ ok: false, error: { kind: 'verification-failed' } });
    expect((await t.mgr.execute(t.key, 'make', { name: 'again.txt' })).ok).toBe(true);
    expect(t.mgr.log().length).toBeGreaterThanOrEqual(4);
  });
  it('revoking grants asks again', async () => {
    const t = await setup();
    await t.mgr.execute(t.key, 'make');
    await t.mgr.revoke(t.key);
    await t.mgr.execute(t.key, 'make');
    expect(t.asked).toHaveLength(2);
  });
});

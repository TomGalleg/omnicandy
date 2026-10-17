// Discovery of programs in custom places (secondary drives), remembered locations and placeholder replacement.
// All with a fake Windows environment: no real registry, no real drives.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADAPTER_SDK_VERSION, type AdapterManifest } from '@shared/integrations';
import { discoverApps, programOf, type DiscoveryEnv } from './discovery';
import { createIntegrationManager } from './index';
import type { AdapterFactory, ExternalAdapter } from './sdk';

const HKLM = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const rows = (items: Array<Record<string, string>>) => items.map((v, i) => `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\App${i}\r\n${Object.entries(v).map(([k, x]) => `    ${k}    REG_SZ    ${x}`).join('\r\n')}\r\n`).join('\r\n');

interface Env { files?: string[]; uninstall?: Array<Record<string, string>>; shortcuts?: string[]; dirs?: Record<string, string[]> }
function fakeEnv(o: Env = {}): DiscoveryEnv & { listed: string[]; existsCalls: number } {
  const files = new Set((o.files ?? []).map((f) => f.toLowerCase()));
  const env = {
    listed: [] as string[],
    existsCalls: 0,
    env: { ProgramFiles: 'C:\\Program Files', PATH: '' },
    exists: async (p: string) => { env.existsCalls++; return files.has(p.toLowerCase()); },
    listDir: async (p: string) => { env.listed.push(p); return (o.dirs?.[p] ?? []).map((n) => ({ name: n, dir: true })); },
    run: async (file: string, args: string[]) => {
      if (file === 'reg' && args[1] === HKLM) return rows(o.uninstall ?? []);
      if (file === 'powershell.exe' && /CreateShortcut/.test(args.join(' '))) return (o.shortcuts ?? []).join('\r\n');
      return '';
    },
  };
  return env;
}
const FC = [{ exeNames: ['FreeCADCmd.exe'], displayNames: ['^FreeCAD'] }];

// These tests simulate a Windows PC (backslash paths, registry text). Linux discovery is covered in discoveryLinux.test.ts.
const onWindows = process.platform === 'win32';

describe.skipIf(!onWindows)('discovery of programs in custom locations', () => {
  it('parses the program out of an uninstall command', () => {
    expect(programOf('"E:\\FreeCAD 1.1\\Uninstall.exe" /S')).toBe('E:\\FreeCAD 1.1\\Uninstall.exe');
    expect(programOf('D:\\Tools\\unins000.exe /SILENT')).toBe('D:\\Tools\\unins000.exe');
    expect(programOf('MsiExec.exe /X{ABC}')).toBe('MsiExec.exe');
    expect(programOf(undefined)).toBeNull();
    expect(programOf('rundll32 something')).toBeNull();
  });

  it('finds a program on another drive from the uninstall record icon when InstallLocation is empty (the real FreeCAD case)', async () => {
    const env = fakeEnv({
      files: ['E:\\FreeCAD 1.1\\bin\\FreeCAD.exe', 'E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe'],
      uninstall: [{ DisplayName: 'FreeCAD 1.1.4', DisplayVersion: '1.1.4', Publisher: 'FreeCAD Team', DisplayIcon: 'E:\\FreeCAD 1.1\\bin\\FreeCAD.exe', InstallLocation: '' }],
    });
    const found = await discoverApps(FC, env);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ exePath: 'E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe', source: 'registry', version: '1.1.4', publisher: 'FreeCAD Team' });
  });

  it('uses the uninstaller folder and its bin folder when the record has neither location nor icon', async () => {
    const env = fakeEnv({
      files: ['D:\\Apps\\Tool\\bin\\FreeCADCmd.exe'],
      uninstall: [{ DisplayName: 'FreeCAD 0.21', DisplayVersion: '0.21.2', UninstallString: '"D:\\Apps\\Tool\\uninstall.exe" /S' }],
    });
    expect((await discoverApps(FC, env)).map((a) => a.exePath)).toEqual(['D:\\Apps\\Tool\\bin\\FreeCADCmd.exe']);
  });

  it('finds a program through a Start Menu shortcut and ignores shortcuts to unrelated places', async () => {
    const env = fakeEnv({
      files: ['G:\\CAD\\FreeCAD 1.0\\bin\\FreeCADCmd.exe'],
      shortcuts: ['G:\\CAD\\FreeCAD 1.0\\bin\\FreeCAD.exe', 'C:\\Windows\\notepad.exe', '', 'not a path'],
    });
    const found = await discoverApps(FC, env);
    expect(found.map((a) => [a.exePath, a.source, a.name])).toEqual([['G:\\CAD\\FreeCAD 1.0\\bin\\FreeCADCmd.exe', 'shortcut', 'FreeCAD 1.0']]);
  });

  it('keeps several installed versions apart', async () => {
    const env = fakeEnv({
      files: ['E:\\FreeCAD 1.0\\bin\\FreeCADCmd.exe', 'E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe'],
      uninstall: [
        { DisplayName: 'FreeCAD 1.0.2', DisplayVersion: '1.0.2', DisplayIcon: 'E:\\FreeCAD 1.0\\bin\\FreeCAD.exe' },
        { DisplayName: 'FreeCAD 1.1.4', DisplayVersion: '1.1.4', DisplayIcon: 'E:\\FreeCAD 1.1\\bin\\FreeCAD.exe' },
      ],
      shortcuts: ['E:\\FreeCAD 1.1\\bin\\FreeCAD.exe'],
    });
    const found = await discoverApps(FC, env);
    expect(found.map((a) => [a.exePath, a.version]).sort()).toEqual([['E:\\FreeCAD 1.0\\bin\\FreeCADCmd.exe', '1.0.2'], ['E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe', '1.1.4']]);
  });

  it('is not fooled by records whose files are gone, or by other programs, and does not fail', async () => {
    const env = fakeEnv({
      files: [],
      uninstall: [{ DisplayName: 'FreeCAD 1.1.4', DisplayIcon: 'E:\\Gone\\bin\\FreeCAD.exe', InstallLocation: 'E:\\Gone' }, { DisplayName: 'Some Game', DisplayIcon: 'E:\\Game\\game.exe' }],
      shortcuts: ['E:\\Gone\\bin\\FreeCAD.exe'],
    });
    expect(await discoverApps(FC, env, [], ['E:\\Unplugged\\bin\\FreeCADCmd.exe'])).toEqual([]);
  });

  it('never walks drives: only the standard roots are listed and the number of checks stays small', async () => {
    const env = fakeEnv({ files: ['E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe'], uninstall: [{ DisplayName: 'FreeCAD 1.1.4', DisplayIcon: 'E:\\FreeCAD 1.1\\bin\\FreeCAD.exe' }], shortcuts: ['E:\\FreeCAD 1.1\\bin\\FreeCAD.exe'] });
    await discoverApps(FC, env);
    expect(env.listed.every((p) => /^C:\\Program Files/i.test(p))).toBe(true);
    expect(env.existsCalls).toBeLessThan(40);
  });

  it('uses remembered locations only while the file exists', async () => {
    const env = fakeEnv({ files: ['E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe'] });
    const found = await discoverApps(FC, env, [], ['E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe', 'F:\\Unplugged\\bin\\FreeCADCmd.exe']);
    expect(found.map((a) => [a.exePath, a.source, a.name])).toEqual([['E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe', 'remembered', 'FreeCAD 1.1']]);
  });
});

const realManifest = (): AdapterManifest => ({
  id: 'freecad', name: 'FreeCAD', vendor: 'Test', sdkVersion: ADAPTER_SDK_VERSION, maturity: 'experimental', exeNames: ['FreeCADCmd.exe'], displayNames: ['^FreeCAD'],
  versions: { min: '0.21' }, methods: ['scripting'], capabilities: ['executeCommand', 'connect', 'disconnect'],
  commands: [{ id: 'x', label: 'X', description: 'x', params: {}, permissions: [] }],
});
const realFactory = (): AdapterFactory => ({
  manifest: realManifest(),
  create: (): ExternalAdapter => ({ probe: async () => ({ version: '1.1.4' }), connect: async () => undefined, disconnect: async () => undefined, healthCheck: async () => ({ ok: true, detail: 'ok' }), dispose: async () => undefined, execute: async () => ({ message: 'ok', outputs: [] }) }),
});
const noPerms = { load: async () => ({}), save: async () => undefined };

describe.skipIf(!onWindows)('remembered locations and placeholder replacement in the manager', () => {
  it('remembers a program found through an uninstall record and still finds it after the record is gone', async () => {
    let stored: string[] = [];
    const withRecord = fakeEnv({ files: ['E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe'], uninstall: [{ DisplayName: 'FreeCAD 1.1.4', DisplayIcon: 'E:\\FreeCAD 1.1\\bin\\FreeCAD.exe' }] });
    const m1 = createIntegrationManager({ workDir: async () => 'x', permissions: noPerms, approve: async () => 'deny', discovery: withRecord, remembered: { load: async () => stored, save: async (p) => { stored = p; } } });
    m1.register(realFactory());
    expect((await m1.scan()).apps.map((a) => a.exePath)).toEqual(['E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe']);
    expect(stored).toEqual(['E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe']);

    const noRecord = fakeEnv({ files: ['E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe'] });
    const m2 = createIntegrationManager({ workDir: async () => 'x', permissions: noPerms, approve: async () => 'deny', discovery: noRecord, remembered: { load: async () => stored, save: async (p) => { stored = p; } } });
    m2.register(realFactory());
    const r = await m2.scan();
    expect(r.apps.map((a) => [a.exePath, a.source])).toEqual([['E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe', 'remembered']]);
    expect(stored).toHaveLength(1); // not duplicated

    const unplugged = fakeEnv({ files: [] });
    const m3 = createIntegrationManager({ workDir: async () => 'x', permissions: noPerms, approve: async () => 'deny', discovery: unplugged, remembered: { load: async () => stored, save: async (p) => { stored = p; } } });
    m3.register(realFactory());
    expect((await m3.scan()).apps).toEqual([]);
    expect(stored).toHaveLength(1); // kept for when the drive is back
  });

  it('a manager without a store behaves as before', async () => {
    const env = fakeEnv({ files: ['E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe'], shortcuts: ['E:\\FreeCAD 1.1\\bin\\FreeCAD.exe'] });
    const m = createIntegrationManager({ workDir: async () => 'x', permissions: noPerms, approve: async () => 'deny', discovery: env });
    m.register(realFactory());
    expect((await m.scan()).apps).toHaveLength(1);
  });

  it('installing a real adapter removes the unsupported placeholder entry at once, without a rescan, and removing it brings the placeholder back', async () => {
    const env = fakeEnv({
      files: ['E:\\FreeCAD 1.1\\bin\\FreeCAD.exe', 'E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe'],
      uninstall: [{ DisplayName: 'FreeCAD 1.1.4', DisplayVersion: '1.1.4', DisplayIcon: 'E:\\FreeCAD 1.1\\bin\\FreeCAD.exe' }],
    });
    const m = createIntegrationManager({ workDir: async () => 'x', permissions: noPerms, approve: async () => 'deny', discovery: env });
    const before = await m.scan();
    // The placeholder wants FreeCAD.exe or FreeCADCmd.exe: both of this install are found, both unsupported.
    expect(before.apps.length).toBeGreaterThan(0);
    expect(before.apps.every((a) => a.status === 'unsupported' && a.adapterId === 'freecad')).toBe(true);

    m.register(realFactory());
    const listed = await m.list();
    expect(listed.filter((a) => a.status === 'unsupported')).toEqual([]); // stale entries are gone immediately
    const after = await m.scan();
    expect(after.apps.map((a) => [path.basename(a.exePath), a.status])).toEqual([['FreeCADCmd.exe', 'available']]);

    await m.unregister('freecad');
    expect(await m.list()).toEqual([]); // its entries leave with it
    const back = await m.scan();
    expect(back.apps.every((a) => a.status === 'unsupported')).toBe(true);
    expect(m.factory('freecad')?.manifest.maturity).toBe('stub');
  });
});

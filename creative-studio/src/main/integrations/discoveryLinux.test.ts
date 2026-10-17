// Synthetic Linux machines (injected file system); not captured from a real one.
import { describe, expect, it } from 'vitest';
import { discoverApps, type DiscoveryEnv } from './discovery';
import { execOfDesktop } from './discoveryLinux';

const targets = [{ exeNames: ['blender.exe', 'FreeCADCmd.exe'], displayNames: ['^Blender'] }];

function machine(files: string[], dirs: Record<string, Array<{ name: string; dir: boolean }>> = {}, texts: Record<string, string> = {}, env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: '/home/ada' }): DiscoveryEnv {
  return { os: 'linux', env, exists: async (p) => files.includes(p), listDir: async (p) => dirs[p] ?? [], run: async (cmd, args) => (cmd === 'cat' ? texts[args[0] ?? ''] ?? '' : '') };
}

describe('Linux application discovery', () => {
  it('maps Windows exe names to Linux names and finds programs on PATH and in /opt', async () => {
    const apps = await discoverApps(targets, machine(['/usr/bin/blender', '/opt/freecad/bin/FreeCADCmd'], { '/opt': [{ name: 'freecad', dir: true }] }));
    expect(apps.map((a) => a.exePath)).toEqual(['/usr/bin/blender', '/opt/freecad/bin/FreeCADCmd']);
    expect(apps.find((a) => a.exePath === '/usr/bin/blender')).toMatchObject({ installType: 'path', source: 'path' });
  });
  it('reads .desktop launchers and ignores field codes and env prefixes', async () => {
    expect(execOfDesktop('[Desktop Entry]\nExec=env LANG=C /opt/blender/blender %f\n')).toBe('/opt/blender/blender');
    expect(execOfDesktop('Exec="/opt/x y/blender" --foo %U')).toBe('/opt/x y/blender');
    expect(execOfDesktop('Exec=blender')).toBeNull();
    const apps = await discoverApps(targets, machine(['/opt/blender-4.0/blender'], { '/usr/share/applications': [{ name: 'blender.desktop', dir: false }] }, { '/usr/share/applications/blender.desktop': 'Exec=/opt/blender-4.0/blender %f' }, { PATH: '', HOME: '/home/ada' }));
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ exePath: '/opt/blender-4.0/blender', source: 'shortcut' });
  });
  it('finds user-chosen folders (bin subfolder too) and remembered programs, and nothing that does not exist', async () => {
    const apps = await discoverApps(targets, machine(['/data/Blender/bin/blender', '/old/blender']), ['/data/Blender'], ['/old/blender', '/gone/blender']);
    expect(apps.map((a) => a.exePath).sort()).toEqual(['/data/Blender/bin/blender', '/old/blender']);
  });
  it('Windows discovery is unchanged when no OS is given', async () => {
    const pf = 'C:\\Program Files';
    const exe = pf + '\\Blender Foundation\\Blender 4.0\\blender.exe';
    const win: DiscoveryEnv = { env: { ProgramFiles: pf, PATH: '' }, exists: async (p) => p.toLowerCase() === exe.toLowerCase(), listDir: async (p) => (p === pf ? [{ name: 'Blender Foundation', dir: true }] : p.endsWith('Blender Foundation') ? [{ name: 'Blender 4.0', dir: true }] : []), run: async () => '' };
    const apps = await discoverApps(targets, win);
    expect(apps.some((a) => /blender\.exe$/i.test(a.exePath))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { bundledClaudeCliPath, claudeLoginLaunch, defaultClaudeCliPath, findOnPath, isDirectlyRunnable, parsePsNames, processNames, pythonCandidates } from './exec';

const has = (...files: string[]) => async (p: string) => files.includes(p);

describe('per-OS execution helpers', () => {
  it('finds programs on PATH with the right separator and suffixes', async () => {
    expect(await findOnPath('xterm', { os: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' }, exists: has('/usr/bin/xterm') })).toBe('/usr/bin/xterm');
    expect(await findOnPath('xterm', { os: 'linux', env: { PATH: '/usr/bin' }, exists: has() })).toBeNull();
    expect(await findOnPath('python', { os: 'win32', env: { PATH: 'C:\\A;C:\\B', PATHEXT: '.EXE;.CMD' }, exists: has('C:\\B\\python.EXE') })).toBe('C:\\B\\python.EXE');
  });
  it('picks Python candidates per OS and honours CREATECRAFT_PYTHON', () => {
    expect(pythonCandidates('linux', {}).map((c) => c[0])).toEqual(['python3', 'python']);
    expect(pythonCandidates('win32', {}).map((c) => c[0])).toEqual(['python', 'py']);
    expect(pythonCandidates('linux', { CREATECRAFT_PYTHON: '/opt/py/bin/python3' })).toEqual([['/opt/py/bin/python3', []]]);
  });
  it('locates the Claude Code command where the installer puts it', () => {
    expect(defaultClaudeCliPath('linux', { HOME: '/home/ada' })).toBe('/home/ada/.local/bin/claude');
    expect(defaultClaudeCliPath('win32', { USERPROFILE: 'C:\\Users\\ada' })).toBe('C:\\Users\\ada\\.local\\bin\\claude.exe');
  });
  it('finds the Claude Code copy that ships inside the app, and refuses npm .cmd wrappers it cannot start', () => {
    expect(bundledClaudeCliPath('C:\\App\\resources\\app.asar.unpacked', 'win32', 'x64')).toBe('C:\\App\\resources\\app.asar.unpacked\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe');
    expect(bundledClaudeCliPath('/opt/app/resources/app.asar.unpacked', 'linux', 'x64')).toBe('/opt/app/resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude');
    expect(isDirectlyRunnable('C:\\Users\\ada\\AppData\\Roaming\\npm\\claude.cmd', 'win32')).toBe(false);
    expect(isDirectlyRunnable('C:\\Users\\ada\\.local\\bin\\claude.exe', 'win32')).toBe(true);
    expect(isDirectlyRunnable('/usr/local/bin/claude', 'linux')).toBe(true);
  });
  it('opens the sign-in in a terminal: cmd on Windows, the first installed terminal on Linux, null when none', async () => {
    const w = await claudeLoginLaunch('C:\\Users\\ada\\.local\\bin\\claude.exe', { os: 'win32' });
    expect(w).toMatchObject({ cmd: 'cmd.exe', verbatim: true });
    await expect(claudeLoginLaunch('C:\\x"&calc', { os: 'win32' })).rejects.toThrow(/Unexpected characters/);
    const l = await claudeLoginLaunch('/home/ada/.local/bin/claude', { os: 'linux', env: { PATH: '/usr/bin' }, exists: has('/usr/bin/gnome-terminal', '/usr/bin/xterm') });
    expect(l).toEqual({ cmd: '/usr/bin/gnome-terminal', args: ['--', '/home/ada/.local/bin/claude', 'auth', 'login'] });
    expect(await claudeLoginLaunch('/x/claude', { os: 'linux', env: { PATH: '/usr/bin' }, exists: has() })).toBeNull();
  });
  it('matches running programs by command name on Linux', () => {
    expect(processNames(['Blender.exe', 'FreeCADCmd.exe'], 'linux')).toEqual(['blender', 'freecadcmd']);
    expect(processNames(['Blender.exe'], 'win32')).toEqual(['blender.exe']);
    const ps = parsePsNames('systemd\nblender\n/usr/bin/FreeCADCmd\n\n');
    expect(ps.has('blender')).toBe(true);
    expect(ps.has('freecadcmd')).toBe(true);
    expect(ps.has('gimp')).toBe(false);
  });
});

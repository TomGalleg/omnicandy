// Small per-OS helpers for finding programs and running them: PATH lookup, Python candidates, the Claude Code command and its
// sign-in terminal, and the "is this program running" check. Every function takes the OS (and any file system access) as an
// argument so both systems are unit-tested on any machine; defaults use the real ones.

import fs from 'node:fs/promises';
import path from 'node:path';
import { currentOs, type OsId } from '@shared/platform';

export type Exists = (p: string) => Promise<boolean>;
const realExists: Exists = (p) => fs.access(p).then(() => true, () => false);

const pathMod = (os: OsId) => (os === 'win32' ? path.win32 : path.posix);

/** First place on PATH that holds `name` (on Windows: with each PATHEXT suffix). */
export async function findOnPath(name: string, o: { os?: OsId; env?: NodeJS.ProcessEnv; exists?: Exists } = {}): Promise<string | null> {
  const os = o.os ?? currentOs();
  const env = o.env ?? process.env;
  const exists = o.exists ?? realExists;
  const p = pathMod(os);
  const dirs = (env.PATH ?? env.Path ?? '').split(os === 'win32' ? ';' : ':').filter(Boolean);
  const exts = os === 'win32' ? ['', ...((env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean))] : [''];
  for (const d of dirs) for (const e of exts) { const f = p.join(d, name + e); if (await exists(f)) return f; }
  return null;
}

/** Python 3 interpreters to try, in order. Windows has the `py` launcher; Linux distributions ship `python3`. */
export function pythonCandidates(os: OsId = currentOs(), env: NodeJS.ProcessEnv = process.env): Array<[string, string[]]> {
  if (env.CREATECRAFT_PYTHON) return [[env.CREATECRAFT_PYTHON, []]];
  return os === 'win32' ? [['python', []], ['py', ['-3']]] : [['python3', []], ['python', []]];
}

/** Where the official installer puts the user's Claude Code command. */
export function defaultClaudeCliPath(os: OsId = currentOs(), env: NodeJS.ProcessEnv = process.env): string {
  if (os === 'win32') return path.win32.join(env.USERPROFILE ?? '', '.local', 'bin', 'claude.exe');
  return path.posix.join(env.HOME ?? '', '.local', 'bin', 'claude');
}

/** The Claude Code program that ships inside OmniCandy (the Agent SDK's own copy), so nothing has to be installed. `root` is the folder holding `node_modules` (the unpacked app folder in an installed build). */
export function bundledClaudeCliPath(root: string, os: OsId = currentOs(), arch: string = process.arch): string {
  const p = pathMod(os);
  return p.join(root, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${os}-${arch}`, os === 'win32' ? 'claude.exe' : 'claude');
}

/** A program OmniCandy can start directly. On Windows that excludes the .cmd/.bat wrappers that npm creates, which cannot be run without a shell. */
export const isDirectlyRunnable = (file: string, os: OsId = currentOs()): boolean => os !== 'win32' || /\.exe$/i.test(file);

/** Terminal programs tried (in this order) to show Claude Code's sign-in on Linux. Each runs the command after its separator. */
export const LINUX_TERMINALS: Array<{ cmd: string; sep: string[] }> = [
  { cmd: 'x-terminal-emulator', sep: ['-e'] }, { cmd: 'gnome-terminal', sep: ['--'] }, { cmd: 'konsole', sep: ['-e'] },
  { cmd: 'xfce4-terminal', sep: ['-x'] }, { cmd: 'xterm', sep: ['-e'] },
];

export interface LaunchPlan { cmd: string; args: string[]; verbatim?: boolean }

/** How to open Claude Code's `auth login` in a visible terminal, or null when no terminal program was found (Linux). */
export async function claudeLoginLaunch(cli: string, o: { os?: OsId; env?: NodeJS.ProcessEnv; exists?: Exists } = {}): Promise<LaunchPlan | null> {
  const os = o.os ?? currentOs();
  if (os === 'win32') {
    if (/["&|<>^%]/.test(cli)) throw new Error('Unexpected characters in the Claude Code path.');
    return { cmd: 'cmd.exe', args: ['/c', 'start', '"Sign in to Claude"', `"${cli}"`, 'auth', 'login'], verbatim: true };
  }
  for (const t of LINUX_TERMINALS) {
    const found = await findOnPath(t.cmd, { ...o, os });
    if (found) return { cmd: found, args: [...t.sep, cli, 'auth', 'login'] };
  }
  return null;
}

/** Process names to look for: Windows image names include `.exe`, Linux command names do not. */
export const processNames = (names: string[], os: OsId = currentOs()): string[] => names.map((n) => (os === 'win32' ? n : n.replace(/\.exe$/i, '')).toLowerCase());

/** Parses `ps -A -o comm=` (one command name per line). */
export function parsePsNames(out: string): Set<string> {
  return new Set(out.split('\n').map((l) => path.posix.basename(l.trim()).toLowerCase()).filter(Boolean));
}

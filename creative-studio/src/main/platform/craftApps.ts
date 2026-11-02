// Where the 13 Craft apps live. OmniCandy does not contain them; it drives separately installed programs.
// Windows: <Program Files>\<App>\<app>.exe and <app>-cli.exe (verified on this PC). Linux: no Linux builds are known, so no path
// is guessed and the apps are reported as unavailable instead of failing in odd ways. (No Wine, no invented locations.)

import fs from 'node:fs';
import path from 'node:path';
import { binName, currentOs, OS_LABEL, type OsId } from '@shared/platform';

export class CraftAppUnavailableError extends Error {
  constructor(app: string, os: OsId) {
    super(`${app} has no ${OS_LABEL[os]} version that OmniCandy knows about, so it cannot be used on this computer.`);
    this.name = 'CraftAppUnavailableError';
  }
}

/** The folder that holds the Craft app installs, or null when this system has no known place. */
export function craftInstallRoot(os: OsId = currentOs(), env: NodeJS.ProcessEnv = process.env): string | null {
  return os === 'win32' ? (env.ProgramFiles ?? 'C:\\Program Files') : null;
}

/** The folder the user chose with "Choose folder…" in the Software tab; looked at before the standard places. */
let userRoot: string | null = null;

/** The picked folder may be the one holding the apps (D:\Apps) or one app's own folder (D:\Apps\PhotoCraft): keep the former. */
export const craftRootFromPick = (picked: string): string => (/craft$/i.test(path.win32.basename(picked)) ? path.win32.dirname(picked) : picked);

export function loadCraftUserRoot(file: string): void {
  try { const r = (JSON.parse(fs.readFileSync(file, 'utf8')) as { root?: unknown }).root; userRoot = typeof r === 'string' && r ? r : null; } catch { userRoot = null; }
}

export function saveCraftUserRoot(file: string, root: string): void {
  userRoot = root;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ root }));
}

/** Folders a Craft app installer may have used, most common first. Windows only; elsewhere there are none. */
export function craftInstallRoots(os: OsId = currentOs(), env: NodeJS.ProcessEnv = process.env): string[] {
  if (os !== 'win32') return [];
  const roots = [userRoot, env.CRAFT_APPS_DIR, env.ProgramFiles ?? 'C:\\Program Files', env.ProgramW6432, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')];
  return [...new Set(roots.filter((r): r is string => !!r))];
}

/** Install folder of one Craft app (`PhotoCraft`): the first known location that actually holds it, else the standard Program Files one. Throws CraftAppUnavailableError where there is none. */
export function craftInstallDir(folder: string, os: OsId = currentOs(), env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  const root = craftInstallRoot(os, env);
  if (!root) throw new CraftAppUnavailableError(folder, os);
  const dirs = craftInstallRoots(os, env).map((r) => path.win32.join(r, folder));
  return dirs.find((d) => exists(d)) ?? path.win32.join(root, folder);
}

/** Full path of a program inside an install folder: `craftBin(dir, 'photocraft-cli')`. */
export const craftBin = (dir: string, base: string, os: OsId = currentOs()): string => path.join(dir, binName(base, os));

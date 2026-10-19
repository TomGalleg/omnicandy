// Where the 13 Craft apps live. OmniCandi does not contain them; it drives separately installed programs.
// Windows: <Program Files>\<App>\<app>.exe and <app>-cli.exe (verified on this PC). Linux: no Linux builds are known, so no path
// is guessed and the apps are reported as unavailable instead of failing in odd ways. (No Wine, no invented locations.)

import path from 'node:path';
import { binName, currentOs, OS_LABEL, type OsId } from '@shared/platform';

export class CraftAppUnavailableError extends Error {
  constructor(app: string, os: OsId) {
    super(`${app} has no ${OS_LABEL[os]} version that OmniCandi knows about, so it cannot be used on this computer.`);
    this.name = 'CraftAppUnavailableError';
  }
}

/** The folder that holds the Craft app installs, or null when this system has no known place. */
export function craftInstallRoot(os: OsId = currentOs(), env: NodeJS.ProcessEnv = process.env): string | null {
  return os === 'win32' ? (env.ProgramFiles ?? 'C:\\Program Files') : null;
}

/** Install folder of one Craft app (`PhotoCraft`). Throws CraftAppUnavailableError where there is none. */
export function craftInstallDir(folder: string, os: OsId = currentOs(), env: NodeJS.ProcessEnv = process.env): string {
  const root = craftInstallRoot(os, env);
  if (!root) throw new CraftAppUnavailableError(folder, os);
  return os === 'win32' ? path.win32.join(root, folder) : path.join(root, folder);
}

/** Full path of a program inside an install folder: `craftBin(dir, 'photocraft-cli')`. */
export const craftBin = (dir: string, base: string, os: OsId = currentOs()): string => path.join(dir, binName(base, os));

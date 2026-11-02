// Where the 13 Craft apps live. OmniCandy does not contain them; it drives separately installed programs.
// Windows: <Program Files>\<App>\<app>.exe and <app>-cli.exe (verified on this PC). Linux: no Linux builds are known, so no path
// is guessed and the apps are reported as unavailable instead of failing in odd ways. (No Wine, no invented locations.)

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
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
export const craftRootFromPick = (picked: string): string => {
  const name = path.win32.basename(picked);
  // "ArtCraft" is the folder that holds the apps, not an app: it must be kept as chosen.
  return /craft$/i.test(name) && !/^artcraft$/i.test(name) ? path.win32.dirname(picked) : picked;
};

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
  const bases = [env.ProgramFiles ?? 'C:\\Program Files', env.ProgramW6432, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')].filter((r): r is string => !!r);
  // Newer installers put every app under <Program Files>\ArtCraft\<App>; older ones directly under <Program Files>\<App>.
  const roots = [userRoot, env.CRAFT_APPS_DIR, ...bases, ...bases.map((b) => path.win32.join(b, 'ArtCraft'))];
  return [...new Set(roots.filter((r): r is string => !!r))];
}

/** Install folder of one Craft app (`PhotoCraft`): the first known location that actually holds it, else the standard Program Files one. Throws CraftAppUnavailableError where there is none. */
export function craftInstallDir(folder: string, os: OsId = currentOs(), env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  const root = craftInstallRoot(os, env);
  if (!root) throw new CraftAppUnavailableError(folder, os);
  const dirs = [...craftInstallRoots(os, env).map((r) => path.win32.join(r, folder)), ...(discovered.get(folder.toLowerCase()) ?? [])];
  return dirs.find((d) => exists(d)) ?? path.win32.join(root, folder);
}

/** Every place checked for one app, for the "not found" note. */
export const craftSearchedPlaces = (folder: string, os: OsId = currentOs(), env: NodeJS.ProcessEnv = process.env): string[] =>
  [...craftInstallRoots(os, env).map((r) => path.win32.join(r, folder)), ...(discovered.get(folder.toLowerCase()) ?? [])];

/** Install folders found by asking Windows (installed-programs registry) and by looking on every drive; lower-case app folder name to folders. */
let discovered = new Map<string, string[]>();

/** Registry text (`reg query ... /s`) to the folders it names for each app: an install location, an icon or an uninstall command inside `...\<App>`. */
export function parseRegistryDirs(text: string, folders: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of folders) {
    const re = new RegExp(`([A-Za-z]:\\\\[^"\\r\\n,]*?\\\\${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=[\\\\",\\s]|$)`, 'gi');
    const hits = new Set<string>();
    for (const m of text.matchAll(re)) hits.add(m[1]!);
    if (hits.size) out.set(f.toLowerCase(), [...hits]);
  }
  return out;
}

const REG_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
];

const realRun = (key: string): Promise<string> => new Promise((resolve) => {
  execFile('reg', ['query', key, '/s', '/f', 'Craft', '/d'], { timeout: 15000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (_e, stdout) => resolve(stdout ?? ''));
});

/** One check that cannot hang on an unreachable network drive. */
const existsSoon = (p: string): Promise<boolean> => Promise.race([fsp.access(p).then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 1500))]);

/** Finds where each app is installed, wherever that is, and remembers it for craftInstallDir. Windows only; never throws. */
export async function discoverCraftDirs(folders: string[], o: { os?: OsId; run?: (key: string) => Promise<string>; exists?: (p: string) => Promise<boolean>; drives?: string[] } = {}): Promise<void> {
  if ((o.os ?? currentOs()) !== 'win32') return;
  try {
    const run = o.run ?? realRun;
    const exists = o.exists ?? existsSoon;
    const text = (await Promise.all(REG_KEYS.map((k) => run(k).catch(() => '')))).join('\n');
    const found = parseRegistryDirs(text, folders);
    // One app's folder shows where the others are: its parent folder is a candidate for every app.
    const parents = [...new Set([...found.values()].flat().map((dir) => path.win32.dirname(dir)))];
    const drives = o.drives ?? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`);
    const next = new Map<string, string[]>();
    await Promise.all(folders.map(async (f) => {
      const onDrive = (d: string) => ['Program Files', 'Program Files (x86)'].flatMap((pf) => [path.win32.join(d, pf, f), path.win32.join(d, pf, 'ArtCraft', f)]).concat(path.win32.join(d, 'ArtCraft', f), path.win32.join(d, f));
      const cands = [...(found.get(f.toLowerCase()) ?? []), ...parents.map((r) => path.win32.join(r, f)), ...drives.flatMap(onDrive)];
      const ok: string[] = [];
      for (const c of [...new Set(cands)]) if (await exists(c)) ok.push(c);
      if (ok.length) next.set(f.toLowerCase(), ok);
    }));
    discovered = next;
  } catch { /* detection falls back to the standard folders */ }
}

/** Full path of a program inside an install folder: `craftBin(dir, 'photocraft-cli')`. */
export const craftBin = (dir: string, base: string, os: OsId = currentOs()): string => path.join(dir, binName(base, os));

/** Stops with a readable message when a program is missing, instead of letting the failed start crash the app as an uncaught error. */
export async function requireProgram(file: string, label: string): Promise<void> {
  try { await fsp.access(file); } catch {
    throw new Error(`${label} was not found at ${file}. See Settings > Diagnostics > ArtCraft detection for where OmniCandy looked, or use "Choose apps folder…" in the Software tab.`);
  }
}

// Windows Application Discovery Service. Runs locally and only looks for the executables that
// installed adapters declare (no full inventory is built, nothing is uploaded, no drive scan).
// Sources: Uninstall registry keys (install location, icon folder, uninstaller folder), App Paths, Start Menu
// shortcuts, common install folders (two levels deep), PATH, running processes, user-selected folders/files and
// folders remembered from earlier scans. Every source only asks "is one of the wanted executables in this one
// folder (or its bin subfolder)?"; no drive is ever walked.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiscoveredApp } from '@shared/integrations';

export interface DiscoveryTarget { exeNames: string[]; displayNames: string[] }

export interface DiscoveryEnv {
  /** Runs a command and returns stdout ('' on failure). */
  run(file: string, args: string[]): Promise<string>;
  env: NodeJS.ProcessEnv;
  exists(p: string): Promise<boolean>;
  listDir(p: string): Promise<Array<{ name: string; dir: boolean }>>;
}

export const realDiscoveryEnv: DiscoveryEnv = {
  run: (file, args) => new Promise((res) => {
    execFile(file, args, { windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (_e, out) => res(String(out ?? '')));
  }),
  env: process.env,
  exists: (p) => fs.stat(p).then(() => true, () => false),
  listDir: (p) => fs.readdir(p, { withFileTypes: true }).then((es) => es.map((e) => ({ name: e.name, dir: e.isDirectory() })), () => []),
};

const lower = (s: string) => s.toLowerCase();
const keyOf = (exe: string) => lower(path.normalize(exe));

/** Parses `reg query <key> /s` output into one record per subkey. */
export function parseRegQuery(out: string): Array<{ key: string; values: Record<string, string> }> {
  const rows: Array<{ key: string; values: Record<string, string> }> = [];
  let cur: { key: string; values: Record<string, string> } | null = null;
  for (const raw of out.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^HKEY_/i.test(raw)) { cur = { key: raw.trim(), values: {} }; rows.push(cur); continue; }
    const m = /^\s+(\S.*?)\s{4}REG_\w+\s{4}(.*)$/.exec(raw);
    if (m && cur) cur.values[m[1]!] = m[2]!.trim();
  }
  return rows;
}

const UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

/** Sources whose finding is worth remembering: they depend on records (uninstall entries, shortcuts) that can disappear. */
export const REMEMBERED_SOURCES: ReadonlyArray<DiscoveredApp['source']> = ['registry', 'app-paths', 'shortcut'];

/** The first program path in an uninstall command such as `"E:\App\unins.exe" /S`, or null (msiexec and the like are ignored). */
export function programOf(command: string | undefined): string | null {
  if (!command) return null;
  const m = /^\s*"([^"]+\.exe)"/i.exec(command) ?? /^\s*([^\s"]+\.exe)/i.exec(command);
  return m ? m[1]! : null;
}

// One PowerShell call lists where Start Menu shortcuts point (a cheap, reliable "this is installed here" signal).
const SHORTCUT_SCRIPT = "$s = New-Object -ComObject WScript.Shell; foreach ($r in @([Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('Programs'))) { if ($r -and (Test-Path $r)) { Get-ChildItem -LiteralPath $r -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object { try { $s.CreateShortcut($_.FullName).TargetPath } catch {} } } }";

export async function discoverApps(targets: DiscoveryTarget[], d: DiscoveryEnv = realDiscoveryEnv, userPaths: string[] = [], remembered: string[] = []): Promise<DiscoveredApp[]> {
  const exeCase = new Map(targets.flatMap((t) => t.exeNames.map((e) => [lower(e), e] as const)));
  const wantedExe = new Set(exeCase.keys());
  const orig = (e: string) => exeCase.get(e) ?? e;
  const nameRes = targets.flatMap((t) => t.displayNames.map((n) => new RegExp(n, 'i')));
  const found = new Map<string, DiscoveredApp>();
  const add = (a: Omit<DiscoveredApp, 'key'>) => {
    const key = keyOf(a.exePath);
    const prev = found.get(key);
    // Keep the richer record (registry knows version and publisher).
    if (!prev || (!prev.version && a.version) || (!prev.publisher && a.publisher)) found.set(key, { ...prev, ...a, name: prev && a.source !== 'registry' ? prev.name : a.name, version: a.version ?? prev?.version ?? null, publisher: a.publisher ?? prev?.publisher ?? null, key });
  };
  const isWanted = (file: string) => wantedExe.has(lower(path.basename(file)));
  /** The wanted executables that would sit directly in `dir`, or in its `bin` subfolder. */
  const exesIn = (dir: string) => [...wantedExe].flatMap((e) => [path.join(dir, orig(e)), path.join(dir, 'bin', orig(e))]);
  /** Adds every wanted executable that really exists in `dir` (or `dir\bin`); returns whether one was found. */
  const addFrom = async (dir: string, source: DiscoveredApp['source'], installType: DiscoveredApp['installType'], name = path.basename(dir)): Promise<boolean> => {
    let any = false;
    for (const exe of exesIn(dir)) {
      if (await d.exists(exe)) { add({ name: path.basename(path.dirname(exe)).toLowerCase() === 'bin' ? path.basename(path.dirname(path.dirname(exe))) : name, publisher: null, version: null, exePath: exe, installType, source }); any = true; }
    }
    return any;
  };

  // 1. Uninstall keys: match by display name, then find the executable under InstallLocation.
  for (const k of UNINSTALL_KEYS) {
    for (const row of parseRegQuery(await d.run('reg', ['query', k, '/s']))) {
      const name = row.values.DisplayName;
      if (!name || !nameRes.some((r) => r.test(name))) continue;
      const loc = row.values.InstallLocation?.replace(/^"|"$/g, '');
      const icon = row.values.DisplayIcon?.replace(/^"|"$/g, '').replace(/,-?\d+$/, '');
      // Many installers leave InstallLocation empty; the icon and the uninstaller still say where the program lives.
      const uninstaller = programOf(row.values.QuietUninstallString) ?? programOf(row.values.UninstallString);
      const candidates: string[] = [];
      if (icon && /\.exe$/i.test(icon)) candidates.push(icon);
      for (const dir of [loc, icon && /\.exe$/i.test(icon) ? path.dirname(icon) : undefined, uninstaller ? path.dirname(uninstaller) : undefined]) {
        if (dir) candidates.push(...exesIn(dir));
      }
      for (const c of candidates) {
        if (isWanted(c) && await d.exists(c)) {
          add({ name, publisher: row.values.Publisher ?? null, version: row.values.DisplayVersion ?? null, exePath: c, installType: 'installed', source: 'registry' });
          break;
        }
      }
    }
  }

  // 2. App Paths.
  for (const root of ['HKLM', 'HKCU']) {
    for (const row of parseRegQuery(await d.run('reg', ['query', `${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths`, '/s']))) {
      const exe = row.values['(Default)']?.replace(/^"|"$/g, '');
      if (exe && isWanted(exe) && await d.exists(exe)) add({ name: path.basename(exe, '.exe'), publisher: null, version: null, exePath: exe, installType: 'installed', source: 'app-paths' });
    }
  }

  // 2b. Start Menu shortcuts: where each one points tells where the program is installed.
  if (wantedExe.size) {
    const dirs = new Set<string>();
    for (const line of (await d.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SHORTCUT_SCRIPT])).split(/\r?\n/)) {
      const t = line.trim();
      if (/^[A-Za-z]:[\\/]/.test(t)) dirs.add(path.dirname(t));
    }
    for (const dir of dirs) await addFrom(dir, 'shortcut', 'installed');
  }

  // 3. Common install folders, two levels deep (vendor folder, then product folder).
  const roots = [d.env.ProgramFiles, d.env['ProgramFiles(x86)'], d.env.LOCALAPPDATA && path.join(d.env.LOCALAPPDATA, 'Programs')].filter((x): x is string => !!x);
  for (const root of roots) {
    for (const l1 of await d.listDir(root)) {
      if (!l1.dir) continue;
      const p1 = path.join(root, l1.name);
      const here = [p1, path.join(p1, 'bin')];
      for (const l2 of await d.listDir(p1)) if (l2.dir) here.push(path.join(p1, l2.name), path.join(p1, l2.name, 'bin'));
      for (const dir of here) {
        for (const e of wantedExe) {
          const exe = path.join(dir, orig(e));
          if (await d.exists(exe)) add({ name: path.basename(dir.endsWith('bin') ? path.dirname(dir) : dir), publisher: null, version: null, exePath: exe, installType: 'installed', source: 'common-dir' });
        }
      }
    }
  }

  // 4. PATH.
  for (const dir of (d.env.PATH ?? d.env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const e of wantedExe) {
      const exe = path.join(dir, orig(e));
      if (await d.exists(exe)) add({ name: path.basename(exe, '.exe'), publisher: null, version: null, exePath: exe, installType: 'path', source: 'path' });
    }
  }

  // 5. User-selected files or folders (portable copies).
  for (const p of userPaths) {
    if (isWanted(p) && await d.exists(p)) { add({ name: path.basename(p, '.exe'), publisher: null, version: null, exePath: p, installType: 'portable', source: 'user' }); continue; }
    // A portable folder holds the program directly, or in its bin subfolder.
    for (const exe of exesIn(p)) {
      if (await d.exists(exe)) add({ name: path.basename(p), publisher: null, version: null, exePath: exe, installType: 'portable', source: 'user' });
    }
  }

  // 5b. Folders found by an earlier scan (kept even while a drive is unplugged: they only count when the file exists).
  for (const p of remembered) {
    if (isWanted(p) && await d.exists(p)) add({ name: path.basename(path.dirname(p)).toLowerCase() === 'bin' ? path.basename(path.dirname(path.dirname(p))) : path.basename(path.dirname(p)), publisher: null, version: null, exePath: p, installType: 'installed', source: 'remembered' });
  }

  // 6. Running processes (only for executables we know about).
  const tl = await d.run('tasklist', ['/FO', 'CSV', '/NH']);
  const running = new Set(tl.split(/\r?\n/).map((l) => /^"([^"]+)"/.exec(l)?.[1]).filter((x): x is string => !!x).map(lower));
  for (const e of wantedExe) {
    if (!running.has(e) || [...found.values()].some((a) => lower(path.basename(a.exePath)) === e)) continue;
    const out = await d.run('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Name '${e.replace(/\.exe$/i, '').replace(/'/g, '')}' -ErrorAction SilentlyContinue | Select-Object -First 1).Path`]);
    const exe = out.trim();
    if (exe && await d.exists(exe)) add({ name: path.basename(exe, '.exe'), publisher: null, version: null, exePath: exe, installType: 'running', source: 'running' });
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

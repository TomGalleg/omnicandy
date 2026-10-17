// Application discovery on Linux. Same promise as the Windows one: it only asks "is one of the wanted programs in this folder?"
// for a short list of places, builds no inventory, walks no drive, uploads nothing. Sources: PATH, the usual program folders
// (/usr/local/bin, /usr/bin, /snap/bin, ~/.local/bin, /opt/<product> and /opt/<vendor>/<product>, each with a bin folder),
// the Exec line of .desktop launchers, folders the user chose, and folders found by an earlier scan.
// Written from the documented Linux conventions; not yet run on a Linux computer.

import path from 'node:path';
import type { DiscoveredApp } from '@shared/integrations';
import type { DiscoveryEnv, DiscoveryTarget } from './discovery';

const posix = path.posix;

/** The program a .desktop `Exec=` line starts, or null. Skips `env VAR=x`, quotes and `%f`-style field codes. */
export function execOfDesktop(content: string): string | null {
  const line = content.split('\n').find((l) => l.startsWith('Exec='));
  if (!line) return null;
  const tokens = line.slice(5).trim().match(/"[^"]*"|\S+/g) ?? [];
  let i = 0;
  if (tokens[i] === 'env') { i++; while (tokens[i] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i++; }
  const first = (tokens[i] ?? '').replace(/^"|"$/g, '');
  return first.startsWith('/') ? first : null;
}

export async function discoverAppsLinux(targets: DiscoveryTarget[], d: DiscoveryEnv, userPaths: string[] = [], remembered: string[] = []): Promise<DiscoveredApp[]> {
  // The manifests name Windows files ("blender.exe"); on Linux the program has no suffix.
  const wanted = new Map(targets.flatMap((t) => t.exeNames.map((e) => { const b = e.replace(/\.exe$/i, ''); return [b.toLowerCase(), b] as const; })));
  const found = new Map<string, DiscoveredApp>();
  const add = (exePath: string, installType: DiscoveredApp['installType'], source: DiscoveredApp['source'], name?: string) => {
    if (found.has(exePath)) return;
    found.set(exePath, { key: exePath, name: name ?? posix.basename(exePath), publisher: null, version: null, exePath, installType, source });
  };
  const tryDir = async (dir: string, installType: DiscoveredApp['installType'], source: DiscoveredApp['source']) => {
    for (const b of wanted.values()) { const f = posix.join(dir, b); if (await d.exists(f)) add(f, installType, source); }
  };
  const home = d.env.HOME;

  // 1. PATH
  for (const dir of (d.env.PATH ?? '').split(':').filter(Boolean)) await tryDir(dir, 'path', 'path');

  // 2. usual folders
  const fixed = ['/usr/local/bin', '/usr/bin', '/snap/bin', ...(home ? [posix.join(home, '.local', 'bin')] : [])];
  for (const dir of fixed) await tryDir(dir, 'installed', 'common-dir');
  for (const root of ['/opt', ...(home ? [posix.join(home, 'opt')] : [])]) {
    for (const l1 of await d.listDir(root)) {
      if (!l1.dir) continue;
      const p1 = posix.join(root, l1.name);
      const here = [p1, posix.join(p1, 'bin')];
      for (const l2 of await d.listDir(p1)) if (l2.dir) here.push(posix.join(p1, l2.name), posix.join(p1, l2.name, 'bin'));
      for (const dir of here) await tryDir(dir, 'installed', 'common-dir');
    }
  }

  // 3. .desktop launchers
  const appDirs = ['/usr/share/applications', '/usr/local/share/applications', ...(home ? [posix.join(home, '.local', 'share', 'applications')] : [])];
  for (const dir of appDirs) {
    for (const f of await d.listDir(dir)) {
      if (f.dir || !f.name.endsWith('.desktop')) continue;
      const content = await d.run('cat', [posix.join(dir, f.name)]); // a bounded read through the same injectable runner
      const exe = execOfDesktop(content);
      if (exe && wanted.has(posix.basename(exe).toLowerCase()) && await d.exists(exe)) add(exe, 'installed', 'shortcut');
    }
  }

  // 4. user-chosen programs or folders, then folders from an earlier scan
  for (const p of userPaths) {
    if (wanted.has(posix.basename(p).toLowerCase()) && await d.exists(p)) { add(p, 'portable', 'user'); continue; }
    for (const dir of [p, posix.join(p, 'bin')]) await tryDir(dir, 'portable', 'user');
  }
  for (const p of remembered) {
    if (wanted.has(posix.basename(p).toLowerCase()) && await d.exists(p)) add(p, 'installed', 'remembered');
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

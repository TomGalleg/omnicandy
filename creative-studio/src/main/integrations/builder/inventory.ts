// A local, read-only list of the programs Windows says are installed (name, publisher, version, location), minus system
// components and the programs OmniCandi already has an integration for. Used for "Option A: select an installed
// application". It never leaves the computer; nothing is scanned on disk beyond the uninstall records.

import path from 'node:path';
import type { InstalledProgram } from '@shared/builder';
import { parseRegQuery, programOf, realDiscoveryEnv, type DiscoveryEnv } from '../discovery';

const KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];
const NOISE = /(redistributable|runtime|driver|update for|security update|hotfix|\bKB\d{5,}|visual c\+\+|\.net (core|framework|runtime|sdk)|windows sdk|webview2|microsoft edge|vc_redist|language pack|python \d|node\.js|git version|nvidia (physx|hd audio|graphics|frameview|app)|intel\(r\)|realtek|help viewer|nuget|setup|bootstrapper)/i;

export interface IntegrationLookup {
  /** Does OmniCandi already have a working (non-placeholder) integration for a program with this name or exe? */
  covered(name: string, exeName: string | null): boolean;
}

export async function listInstalledPrograms(lookup: IntegrationLookup, env: DiscoveryEnv = realDiscoveryEnv): Promise<InstalledProgram[]> {
  const byName = new Map<string, InstalledProgram>();
  for (const k of KEYS) {
    for (const row of parseRegQuery(await env.run('reg', ['query', k, '/s']))) {
      const v = row.values;
      const name = v.DisplayName?.trim();
      if (!name || v.SystemComponent === '0x1' || v.ParentKeyName || v.ParentDisplayName || NOISE.test(name)) continue;
      if (/^microsoft (visual studio|windows)/i.test(name) && !/visual studio (code|community|professional|enterprise)/i.test(name)) continue;
      const loc = v.InstallLocation?.replace(/^"|"$/g, '') || null;
      const icon = v.DisplayIcon?.replace(/^"|"$/g, '').replace(/,-?\d+$/, '') ?? null;
      const uninstaller = programOf(v.QuietUninstallString) ?? programOf(v.UninstallString);
      let exe = icon && /\.exe$/i.test(icon) ? icon : null;
      if (exe && /unins|uninstall|setup|installer/i.test(path.basename(exe))) exe = null;
      const folder = loc ?? (exe ? path.dirname(exe) : uninstaller ? path.dirname(uninstaller) : null);
      const exeName = exe ? path.basename(exe) : null;
      if (lookup.covered(name, exeName)) continue;
      const key = name.toLowerCase();
      const prev = byName.get(key);
      const entry: InstalledProgram = { key, name, publisher: v.Publisher?.trim() || null, version: v.DisplayVersion?.trim() || null, exePath: exe, installLocation: folder };
      if (!prev || (!prev.exePath && entry.exePath)) byName.set(key, entry);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

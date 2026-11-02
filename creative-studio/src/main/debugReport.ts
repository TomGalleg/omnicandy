// A plain-text report a tester can send when something does not work: versions, where OmniCandy is installed, and every place it
// looked for the Craft apps. It holds no keys, passwords or project content (only file names and sizes).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppProbeResult } from '@shared/types';
import { craftInstallRoots } from './platform/craftApps';

const listDir = (dir: string, max = 60): string[] => {
  try {
    const names = fs.readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}\\` : e.name));
    return names.length > max ? [...names.slice(0, max), `… ${names.length - max} more`] : names;
  } catch (e) { return [`(cannot read: ${(e as Error).message})`]; }
};

const sizeOf = (file: string): string => { try { return `${fs.statSync(file).size} bytes`; } catch { return 'missing'; } };

export function buildDebugReport(o: { version: string; apps: AppProbeResult[]; dataDir: string; chosenFile: string; resourcesPath: string; execPath: string }): string {
  const env = process.env;
  const out: string[] = [];
  const section = (t: string) => out.push('', `== ${t} ==`);
  out.push(`OmniCandy debug report, ${new Date().toISOString()}`);

  section('This copy of OmniCandy');
  out.push(`version: ${o.version}`, `program: ${o.execPath}`, `resources: ${o.resourcesPath}`, `windows user: ${os.userInfo().username}`, `os: ${os.type()} ${os.release()} ${os.arch()}`);
  out.push(`ProgramFiles=${env.ProgramFiles ?? ''} | ProgramW6432=${env.ProgramW6432 ?? ''} | ProgramFiles(x86)=${env['ProgramFiles(x86)'] ?? ''} | LOCALAPPDATA=${env.LOCALAPPDATA ?? ''}`);
  const claude = path.join(o.resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe');
  out.push(`bundled Claude program: ${claude} (${sizeOf(claude)})`);

  section('Chosen apps folder (Software tab, Choose apps folder)');
  try { out.push(fs.readFileSync(o.chosenFile, 'utf8')); } catch { out.push('(none chosen)'); }

  section('Craft apps as OmniCandy sees them');
  for (const a of o.apps) out.push(`${a.displayName}: installed ${a.installed ? 'yes' : 'no'}${a.version ? ` (${a.version})` : ''}${a.notes.length ? ` | ${a.notes.join('; ')}` : ''}`);

  section('What is really in the folders OmniCandy searches');
  for (const root of craftInstallRoots()) {
    if (!fs.existsSync(root)) { out.push(`${root}: does not exist`); continue; }
    const crafts = listDir(root, 400).filter((n) => /craft/i.test(n));
    out.push(`${root}: ${crafts.length ? crafts.join(', ') : '(no folder with "Craft" in its name)'}`);
  }

  section('OmniCandy data folder (names only)');
  out.push(...listDir(o.dataDir).map((n) => `  ${n}`));
  return out.join('\r\n') + '\r\n';
}

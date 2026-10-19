import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { InstalledProgram } from '@shared/builder';

/** The product version stored in the program file (Windows), or null. Reads file properties only; the program is not started. */
async function fileVersion(file: string): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const script = `(Get-Item -LiteralPath '${file.replace(/'/g, "''")}').VersionInfo.ProductVersion`;
  return new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, windowsHide: true }, (_e, out) => res(/\d+\.\d+(?:\.\d+)?/.exec(String(out ?? ''))?.[0] ?? null)));
}

/** A program the user pointed at with a file picker (installed in an unusual place): name from the file name, which the user can still correct. */
export async function programFromPath(file: string): Promise<InstalledProgram> {
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) throw new Error('That file does not exist any more. Choose the program file again.');
  const ext = path.extname(file);
  if (process.platform === 'win32' && ext.toLowerCase() !== '.exe') throw new Error('Choose the program file (it ends in .exe).');
  const name = path.basename(file, ext).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Program';
  return { key: `picked:${path.normalize(file).toLowerCase()}`, name, publisher: null, version: await fileVersion(file), exePath: file, installLocation: path.dirname(file) };
}

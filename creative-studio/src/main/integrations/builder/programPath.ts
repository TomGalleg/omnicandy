import fs from 'node:fs/promises';
import path from 'node:path';
import type { InstalledProgram } from '@shared/builder';

/** A program the user pointed at with a file picker (installed in an unusual place): name from the file name, which the user can still correct. */
export async function programFromPath(file: string): Promise<InstalledProgram> {
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) throw new Error('That file does not exist any more. Choose the program file again.');
  const ext = path.extname(file);
  if (process.platform === 'win32' && ext.toLowerCase() !== '.exe') throw new Error('Choose the program file (it ends in .exe).');
  const name = path.basename(file, ext).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Program';
  return { key: `picked:${path.normalize(file).toLowerCase()}`, name, publisher: null, version: null, exePath: file, installLocation: path.dirname(file) };
}

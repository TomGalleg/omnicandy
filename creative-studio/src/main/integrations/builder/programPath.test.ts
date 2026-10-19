import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { programFromPath } from './programPath';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-prog-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });
const exe = process.platform === 'win32' ? '.exe' : '';

describe('programFromPath', () => {
  it('describes a program file chosen from any folder', async () => {
    const dir = path.join(tmp, 'D drive', 'Tools');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `my-cad_tool${exe}`);
    await fs.writeFile(file, 'x');
    expect(await programFromPath(file)).toEqual({ key: expect.stringContaining('picked:'), name: 'my cad tool', publisher: null, version: null, exePath: file, installLocation: dir });
  });

  it('splits a CamelCase file name into words', async () => {
    const file = path.join(tmp, `UnrealEditor${exe}`);
    await fs.writeFile(file, 'x');
    expect((await programFromPath(file)).name).toBe('Unreal Editor');
  });

  it.skipIf(process.platform !== 'win32')('reads the version stored in the program file without starting it', async () => {
    const p = await programFromPath(process.execPath);
    expect(p.version).toMatch(/^\d+\.\d+/);
  });

  it('refuses a file that is gone, and (on Windows) a file that is not a program', async () => {
    await expect(programFromPath(path.join(tmp, `nope${exe}`))).rejects.toThrow(/does not exist/);
    if (process.platform === 'win32') {
      const f = path.join(tmp, 'notes.txt');
      await fs.writeFile(f, 'x');
      await expect(programFromPath(f)).rejects.toThrow(/\.exe/);
    }
  });
});

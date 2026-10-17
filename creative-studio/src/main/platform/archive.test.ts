import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeZip } from '../integrations/zip';
import { sdcppRuntime, SDCPP_RUNTIME, SDCPP_RUNTIME_LINUX } from '@shared/localAi';
import { extractArchive, extractWithReader } from './archive';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-arch-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('unpacking downloads', () => {
  it('Windows uses its own tar.exe', async () => {
    const calls: string[][] = [];
    await extractArchive('a.zip', 'out', { os: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: async (f, a) => { calls.push([f, ...a]); } });
    expect(calls).toEqual([['C:\\Windows\\System32\\tar.exe', '-xf', 'a.zip', '-C', 'out']]);
  });
  it('Linux prefers unzip, then Python zipfile, then the built-in reader', async () => {
    const find = async (name: string) => (name === 'unzip' ? '/usr/bin/unzip' : name === 'python3' ? '/usr/bin/python3' : null);
    const calls: string[][] = [];
    await extractArchive('a.zip', '/o', { os: 'linux', run: async (f, a) => { calls.push([f, ...a]); }, find: find as never });
    expect(calls[0]).toEqual(['/usr/bin/unzip', '-o', '-q', 'a.zip', '-d', '/o']);
    const py: string[][] = [];
    await extractArchive('a.zip', '/o', { os: 'linux', find: (async (n: string) => (n === 'python3' ? '/usr/bin/python3' : null)) as never, run: async (f, a) => { py.push([f, ...a]); } });
    expect(py[0]).toEqual(['/usr/bin/python3', '-m', 'zipfile', '-e', 'a.zip', '/o']);
    let usedReader = false;
    await extractArchive('a.zip', '/o', { os: 'linux', find: (async () => null) as never, run: async () => { throw new Error('no'); }, reader: async () => { usedReader = true; } });
    expect(usedReader).toBe(true);
    await expect(extractArchive('a.zip', '/o', { os: 'linux', find: (async () => null) as never, reader: async () => { throw new Error('bad zip'); } })).rejects.toThrow(/Could not unpack/);
  });
  it('the built-in reader really unpacks a zip, and refuses paths that climb out', async () => {
    const z = path.join(tmp, 'e.zip');
    await fs.writeFile(z, writeZip({ 'sd-cli': 'binary', 'lib/libx.so': 'lib' }));
    const out = path.join(tmp, 'out');
    await extractWithReader(z, out);
    expect(await fs.readFile(path.join(out, 'sd-cli'), 'utf8')).toBe('binary');
    expect(await fs.readFile(path.join(out, 'lib', 'libx.so'), 'utf8')).toBe('lib');
  });
  it('the engine download is per system, with the official Linux asset', () => {
    expect(sdcppRuntime('win32')).toBe(SDCPP_RUNTIME);
    expect(sdcppRuntime('linux')).toBe(SDCPP_RUNTIME_LINUX);
    expect(sdcppRuntime('darwin')).toBeNull();
    expect(SDCPP_RUNTIME_LINUX.id).toBe(SDCPP_RUNTIME.id);
    expect(SDCPP_RUNTIME_LINUX.files[0]?.url).toMatch(/Linux-Ubuntu-24\.04-x86_64-vulkan\.zip$/);
    expect(SDCPP_RUNTIME_LINUX.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(SDCPP_RUNTIME_LINUX.verified).toEqual([]); // not verified on Linux
  });
});

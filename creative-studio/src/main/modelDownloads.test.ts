// Download manager rules with a fake server and tiny fake models. No network, no real model files.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalModel } from '@shared/localAi';
import { ModelDownloads, type Fetcher } from './modelDownloads';

const A = Buffer.alloc(5000, 7);
const B = Buffer.alloc(300, 9);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const model: LocalModel = {
  kind: 'model', engine: null, id: 'fake', name: 'Fake', version: '1', sourceUrl: '', license: 'x', licenseNote: '', downloadGb: 0, minVramGb: 1, minRamGb: 1,
  backends: ['cpu'], capabilities: ['text-to-video'], minTier: 'experimental', note: '', verified: [],
  files: [
    { path: 'big.bin', url: 'https://host/big.bin', bytes: A.length, sha256: sha(A) },
    { path: 'sub/small.json', url: 'https://host/small.json', bytes: B.length },
  ],
};
const DATA: Record<string, Buffer> = { 'https://host/big.bin': A, 'https://host/small.json': B };

/** A server that can cut the connection after `cutAt` bytes of the first request and honours Range. */
function server(o: { cutAt?: number; corrupt?: boolean; ignoreRange?: boolean } = {}) {
  const calls: Array<{ url: string; range: string | null }> = [];
  let cut = o.cutAt;
  const f: Fetcher = async (url, init) => {
    let data = DATA[url]!;
    if (o.corrupt && url.endsWith('big.bin')) data = Buffer.alloc(data.length, 1);
    const range = init.headers.Range ?? null;
    calls.push({ url, range });
    let start = 0;
    if (range && !o.ignoreRange) start = Number(/bytes=(\d+)-/.exec(range)![1]);
    let chunk = data.subarray(start);
    const cutting = cut !== undefined && url.endsWith('big.bin');
    if (cutting) chunk = chunk.subarray(0, cut);
    cut = undefined;
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (sent) {
          await new Promise((r) => setTimeout(r, 20)); // let the reader take the chunk first
          if (cutting) c.error(new Error('connection reset')); else c.close();
          return;
        }
        sent = true;
        c.enqueue(new Uint8Array(chunk));
      },
    });
    return new Response(stream, { status: start ? 206 : 200 });
  };
  return { f, calls };
}

describe('model download manager', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-models-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const mk = (f: Fetcher, free = 10 * 1024 ** 3) => new ModelDownloads({ modelDir: async () => dir, fetch: f, freeBytes: async () => free, models: [model] });

  it('does nothing without explicit consent', async () => {
    const s = server();
    const dl = mk(s.f);
    await expect(dl.start('fake', false)).rejects.toThrow(/accepted/);
    expect(s.calls).toHaveLength(0);
    expect((await dl.status())[0]!.state).toBe('idle');
  });

  it('downloads, verifies the checksum and marks it installed', async () => {
    const s = server();
    const dl = mk(s.f);
    await dl.start('fake', true);
    const end = await dl.wait('fake');
    expect(end.state).toBe('installed');
    expect(end.doneBytes).toBe(A.length + B.length);
    expect(await fs.readFile(path.join(dir, 'fake', 'big.bin'))).toEqual(A);
    expect(await dl.isInstalled('fake')).toBe(true);
    expect((await dl.status())[0]!.state).toBe('installed');
  });

  it('refuses when the disk is too small and downloads nothing', async () => {
    const s = server();
    const dl = mk(s.f, 1024);
    await expect(dl.start('fake', true)).rejects.toThrow(/Not enough disk space/);
    expect(s.calls).toHaveLength(0);
  });

  it('resumes after an interrupted download with a Range request', async () => {
    const s1 = server({ cutAt: 2000 });
    const dl1 = mk(s1.f);
    await dl1.start('fake', true);
    const failed = await dl1.wait('fake');
    expect(failed.state).toBe('failed');
    expect((await fs.stat(path.join(dir, 'fake', 'big.bin.part'))).size).toBe(2000);
    const s2 = server();
    const dl2 = mk(s2.f);
    await dl2.start('fake', true);
    expect((await dl2.wait('fake')).state).toBe('installed');
    expect(s2.calls[0]).toEqual({ url: 'https://host/big.bin', range: 'bytes=2000-' });
    expect(await fs.readFile(path.join(dir, 'fake', 'big.bin'))).toEqual(A);
  });

  it('restarts cleanly when the server ignores Range', async () => {
    await fs.mkdir(path.join(dir, 'fake'), { recursive: true });
    await fs.writeFile(path.join(dir, 'fake', 'big.bin.part'), A.subarray(0, 1000));
    const dl = mk(server({ ignoreRange: true }).f);
    await dl.start('fake', true);
    expect((await dl.wait('fake')).state).toBe('installed');
    expect(await fs.readFile(path.join(dir, 'fake', 'big.bin'))).toEqual(A);
  });

  it('deletes a corrupt file and does not mark the model installed', async () => {
    const dl = mk(server({ corrupt: true }).f);
    await dl.start('fake', true);
    const end = await dl.wait('fake');
    expect(end.state).toBe('failed');
    expect(end.message).toMatch(/checksum/);
    await expect(fs.stat(path.join(dir, 'fake', 'big.bin.part'))).rejects.toThrow();
    expect(await dl.isInstalled('fake')).toBe(false);
  });

  it('cancel keeps partial files and reports cancelled', async () => {
    const f: Fetcher = (_u, init) => new Promise((_res, rej) => { if (init.signal.aborted) rej(new Error('aborted')); init.signal.addEventListener('abort', () => rej(new Error('aborted'))); });
    const dl = mk(f);
    await dl.start('fake', true);
    await new Promise((r) => setTimeout(r, 20));
    dl.cancel('fake');
    expect((await dl.wait('fake')).state).toBe('cancelled');
    await expect(dl.start('fake', true)).resolves.toBeTruthy();
    dl.cancel('fake');
    await dl.wait('fake');
  });

  it('removes an installed model', async () => {
    const dl = mk(server().f);
    await dl.start('fake', true);
    await dl.wait('fake');
    await dl.remove('fake');
    expect(await dl.isInstalled('fake')).toBe(false);
    await expect(fs.stat(path.join(dir, 'fake'))).rejects.toThrow();
  });

  it('a model with no file list cannot be downloaded', async () => {
    const dl = new ModelDownloads({ modelDir: async () => dir, fetch: server().f, freeBytes: async () => 1e12, models: [{ ...model, files: [] }] });
    await expect(dl.start('fake', true)).rejects.toThrow(/cannot be downloaded/);
  });
});

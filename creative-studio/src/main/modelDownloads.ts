// Model download manager for Free local AI. Only runs when the user asks (the caller must pass
// explicit consent); resumes interrupted files with HTTP Range; checks each file's size and, when
// the host publishes one, its SHA-256; refuses when the disk is too small. Models live under the
// model folder, one folder per model, never inside a project and never in the installer.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LOCAL_MODELS, totalBytes, type DownloadState, type LocalModel } from '@shared/localAi';

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface DownloadDeps {
  modelDir: () => Promise<string>;
  fetch: Fetcher;
  /** Free bytes where the models go. */
  freeBytes: (dir: string) => Promise<number>;
  onChange?: (s: DownloadState) => void;
  models?: LocalModel[];
}

const MARGIN = 2 * 1024 ** 3;
const MARKER = 'install.json';

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}
const sizeOf = (f: string) => fs.stat(f).then((s) => s.size, () => 0);

export class ModelDownloads {
  private active = new Map<string, AbortController>();
  private states = new Map<string, DownloadState>();

  constructor(private readonly d: DownloadDeps) {}

  private model(id: string): LocalModel {
    const m = (this.d.models ?? LOCAL_MODELS).find((x) => x.id === id);
    if (!m) throw new Error('Unknown model.');
    return m;
  }

  private set(id: string, patch: Partial<DownloadState>): DownloadState {
    const m = this.model(id);
    const cur = this.states.get(id) ?? { modelId: id, state: 'idle' as const, doneBytes: 0, totalBytes: totalBytes(m), file: null, message: '' };
    const next = { ...cur, ...patch };
    this.states.set(id, next);
    this.d.onChange?.(next);
    return next;
  }

  async isInstalled(id: string): Promise<boolean> {
    const m = this.model(id);
    if (!m.files.length) return false;
    const dir = path.join(await this.d.modelDir(), id);
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, MARKER), 'utf8')) as { files?: string[] };
      for (const f of m.files) {
        if (!j.files?.includes(f.path)) return false;
        if ((await sizeOf(path.join(dir, ...f.path.split('/')))) !== f.bytes) return false;
      }
      return true;
    } catch { return false; }
  }

  async status(): Promise<DownloadState[]> {
    const out: DownloadState[] = [];
    for (const m of this.d.models ?? LOCAL_MODELS) {
      const live = this.states.get(m.id);
      if (live && (live.state === 'downloading' || live.state === 'verifying')) { out.push(live); continue; }
      if (await this.isInstalled(m.id)) out.push({ modelId: m.id, state: 'installed', doneBytes: totalBytes(m), totalBytes: totalBytes(m), file: null, message: 'Installed.' });
      else out.push(live ?? { modelId: m.id, state: 'idle', doneBytes: 0, totalBytes: totalBytes(m), file: null, message: '' });
    }
    return out;
  }

  cancel(id: string): void { this.active.get(id)?.abort(); }

  /** Removes the model folder (including partial downloads). */
  async remove(id: string): Promise<void> {
    this.model(id);
    if (this.active.has(id)) throw new Error('Cancel the download first.');
    await fs.rm(path.join(await this.d.modelDir(), id), { recursive: true, force: true });
    this.states.delete(id);
    this.set(id, { state: 'idle', doneBytes: 0, file: null, message: 'Removed.' });
  }

  /** Starts (or resumes) a download. `consented` must be true: the caller shows the license and size first. */
  async start(id: string, consented: boolean): Promise<DownloadState> {
    if (consented !== true) throw new Error('The license and download size must be accepted first.');
    const m = this.model(id);
    if (!m.files.length) throw new Error(`${m.name} cannot be downloaded through CreateCraft yet.`);
    if (this.active.has(id)) throw new Error('This model is already downloading.');
    const root = await this.d.modelDir();
    const dir = path.join(root, id);
    await fs.mkdir(dir, { recursive: true });

    let have = 0;
    for (const f of m.files) have += Math.min(f.bytes, await sizeOf(path.join(dir, ...f.path.split('/'))) + (await sizeOf(path.join(dir, ...f.path.split('/')) + '.part')));
    const need = totalBytes(m) - have;
    const free = await this.d.freeBytes(root);
    if (free < need + MARGIN) {
      throw new Error(`Not enough disk space: ${(need / 1024 ** 3).toFixed(1)} GB still to download plus a 2 GB safety margin, but only ${(free / 1024 ** 3).toFixed(1)} GB is free. Nothing was downloaded.`);
    }

    const ac = new AbortController();
    this.active.set(id, ac);
    this.set(id, { state: 'downloading', doneBytes: have, totalBytes: totalBytes(m), message: 'Downloading…' });
    void this.run(m, dir, ac).finally(() => this.active.delete(id));
    return this.states.get(id)!;
  }

  /** Resolves when the running download for this model finishes (tests and callers that want to wait). */
  async wait(id: string): Promise<DownloadState> {
    while (this.active.has(id)) await new Promise((r) => setTimeout(r, 10));
    return this.states.get(id)!;
  }

  private async run(m: LocalModel, dir: string, ac: AbortController): Promise<void> {
    const done: string[] = [];
    let counted = 0;
    try {
      for (const f of m.files) {
        const final = path.join(dir, ...f.path.split('/'));
        await fs.mkdir(path.dirname(final), { recursive: true });
        if ((await sizeOf(final)) === f.bytes) { done.push(f.path); counted += f.bytes; this.set(m.id, { doneBytes: counted, file: f.path }); continue; }
        const part = `${final}.part`;
        let start = await sizeOf(part);
        if (start > f.bytes) { await fs.rm(part, { force: true }); start = 0; }
        if (start < f.bytes) {
          this.set(m.id, { file: f.path, message: `Downloading ${f.path}` });
          const res = await this.d.fetch(f.url, { headers: start ? { Range: `bytes=${start}-` } : {}, signal: ac.signal });
          if (start && res.status === 200) { await fs.rm(part, { force: true }); start = 0; } // server ignored Range
          else if (!res.ok && res.status !== 206) throw new Error(`${f.path}: the download server answered HTTP ${res.status}.`);
          if (!res.body) throw new Error(`${f.path}: empty response.`);
          // Write each chunk as it arrives so a dropped connection keeps everything received (resume point).
          const out = await fs.open(part, start ? 'a' : 'w');
          let got = start;
          try {
            for await (const c of Readable.fromWeb(res.body as never) as AsyncIterable<Buffer>) {
              if (ac.signal.aborted) throw new Error('aborted');
              await out.write(c);
              got += c.length;
              this.set(m.id, { doneBytes: counted + got });
            }
          } finally { await out.close(); }
          if (got !== f.bytes) throw new Error(`${f.path}: the download stopped at ${got} of ${f.bytes} bytes. Start again to resume.`);
        }
        if (f.sha256) {
          this.set(m.id, { state: 'verifying', message: `Checking ${f.path}` });
          if ((await sha256(part)) !== f.sha256) {
            await fs.rm(part, { force: true });
            throw new Error(`${f.path} did not match its published checksum and was deleted. Start again to download it fresh.`);
          }
          this.set(m.id, { state: 'downloading' });
        }
        await fs.rename(part, final);
        done.push(f.path);
        counted += f.bytes;
        this.set(m.id, { doneBytes: counted });
      }
      await fs.writeFile(path.join(dir, MARKER), JSON.stringify({ modelId: m.id, version: m.version, files: done, installedAt: new Date().toISOString() }, null, 2));
      this.set(m.id, { state: 'installed', doneBytes: counted, file: null, message: 'Installed. Not tested yet: no clip has been generated with it.' });
    } catch (e) {
      if (ac.signal.aborted) this.set(m.id, { state: 'cancelled', message: 'Download cancelled. Files already downloaded are kept so it can resume.' });
      else this.set(m.id, { state: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  }
}

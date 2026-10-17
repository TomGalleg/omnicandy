// Runs a local text-to-video model with stable-diffusion.cpp (the installed Vulkan runtime). Free and
// local: no key, no approval dialog, no ledger entry. The result is a new library asset that is
// labelled as AI-generated with the model and settings. One clip at a time; cancel kills the process.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LOCAL_MODELS, type LocalModel } from '@shared/localAi';
import { clipSeconds, LOCAL_FPS, normalizeLocalJob, parseProgress, sdCliArgs, type LocalVideoJob } from '@shared/localVideo';
import type { Asset } from '@shared/types';
import type { ModelDownloads } from './modelDownloads';
import type { ProjectStore } from './projectStore';
import { binName, currentOs } from '@shared/platform';
import { craftBin, craftInstallDir } from './platform/craftApps';

export interface RunHandle { exitCode: Promise<number>; kill(): void }
export type Spawner = (exe: string, args: string[], o: { cwd: string; onLine: (l: string) => void }) => RunHandle;

const defaultSpawn: Spawner = (exe, args, o) => {
  const child = spawn(exe, args, { cwd: o.cwd, windowsHide: true });
  let buf = '';
  const feed = (d: Buffer) => {
    buf += d.toString('utf8');
    const parts = buf.split(/\r|\n/);
    buf = parts.pop() ?? '';
    for (const l of parts) if (l.trim()) o.onLine(l);
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  return {
    exitCode: new Promise((resolve) => { child.on('error', () => resolve(-1)); child.on('close', (c) => resolve(c ?? -1)); }),
    kill: () => { try { child.kill(); } catch { /* already gone */ } },
  };
};

export interface LocalVideoProgress { fraction: number | null; line: string }
export class LocalVideoCancelled extends Error {
  constructor() { super('Local video generation cancelled.'); this.name = 'LocalVideoCancelled'; }
}

export interface LocalVideoDeps {
  store: () => Promise<ProjectStore>;
  modelDir: () => Promise<string>;
  downloads: ModelDownloads;
  spawn?: Spawner;
  /** Turns a produced file (e.g. AVI) into an MP4 the library accepts. Default: FilmCraft headless. */
  toMp4?: (src: string, out: string) => Promise<void>;
  onProgress?: (p: LocalVideoProgress) => void;
  models?: LocalModel[];
}

const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.gif', '.avi', '.mkv'];

async function findFile(dir: string, names: string[]): Promise<string | null> {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = await findFile(p, names); if (r) return r; } else if (names.includes(e.name.toLowerCase())) return p;
  }
  return null;
}

export class LocalVideoService {
  private run: RunHandle | null = null;
  private cancelled = false;

  constructor(private readonly d: LocalVideoDeps) {}

  get busy() { return this.run !== null; }
  cancel() { this.cancelled = true; this.run?.kill(); }

  async render(raw: LocalVideoJob): Promise<{ asset: Asset; message: string }> {
    if (this.run) throw new Error('A local video is already being made.');
    const job = normalizeLocalJob(raw);
    const model = (this.d.models ?? LOCAL_MODELS).find((m) => m.id === job.modelId);
    if (!model || model.engine !== 'sdcpp') throw new Error('That model cannot run locally yet.');
    if (!(await this.d.downloads.isInstalled(model.id))) throw new Error(`${model.name} is not downloaded yet. Download it first.`);
    if (!(await this.d.downloads.isInstalled('sdcpp-vulkan-runtime'))) throw new Error('The local video engine (stable-diffusion.cpp) is not installed yet. Download it first.');
    const root = await this.d.modelDir();
    const exe = await findFile(path.join(root, 'sdcpp-vulkan-runtime'), [binName('sd-cli'), binName('sd')]);
    if (!exe) throw new Error(`The engine folder has no ${binName('sd-cli')}. Remove it and download the engine again.`);
    if (currentOs() !== 'win32') await fs.chmod(exe, 0o755).catch(() => undefined); // an unpacked download is not executable by default

    const store = await this.d.store();
    const tmp = path.join(await store.workDir('local-video'), randomUUID().slice(0, 8));
    await fs.mkdir(tmp, { recursive: true });
    this.cancelled = false;
    const out = path.join(tmp, 'out.avi');
    const args = sdCliArgs(model, job, path.join(root, model.id), out, { offloadToCpu: true, vaeTiling: true });
    const tail: string[] = [];
    try {
      this.run = (this.d.spawn ?? defaultSpawn)(exe, args, {
        cwd: tmp,
        onLine: (line) => { tail.push(line); if (tail.length > 30) tail.shift(); this.d.onProgress?.({ fraction: parseProgress(line), line }); },
      });
      const code = await this.run.exitCode;
      if (this.cancelled) throw new LocalVideoCancelled();
      if (code !== 0) {
        const hint = tail.slice(-4).join(' | ');
        throw new Error(`The local engine stopped with code ${code}. ${/memory|alloc|vram|out of/i.test(hint) ? 'It ran out of memory: try the Experimental or Low Resource preset. ' : ''}Last output: ${hint || 'none'}`);
      }
      // Find what the tool wrote: the requested name, otherwise any video file in the work folder.
      let produced: string | null = null;
      for (const e of await fs.readdir(tmp)) if (VIDEO_EXT.includes(path.extname(e).toLowerCase()) && !e.startsWith('final')) produced = path.join(tmp, e);
      if (!produced || (await fs.stat(produced)).size < 1000) throw new Error('The engine finished but wrote no video file. Last output: ' + tail.slice(-3).join(' | '));
      let mp4 = produced;
      if (path.extname(produced).toLowerCase() !== '.mp4') {
        mp4 = path.join(tmp, 'final.mp4');
        await (this.d.toMp4 ?? ((s, o) => convertWithFilmCraft(s, o)))(produced, mp4);
        if (!(await fs.stat(mp4).then((s) => s.size > 1000, () => false))) throw new Error('The video could not be converted to MP4.');
      }
      const slug = job.prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'local-video';
      const name = `${slug}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`;
      const r = await store.addGeneratedFile(mp4, {
        name,
        provenance: {
          source: `Generated locally with ${model.name} on stable-diffusion.cpp (free, on this PC)`,
          prompt: job.prompt, provider: 'local', model: model.id,
          settings: { size: `${job.width}x${job.height}`, frames: String(job.frames), length: `${clipSeconds(job)} s`, fps: String(LOCAL_FPS), steps: String(job.steps), preset: job.preset },
          estimatedCostUsd: 0, requestedBy: 'user',
          licensingNotes: `AI-generated with ${model.name} (${model.license}).`,
        },
      });
      return { asset: r.asset, message: `Local video ready (${clipSeconds(job)} s, ${job.width}x${job.height}). Free; made on this PC.` };
    } finally {
      this.run = null;
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** FilmCraft headless: import the file, make a sequence, export H.264. */
async function convertWithFilmCraft(src: string, out: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const film = craftBin(craftInstallDir('FilmCraft'), 'filmcraft-cli');
  const script = path.join(path.dirname(out), 'convert.jsonl');
  const lines = [
    { id: 'file.newProject', params: { name: 'Convert' } },
    { id: 'file.import', params: { paths: [src.replace(/\\/g, '/')] } },
    { id: 'file.newSequence', params: { name: 'Convert', fromItem: 1 } },
    { id: 'file.exportMedia', params: { path: out, wait: true, format: 'h264' } },
  ];
  await fs.writeFile(script, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  await new Promise<void>((resolve, reject) => {
    execFile(film, ['--data-dir', path.join(path.dirname(out), 'fc-data'), '--compact', 'run', script], { windowsHide: true, timeout: 10 * 60_000 }, (err, _o, stderr) => (err ? reject(new Error(String(stderr).trim().split(/\r?\n/).pop() || err.message)) : resolve()));
  });
}

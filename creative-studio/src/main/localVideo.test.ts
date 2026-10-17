// SIMULATED engine: these tests prove CreateCraft's own runner logic (args, progress, cancel, import,
// isolation, no paid usage) with a fake process. They do NOT show that any GPU can generate video.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalVideoService, type Spawner } from './localVideo';
import { ProjectStore } from './projectStore';
import { binName } from '@shared/platform';

const job = { modelId: 'wan-2.1-t2v-1.3b', prompt: 'a lighthouse at dusk', preset: 'experimental' as const, width: 0, height: 0, frames: 0, steps: 0 };

describe('local video runner (simulated engine)', () => {
  let tmp: string;
  let modelDir: string;
  let store: ProjectStore;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-lv-'));
    modelDir = path.join(tmp, 'models');
    await fs.mkdir(path.join(modelDir, 'sdcpp-vulkan-runtime'), { recursive: true });
    await fs.writeFile(path.join(modelDir, 'sdcpp-vulkan-runtime', binName('sd-cli')), 'x');
    store = new ProjectStore(path.join(tmp, 'p'));
    await store.create('lv');
  });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 }); });

  const downloads = (installed: string[]) => ({ isInstalled: async (id: string) => installed.includes(id) }) as never;
  const ok = ['wan-2.1-t2v-1.3b', 'sdcpp-vulkan-runtime'];

  it('refuses when the model or engine is not downloaded, without spawning', async () => {
    let spawned = 0;
    const spawn: Spawner = () => { spawned++; return { exitCode: Promise.resolve(0), kill() {} }; };
    const a = new LocalVideoService({ store: async () => store, modelDir: async () => modelDir, downloads: downloads([]), spawn });
    await expect(a.render(job)).rejects.toThrow(/not downloaded/);
    const b = new LocalVideoService({ store: async () => store, modelDir: async () => modelDir, downloads: downloads(['wan-2.1-t2v-1.3b']), spawn });
    await expect(b.render(job)).rejects.toThrow(/engine/);
    expect(spawned).toBe(0);
  });

  it('runs, reports progress, imports an AI-labelled free clip into this project only', async () => {
    const lines: Array<number | null> = [];
    let seenArgs: string[] = [];
    const spawn: Spawner = (_exe, args, o) => {
      seenArgs = args;
      const out = args[args.indexOf('-o') + 1]!;
      return { exitCode: (async () => { o.onLine('step 3/10'); await fs.writeFile(out.replace(/\.avi$/, '.mp4'), Buffer.alloc(5000, 1)); return 0; })(), kill() {} };
    };
    const svc = new LocalVideoService({ store: async () => store, modelDir: async () => modelDir, downloads: downloads(ok), spawn, onProgress: (p) => lines.push(p.fraction) });
    const r = await svc.render(job);
    expect(lines).toContain(0.3);
    expect(seenArgs).toContain('vid_gen');
    expect(r.asset.provenance).toMatchObject({ provider: 'local', model: 'wan-2.1-t2v-1.3b', estimatedCostUsd: 0 });
    expect(r.asset.provenance.settings).toMatchObject({ frames: '17' });
    expect((await store.spending()).entries).toHaveLength(0);
    expect((await store.loadManifest()).assets.some((a) => a.id === r.asset.id)).toBe(true);
    expect(svc.busy).toBe(false);
  });

  it('cancel kills the process and imports nothing', async () => {
    const before = (await store.loadManifest()).assets.length;
    const spawn: Spawner = () => {
      let done!: (n: number) => void;
      const p = new Promise<number>((res) => { done = res; });
      return { exitCode: p, kill: () => done(1) };
    };
    const svc = new LocalVideoService({ store: async () => store, modelDir: async () => modelDir, downloads: downloads(ok), spawn });
    const p = svc.render(job);
    await new Promise((r) => setTimeout(r, 30));
    await expect(svc.render(job)).rejects.toThrow(/already/);
    svc.cancel();
    await expect(p).rejects.toThrow(/cancelled/);
    expect((await store.loadManifest()).assets.length).toBe(before);
  });

  it('low-memory failures get a plain hint', async () => {
    const spawn: Spawner = (_e, _a, o) => ({ exitCode: (async () => { o.onLine('ggml_vulkan: out of device memory'); return 3; })(), kill() {} });
    const svc = new LocalVideoService({ store: async () => store, modelDir: async () => modelDir, downloads: downloads(ok), spawn });
    await expect(svc.render(job)).rejects.toThrow(/ran out of memory/);
  });

  it('a clean exit with no file is an error, not a fake success', async () => {
    const spawn: Spawner = () => ({ exitCode: Promise.resolve(0), kill() {} });
    const svc = new LocalVideoService({ store: async () => store, modelDir: async () => modelDir, downloads: downloads(ok), spawn });
    await expect(svc.render(job)).rejects.toThrow(/no video file/);
  });
});

// Motion Effects: a real FilmCraft render (skipped when FilmCraft is not installed) plus fake-exec
// checks for cancellation, input errors and provenance. No network and no provider is involved.
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MotionJob } from '@shared/motionEffects';
import { MotionService } from './motionEffects';
import { ProjectStore } from './projectStore';

const FILM = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'FilmCraft');
const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');
const hasFilm = existsSync(path.join(FILM, 'filmcraft-cli.exe'));
const job = (assetId: string, o: Partial<MotionJob> = {}): MotionJob => ({ assetId, preset: 'zoom-in', intensity: 'medium', aspectRatio: '16:9', resolution: '720p', fps: 24, durationSeconds: 3, ...o });

describe('Motion Effects', () => {
  let tmp: string;
  let store: ProjectStore;
  let still: string;
  let wav: string;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-motion-'));
    store = new ProjectStore(path.join(tmp, 'p'));
    await store.create('motion');
    still = (await store.importFile(path.join(FIXTURES, 'sunset-still.jpg'))).asset.id;
    wav = (await store.importFile(path.join(FIXTURES, 'tone-a440.wav'))).asset.id;
  });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 }); });

  it.skipIf(!hasFilm)('renders a real zoom with FilmCraft and stores it as a non-AI version', async () => {
    const svc = new MotionService({ store: async () => store, filmcraftDir: () => FILM });
    const r = await svc.render(job(still, { durationSeconds: 2, fps: 24 }));
    expect(r.asset.parentId).toBe(still);
    expect(r.asset.kind).toBe('video');
    expect(r.asset.provenance.provider).toBeUndefined();
    expect(r.asset.provenance.source).toMatch(/not AI-generated/);
    expect(r.asset.provenance.estimatedCostUsd).toBeUndefined();
    const file = await store.resolveAssetPath(r.asset.id);
    expect((await fs.stat(file)).size).toBeGreaterThan(1000);
    expect(svc.busy).toBe(false);
    // Nothing is left behind in the work folder.
    const work = path.join(await store.workDir('motion'));
    expect(await fs.readdir(work)).toEqual([]);
    // Ledger untouched: no spend recorded.
    expect((await store.spending()).entries).toHaveLength(0);
    // Playable: ffprobe is not required; check the MP4 header instead.
    const head = await fs.readFile(file).then((b) => b.subarray(4, 8).toString('latin1'));
    expect(head).toBe('ftyp');
  }, 60_000);

  it('rejects non-pictures and unknown files before running anything', async () => {
    let called = 0;
    const svc = new MotionService({ store: async () => store, filmcraftDir: () => FILM, exec: async () => { called++; return ''; } });
    await expect(svc.render(job(wav))).rejects.toThrow(/PNG, JPEG or WebP/);
    await expect(svc.render(job('nope'))).rejects.toThrow(/no longer in the library/);
    expect(called).toBe(0);
  });

  it.skipIf(!hasFilm)('cancel stops the run and leaves no file', async () => {
    const svc = new MotionService({
      store: async () => store, filmcraftDir: () => FILM,
      exec: (_exe, _args, o) => new Promise((_res, rej) => { o.signal.addEventListener('abort', () => rej(new Error('Motion video cancelled.'))); }),
    });
    const p = svc.render(job(still));
    await new Promise((r) => setTimeout(r, 50));
    expect(svc.busy).toBe(true);
    await expect(svc.render(job(still))).rejects.toThrow(/already being made/);
    svc.cancel();
    await expect(p).rejects.toThrow(/cancelled/);
    expect(svc.busy).toBe(false);
    expect(await fs.readdir(await store.workDir('motion'))).toEqual([]);
  });
});

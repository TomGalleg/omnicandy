// AI video with mocked network and a fake encryptor. No real provider is ever contacted.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateVideoCost, normalizeVideoJob, type VideoJob } from '@shared/video';
import { SafeStorageVault, type Encryptor } from './credentialVault';
import { ProjectStore } from './projectStore';
import { VideoService } from './videoGeneration';
import { parseOperation, veoBody } from './videoApis';

const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');
const KEY = 'AIzaTEST0123456789abcdefghijklmno';
const fakeCrypto: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64').split('').reverse().join('')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4).split('').reverse().join(''), 'base64').toString(),
};

let tmp: string;
let store: ProjectStore;
let vault: SafeStorageVault;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-vid-'));
  store = new ProjectStore(path.join(tmp, 'proj'));
  await store.create('Vid');
  vault = new SafeStorageVault(path.join(tmp, 'secrets', 'providers'), fakeCrypto);
  await vault.save('gemini', KEY);
});
afterEach(async () => {
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else await fs.chmod(p, 0o666).catch(() => {});
    }
  };
  await walk(tmp);
  // Background job trackers of a finished test may still be writing jobs.json for a moment; retry.
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const job = (o: Partial<VideoJob> = {}): VideoJob => ({ modelId: 'veo-3.1-fast-generate-preview', prompt: 'A kite over dunes', referenceAssetId: null, aspectRatio: '16:9', durationSeconds: 4, resolution: '720p', ...o });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

async function fakeVeo(polls: number) {
  const mp4 = await fs.readFile(path.join(FIXTURES, 'sunset-clip.mp4'));
  let n = 0;
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith(':predictLongRunning')) return json({ name: 'models/veo/operations/abc123' });
    if (url.includes('/operations/')) {
      return ++n <= polls ? json({ done: false }) : json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/x:download?alt=media' } }] } } });
    }
    return new Response(new Uint8Array(mp4), { status: 200 });
  });
}

const make = (fetchMock: unknown, approve: () => Promise<boolean> = async () => true) =>
  new VideoService({ vault, store: async () => store, approve, fetch: fetchMock as typeof fetch, pollMs: 5, maxWaitMs: 25_000 });

async function until(fn: () => Promise<boolean>) {
  for (let i = 0; i < 2000; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timed out');
}

describe('video job rules and price', () => {
  it('prices per second and enforces the 8 second rule', () => {
    expect(estimateVideoCost(job({ durationSeconds: 6 })).amount).toBeCloseTo(0.6, 4);
    expect(estimateVideoCost(job({ modelId: 'veo-3.1-generate-preview', durationSeconds: 8, resolution: '4k' })).amount).toBeCloseTo(4.8, 4);
    expect(() => normalizeVideoJob(job({ resolution: '1080p', durationSeconds: 4 }))).toThrow(/8-second/);
    expect(() => normalizeVideoJob(job({ modelId: 'veo-3.1-lite-generate-preview', resolution: '4k', durationSeconds: 8 }))).toThrow(/not available/);
  });
  it('maps requests and operation results', () => {
    const b = veoBody(job(), { mime: 'image/png', data: Buffer.from('x') });
    expect(b.instances[0]).toMatchObject({ prompt: 'A kite over dunes', image: { mimeType: 'image/png' } });
    expect(b.parameters).toEqual({ aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' });
    expect(parseOperation({ done: false })).toEqual({ done: false });
    expect(parseOperation({ done: true, error: { message: 'no' } })).toMatchObject({ error: expect.stringContaining('no') });
    expect(parseOperation({ done: true, response: { generateVideoResponse: { raiMediaFilteredReasons: ['blocked'] } } })).toMatchObject({ error: expect.stringContaining('blocked') });
  });
});

// Generous timeouts: these tests poll, hash and encrypt, and exceeded the 5 s default when other test files
// ran in parallel on a busy machine (the intermittent failure). The logic itself is not time dependent.
describe('VideoService', { timeout: 30_000 }, () => {
  it('sends nothing when the approval is declined', async () => {
    const f = await fakeVeo(0);
    await expect(make(f, async () => false).submit(job(), 'user')).rejects.toThrow(/cancelled/i);
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses over the spending limit before asking', async () => {
    await store.setSpendingLimit(0.1);
    const f = await fakeVeo(0);
    const approve = vi.fn(async () => true);
    await expect(make(f, approve).submit(job(), 'user')).rejects.toThrow(/spending limit/);
    expect(approve).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });

  it('runs a job to a library video with provenance and a ledger entry', async () => {
    const f = await fakeVeo(2);
    const svc = make(f);
    const rec = await svc.submit(job(), 'user');
    expect(rec.state).toBe('running');
    await until(async () => (await svc.list())[0]?.state === 'done');
    const done = (await svc.list())[0]!;
    const asset = (await store.loadManifest()).assets.find((a) => a.id === done.assetId)!;
    expect(asset.kind).toBe('video');
    expect(asset.provenance).toMatchObject({ origin: 'generated', provider: 'gemini', model: 'veo-3.1-fast-generate-preview', estimatedCostUsd: 0.4 });
    expect((await store.spending()).spentUsd).toBeCloseTo(0.4, 4);
    const call = f.mock.calls.find((c) => String(c[0]).endsWith(':predictLongRunning'))!;
    expect(JSON.parse(call[1]!.body as string).parameters.durationSeconds).toBe(4);
  });

  it('picks a saved running job up again after a restart', async () => {
    const f = await fakeVeo(1);
    await make(f).submit(job(), 'user');
    const second = make(f); // new process: nothing in memory
    await until(async () => (await second.list())[0]?.state === 'done');
  });

  it('records a failure and stops waiting on cancel without importing', async () => {
    const fail = vi.fn(async (url: string) => (url.endsWith(':predictLongRunning') ? json({ name: 'models/veo/operations/z9z' }) : json({ done: true, error: { message: 'quota' } })));
    const svc = make(fail);
    await svc.submit(job(), 'user');
    await until(async () => (await svc.list())[0]?.state === 'failed');
    expect((await svc.list())[0]!.message).toMatch(/quota/);

    const slow = vi.fn(async (url: string) => (url.endsWith(':predictLongRunning') ? json({ name: 'models/veo/operations/q1q' }) : json({ done: false })));
    const s2 = make(slow);
    const r = await s2.submit(job({ prompt: 'another' }), 'user');
    const c = await s2.cancel(r.id);
    expect(c.state).toBe('cancelled');
    expect(c.message).toMatch(/may still/);
    expect((await store.loadManifest()).assets.filter((a) => a.kind === 'video' && a.provenance.origin === 'generated')).toHaveLength(0);
  });
});

describe('Runway', { timeout: 30_000 }, () => {
  const rjob = (o: Partial<VideoJob> = {}): VideoJob => ({ modelId: 'gen4.5', prompt: 'A paper boat', referenceAssetId: null, aspectRatio: '16:9', durationSeconds: 5, resolution: '720p', ...o });

  it('prices credits per second and needs a picture for Gen-4 Turbo', () => {
    expect(estimateVideoCost(rjob()).amount).toBeCloseTo(0.6, 4);
    expect(() => normalizeVideoJob(rjob({ modelId: 'gen4_turbo' }))).toThrow(/starting picture/);
    expect(estimateVideoCost(rjob({ modelId: 'gen4_turbo', referenceAssetId: 'x', durationSeconds: 10 })).amount).toBeCloseTo(0.5, 4);
  });

  it('sends the version header, polls, downloads without the key and can cancel', async () => {
    await vault.save('runway', 'key_0123456789abcdefghijklmnopqrstuvwxyz');
    const mp4 = await fs.readFile(path.join(FIXTURES, 'aurora-clip.mp4'));
    let polls = 0;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/text_to_video')) return json({ id: '11111111-2222-3333-4444-555555555555' });
      if (url.includes('/v1/tasks/') && init?.method !== 'DELETE') {
        return ++polls < 2 ? json({ status: 'RUNNING' }) : json({ status: 'SUCCEEDED', output: ['https://dnznrvs05pmza.cloudfront.net/out.mp4?sig=1'] });
      }
      if (url.includes('/v1/tasks/')) return new Response(null, { status: 204 });
      return new Response(new Uint8Array(mp4), { status: 200 });
    });
    const svc = make(f);
    await svc.submit(rjob(), 'user');
    await until(async () => (await svc.list())[0]?.state === 'done');
    const first = f.mock.calls[0]!;
    expect(first[0]).toBe('https://api.dev.runwayml.com/v1/text_to_video');
    expect((first[1]!.headers as Record<string, string>)['X-Runway-Version']).toBe('2024-11-06');
    expect(JSON.parse(first[1]!.body as string)).toMatchObject({ model: 'gen4.5', ratio: '1280:720', duration: 5, promptText: 'A paper boat' });
    const dl = f.mock.calls.find((c) => String(c[0]).includes('cloudfront'))!;
    expect(JSON.stringify(dl[1]!.headers)).not.toContain('key_');
    expect((await store.spending()).entries.at(-1)).toMatchObject({ provider: 'runway', estimateUsd: 0.6 });

    const slow = vi.fn(async (url: string, init?: RequestInit) => (url.endsWith('/v1/text_to_video') ? json({ id: '99999999-2222-3333-4444-555555555555' }) : init?.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ status: 'RUNNING' })));
    const s2 = make(slow);
    const r = await s2.submit(rjob({ prompt: 'two' }), 'user');
    const c = await s2.cancel(r.id);
    expect(c.state).toBe('cancelled');
    expect(c.message).toMatch(/Cancelled at Runway/);
    expect(slow.mock.calls.some((x) => (x[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(true);
  });
});


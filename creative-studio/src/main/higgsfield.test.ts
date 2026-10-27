// Higgsfield with mocked network and a fake encryptor. No real provider is ever contacted.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HfJobRecord, HiggsfieldJob } from '@shared/higgsfield';
import { SafeStorageVault, type Encryptor } from './credentialVault';
import { GenerationCancelled, GenerationService, type ApprovalRequest } from './generation';
import { HiggsfieldService, sniffMedia } from './higgsfield';
import { testPattern } from './png';
import { ProjectStore } from './projectStore';

const KEY = 'kid_0123456789:secret_abcdefghijklmnop';
const API = 'https://api.higgsfield.ai';
const fakeCrypto: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4), 'base64').toString(),
};
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(2000, 1)]);

let tmp: string; let store: ProjectStore; let vault: SafeStorageVault; let imageId: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-hf-'));
  store = new ProjectStore(path.join(tmp, 'proj'));
  await store.create('H');
  vault = new SafeStorageVault(path.join(tmp, 'secrets', 'providers'), fakeCrypto);
  const f = path.join(await store.workDir('generate'), 'start.png');
  await fs.writeFile(f, testPattern(8, 8, 3));
  imageId = (await store.addGeneratedFile(f, { name: 'start.png', provenance: { source: 'test', prompt: 'p', provider: 'mock', model: 'm', settings: {}, requestedBy: 'user' } })).asset.id;
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const i2v = (o: Partial<HiggsfieldJob> = {}): HiggsfieldJob => ({ modelId: 'kling-video/v2.5-turbo/pro/image-to-video', prompt: 'The lighthouse beam turns', params: { duration: 5 }, inputs: { image_url: [imageId] }, ...o });

interface Calls { url: string; init: RequestInit | undefined }
/** statuses = the answers to successive status polls. */
function rig(opts: { statuses?: unknown[]; submit?: unknown; download?: () => Response; approve?: boolean; styleList?: unknown } = {}) {
  const calls: Calls[] = [];
  const statuses = [...(opts.statuses ?? [{ status: 'in_progress' }, { status: 'completed', video: { url: 'https://cdn.example/out.mp4' } }])];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === `${API}/files/generate-upload-url`) return json({ public_url: 'https://cdn.example/u.png', upload_url: 'https://storage.example/put', upload_headers: { 'x-amz-meta': 'a' } });
    if (url === 'https://storage.example/put') return new Response(null, { status: 200 });
    if (init?.method === 'POST' && url.startsWith(API) && !url.includes('/files/') && !url.endsWith('/cancel')) return json(opts.submit ?? { status: 'queued', request_id: 'req1', status_url: `${API}/requests/req1/status`, cancel_url: `${API}/requests/req1/cancel` });
    if (url.endsWith('/cancel')) return new Response(null, { status: 202 });
    if (url.includes('/status')) return json(statuses.length > 1 ? statuses.shift() : statuses[0]);
    const pic = /^https:\/\/cdn\.example\/pic(\d)\.png$/.exec(url);
    if (pic) return new Response(new Uint8Array(testPattern(8, 8, Number(pic[1]) + 10)), { status: 200 });
    if (url === 'https://cdn.example/out.mp4') return opts.download ? opts.download() : new Response(new Uint8Array(MP4), { status: 200 });
    if (url.startsWith(`${API}/v1/text2image/`)) return json(opts.styleList ?? []);
    if (url.startsWith('https://styles.example/')) return url.endsWith('big.png') ? new Response(new Uint8Array(Buffer.alloc(300 * 1024, 1)), { status: 200 }) : url.endsWith('bad.png') ? new Response('<html>no</html>'.padEnd(50), { status: 200 }) : new Response(new Uint8Array(testPattern(8, 8, 3)), { status: 200 });
    return json({}, 404);
  });
  const approveMock = vi.fn(async (_r: ApprovalRequest) => opts.approve ?? true);
  const changes: HfJobRecord[] = [];
  const deps = { vault, store: async () => store, approve: approveMock, fetch: fetchMock as unknown as typeof fetch };
  return { svc: new HiggsfieldService({ ...deps, pollMs: 1, onChange: (r) => changes.push(r) }), gen: new GenerationService(deps), fetchMock, approveMock, calls, changes };
}
async function until(svc: HiggsfieldService, ok: (r: HfJobRecord) => boolean): Promise<HfJobRecord> {
  let last: HfJobRecord | undefined;
  for (let i = 0; i < 400; i++) { last = (await svc.list())[0]; if (last && ok(last)) return last; await new Promise((x) => setTimeout(x, 5)); }
  throw new Error(`timed out; last record: ${JSON.stringify(last)}`);
}

describe('HiggsfieldService', () => {
  it('refuses without a key and sends nothing without approval', async () => {
    const a = rig();
    await expect(a.svc.submit(i2v(), 'user')).rejects.toThrow(/Higgsfield API key first/);
    expect(a.approveMock).not.toHaveBeenCalled();
    await vault.save('higgsfield', KEY);
    const b = rig({ approve: false });
    await expect(b.svc.submit(i2v(), 'user')).rejects.toBeInstanceOf(GenerationCancelled);
    expect(b.fetchMock).not.toHaveBeenCalled();
    expect(await b.svc.list()).toEqual([]);
  });

  it('refuses a project with a spending limit, because the price is unknown', async () => {
    await vault.save('higgsfield', KEY);
    await store.setSpendingLimit(5);
    const a = rig();
    await expect(a.svc.submit(i2v(), 'user')).rejects.toThrow(/publishes no price/);
    expect(a.approveMock).not.toHaveBeenCalled();
    expect(a.fetchMock).not.toHaveBeenCalled();
  });

  it('uploads the picture, submits once, polls, downloads at once and saves a video with provenance', async () => {
    await vault.save('higgsfield', KEY);
    const a = rig();
    const rec = await a.svc.submit(i2v(), 'user');
    expect(rec).toMatchObject({ state: 'queued', requestId: 'req1' });
    // The approval says the price is unknown and carries no secret.
    const req = a.approveMock.mock.calls[0]![0];
    expect(req).toMatchObject({ provider: 'Higgsfield', kind: 'video', priceUnknown: expect.stringMatching(/no price/) });
    expect(JSON.stringify(req)).not.toContain('secret_');
    const done = await until(a.svc, (r) => r.state === 'done');
    expect(done.assetIds).toHaveLength(1);

    const submit = a.calls.filter((c) => c.init?.method === 'POST' && c.url.includes('/kling-video'));
    expect(submit).toHaveLength(1); // a paid request is sent exactly once
    const headers = submit[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Key ${KEY}`);
    expect(headers['Idempotency-Key']).toBe(rec.id);
    expect(JSON.parse(submit[0]!.init!.body as string)).toEqual({ prompt: 'The lighthouse beam turns', duration: 5, image_url: 'https://cdn.example/u.png' });

    // The key goes only to api.higgsfield.ai: not to the storage upload, not to the result download.
    for (const c of a.calls) {
      const auth = (c.init?.headers as Record<string, string> | undefined)?.Authorization;
      if (!c.url.startsWith(API)) expect(auth, c.url).toBeUndefined();
    }
    const asset = (await store.loadManifest()).assets.find((x) => x.id === done.assetIds[0])!;
    expect(asset).toMatchObject({ kind: 'video', sourceFormat: 'mp4', provenance: { provider: 'higgsfield', model: 'kling-video/v2.5-turbo/pro/image-to-video', referenceAssetIds: [imageId] } });
    expect(JSON.stringify(await store.loadManifest())).not.toContain('secret_');
    expect(a.changes.map((c) => c.state)).toContain('running');
  });

  it('does not trust a status_url that is not on api.higgsfield.ai', async () => {
    await vault.save('higgsfield', KEY);
    const a = rig({ submit: { status: 'queued', request_id: 'req9', status_url: 'https://evil.example/s', cancel_url: 'https://evil.example/c' } });
    const rec = await a.svc.submit(i2v(), 'user');
    expect(rec.statusUrl).toBeUndefined();
    await until(a.svc, (r) => r.state === 'done');
    expect(a.calls.some((c) => c.url.includes('evil.example'))).toBe(false);
    expect(a.calls.some((c) => c.url === `${API}/requests/req9/status`)).toBe(true);
  });

  it('reports failed and moderated requests as not charged, without resending', async () => {
    await vault.save('higgsfield', KEY);
    const a = rig({ statuses: [{ status: 'failed', error: 'bad input' }] });
    await a.svc.submit(i2v(), 'user');
    const r = await until(a.svc, (x) => x.state === 'failed');
    expect(r.message).toMatch(/not charged/);
    expect(a.calls.filter((c) => c.init?.method === 'POST' && c.url.includes('/kling-video'))).toHaveLength(1);
    const b = rig({ statuses: [{ status: 'nsfw' }] });
    await b.svc.submit(i2v({ prompt: 'again' }), 'user');
    expect((await until(b.svc, (x) => x.state === 'moderated')).message).toMatch(/not charged/);
  });

  it('cancels only while queued and says so when it is too late', async () => {
    await vault.save('higgsfield', KEY);
    const a = rig({ statuses: [{ status: 'queued' }] });
    const rec = await a.svc.submit(i2v(), 'user');
    expect((await a.svc.cancel(rec.id)).state).toBe('canceled');
    expect(a.calls.some((c) => c.url === `${API}/requests/req1/cancel`)).toBe(true);

    const b = rig({ statuses: [{ status: 'in_progress' }] });
    const r2 = await b.svc.submit(i2v({ prompt: 'two' }), 'user');
    await until(b.svc, (x) => x.state === 'running');
    const out = await b.svc.cancel(r2.id);
    expect(out.state).toBe('running');
    expect(out.message).toMatch(/cannot stop/);
    expect(b.calls.some((c) => c.url.endsWith('/cancel'))).toBe(false);
  });

  it('never re-sends a request that was interrupted before it got an id', async () => {
    const f = path.join(await store.workDir('higgsfield'), 'jobs.json');
    const stuck: HfJobRecord = { id: 'x', job: i2v(), state: 'submitting', requestId: '', requestedBy: 'user', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), assetIds: [], message: '' };
    await fs.writeFile(f, JSON.stringify({ version: 1, jobs: [stuck] }));
    await vault.save('higgsfield', KEY);
    const a = rig();
    const [r] = await a.svc.list();
    expect(r!.state).toBe('failed');
    expect(r!.message).toMatch(/not sent again/);
    expect(a.fetchMock).not.toHaveBeenCalled();
  });

  it('resumes polling a saved running job after a restart', async () => {
    const f = path.join(await store.workDir('higgsfield'), 'jobs.json');
    const running: HfJobRecord = { id: 'y', job: i2v(), state: 'running', requestId: 'req7', requestedBy: 'user', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), assetIds: [], message: '' };
    await fs.writeFile(f, JSON.stringify({ version: 1, jobs: [running] }));
    await vault.save('higgsfield', KEY);
    const a = rig();
    await a.svc.list();
    const done = await until(a.svc, (r) => r.state === 'done');
    expect(done.assetIds).toHaveLength(1);
    expect(a.calls.some((c) => c.init?.method === 'POST' && c.url.includes('/kling-video'))).toBe(false);
  });

  it('refuses a result that is not a real video', async () => {
    await vault.save('higgsfield', KEY);
    const a = rig({ download: () => new Response('<html>nope</html>'.padEnd(2000, ' '), { status: 200 }) });
    await a.svc.submit(i2v(), 'user');
    const r = await until(a.svc, (x) => x.state === 'failed');
    expect(r.message).toMatch(/not a valid video/);
    expect((await store.loadManifest()).assets.filter((x) => x.kind === 'video')).toHaveLength(0);
  });

  it('connection test is free and tells a rejected key from an accepted one', async () => {
    await vault.save('higgsfield', KEY);
    const bad = rig(); bad.fetchMock.mockImplementation(async () => json({ detail: 'nope' }, 401));
    expect((await bad.gen.testConnection('higgsfield')).ok).toBe(false);
    const good = rig(); good.fetchMock.mockImplementation(async () => json({}, 404));
    const t = await good.gen.testConnection('higgsfield');
    expect(t.ok).toBe(true);
    expect(good.approveMock).not.toHaveBeenCalled();
    expect(good.fetchMock.mock.calls.every((c) => (c[1] as RequestInit).method !== 'POST')).toBe(true);
  });
});

describe('Soul', () => {
  const SOUL_JOB: HiggsfieldJob = { modelId: 'higgsfield-ai/soul/v2/standard', prompt: 'A quiet portrait', params: { batch_size: 4, aspect_ratio: '3:4' }, inputs: {} };

  it('sends the documented body and saves every picture of a batch as its own new asset', async () => {
    await vault.save('higgsfield', KEY);
    const a = rig({ statuses: [{ status: 'completed', images: [1, 2, 3, 4].map((n) => ({ url: `https://cdn.example/pic${n}.png` })) }] });
    const rec = await a.svc.submit(SOUL_JOB, 'user');
    expect(a.approveMock.mock.calls[0]![0]).toMatchObject({ kind: 'image', settings: { batch_size: '4' }, priceUnknown: expect.stringMatching(/no price/) });
    const done = await until(a.svc, (r) => r.state === 'done');
    expect(done.assetIds).toHaveLength(4);
    const post = a.calls.find((c) => c.init?.method === 'POST' && c.url === `${API}/higgsfield-ai/soul/v2/standard`)!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ prompt: 'A quiet portrait', batch_size: 4, aspect_ratio: '3:4' });
    expect(rec.requestId).toBe('req1');
    expect((await store.loadManifest()).assets.filter((x) => x.kind === 'image' && x.provenance.provider === 'higgsfield')).toHaveLength(4);
  });

  it('lists styles with the key, fetches small previews without it, and skips what is not a picture', async () => {
    await vault.save('higgsfield', KEY);
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    const a = rig({ styleList: [
      { id: id(1), name: 'General', description: 'Plain', preview_url: 'https://styles.example/a.png' },
      { id: id(2), name: 'Heavy', description: '', preview_url: 'https://styles.example/big.png' },
      { id: id(3), name: 'Broken', description: '', preview_url: 'https://styles.example/bad.png' },
      { id: id(4), name: 'Insecure', description: '', preview_url: 'http://styles.example/a.png' },
    ] });
    const list = await a.svc.styles('higgsfield-ai/soul/v2/standard');
    expect(list.map((s) => [s.name, s.preview?.slice(0, 22) ?? null])).toEqual([['General', 'data:image/png;base64,'], ['Heavy', null], ['Broken', null], ['Insecure', null]]);
    const listCall = a.calls.find((c) => c.url === `${API}/v1/text2image/soul-styles/v2`)!;
    expect((listCall.init!.headers as Record<string, string>).Authorization).toBe(`Key ${KEY}`);
    for (const c of a.calls.filter((x) => x.url.startsWith('https://styles.example/'))) expect((c.init?.headers as Record<string, string> | undefined)?.Authorization, c.url).toBeUndefined();
    expect(a.calls.some((c) => c.url.startsWith('http://styles.example'))).toBe(false);
    await a.svc.styles('higgsfield-ai/soul/v2/standard'); // cached: no second list call
    expect(a.calls.filter((c) => c.url === `${API}/v1/text2image/soul-styles/v2`)).toHaveLength(1);
    expect((await a.svc.styles('higgsfield-ai/soul/cinema'))).toEqual([]); // a fixed look has no styles
    const b = rig();
    await b.svc.styles('higgsfield-ai/soul/standard');
    expect(b.calls[0]!.url).toBe(`${API}/v1/text2image/soul-styles`); // the original Soul has its own list
  });

  it('asks for the key before listing styles', async () => {
    const a = rig();
    await expect(a.svc.styles('higgsfield-ai/soul/v2/standard')).rejects.toThrow(/Higgsfield API key first/);
    expect(a.fetchMock).not.toHaveBeenCalled();
  });
});

describe('sniffMedia', () => {
  it('recognises real files and rejects text', () => {
    expect(sniffMedia(MP4)).toBe('mp4');
    expect(sniffMedia(testPattern(8, 8, 1))).toBe('png');
    expect(sniffMedia(Buffer.from('<html>this is not media</html>'))).toBeNull();
  });
});

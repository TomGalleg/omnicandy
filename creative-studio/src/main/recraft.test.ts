// Recraft with mocked network and a fake encryptor. No real provider is ever contacted.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecraftJob } from '@shared/recraft';
import { SafeStorageVault, type Encryptor } from './credentialVault';
import { GenerationCancelled, GenerationService, type ApprovalRequest } from './generation';
import { testPattern } from './png';
import { ProjectStore } from './projectStore';
import { RecraftService } from './recraft';
import { StudioJobStore } from './studioJobs';

const KEY = 'rk_test_0123456789abcdefghijklmnop';
const fakeCrypto: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4), 'base64').toString(),
};
let tmp: string; let store: ProjectStore; let vault: SafeStorageVault;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-recraft-'));
  store = new ProjectStore(path.join(tmp, 'proj'));
  await store.create('R');
  vault = new SafeStorageVault(path.join(tmp, 'secrets', 'providers'), fakeCrypto);
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const job = (o: Partial<RecraftJob> = {}): RecraftJob => ({ modelId: 'recraftv4_1', prompt: 'A lighthouse', count: 1, aspect: '1:1', colors: [], background: '', ...o });
const png = (seed: number) => testPattern(8, 8, seed).toString('base64');
const svg = (n: number) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="${n}" height="10"/></svg>`).toString('base64');

function service(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, approve: (r: ApprovalRequest) => Promise<boolean>) {
  const fetchMock = vi.fn(fetchImpl);
  const approveMock = vi.fn(approve);
  const deps = { vault, store: async () => store, approve: approveMock, fetch: fetchMock as unknown as typeof fetch };
  return { svc: new RecraftService(deps), gen: new GenerationService(deps), fetchMock, approveMock };
}

describe('RecraftService', () => {
  it('refuses without a key, and sends nothing without approval', async () => {
    const a = service(async () => json({}), async () => true);
    await expect(a.svc.generate(job(), 'user')).rejects.toThrow(/Recraft API key first/);
    expect(a.approveMock).not.toHaveBeenCalled();
    await vault.save('recraft', KEY);
    const b = service(async () => json({}), async () => false);
    await expect(b.svc.generate(job(), 'user')).rejects.toBeInstanceOf(GenerationCancelled);
    expect(b.fetchMock).not.toHaveBeenCalled();
    expect((await store.loadManifest()).assets).toHaveLength(0);
  });

  it('sends the documented request after approval and saves a raster result with provenance and real units', async () => {
    await vault.save('recraft', KEY);
    const { svc, fetchMock, approveMock } = service(async () => json({ created: 1, credits: 35, data: [{ image_id: 'i', b64_json: png(1) }] }), async () => true);
    const r = await svc.generate(job(), 'user');
    expect(approveMock.mock.calls[0]![0]).toMatchObject({ provider: 'Recraft', model: 'Recraft V4.1', count: 1 });
    expect(JSON.stringify(approveMock.mock.calls[0]![0])).not.toContain(KEY);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://external.api.recraft.ai/v1/images/generations');
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init!.body as string)).toMatchObject({ model: 'recraftv4_1', n: 1, size: '1:1', response_format: 'b64_json' });
    expect(r.assets[0]).toMatchObject({ kind: 'image', provenance: { origin: 'generated', provider: 'recraft', model: 'recraftv4_1' } });
    expect(r.message).toMatch(/35 Recraft units/);
    expect((await store.spending()).spentUsd).toBe(0.035);
    expect(await fs.readFile(path.join(store.root, 'project.json'), 'utf8')).not.toContain(KEY);
  });

  it('vector models produce a genuine SVG asset (vector kind), not a picture', async () => {
    await vault.save('recraft', KEY);
    const { svc } = service(async () => json({ credits: 80, data: [{ b64_json: svg(10) }] }), async () => true);
    const r = await svc.generate(job({ modelId: 'recraftv4_1_vector' }), 'user');
    expect(r.assets[0]).toMatchObject({ kind: 'vector', sourceFormat: 'svg' });
  });

  it('rejects a "vector" answer that is not SVG, and never retries a failed paid request', async () => {
    await vault.save('recraft', KEY);
    const bad = service(async () => json({ data: [{ b64_json: png(2) }] }), async () => true);
    await expect(bad.svc.generate(job({ modelId: 'recraftv4_1_vector' }), 'user')).rejects.toThrow(/not an SVG/);
    const err = service(async () => json({ message: `bad token ${KEY}` }, 401), async () => true);
    const e = await err.svc.generate(job(), 'user').catch((x: Error) => x);
    expect(String(e)).toMatch(/key was rejected/);
    expect(err.fetchMock).toHaveBeenCalledTimes(1);
    expect(err.approveMock).toHaveBeenCalledTimes(1);
  });

  it('honours the project spending limit before asking', async () => {
    await vault.save('recraft', KEY);
    await store.setSpendingLimit(0.01);
    const { svc, approveMock, fetchMock } = service(async () => json({}), async () => true);
    await expect(svc.generate(job(), 'user')).rejects.toThrow(/spending limit/);
    expect(approveMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('connection test reads the balance (free) and never generates', async () => {
    await vault.save('recraft', KEY);
    const { gen, fetchMock, approveMock } = service(async () => json({ credits: 5000 }), async () => true);
    const t = await gen.testConnection('recraft');
    expect(t.ok).toBe(true);
    expect(t.message).toMatch(/5000 API units/);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://external.api.recraft.ai/v1/users/me');
    expect(approveMock).not.toHaveBeenCalled();
  });
});

describe('StudioJobStore', () => {
  it('persists jobs in the project and brings a running job back as failed', async () => {
    const s = new StudioJobStore(async () => store.root);
    const j = { id: 'a', at: 'x', providerId: 'recraft', modelId: 'm', modelLabel: 'M', prompt: 'p', settings: {}, count: 1, referenceAssetIds: [], state: 'running' as const };
    await s.save([j, { ...j, id: 'b', state: 'done' as const }]);
    const back = await new StudioJobStore(async () => store.root).list();
    expect(back.map((x) => x.state)).toEqual(['failed', 'done']);
    expect(await new StudioJobStore(async () => path.join(tmp, 'nothing')).list()).toEqual([]);
  });
});

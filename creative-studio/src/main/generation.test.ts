// AI generation with mocked network and a fake encryptor. No real provider is ever contacted.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageJob } from '@shared/generation';
import { checkKeyShape, redact, SafeStorageVault, type Encryptor } from './credentialVault';
import { GenerationCancelled, GenerationService, type ApprovalRequest } from './generation';
import { testPattern } from './png';
import { ProjectStore } from './projectStore';

const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');
const OPENAI_KEY = 'sk-test-0123456789abcdefghijklmnop';
const GEMINI_KEY = 'AIzaTEST0123456789abcdefghijklmno';

/** Reversible stand-in for DPAPI that still keeps the plain key out of the file. */
const fakeCrypto: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64').split('').reverse().join('')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4).split('').reverse().join(''), 'base64').toString(),
};

let tmp: string;
let store: ProjectStore;
let vault: SafeStorageVault;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-gen-'));
  store = new ProjectStore(path.join(tmp, 'proj'));
  await store.create('Gen');
  vault = new SafeStorageVault(path.join(tmp, 'secrets', 'providers'), fakeCrypto);
});
afterEach(async () => {
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else await fs.chmod(p, 0o666).catch(() => {});
    }
  };
  await walk(tmp);
  await fs.rm(tmp, { recursive: true, force: true });
});

const png = (seed: number) => testPattern(8, 8, seed).toString('base64');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const job = (o: Partial<ImageJob> = {}): ImageJob => ({ modelId: 'gpt-image-2.5-flare', prompt: 'A lighthouse at dusk', referenceAssetIds: [], settings: {}, count: 1, ...o });

function service(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, approve: (r: ApprovalRequest) => Promise<boolean>) {
  const fetchMock = vi.fn(fetchImpl);
  const approveMock = vi.fn(approve);
  const svc = new GenerationService({ vault, store: async () => store, approve: approveMock, fetch: fetchMock as unknown as typeof fetch });
  return { svc, fetchMock, approveMock };
}

describe('SafeStorageVault', () => {
  it('stores keys encrypted, never in plain text, and only lends them to main-process code', async () => {
    await vault.save('openai', `  ${OPENAI_KEY}\n`);
    const raw = await fs.readFile(path.join(tmp, 'secrets', 'providers', 'openai.key'), 'utf8');
    expect(raw).not.toContain(OPENAI_KEY);
    const meta = await fs.readFile(path.join(tmp, 'secrets', 'providers', 'openai.json'), 'utf8');
    expect(meta).not.toContain(OPENAI_KEY);
    expect(await vault.status('openai')).toEqual({ providerId: 'openai', configured: true, handle: 'vault:openai' });
    expect(await vault.withKey('openai', async (k) => k)).toBe(OPENAI_KEY);
    await vault.remove('openai');
    expect((await vault.status('openai')).configured).toBe(false);
    await expect(vault.withKey('openai', async (k) => k)).rejects.toThrow(/No API key/);
  });

  it('rejects things that are not keys, and refuses to save without OS encryption', async () => {
    expect(() => checkKeyShape('openai', '')).toThrow(/empty/);
    expect(() => checkKeyShape('openai', 'hello world this is text')).toThrow(/doesn't look like/);
    expect(() => checkKeyShape('openai', 'AIzaSomethingSomethingSomething')).toThrow(/sk-/);
    const plain = new SafeStorageVault(path.join(tmp, 'x'), { ...fakeCrypto, isEncryptionAvailable: () => false });
    await expect(plain.save('gemini', GEMINI_KEY)).rejects.toThrow(/protected storage/);
    await expect(vault.status('../evil')).rejects.toThrow(/Invalid provider/);
  });

  it('redacts keys from error text', async () => {
    await vault.save('gemini', GEMINI_KEY);
    await expect(vault.withKey('gemini', async (k) => { throw new Error(`bad key ${k}`); })).rejects.toThrow('bad key [key]');
    expect(redact(`oops ${OPENAI_KEY}`, null)).not.toContain(OPENAI_KEY);
    expect(redact('Incorrect API key provided: sk-creat************0000. See docs', null)).toBe('Incorrect API key provided: sk-… See docs');
  });
});

describe('GenerationService', () => {
  it('never contacts a provider without approval, and charges nothing when the user cancels', async () => {
    await vault.save('openai', OPENAI_KEY);
    const { svc, fetchMock, approveMock } = service(async () => json({ data: [{ b64_json: png(1) }] }), async () => false);
    await expect(svc.generate(job(), 'user')).rejects.toBeInstanceOf(GenerationCancelled);
    expect(approveMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await store.loadManifest()).assets).toHaveLength(0);
  });

  it('refuses billable providers without a saved key (before asking or calling)', async () => {
    const { svc, fetchMock, approveMock } = service(async () => json({}), async () => true);
    await expect(svc.generate(job(), 'user')).rejects.toThrow(/API key first/);
    expect(approveMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OpenAI: sends the documented request after approval and saves results as originals with provenance', async () => {
    await vault.save('openai', OPENAI_KEY);
    const { svc, fetchMock, approveMock } = service(async () => json({ data: [{ b64_json: png(1) }, { b64_json: png(2) }] }), async () => true);
    const r = await svc.generate(job({ count: 2, settings: { quality: 'high', size: '1536x1024' } }), 'claude');

    const approval = approveMock.mock.calls[0]![0];
    expect(approval).toMatchObject({ provider: 'OpenAI', count: 2, requestedBy: 'claude', settings: { quality: 'high', size: '1536x1024' } });
    expect(approval.estimate.amount).toBeGreaterThan(0);
    expect(JSON.stringify(approval)).not.toContain(OPENAI_KEY);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(JSON.parse(init!.body as string)).toMatchObject({ model: 'gpt-image-2.5-flare', n: 2, size: '1536x1024', quality: 'high', output_format: 'png' });

    expect(r.assets).toHaveLength(2);
    const a = r.assets[0]!;
    expect(a.parentId).toBeUndefined();
    expect(a.relPath).toMatch(/^Assets\/Generated\//);
    expect(a.provenance).toMatchObject({ origin: 'generated', provider: 'openai', model: 'gpt-image-2.5-flare', prompt: 'A lighthouse at dusk', requestedBy: 'claude', settings: { quality: 'high' } });
    expect(a.provenance.estimatedCostUsd).toBe(r.estimate.amount);
    const manifestText = await fs.readFile(path.join(store.root, 'project.json'), 'utf8');
    expect(manifestText).not.toContain(OPENAI_KEY);
  });

  it('OpenAI with a reference picture uses the edits endpoint (multipart)', async () => {
    await vault.save('openai', OPENAI_KEY);
    const ref = (await store.importFile(path.join(FIXTURES, 'photocraft-smoke.png'))).asset;
    const { svc, fetchMock } = service(async () => json({ data: [{ b64_json: png(3) }] }), async () => true);
    await svc.generate(job({ referenceAssetIds: [ref.id] }), 'user');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    const form = init!.body as FormData;
    expect(form.get('model')).toBe('gpt-image-2.5-flare');
    expect(form.getAll('image[]')).toHaveLength(1);
    const m = await store.loadManifest();
    expect(m.assets.find((x) => x.provenance.origin === 'generated')!.provenance.referenceAssetIds).toEqual([ref.id]);
  });

  it('Gemini: one Interactions call per image with the key header; partial results are kept', async () => {
    await vault.save('gemini', GEMINI_KEY);
    let n = 0;
    const { svc, fetchMock } = service(async () => {
      n++;
      if (n === 3) return json({ error: { message: 'quota' } }, 429);
      return json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: png(10 + n) }] }] });
    }, async () => true);
    const r = await svc.generate(job({ modelId: 'gemini-nano-banana-2.1', count: 3, settings: { aspect_ratio: '16:9', image_size: '2K' } }), 'user');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe(GEMINI_KEY);
    expect(JSON.parse(init!.body as string).response_format).toEqual({ type: 'image', aspect_ratio: '16:9', image_size: '2K' });
    expect(r.assets).toHaveLength(2);
  });

  it('reports provider errors in plain words without the key', async () => {
    await vault.save('openai', OPENAI_KEY);
    const { svc } = service(async () => json({ error: { message: `Incorrect API key provided: ${OPENAI_KEY}` } }, 401), async () => true);
    const err = await svc.generate(job(), 'user').catch((e: Error) => e);
    expect(String(err)).toMatch(/key was rejected/);
    expect(String(err)).not.toContain(OPENAI_KEY);
  });

  it('connection test lists models (free) and records which image models the key can use', async () => {
    await vault.save('openai', OPENAI_KEY);
    const { svc, fetchMock, approveMock } = service(async () => json({ data: [{ id: 'gpt-image-2.5-flare' }, { id: 'gpt-5' }] }), async () => true);
    const t = await svc.testConnection('openai');
    expect(t).toMatchObject({ ok: true, models: ['gpt-image-2.5-flare'] });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/models');
    expect(approveMock).not.toHaveBeenCalled();
    expect((await vault.meta('openai'))!.lastTest!.ok).toBe(true);
  });

  it('the mock provider works offline with no approval and no network', async () => {
    const { svc, fetchMock, approveMock } = service(async () => json({}), async () => false);
    const r = await svc.generate(job({ modelId: 'mock-image', count: 2 }), 'user');
    expect(r.assets).toHaveLength(2);
    expect(r.assets[0]).toMatchObject({ kind: 'image', width: 512, height: 512 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(approveMock).not.toHaveBeenCalled();
  });
});

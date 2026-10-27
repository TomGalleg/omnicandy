// Recraft picture tools with mocked network and a fake encryptor. No real provider is ever contacted.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecraftToolJob } from '@shared/recraftTools';
import { SafeStorageVault, type Encryptor } from './credentialVault';
import { GenerationCancelled, type ApprovalRequest } from './generation';
import { testPattern } from './png';
import { ProjectStore } from './projectStore';
import { parseToolResult, RecraftService } from './recraft';

const KEY = 'rk_test_0123456789abcdefghijklmnop';
const fakeCrypto: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4), 'base64').toString(),
};
let tmp: string; let store: ProjectStore; let vault: SafeStorageVault; let srcId: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-rtool-'));
  store = new ProjectStore(path.join(tmp, 'proj'));
  await store.create('T');
  vault = new SafeStorageVault(path.join(tmp, 'secrets', 'providers'), fakeCrypto);
  const f = path.join(await store.workDir('generate'), 'src.png');
  await fs.writeFile(f, testPattern(300, 300, 5));
  srcId = (await store.addGeneratedFile(f, { name: 'src.png', provenance: { source: 't', prompt: 'p', provider: 'mock', model: 'm', settings: {}, requestedBy: 'user' } })).asset.id;
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const job = (toolId: string, o: Partial<RecraftToolJob> = {}): RecraftToolJob => ({ toolId, assetId: srcId, prompt: '', strength: 0.5, count: 1, shapeStacking: 'hierarchical', ...o });
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="10"/></svg>');

function rig(answer: unknown, downloads: Record<string, Buffer>, approve = true) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith('https://external.api.recraft.ai/v1/')) return json(answer);
    const body = downloads[url];
    return body ? new Response(new Uint8Array(body), { status: 200 }) : json({}, 404);
  });
  const approveMock = vi.fn(async (_r: ApprovalRequest) => approve);
  return { svc: new RecraftService({ vault, store: async () => store, approve: approveMock, fetch: fetchMock as unknown as typeof fetch }), fetchMock, approveMock, calls };
}

describe('RecraftService.tool', () => {
  it('refuses without a key, a missing picture, or approval, and sends nothing', async () => {
    const a = rig({}, {});
    await expect(a.svc.tool(job('vectorize'), 'user')).rejects.toThrow(/Recraft API key first/);
    await vault.save('recraft', KEY);
    await expect(a.svc.tool(job('vectorize', { assetId: 'gone' }), 'user')).rejects.toThrow(/no longer in the library/);
    const b = rig({}, {}, false);
    await expect(b.svc.tool(job('vectorize'), 'user')).rejects.toBeInstanceOf(GenerationCancelled);
    expect(b.fetchMock).not.toHaveBeenCalled();
    expect(a.approveMock).not.toHaveBeenCalled();
  });

  it('vectorizes a picture into a genuine SVG asset and leaves the original alone', async () => {
    await vault.save('recraft', KEY);
    const a = rig({ created: 1, credits: 10, image: { image_id: 'i', url: 'https://cdn.recraft.example/out.svg' } }, { 'https://cdn.recraft.example/out.svg': SVG });
    const r = await a.svc.tool(job('vectorize', { shapeStacking: 'cut_out' }), 'user');
    expect(a.approveMock.mock.calls[0]![0]).toMatchObject({ provider: 'Recraft', model: 'Recraft · Vectorize', references: ['src.png'] });
    expect(JSON.stringify(a.approveMock.mock.calls[0]![0])).not.toContain(KEY);
    const { url, init } = a.calls[0]!;
    expect(url).toBe('https://external.api.recraft.ai/v1/images/vectorize');
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ response_format: 'url', shape_stacking: 'cut_out' });
    expect(body.image_url).toMatch(/^data:image\/png;base64,/);
    // The download carries no Recraft key.
    expect((a.calls[1]!.init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
    expect(r.assets[0]).toMatchObject({ kind: 'vector', sourceFormat: 'svg', provenance: { provider: 'recraft', model: 'vectorize', referenceAssetIds: [srcId] } });
    expect(r.message).toMatch(/original untouched.*10 Recraft units/);
    expect((await store.spending()).spentUsd).toBe(0.01);
    const m = await store.loadManifest();
    expect(m.assets.find((x) => x.id === srcId)).toBeDefined();
    expect(JSON.stringify(m)).not.toContain(KEY);
  });

  it('edits with a prompt (several results) and upscales to a picture', async () => {
    await vault.save('recraft', KEY);
    const p1 = testPattern(16, 16, 1); const p2 = testPattern(16, 16, 2);
    const a = rig({ credits: 80, data: [{ url: 'https://cdn.recraft.example/1.png' }, { url: 'https://cdn.recraft.example/2.png' }] }, { 'https://cdn.recraft.example/1.png': p1, 'https://cdn.recraft.example/2.png': p2 });
    const r = await a.svc.tool(job('imageToImage', { prompt: 'make it autumn', strength: 0.3, count: 2 }), 'user');
    expect(JSON.parse(a.calls[0]!.init!.body as string)).toMatchObject({ model: 'recraftv3', prompt: 'make it autumn', strength: 0.3, n: 2 });
    expect(r.assets).toHaveLength(2);
    expect((await store.spending()).spentUsd).toBe(0.08);

    const b = rig({ credits: 4, image: { url: 'https://cdn.recraft.example/up.png' } }, { 'https://cdn.recraft.example/up.png': testPattern(16, 16, 3) });
    expect((await b.svc.tool(job('crispUpscale'), 'user')).assets[0]).toMatchObject({ kind: 'image' });
  });

  it('refuses a result that is not what the tool promised, and never retries a failed paid request', async () => {
    await vault.save('recraft', KEY);
    const notSvg = rig({ image: { url: 'https://cdn.recraft.example/x' } }, { 'https://cdn.recraft.example/x': testPattern(16, 16, 4) });
    await expect(notSvg.svc.tool(job('vectorize'), 'user')).rejects.toThrow(/not an SVG/);
    const notPic = rig({ image: { url: 'https://cdn.recraft.example/y' } }, { 'https://cdn.recraft.example/y': Buffer.from('<html>no</html>'.padEnd(100)) });
    await expect(notPic.svc.tool(job('removeBackground'), 'user')).rejects.toThrow(/not a valid picture/);
    const http = rig({}, {}); http.fetchMock.mockImplementation(async () => json({ message: `bad ${KEY}` }, 401));
    const e = await http.svc.tool(job('crispUpscale'), 'user').catch((x: Error) => x);
    expect(String(e)).toMatch(/key was rejected/);
    expect(String(e)).not.toContain(KEY);
    expect(http.fetchMock).toHaveBeenCalledTimes(1);
    expect(http.approveMock).toHaveBeenCalledTimes(1);
    const plain = rig({ image: { url: 'http://insecure.example/z.png' } }, {});
    await expect(plain.svc.tool(job('crispUpscale'), 'user')).rejects.toThrow(/not https/);
  });

  it('checks the picture size and the spending limit before asking', async () => {
    await vault.save('recraft', KEY);
    const small = path.join(await store.workDir('generate'), 'tiny.png');
    await fs.writeFile(small, testPattern(40, 40, 9));
    const tinyId = (await store.addGeneratedFile(small, { name: 'tiny.png', provenance: { source: 't', prompt: 'p', provider: 'mock', model: 'm', settings: {}, requestedBy: 'user' } })).asset.id;
    const a = rig({}, {});
    await expect(a.svc.tool(job('creativeUpscale', { assetId: tinyId }), 'user')).rejects.toThrow(/between 256 and 4096/);
    await store.setSpendingLimit(0.1);
    await expect(a.svc.tool(job('creativeUpscale'), 'user')).rejects.toThrow(/spending limit/);
    expect(a.approveMock).not.toHaveBeenCalled();
    expect(a.fetchMock).not.toHaveBeenCalled();
  });
});

describe('parseToolResult', () => {
  it('reads one result or several, and rejects an empty answer', () => {
    expect(parseToolResult({ credits: 4, image: { url: 'https://x/a.png' } })).toEqual({ items: [{ url: 'https://x/a.png' }], credits: 4 });
    expect(parseToolResult({ data: [{ url: 'https://x/1' }, { b64_json: 'AAAA' }] }).items).toHaveLength(2);
    expect(() => parseToolResult({})).toThrow(/no image/);
  });
});

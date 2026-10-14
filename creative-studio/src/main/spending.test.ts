// Project spending limit and ledger, with mocked network. No real provider is contacted.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeStorageVault, type Encryptor } from './credentialVault';
import { GenerationService } from './generation';
import { testPattern } from './png';
import { ProjectStore } from './projectStore';

const fakeCrypto: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64').split('').reverse().join('')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4).split('').reverse().join(''), 'base64').toString(),
};
let tmp: string;
let store: ProjectStore;
let vault: SafeStorageVault;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-spend-'));
  store = new ProjectStore(path.join(tmp, 'proj'));
  await store.create('Spend');
  vault = new SafeStorageVault(path.join(tmp, 'secrets'), fakeCrypto);
  await vault.save('openai', 'sk-test-0123456789abcdefghijklmnop');
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

describe('spending limit', () => {
  it('records estimated spend and refuses a request that would pass the limit before asking or sending', async () => {
    let n = 0;
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ data: [{ b64_json: testPattern(8, 8, ++n).toString('base64') }] }), { status: 200 }));
    const approve = vi.fn(async (_r: unknown) => true);
    const svc = new GenerationService({ vault, store: async () => store, approve, fetch: fetchMock as unknown as typeof fetch });
    const job = { modelId: 'gpt-image-2.5-flare', prompt: 'A lighthouse at dusk', referenceAssetIds: [], settings: {}, count: 1 };
    const first = await svc.generate(job, 'user');
    const s1 = await store.spending();
    expect(s1.entries).toHaveLength(1);
    expect(s1.spentUsd).toBe(first.estimate.amount);
    await store.setSpendingLimit(s1.spentUsd + first.estimate.amount / 2);
    await expect(svc.generate({ ...job, prompt: 'Another lighthouse' }, 'claude')).rejects.toThrow(/spending limit/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(1);
    await store.setSpendingLimit(null);
    await svc.generate({ ...job, prompt: 'Another lighthouse' }, 'user');
    expect((await store.spending()).entries).toHaveLength(2);
    expect(approve.mock.calls[1]![0]).toMatchObject({ limitUsd: null });
    await expect(store.setSpendingLimit(-1)).rejects.toThrow();
  });
});

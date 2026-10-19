import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADAPTER_SDK_VERSION, type AdapterManifest } from '@shared/integrations';
import type { DiscoveryEnv } from './discovery';
import { IntegrationManager } from './index';
import type { AdapterFactory, ExternalAdapter } from './sdk';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-rel-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const manifest: AdapterManifest = {
  id: 'mock.rel', platforms: ['win32', 'linux'], name: 'Mock Rel', vendor: 'Test', sdkVersion: ADAPTER_SDK_VERSION, maturity: 'experimental',
  exeNames: ['mockrel.exe'], displayNames: ['^Mock Rel'], versions: { min: '1.0', max: '9.9' },
  methods: ['scripting'], capabilities: ['executeCommand', 'connect', 'disconnect'],
  commands: [{ id: 'crash', label: 'Crash', description: 'throws', params: {}, permissions: [] }],
};

const env = (exe: string): DiscoveryEnv => ({
  env: { ProgramFiles: 'C:\\Program Files', PATH: '' },
  exists: async (p) => p.toLowerCase() === exe.toLowerCase(),
  listDir: async () => [],
  run: async () => '',
});

async function setup(connectDelayMs = 0) {
  const exe = path.join(tmp, `m-${Math.random().toString(36).slice(2)}`, 'mockrel.exe');
  await fs.mkdir(path.dirname(exe), { recursive: true });
  await fs.writeFile(exe, 'x');
  const created = { n: 0, disposed: 0 };
  let remembered: string[] = [];
  const factory: AdapterFactory = {
    manifest,
    create: (): ExternalAdapter => {
      created.n++;
      return {
        probe: async () => ({ version: '2.0' }),
        connect: async () => { await new Promise((r) => setTimeout(r, connectDelayMs)); },
        disconnect: async () => undefined,
        healthCheck: async () => ({ ok: true, detail: 'ok' }),
        dispose: async () => { created.disposed++; },
        execute: async () => { throw new Error('boom'); },
      };
    },
  };
  const mgr = new IntegrationManager({
    workDir: async () => path.join(tmp, 'work'),
    permissions: { load: async () => ({}), save: async () => undefined },
    approve: async () => 'always',
    discovery: env(exe),
    userPaths: async () => [exe],
    connected: { load: async () => remembered, save: async (k) => { remembered = k; } },
  });
  mgr.register(factory);
  const key = (await mgr.scan()).apps[0]!.key;
  created.n = 0; created.disposed = 0; // the scan made one short-lived probe adapter
  return { mgr, key, created, remembered: () => remembered };
}

describe('IntegrationManager reliability', () => {
  it('two simultaneous connects share one adapter', async () => {
    const t = await setup(50);
    const [a, b, c] = await Promise.all([t.mgr.connect(t.key), t.mgr.connect(t.key), t.mgr.connect(t.key)]);
    expect([a.status, b.status, c.status]).toEqual(['limited', 'limited', 'limited']);
    expect(t.created.n).toBe(1);
    expect(t.created.disposed).toBe(0);
    await t.mgr.shutdown();
  });

  it('after a disconnect the next connect starts a fresh adapter (the in-flight entry is cleared)', async () => {
    const t = await setup();
    const first = await t.mgr.connect(t.key);
    await t.mgr.disconnect(t.key);
    expect(first.status).toBe('limited');
    expect((await t.mgr.connect(t.key)).status).toBe('limited');
    expect(t.created.n).toBe(2);
    await t.mgr.shutdown();
  });

  it('an adapter crash keeps the program in the remembered list', async () => {
    const t = await setup();
    await t.mgr.connect(t.key);
    await new Promise((r) => setTimeout(r, 20)); // remember() runs in the background
    expect(t.remembered()).toEqual([t.key]);
    const r = await t.mgr.execute(t.key, 'crash');
    expect(r.error?.kind).toBe('internal');
    expect((await t.mgr.list())[0]!.status).toBe('available'); // session dropped
    expect(t.remembered()).toEqual([t.key]); // still remembered, so it reconnects at the next start
  });

  it('a deliberate disconnect still forgets the program', async () => {
    const t = await setup();
    await t.mgr.connect(t.key);
    await new Promise((r) => setTimeout(r, 20));
    await t.mgr.disconnect(t.key);
    expect(t.remembered()).toEqual([]);
  });
});

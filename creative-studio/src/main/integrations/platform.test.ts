// Adapters and commands declare where they may run; the manager refuses everything else before any adapter code is touched.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADAPTER_SDK_VERSION, type AdapterManifest } from '@shared/integrations';
import type { OsId } from '@shared/platform';
import type { DiscoveryEnv } from './discovery';
import { IntegrationManager } from './index';
import { packageManifestSchema } from './packageFormat';
import type { AdapterFactory } from './sdk';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-plat-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const manifest = (over: Partial<AdapterManifest> = {}): AdapterManifest => ({
  id: 'mock.plat', name: 'Mock Plat', vendor: 'Test', sdkVersion: ADAPTER_SDK_VERSION, maturity: 'experimental', exeNames: ['mockplat.exe'], displayNames: ['^Mock Plat'],
  versions: { min: '1.0' }, methods: ['scripting'], capabilities: ['executeCommand', 'connect', 'disconnect'],
  commands: [
    { id: 'everywhere', label: 'A', description: 'a', params: {}, permissions: [], platforms: ['win32', 'linux'] },
    { id: 'windows-only', label: 'B', description: 'b', params: {}, permissions: [] },
  ],
  ...over,
});

async function setup(osId: OsId, m: AdapterManifest) {
  const exe = path.join(tmp, `p-${Math.random().toString(36).slice(2)}`, 'mockplat.exe');
  await fs.mkdir(path.dirname(exe), { recursive: true });
  await fs.writeFile(exe, 'x');
  const calls: string[] = [];
  const discovery: DiscoveryEnv = {
    env: { ProgramFiles: 'C:\\Program Files', PATH: '' }, exists: async (p) => p === exe, listDir: async () => [], run: async () => '',
  };
  const mgr = new IntegrationManager({ workDir: async () => tmp, permissions: { load: async () => ({}), save: async () => undefined }, approve: async () => 'always', discovery, userPaths: async () => [exe], os: osId });
  const f: AdapterFactory = {
    manifest: m,
    create: () => ({
      probe: async () => { calls.push('probe'); return { version: '1.2.0' }; }, connect: async () => { calls.push('connect'); }, disconnect: async () => undefined,
      healthCheck: async () => ({ ok: true, detail: 'ok' }), dispose: async () => undefined,
      execute: async (cmd) => { calls.push(`run:${cmd.id}`); return { message: 'ok', outputs: [] }; },
    }),
  };
  mgr.register(f);
  const scan = await mgr.scan();
  return { mgr, calls, key: scan.apps[0]!.key, info: scan.apps[0]! };
}

describe('adapter platform compatibility', () => {
  it('an adapter without a platforms list is Windows only: fine on Windows, refused on Linux with nothing run', async () => {
    const win = await setup('win32', manifest({ commands: manifest().commands.map((c) => ({ ...c, platforms: undefined })) }));
    expect(win.info.status).not.toBe('incompatible');
    await win.mgr.connect(win.key);
    expect((await win.mgr.execute(win.key, 'windows-only')).ok).toBe(true);

    const lin = await setup('linux', manifest({ commands: manifest().commands.map((c) => ({ ...c, platforms: undefined })) }));
    expect(lin.info.status).toBe('incompatible');
    expect(lin.info.statusDetail).toMatch(/not available on Linux/);
    await expect(lin.mgr.connect(lin.key)).rejects.toThrow(/not available on Linux/);
    const r = await lin.mgr.execute(lin.key, 'windows-only');
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('unsupported');
    expect(lin.calls).toEqual([]); // no adapter code touched
  });
  it('an adapter that declares Linux can run there, but a Windows-only command still cannot', async () => {
    const lin = await setup('linux', manifest({ platforms: ['win32', 'linux'], commands: [manifest().commands[0]!, { ...manifest().commands[1]!, platforms: ['win32'] }] }));
    expect(lin.info.status).not.toBe('incompatible');
    await lin.mgr.connect(lin.key);
    expect((await lin.mgr.execute(lin.key, 'everywhere')).ok).toBe(true);
    const blocked = await lin.mgr.execute(lin.key, 'windows-only');
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toMatch(/not available on Linux/);
    expect(lin.calls.filter((c) => c.startsWith('run:'))).toEqual(['run:everywhere']);
  });
  it('the package manifest accepts platforms and rejects unknown systems', () => {
    const shape = packageManifestSchema.shape.platforms;
    expect(shape.safeParse(['win32', 'linux']).success).toBe(true);
    expect(shape.safeParse(['beos']).success).toBe(false);
    expect(shape.safeParse([]).success).toBe(false);
    expect(shape.safeParse(undefined).success).toBe(true);
  });
});

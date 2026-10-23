// LIVE test against a running Unreal Editor 5.8+ whose MCP server is started (ModelContextProtocol.StartServer).
// Read only: it never changes the editor. Skipped automatically when nothing answers on the endpoint.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationManager } from './index';
import { UNREAL_DEFAULT_ENDPOINT, unrealFactory } from './adapters/unreal';

const endpoint = process.env.OMNICANDY_UNREAL_MCP_URL || UNREAL_DEFAULT_ENDPOINT;
const exe = process.env.OMNICANDY_UNREAL_EXE || 'E:\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor.exe';
const up = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const haveExe = await fs.stat(exe).then(() => true, () => false);

describe.skipIf(!up || !haveExe)('Unreal adapter against the live editor', { timeout: 120_000 }, () => {
  let tmp: string;
  beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-unreal-live-')); });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('connects and reads the toolsets, the level, assets and the log', async () => {
    const m = new IntegrationManager({
      workDir: async (id) => path.join(tmp, id),
      permissions: { load: async () => ({}), save: async () => undefined },
      approve: async () => 'always',
      discovery: { env: { ProgramFiles: 'C:\\x' }, exists: async (p) => p.toLowerCase() === exe.toLowerCase(), listDir: async () => [], run: async () => '' },
      userPaths: async () => [exe],
    });
    m.register(unrealFactory, { builtin: true });
    const scan = await m.scan();
    const key = scan.apps[0]!.key;
    expect(scan.apps[0]).toMatchObject({ adapterId: 'unreal', version: expect.stringMatching(/^5\.8/) });
    await m.connect(key);

    const info = await m.execute(key, 'app.info');
    expect(info.error).toBeUndefined();
    expect((info.data as { toolsetCount: number }).toolsetCount).toBeGreaterThan(10);
    const { level, pieRunning } = info.data as { level: string; pieRunning: boolean };
    // While Play-In-Editor runs the editor reports no level; that is a state to report, not a failure.
    if (!pieRunning) expect(level).toMatch(/^\//);

    const list = await m.execute(key, 'toolsets.list');
    const names = (list.data as { toolsets: Array<{ name: string }> }).toolsets.map((t) => t.name);
    expect(names).toContain('editor_toolset.toolsets.scene.SceneTools');

    const desc = await m.execute(key, 'toolsets.describe', { toolset: 'editor_toolset.toolsets.scene.SceneTools' });
    expect((desc.data as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toContain('find_actors');

    const lvl = await m.execute(key, 'level.inspect', { max_names: 5 });
    if (pieRunning) expect(lvl.error?.message).toMatch(/Play-In-Editor/);
    else {
      expect(lvl.error).toBeUndefined();
      expect((lvl.data as { actorCount: number }).actorCount).toBeGreaterThan(0);
    }

    const assets = await m.execute(key, 'assets.find', { folder: '/Game', recursive: true, max: 20 });
    expect(assets.error).toBeUndefined();
    expect((assets.data as { total: number }).total).toBeGreaterThan(0);

    const logs = await m.execute(key, 'logs.read', { pattern: 'ModelContextProtocol', max: 5 });
    expect((logs.data as { count: number }).count).toBeGreaterThan(0);
  });
});

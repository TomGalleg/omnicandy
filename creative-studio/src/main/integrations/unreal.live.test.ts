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

    // the whole tool catalogue is searchable and each tool names the command that runs it
    const search = await m.execute(key, 'tools.search', { query: 'blueprint compile', limit: 10 });
    const tools = (search.data as { total: number; tools: Array<{ tool: string; command: string }> }).tools;
    expect((search.data as { total: number }).total).toBeGreaterThan(500);
    expect(tools.find((t) => t.tool === 'compile_blueprint')).toMatchObject({ command: 'tool.edit' });

    // a generic read-tier call
    const cur = await m.execute(key, 'tool.read', { toolset: 'editor_toolset.toolsets.scene.SceneTools', tool: 'get_current_level', arguments: {} });
    expect(cur.error).toBeUndefined();
    // and the wrong tier is refused before Unreal is touched
    expect((await m.execute(key, 'tool.read', { toolset: 'editor_toolset.toolsets.scene.SceneTools', tool: 'remove_from_scene', arguments: { actor: { refPath: '/x' } } })).error?.message).toMatch(/tool\.restricted/);
  });

  // Changes the open level (and cleans up after itself): only when asked for, never by default.
  it.skipIf(process.env.OMNICANDY_UNREAL_LIVE_EDIT !== '1')('places, moves and deletes an actor with read-back verification', async () => {
    const m = new IntegrationManager({
      workDir: async (id) => path.join(tmp, id),
      permissions: { load: async () => ({}), save: async () => undefined },
      approve: async () => 'always',
      discovery: { env: { ProgramFiles: 'C:\\x' }, exists: async (p) => p.toLowerCase() === exe.toLowerCase(), listDir: async () => [], run: async () => '' },
      userPaths: async () => [exe],
    });
    m.register(unrealFactory, { builtin: true });
    const key = (await m.scan()).apps[0]!.key;
    await m.connect(key);
    const before = (await m.execute(key, 'level.inspect', { max_names: 0 })).data as { actorCount: number };
    const placed = await m.execute(key, 'actor.place', { asset: '/Script/Engine.PointLight', name: 'OmniCandyTestLight', x: 120, y: -40, z: 250, scale: 1 });
    expect(placed.error, JSON.stringify(placed.error)).toBeUndefined();
    const actor = (placed.data as { actor: string }).actor;
    try {
      const moved = await m.execute(key, 'actor.transform', { actor, x: 300, yaw: 30 });
      expect(moved.error, JSON.stringify(moved.error)).toBeUndefined();
      expect((moved.data as { transform: { location: { x: number } } }).transform.location.x).toBeCloseTo(300, 0);
    } finally {
      const gone = await m.execute(key, 'actor.delete', { actor });
      expect(gone.error, JSON.stringify(gone.error)).toBeUndefined();
    }
    expect(((await m.execute(key, 'level.inspect', { max_names: 0 })).data as { actorCount: number }).actorCount).toBe(before.actorCount);
  });
});

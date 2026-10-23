// Unreal adapter and the Streamable HTTP MCP client against a MOCK server that behaves like Unreal 5.8's: a session id on
// initialize, a 400 without it, tool errors returned as plain text, replies as JSON or SSE, and a small stateful "editor"
// (actors, transforms, dirty flag) so the verified commands can be proven to read the state back. It proves the client, the
// adapter logic and the error paths. It does NOT prove the real editor; that is unreal.live.test.ts.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpHttpClient, assertLoopbackUrl, parseSseResponse } from '../mcpHttpClient';
import { IntegrationManager } from './index';
import { actorKind, capResult, parseToolsetList, RESULT_MAX_CHARS, UNREAL_MANIFEST, unrealFactory } from './adapters/unreal';
import { classifyTool, validateUnrealJson } from './adapters/unrealTools';
import { validateManifest } from './sdk';
import { ADAPTER_SDK_VERSION, type ApprovalAnswer, type Permission } from '@shared/integrations';

const LEVEL = '/Game/ThirdPerson/Lvl_ThirdPerson';
const P = `${LEVEL}.Lvl_ThirdPerson:PersistentLevel.`;
const SCENE = 'editor_toolset.toolsets.scene.SceneTools';
const ACTOR = 'editor_toolset.toolsets.actor.ActorTools';
const ASSET = 'editor_toolset.toolsets.asset.AssetTools';
const APP = 'EditorToolset.EditorAppToolset';
const PROG = 'editor_toolset.toolsets.programmatic.ProgrammaticToolset';
const ref = { type: 'object', properties: { refPath: { type: 'string' } }, required: ['refPath'] };
const T = (name: string, props: string[], required: string[] = props, description = `${name}.\nMore.`) => ({ name, description, inputSchema: { properties: Object.fromEntries(props.map((p) => [p, ref])), required } });
const TOOLSETS: Record<string, ReturnType<typeof T>[]> = {
  [SCENE]: [T('get_current_level', []), T('find_actors', ['name', 'tag', 'collision_channels'], ['name', 'tag', 'collision_channels']), T('add_to_scene_from_class', ['actor_type', 'name', 'xform', 'snap_to_ground'], ['actor_type', 'name', 'xform']), T('add_to_scene_from_asset', ['asset_path', 'name', 'xform', 'snap_to_ground'], ['asset_path', 'name', 'xform']), T('remove_from_scene', ['actor']), T('load_level', ['level_path'])],
  [ACTOR]: [T('get_actor_transform', ['actor']), T('set_actor_transform', ['actor', 'xform', 'worldspace'], ['actor', 'xform']), T('get_label', ['actor']), T('set_label', ['actor', 'label']), T('add_tag', ['actor', 'tag'])],
  [ASSET]: [T('find_assets', ['folder_path', 'name', 'recursive', 'asset_type', 'tags'], ['folder_path', 'name']), T('is_dirty', ['asset_path']), T('save_assets', ['asset_paths']), T('delete', ['path']), T('read_file', ['file_path'])],
  [APP]: [T('IsPIERunning', [], []), T('StopPIE', [], [])],
  'EditorToolset.LogsToolset': [T('GetLogEntries', ['category', 'pattern', 'maxEntries'], ['pattern'])],
  [PROG]: [T('execute_tool_script', ['script'])],
};

let server: http.Server, url: string;
const log: string[] = [];
const calls: string[] = [];
let sse = false, refuseCalls = false, emptyLevel = false;
// the mock editor
let actors: string[], xforms: Record<string, { location: { x: number; y: number; z: number }; rotation: { pitch: number; yaw: number; roll: number }; scale: { x: number; y: number; z: number } }>;
let dirty = true, saveWorks = true, deleteWorks = true, placeOffset = 0, lastScript = '';
const resetEditor = () => {
  actors = ['WorldSettings', 'Brush_0', 'StaticMeshActor_UAID_AA_1', 'StaticMeshActor_UAID_AA_2', 'PlayerStart_0'].map((n) => P + n);
  xforms = {}; dirty = true; saveWorks = true; deleteWorks = true; placeOffset = 0; lastScript = ''; emptyLevel = false;
};
const ident = () => ({ location: { x: 0, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 }, scale: { x: 1, y: 1, z: 1 } });

function reply(res: http.ServerResponse, id: unknown, result: unknown, sid?: string) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  const h: Record<string, string> = sid ? { 'Mcp-Session-Id': sid } : {};
  if (sse) { res.writeHead(200, { ...h, 'Content-Type': 'text/event-stream' }); res.end(`event: message\ndata: ${body}\n\n`); }
  else { res.writeHead(200, { ...h, 'Content-Type': 'application/json' }); res.end(body); }
}
const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const rv = (v: unknown) => text(JSON.stringify({ returnValue: v }));

function runTool(t: string, a: Record<string, any>): unknown { // eslint-disable-line @typescript-eslint/no-explicit-any -- the mock reads arbitrary tool arguments
  calls.push(t);
  switch (t) {
    case 'get_current_level': return rv(emptyLevel ? '' : LEVEL);
    case 'IsPIERunning': return rv(emptyLevel);
    case 'StopPIE': emptyLevel = false; return rv(true);
    case 'find_actors':
      if (!Array.isArray(a.collision_channels)) return text('Function "find_actors", input param "collision_channels" is required by the function input schema');
      return rv(actors.map((refPath) => ({ refPath })));
    case 'find_assets': return rv([`${a.folder_path}/A`, `${a.folder_path}/B`, `${a.folder_path}/C`]);
    case 'GetLogEntries': return rv(['l1', 'l2']);
    case 'add_to_scene_from_class': case 'add_to_scene_from_asset': {
      const kind = t === 'add_to_scene_from_class' ? String(a.actor_type.refPath).split('.').pop() : String(a.asset_path).split('/').pop();
      const r = `${P}${kind}_${actors.length + 10}`;
      actors.push(r);
      const x = a.xform ?? {};
      xforms[r] = { ...ident(), ...x, location: { ...x.location, x: (x.location?.x ?? 0) + placeOffset } };
      return rv({ refPath: r });
    }
    case 'get_actor_transform': return rv(xforms[a.actor.refPath] ?? ident());
    case 'set_actor_transform': { xforms[a.actor.refPath] = { ...(xforms[a.actor.refPath] ?? ident()), ...a.xform }; return rv(true); }
    case 'get_label': return rv(String(a.actor.refPath).split('.').pop());
    case 'set_label': return rv(true);
    case 'add_tag': return text('Parameter error: tag is invalid', true);
    case 'remove_from_scene': if (deleteWorks) actors = actors.filter((x) => x !== a.actor.refPath); return rv(true);
    case 'is_dirty': return rv(dirty);
    case 'save_assets': if (saveWorks) dirty = false; return rv(true);
    case 'execute_tool_script': lastScript = String(a.script); return rv(JSON.stringify({ ok: true }));
    case 'delete': case 'read_file': case 'load_level': return rv(true);
    default: return text(`Parameter error: ${t}`, true);
  }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      log.push(`${req.method} ${req.headers['mcp-session-id'] ?? '-'}`);
      if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the mock reads arbitrary tool arguments
      const m = b ? JSON.parse(b) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, any> } } : { method: '' };
      if (m.method === 'initialize') return reply(res, m.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-ue', version: '5.8' } }, 'sess-1');
      if (req.headers['mcp-session-id'] !== 'sess-1') { res.writeHead(400); res.end('Missing required Mcp-Session-Id header'); return; }
      if (m.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      if (refuseCalls) { res.writeHead(500); res.end('boom'); return; }
      if (m.method === 'tools/call') {
        const n = m.params!.name!, a = m.params!.arguments ?? {};
        if (n === 'list_toolsets') return reply(res, m.id, text(Object.keys(TOOLSETS).map((k) => `- ${k}: ${k.split('.').pop()} toolset.\n  - GetSomething: a bullet inside the description`).join('\n')));
        if (n === 'describe_toolset') {
          const set = TOOLSETS[a.toolset_name as string];
          if (!set) return reply(res, m.id, text(`Toolset '${String(a.toolset_name)}' not found`, true));
          return reply(res, m.id, text(JSON.stringify({ name: a.toolset_name, description: 'd', tools: set.map((t) => ({ ...t, name: `${a.toolset_name}.${t.name}` })) })));
        }
        if (n === 'call_tool') return reply(res, m.id, runTool(a.tool_name as string, a.arguments ?? {}));
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { resetEditor(); calls.length = 0; });

describe('MCP Streamable HTTP client', () => {
  it('accepts only endpoints on this computer', () => {
    expect(() => assertLoopbackUrl('http://127.0.0.1:8000/mcp')).not.toThrow();
    expect(() => assertLoopbackUrl('http://localhost:8000/mcp')).not.toThrow();
    expect(() => assertLoopbackUrl('http://example.com/mcp')).toThrow(/on this computer/);
    expect(() => assertLoopbackUrl('http://192.168.1.5:8000/mcp')).toThrow(/on this computer/);
    expect(() => assertLoopbackUrl('ftp://127.0.0.1/mcp')).toThrow(/http/);
    expect(() => assertLoopbackUrl('nonsense')).toThrow(/valid URL/);
  });

  it('parses an SSE body and ignores events for other ids', () => {
    const body = 'event: message\ndata: {"id":1,"result":"no"}\n\n: keep-alive\n\nevent: message\ndata: {"id":2,\ndata: "result":"yes"}\n\n';
    expect(parseSseResponse(body, 2)).toEqual({ id: 2, result: 'yes' });
    expect(parseSseResponse(body, 9)).toBeNull();
  });

  for (const mode of [false, true]) {
    it(`initializes, keeps the session id and calls a tool (${mode ? 'SSE' : 'JSON'} replies)`, async () => {
      sse = mode; log.length = 0;
      const c = await McpHttpClient.connect(url);
      expect(c.serverInfo.name).toBe('mock-ue');
      const r = await c.callTool('call_tool', { toolset_name: 'x', tool_name: 'get_current_level', arguments: {} });
      expect(r).toEqual({ returnValue: LEVEL });
      await c.close();
      expect(log.filter((l) => l.startsWith('POST sess-1')).length).toBeGreaterThanOrEqual(2);
      expect(log.at(-1)).toBe('DELETE sess-1');
      sse = false;
    });
  }

  it('turns an isError result into a tool error and reports an unreachable server', async () => {
    const c = await McpHttpClient.connect(url);
    await expect(c.callTool('call_tool', { tool_name: 'nope', arguments: {} })).rejects.toMatchObject({ kind: 'tool', message: expect.stringContaining('Parameter error') });
    await c.close();
    await expect(McpHttpClient.connect('http://127.0.0.1:1/mcp', {}, undefined, 3000)).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('times out and honours cancel', async () => {
    const slow = http.createServer(() => { /* never answers */ });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const u = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/mcp`;
    await expect(McpHttpClient.connect(u, {}, undefined, 300)).rejects.toMatchObject({ kind: 'timeout' });
    const ac = new AbortController();
    const p = McpHttpClient.connect(u, {}, ac.signal, 5000);
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
    slow.closeAllConnections(); slow.close();
  });
});

describe('Unreal helpers and safety tiers', () => {
  it('reads the toolset list (bullets inside a description are not toolsets) and guesses actor kinds', () => {
    expect(parseToolsetList('- A.One: First.\n- GetThing: bullet in a description\ncontinued\n- B.Two: Second.')).toEqual([{ name: 'A.One', summary: 'First.' }, { name: 'B.Two', summary: 'Second.' }]);
    expect(actorKind('/Game/L.L:PersistentLevel.StaticMeshActor_UAID_F4A4_196')).toEqual({ name: 'StaticMeshActor_UAID_F4A4_196', kind: 'StaticMeshActor' });
    expect(actorKind('/Game/L.L:PersistentLevel.PlayerStart_0')).toEqual({ name: 'PlayerStart_0', kind: 'PlayerStart' });
  });

  it('puts every real tool name in the right tier', () => {
    const t = (set: string, tool: string) => classifyTool(set, tool);
    for (const [s, n] of [[SCENE, 'find_actors'], [SCENE, 'get_current_level'], [ACTOR, 'get_actor_transform'], [ASSET, 'find_assets'], [ASSET, 'is_dirty'], [APP, 'IsPIERunning'], [APP, 'GetSelectedActors'], [APP, 'CaptureViewport'], ['editor_toolset.toolsets.blueprint.BlueprintTools', 'read_graph_dsl'], ['editor_toolset.toolsets.material.MaterialTools', 'get_expressions'], ['editor_toolset.toolsets.object.ObjectTools', 'list_properties']] as const) expect(t(s, n), `${s}.${n}`).toBe('read');
    for (const [s, n] of [[SCENE, 'add_to_scene_from_class'], [ACTOR, 'set_actor_transform'], [ACTOR, 'remove_component'], [ASSET, 'save_assets'], [ASSET, 'duplicate'], [APP, 'StartPIE'], [APP, 'StopPIE'], ['editor_toolset.toolsets.blueprint.BlueprintTools', 'write_graph_dsl'], ['editor_toolset.toolsets.blueprint.BlueprintTools', 'delete_node'], ['editor_toolset.toolsets.object.ObjectTools', 'set_properties'], ['editor_toolset.toolsets.blueprint.BlueprintTools', 'get_or_create_thing']] as const) expect(t(s, n), `${s}.${n}`).toBe('edit');
    for (const [s, n] of [[ASSET, 'delete'], [ASSET, 'move'], [ASSET, 'write_file'], [ASSET, 'read_file'], [SCENE, 'remove_from_scene'], [SCENE, 'load_level'], [SCENE, 'delete_folder'], ['editor_toolset.toolsets.static_mesh.StaticMeshTools', 'import_file'], ['PluginToolset.PluginToolset', 'EnablePlugin'], ['SlateInspectorToolset.SlateInspectorToolset', 'Click'], ['ConfigSettingsToolset.ConfigSettingsToolset', 'SaveSection'], ['animation_toolset.toolsets.import_export.SequencerImportExportTools', 'export_fbx']] as const) expect(t(s, n), `${s}.${n}`).toBe('restricted');
    expect(t(PROG, 'execute_tool_script')).toBe('script');
    // reading a restricted toolset is still reading
    expect(t('PluginToolset.PluginToolset', 'ListPlugins')).toBe('read');
  });

  it('checks structured parameters before anyone is asked', () => {
    expect(validateUnrealJson('tool.read', 'arguments', {})).toBeUndefined();
    expect(validateUnrealJson('tool.read', 'arguments', [1])).toMatch(/object/);
    expect(validateUnrealJson('tool.batch', 'calls', [])).toMatch(/non-empty/);
    expect(validateUnrealJson('tool.batch', 'calls', Array.from({ length: 51 }, () => ({ toolset: ACTOR, tool: 'get_label' })))).toMatch(/at most 50/);
    expect(validateUnrealJson('tool.batch', 'calls', [{ toolset: ASSET, tool: 'delete' }])).toMatch(/restricted tool.*tool\.restricted/);
    expect(validateUnrealJson('tool.batch', 'calls', [{ toolset: PROG, tool: 'execute_tool_script' }])).toMatch(/script\.run/);
    expect(validateUnrealJson('tool.batch', 'calls', [{ toolset: 'bad name!', tool: 'x' }])).toMatch(/toolset/);
    expect(validateUnrealJson('tool.batch', 'calls', [{ toolset: ACTOR, tool: 'get_label', arguments: {} }])).toBeUndefined();
    expect(validateUnrealJson('script.run', 'script', { purpose: 'ok!', code: 'x = 1' })).toMatch(/run\(\)/);
    expect(validateUnrealJson('script.run', 'script', { purpose: 'ok!', code: 'def run():\n    return {}', extra: 1 })).toMatch(/only/);
    expect(validateUnrealJson('script.run', 'script', { purpose: 'ok!', code: 'def run():\n    return {}' })).toBeUndefined();
  });

  it('caps huge results and says so', () => {
    expect(capResult({ a: 1 })).toMatchObject({ truncated: false, result: { a: 1 } });
    const big = capResult('x'.repeat(RESULT_MAX_CHARS + 5));
    expect(big).toMatchObject({ truncated: true, chars: RESULT_MAX_CHARS + 5 });
    expect(big.preview).toHaveLength(RESULT_MAX_CHARS);
  });

  it('has a valid manifest whose dangerous commands are asked about, and nothing launches the editor', () => {
    expect(validateManifest(UNREAL_MANIFEST, ADAPTER_SDK_VERSION)).toEqual([]);
    expect(UNREAL_MANIFEST.commands.flatMap((c) => c.permissions)).not.toContain('launch');
    const cmd = (id: string) => UNREAL_MANIFEST.commands.find((c) => c.id === id)!;
    for (const id of ['tool.restricted', 'actor.delete', 'script.run']) expect(cmd(id).destructive, id).toBe(true);
    expect(cmd('script.run').confirmEveryTime).toBe(true);
    // every command that only reads is idempotent, non-destructive and holds no write permission
    for (const id of ['app.info', 'toolsets.list', 'toolsets.describe', 'tools.search', 'level.inspect', 'assets.find', 'logs.read', 'tool.read']) {
      const c = cmd(id);
      expect(c.idempotent && !c.destructive && c.permissions.every((p) => p === 'read-info' || p === 'read-project'), id).toBe(true);
    }
    // the generic edit and batch commands are not destructive but need modify-project
    expect(cmd('tool.edit').permissions).toContain('modify-project');
    expect(cmd('tool.batch').destructive).toBeFalsy();
  });
});

describe('Unreal adapter through the shared manager (mock server)', { timeout: 60_000 }, () => {
  let tmp: string, exe: string;
  const asked: Array<{ cmd: string; destructive: boolean }> = [];
  let answer: ApprovalAnswer = 'always';
  let grants: Record<string, Permission[]> = {};
  async function manager() {
    const m = new IntegrationManager({
      workDir: async (id) => path.join(tmp, 'work', id),
      permissions: { load: async () => grants, save: async (g) => { grants = g; } },
      approve: async (r) => { asked.push({ cmd: r.command.id, destructive: r.destructive }); return answer; },
      discovery: { env: { ProgramFiles: 'C:\\x' }, exists: async (p) => p.toLowerCase() === exe.toLowerCase(), listDir: async () => [], run: async () => '' },
      userPaths: async () => [exe],
    });
    m.register(unrealFactory, { builtin: true });
    const scan = await m.scan();
    return { m, key: scan.apps[0]!.key, scan };
  }
  async function connected() { const x = await manager(); await x.m.connect(x.key); return x; }
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-unreal-'));
    exe = path.join(tmp, 'UE_5.8', 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');
    await fs.mkdir(path.dirname(exe), { recursive: true });
    await fs.writeFile(exe, 'x');
    await fs.mkdir(path.join(tmp, 'UE_5.8', 'Engine', 'Build'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'UE_5.8', 'Engine', 'Build', 'Build.version'), JSON.stringify({ MajorVersion: 5, MinorVersion: 8, PatchVersion: 4 }));
    process.env.OMNICANDY_UNREAL_MCP_URL = url;
  });
  afterAll(async () => { delete process.env.OMNICANDY_UNREAL_MCP_URL; refuseCalls = false; await fs.rm(tmp, { recursive: true, force: true }); });
  beforeEach(() => { asked.length = 0; answer = 'always'; grants = {}; });

  it('is found, reads its version from Build.version and connects', async () => {
    const { m, key, scan } = await manager();
    expect(scan.apps[0]).toMatchObject({ adapterId: 'unreal', version: '5.8.4' });
    await m.connect(key);
    const [info] = await m.list();
    expect(info!.status).toMatch(/connected|limited/i);
  });

  it('runs the read commands and reports live evidence', async () => {
    const { m, key } = await connected();
    expect((await m.execute(key, 'app.info')).data).toMatchObject({ toolsetCount: 6, level: LEVEL, pieRunning: false });
    expect((await m.execute(key, 'toolsets.list')).data).toMatchObject({ count: 6 });
    const desc = await m.execute(key, 'toolsets.describe', { toolset: ACTOR });
    expect((desc.data as { tools: Array<{ name: string; tier: string }> }).tools.find((t) => t.name === 'set_actor_transform')).toMatchObject({ tier: 'edit', required: ['actor', 'xform'] });
    const lvl = await m.execute(key, 'level.inspect', { max_names: 3 });
    expect(lvl.data).toMatchObject({ level: LEVEL, actorCount: 5, kinds: { StaticMeshActor: 2, WorldSettings: 1, Brush: 1, PlayerStart: 1 } });
    expect((lvl.data as { names: string[] }).names).toHaveLength(3);
    expect((await m.execute(key, 'assets.find', { folder: '/Game/ThirdPerson', max: 2 })).data).toMatchObject({ total: 3, assets: ['/Game/ThirdPerson/A', '/Game/ThirdPerson/B'] });
    expect((await m.execute(key, 'logs.read', { pattern: 'Mcp' })).data).toMatchObject({ count: 2 });
  });

  it('tools.search finds tools across toolsets and names the command that runs each', async () => {
    const { m, key } = await connected();
    const r = await m.execute(key, 'tools.search', { query: 'actor transform' });
    const hits = (r.data as { tools: Array<{ tool: string; tier: string; command: string }> }).tools;
    expect(hits.map((h) => h.tool)).toEqual(expect.arrayContaining(['get_actor_transform', 'set_actor_transform']));
    expect(hits.find((h) => h.tool === 'set_actor_transform')).toMatchObject({ tier: 'edit', command: 'tool.edit' });
    const del = await m.execute(key, 'tools.search', { query: 'delete', tier: 'restricted' });
    expect((del.data as { tools: Array<{ tool: string; command: string }> }).tools).toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'delete', command: 'tool.restricted' })]));
    expect((await m.execute(key, 'tools.search', { tier: 'bogus' })).error?.kind).toBe('invalid-params');
  });

  it('routes a tool to the command of its tier and refuses the others before calling Unreal', async () => {
    const { m, key } = await connected();
    const ok = await m.execute(key, 'tool.read', { toolset: ACTOR, tool: 'get_label', arguments: { actor: { refPath: `${P}Brush_0` } } });
    expect(ok.error).toBeUndefined();
    expect(ok.data).toMatchObject({ tool: 'get_label', result: 'Brush_0' });
    calls.length = 0;
    const wrong = await m.execute(key, 'tool.read', { toolset: ACTOR, tool: 'set_label', arguments: { actor: { refPath: `${P}Brush_0` }, label: 'x' } });
    expect(wrong.error?.message).toMatch(/edit tool.*tool\.edit/);
    expect((await m.execute(key, 'tool.edit', { toolset: ASSET, tool: 'delete', arguments: { path: '/Game/X' } })).error?.message).toMatch(/restricted tool.*tool\.restricted/);
    expect((await m.execute(key, 'tool.edit', { toolset: PROG, tool: 'execute_tool_script', arguments: { script: 'x' } })).error?.message).toMatch(/script\.run/);
    expect((await m.execute(key, 'tool.read', { toolset: ACTOR, tool: 'get_nothing', arguments: {} })).error?.message).toMatch(/no tool "get_nothing"/);
    expect((await m.execute(key, 'tool.read', { toolset: ACTOR, tool: 'get_label', arguments: {} })).error?.message).toMatch(/needs actor/);
    expect((await m.execute(key, 'tool.read', { toolset: ACTOR, tool: 'get_label', arguments: { actor: {}, bogus: 1 } })).error?.message).toMatch(/no parameter bogus/);
    expect((await m.execute(key, 'tool.read', { toolset: 'No.Such', tool: 'get_x', arguments: {} })).error).toBeDefined();
    expect(calls).toEqual([]); // not one real tool call was made for any refused request
  });

  it('tool.edit changes the editor, is only a receipt (not "verified"), and surfaces Unreal errors', async () => {
    const { m, key } = await connected();
    const r = await m.execute(key, 'tool.edit', { toolset: ACTOR, tool: 'set_label', arguments: { actor: { refPath: `${P}Brush_0` }, label: 'Wall' } });
    expect(r.error).toBeUndefined();
    expect(r.verified).not.toBe(true);
    expect((await m.execute(key, 'tool.edit', { toolset: ACTOR, tool: 'add_tag', arguments: { actor: { refPath: `${P}Brush_0` }, tag: 'x' } })).error?.message).toMatch(/tag is invalid/);
  });

  it('asks before restricted tools every time and never runs them when declined', async () => {
    const { m, key } = await connected();
    answer = 'deny';
    calls.length = 0;
    const r = await m.execute(key, 'tool.restricted', { toolset: ASSET, tool: 'delete', arguments: { path: '/Game/X' } });
    expect(r.error).toBeDefined();
    expect(asked.at(-1)).toMatchObject({ cmd: 'tool.restricted', destructive: true });
    expect(calls).toEqual([]);
    answer = 'always';
    expect((await m.execute(key, 'tool.restricted', { toolset: ASSET, tool: 'delete', arguments: { path: '/Game/X' } })).error).toBeUndefined();
    expect(calls).toContain('delete');
  });

  it('tool.batch checks every call first, runs them in order, and reports a partial failure honestly', async () => {
    const { m, key } = await connected();
    const a = { actor: { refPath: `${P}Brush_0` } };
    const good = [{ toolset: ACTOR, tool: 'set_label', arguments: { ...a, label: 'A' } }, { toolset: ACTOR, tool: 'get_label', arguments: a }];
    const ok = await m.execute(key, 'tool.batch', { calls: good });
    expect(ok.error).toBeUndefined();
    expect(ok.data).toMatchObject({ total: 2, applied: 2, failedAt: null });
    calls.length = 0;
    // one bad call anywhere: nothing runs at all
    const bad = [...good, { toolset: ACTOR, tool: 'no_such_tool', arguments: {} }];
    const refused = await m.execute(key, 'tool.batch', { calls: bad });
    expect(refused.error?.message).toMatch(/calls\[2\].*no tool "no_such_tool"/);
    expect(calls).toEqual([]);
    // a failure at run time stops the batch and says what was applied
    const mid = [good[0]!, { toolset: ACTOR, tool: 'add_tag', arguments: { ...a, tag: 't' } }, good[1]!];
    calls.length = 0;
    const partial = await m.execute(key, 'tool.batch', { calls: mid });
    expect(partial.error?.message).toMatch(/stopped at call 2 of 3.*1 earlier call\(s\) were applied.*NOT rolled back/);
    expect(calls).toEqual(['IsPIERunning', 'set_label', 'add_tag']); // stopped at the failure: get_label never ran
  });

  it('refuses every edit while Play-In-Editor runs, except the call that stops it', async () => {
    const { m, key } = await connected();
    emptyLevel = true; // the mock reports PIE running and no level
    expect((await m.execute(key, 'tool.edit', { toolset: ACTOR, tool: 'set_label', arguments: { actor: { refPath: `${P}Brush_0` }, label: 'x' } })).error?.message).toMatch(/Play-In-Editor is running/);
    expect((await m.execute(key, 'actor.place', { asset: '/Script/Engine.PointLight', name: 'L' })).error?.message).toMatch(/Play-In-Editor/);
    expect((await m.execute(key, 'level.inspect')).error?.message).toMatch(/Play-In-Editor/);
    expect((await m.execute(key, 'app.info')).message).toMatch(/no editor level/);
    const stop = await m.execute(key, 'tool.edit', { toolset: APP, tool: 'StopPIE', arguments: {} });
    expect(stop.error).toBeUndefined();
    expect((await m.execute(key, 'level.inspect')).error).toBeUndefined();
  });

  it('actor.place spawns, then proves the actor is new and where it was asked to be', async () => {
    const { m, key } = await connected();
    const r = await m.execute(key, 'actor.place', { asset: '/Script/Engine.PointLight', name: 'Lamp', x: 100, y: 200, z: 300, yaw: 90, scale: 2 });
    expect(r.error).toBeUndefined();
    expect(r.verified).toBe(true);
    const d = r.data as { actor: string; actorCount: number; transform: { location: { x: number }; scale: { x: number } } };
    expect(d.actor).toContain('PointLight_');
    expect(d.actorCount).toBe(6);
    expect(d.transform.location.x).toBe(100);
    expect(d.transform.scale.x).toBe(2);
    expect((await m.execute(key, 'level.inspect')).data).toMatchObject({ actorCount: 6 });
    // an asset path uses the asset tool
    calls.length = 0;
    expect((await m.execute(key, 'actor.place', { asset: '/Game/Props/Crate', name: 'Crate' })).error).toBeUndefined();
    expect(calls).toContain('add_to_scene_from_asset');
    expect((await m.execute(key, 'actor.place', { asset: 'not a path', name: 'x' })).error?.kind).toBe('invalid-params');
    expect((await m.execute(key, 'actor.place', { asset: '/Game/X', name: 'bad;name' })).error?.kind).toBe('invalid-params');
  });

  it('actor.place fails verification when the editor put the actor somewhere else', async () => {
    const { m, key } = await connected();
    placeOffset = 50;
    const r = await m.execute(key, 'actor.place', { asset: '/Script/Engine.PointLight', name: 'Lamp', x: 10 });
    expect(r.error?.kind).toBe('verification-failed');
    expect(r.error?.message).toMatch(/instead of/);
  });

  it('actor.transform changes only what is given and re-reads the result', async () => {
    const { m, key } = await connected();
    const placed = (await m.execute(key, 'actor.place', { asset: '/Script/Engine.PointLight', name: 'Lamp', x: 1, y: 2, z: 3 })).data as { actor: string };
    const r = await m.execute(key, 'actor.transform', { actor: placed.actor, x: 50, yaw: 45 });
    expect(r.error).toBeUndefined();
    expect(r.verified).toBe(true);
    expect((r.data as { transform: { location: Record<string, number>; rotation: Record<string, number> } }).transform).toMatchObject({ location: { x: 50, y: 2, z: 3 }, rotation: { pitch: 0, yaw: 45, roll: 0 } });
    expect((await m.execute(key, 'actor.transform', { actor: placed.actor })).error?.kind).toBe('invalid-params');
    expect((await m.execute(key, 'actor.transform', { actor: `${P}Nope_9`, x: 1 })).error?.message).toMatch(/no actor/);
  });

  it('actor.delete asks first and proves the actor is gone, or says it is not', async () => {
    const { m, key } = await connected();
    const target = `${P}PlayerStart_0`;
    answer = 'deny';
    expect((await m.execute(key, 'actor.delete', { actor: target })).error).toBeDefined();
    expect(actors).toContain(target);
    answer = 'always';
    const r = await m.execute(key, 'actor.delete', { actor: target });
    expect(r.error).toBeUndefined();
    expect(r.verified).toBe(true);
    expect(actors).not.toContain(target);
    expect(asked.every((a) => a.cmd !== 'actor.delete' || a.destructive)).toBe(true);
    expect((await m.execute(key, 'actor.delete', { actor: target })).data).toMatchObject({ existed: false });
    deleteWorks = false;
    expect((await m.execute(key, 'actor.delete', { actor: `${P}Brush_0` })).error?.kind).toBe('verification-failed');
  });

  it('level.save only succeeds when the level is no longer dirty', async () => {
    const { m, key } = await connected();
    const r = await m.execute(key, 'level.save');
    expect(r.error).toBeUndefined();
    expect(r.data).toMatchObject({ level: LEVEL, dirtyBefore: true, dirtyAfter: false });
    dirty = true; saveWorks = false;
    expect((await m.execute(key, 'level.save')).error?.kind).toBe('verification-failed');
  });

  it('script.run shows the code, is asked every time, and only then reaches the sandbox', async () => {
    const { m, key } = await connected();
    const script = { purpose: 'Count actors', code: 'def run():\n    return {"n": 1}' };
    answer = 'deny';
    expect((await m.execute(key, 'script.run', { script })).error).toBeDefined();
    expect(lastScript).toBe('');
    answer = 'always';
    const r = await m.execute(key, 'script.run', { script });
    expect(r.error).toBeUndefined();
    expect(lastScript).toBe(script.code);
    expect(r.data).toMatchObject({ purpose: 'Count actors', result: { ok: true } });
    expect(r.verified).not.toBe(true);
    asked.length = 0;
    await m.execute(key, 'script.run', { script });
    await m.execute(key, 'script.run', { script });
    expect(asked.filter((a) => a.cmd === 'script.run')).toHaveLength(2); // never "always allow"
    expect((await m.execute(key, 'script.run', { script: { purpose: 'No run', code: 'x = 1' } })).error?.kind).toBe('invalid-params');
  });

  it('refuses bad input before calling Unreal and surfaces plain-text tool errors', async () => {
    const { m, key } = await connected();
    expect((await m.execute(key, 'assets.find', { folder: 'Game; rm' })).error?.kind).toBe('invalid-params');
    expect((await m.execute(key, 'logs.read', { pattern: '(' })).error?.kind).toBe('invalid-params');
    expect((await m.execute(key, 'toolsets.describe', { toolset: 'bad name!' })).error?.kind).toBe('invalid-params');
    expect((await m.execute(key, 'toolsets.describe', { toolset: 'No.Such' })).error).toBeDefined();
    expect((await m.execute(key, 'app.write_everything')).error).toBeDefined();
  });

  it('reports an unreachable server instead of a generic failure', async () => {
    const { m, key } = await manager();
    process.env.OMNICANDY_UNREAL_MCP_URL = 'http://127.0.0.1:1/mcp';
    try {
      await expect(m.connect(key)).rejects.toThrow(/not reachable|ModelContextProtocol|Auto Start/i);
    } finally { process.env.OMNICANDY_UNREAL_MCP_URL = url; }
  });
});

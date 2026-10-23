// Unreal adapter and the Streamable HTTP MCP client against a MOCK server that behaves like Unreal 5.8's: a session id on
// initialize, a 400 without it, tool errors returned as plain text, replies as JSON or SSE. It proves the client, the
// adapter logic and the error paths. It does NOT prove the real editor; that is unreal.live.test.ts.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpHttpClient, assertLoopbackUrl, parseSseResponse } from '../mcpHttpClient';
import { IntegrationManager } from './index';
import { actorKind, parseToolsetList, UNREAL_MANIFEST } from './adapters/unreal';
import { validateManifest } from './sdk';
import { ADAPTER_SDK_VERSION } from '@shared/integrations';

const LEVEL = '/Game/ThirdPerson/Lvl_ThirdPerson';
const ACTORS = ['WorldSettings', 'Brush_0', 'StaticMeshActor_UAID_AA_1', 'StaticMeshActor_UAID_AA_2', 'PlayerStart_0']
  .map((n) => ({ refPath: `${LEVEL}.Lvl_ThirdPerson:PersistentLevel.${n}` }));

let server: http.Server, url: string;
const log: string[] = [];
let sse = false, refuseCalls = false, emptyLevel = false;

function reply(res: http.ServerResponse, id: unknown, result: unknown, sid?: string) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  const h: Record<string, string> = sid ? { 'Mcp-Session-Id': sid } : {};
  if (sse) { res.writeHead(200, { ...h, 'Content-Type': 'text/event-stream' }); res.end(`event: message\ndata: ${body}\n\n`); }
  else { res.writeHead(200, { ...h, 'Content-Type': 'application/json' }); res.end(body); }
}
const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

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
        if (n === 'list_toolsets') return reply(res, m.id, text('- A.One: First toolset.\nwith a second line\n- B.Two: Second toolset.'));
        if (n === 'describe_toolset') return reply(res, m.id, text(JSON.stringify({ name: a.toolset_name, description: 'd', tools: [{ name: `${a.toolset_name}.go`, description: 'Goes.\nMore.', inputSchema: { properties: { x: {} }, required: ['x'] } }] })));
        if (n === 'call_tool') {
          const t = a.tool_name as string, args = a.arguments ?? {};
          if (t === 'get_current_level') return reply(res, m.id, text(JSON.stringify({ returnValue: emptyLevel ? '' : LEVEL })));
          if (t === 'IsPIERunning') return reply(res, m.id, text(JSON.stringify({ returnValue: emptyLevel })));
          if (t === 'find_actors') {
            if (!Array.isArray(args.collision_channels)) return reply(res, m.id, text('Function "find_actors", input param "collision_channels" is required by the function input schema'));
            return reply(res, m.id, text(JSON.stringify({ returnValue: ACTORS })));
          }
          if (t === 'find_assets') return reply(res, m.id, text(JSON.stringify({ returnValue: [`${args.folder_path}/A`, `${args.folder_path}/B`, `${args.folder_path}/C`] })));
          if (t === 'GetLogEntries') return reply(res, m.id, text(JSON.stringify({ returnValue: ['l1', 'l2'] })));
          return reply(res, m.id, text(`Parameter error: ${t}`, true));
        }
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

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

describe('Unreal helpers', () => {
  it('reads the toolset list and guesses actor kinds', () => {
    expect(parseToolsetList('- A.One: First.\ncontinued\n- B.Two: Second.')).toEqual([{ name: 'A.One', summary: 'First.' }, { name: 'B.Two', summary: 'Second.' }]);
    expect(actorKind('/Game/L.L:PersistentLevel.StaticMeshActor_UAID_F4A4_196')).toEqual({ name: 'StaticMeshActor_UAID_F4A4_196', kind: 'StaticMeshActor' });
    expect(actorKind('/Game/L.L:PersistentLevel.PlayerStart_0')).toEqual({ name: 'PlayerStart_0', kind: 'PlayerStart' });
  });
  it('has a valid read-only manifest that never asks to launch or write', () => {
    expect(validateManifest(UNREAL_MANIFEST, ADAPTER_SDK_VERSION)).toEqual([]);
    const perms = UNREAL_MANIFEST.commands.flatMap((c) => c.permissions);
    for (const p of ['launch', 'modify-project', 'write-files', 'execute-scripts', 'network']) expect(perms).not.toContain(p);
    expect(UNREAL_MANIFEST.commands.every((c) => c.idempotent && !c.destructive)).toBe(true);
  });
});

describe('Unreal adapter through the shared manager (mock server)', { timeout: 60_000 }, () => {
  let tmp: string, exe: string;
  async function manager() {
    const m = new IntegrationManager({
      workDir: async (id) => path.join(tmp, 'work', id),
      permissions: { load: async () => ({}), save: async () => undefined },
      approve: async () => 'always',
      discovery: { env: { ProgramFiles: 'C:\\x' }, exists: async (p) => p.toLowerCase() === exe.toLowerCase(), listDir: async () => [], run: async () => '' },
      userPaths: async () => [exe],
    });
    const { unrealFactory } = await import('./adapters/unreal');
    m.register(unrealFactory, { builtin: true });
    const scan = await m.scan();
    return { m, key: scan.apps[0]!.key, scan };
  }
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

  it('is found, reads its version from Build.version and connects', async () => {
    const { m, key, scan } = await manager();
    expect(scan.apps[0]).toMatchObject({ adapterId: 'unreal', version: '5.8.4' });
    await m.connect(key);
    const [info] = await m.list();
    expect(info!.status).toMatch(/connected|limited/i);
  });

  it('runs every read-only command and reports live evidence', async () => {
    const { m, key } = await manager();
    await m.connect(key);
    const info = await m.execute(key, 'app.info');
    expect(info.error).toBeUndefined();
    expect(info.data).toMatchObject({ toolsetCount: 2, level: LEVEL, pieRunning: false });
    const list = await m.execute(key, 'toolsets.list');
    expect(list.data).toMatchObject({ count: 2 });
    const desc = await m.execute(key, 'toolsets.describe', { toolset: 'A.One' });
    expect(desc.data).toMatchObject({ count: 1, tools: [{ name: 'go', summary: 'Goes.', params: ['x'], required: ['x'] }] });
    const lvl = await m.execute(key, 'level.inspect', { max_names: 3 });
    expect(lvl.data).toMatchObject({ level: LEVEL, actorCount: 5, kinds: { StaticMeshActor: 2, WorldSettings: 1, Brush: 1, PlayerStart: 1 } });
    expect((lvl.data as { names: string[] }).names).toHaveLength(3);
    const assets = await m.execute(key, 'assets.find', { folder: '/Game/ThirdPerson', max: 2 });
    expect(assets.data).toMatchObject({ total: 3, assets: ['/Game/ThirdPerson/A', '/Game/ThirdPerson/B'] });
    const logs = await m.execute(key, 'logs.read', { pattern: 'Mcp' });
    expect(logs.data).toMatchObject({ count: 2 });
  });

  it('refuses bad input before calling Unreal and surfaces plain-text tool errors', async () => {
    const { m, key } = await manager();
    await m.connect(key);
    expect((await m.execute(key, 'assets.find', { folder: 'Game; rm' })).error?.kind).toBe('invalid-params');
    expect((await m.execute(key, 'logs.read', { pattern: '(' })).error?.kind).toBe('invalid-params');
    expect((await m.execute(key, 'toolsets.describe', { toolset: 'bad name!' })).error?.kind).toBe('invalid-params');
    expect((await m.execute(key, 'app.write_everything')).error).toBeDefined();
  });

  it('explains an empty level while Play-In-Editor runs instead of inspecting nothing', async () => {
    const { m, key } = await manager();
    await m.connect(key);
    emptyLevel = true;
    try {
      const r = await m.execute(key, 'level.inspect');
      expect(r.error?.message).toMatch(/Play-In-Editor/);
      const info = await m.execute(key, 'app.info');
      expect(info.error).toBeUndefined();
      expect(info.message).toMatch(/no editor level/);
    } finally { emptyLevel = false; }
  });

  it('reports an unreachable server instead of a generic failure', async () => {
    const { m, key } = await manager();
    process.env.OMNICANDY_UNREAL_MCP_URL = 'http://127.0.0.1:1/mcp';
    try {
      await expect(m.connect(key)).rejects.toThrow(/not reachable|ModelContextProtocol/i);
    } finally { process.env.OMNICANDY_UNREAL_MCP_URL = url; }
  });
});

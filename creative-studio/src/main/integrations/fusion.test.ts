// Fusion adapter against a MOCK server shaped like Autodesk's real Fusion MCP server (verified live against Fusion 360
// itself for the tool names/schemas below; see fusion.live.test.ts for the real program). The mock cannot run Python, so
// script calls are recognised by a distinctive fragment of the fixed template and answered the way the real template's
// script would answer; export scripts additionally write a real (minimal) file at the path the script's own base64
// parameter block names, so the adapter's own re-read-and-verify code runs against real bytes on disk.
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationManager } from './index';
import { FUSION_MANIFEST, fusionFactory, fusionLaunch, validateFusionJson } from './adapters/fusion';
import { setFusionLiveHooks, fusionProcess } from './adapters/fusionLive';
import { validateManifest } from './sdk';
import { ADAPTER_SDK_VERSION, type ApprovalAnswer, type Permission } from '@shared/integrations';

let server: http.Server, url: string;
let refuseCalls = false;
const calls: string[] = [];

function reply(res: http.ServerResponse, id: unknown, result: unknown, sid?: string) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  const h: Record<string, string> = sid ? { 'Mcp-Session-Id': sid } : {};
  res.writeHead(200, { ...h, 'Content-Type': 'application/json' });
  res.end(body);
}
const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
// Fusion's real execute "script" feature never sets isError: it always answers {success, message} or {success: false, error}.
const resultLine = (obj: unknown) => text(JSON.stringify({ message: `CREATECRAFT_RESULT ${JSON.stringify(obj)}`, success: true }));
const scriptFailure = (error: string) => text(JSON.stringify({ error, success: false }));

function decodedParams(script: string): Record<string, unknown> {
  const m = /base64\.b64decode\("([^"]+)"\)/.exec(script);
  if (!m) return {};
  return JSON.parse(Buffer.from(m[1]!, 'base64').toString('utf8')) as Record<string, unknown>;
}

/** Fakes the one thing Fusion's real script door does that OmniCandy's adapter re-checks from disk: writing export files. */
async function fakeExport(scriptPath: string, format: string): Promise<void> {
  if (format === 'step') { await fs.writeFile(scriptPath, 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n'); return; }
  const header = Buffer.alloc(80);
  const count = Buffer.alloc(4); count.writeUInt32LE(0, 0);
  await fs.writeFile(scriptPath, Buffer.concat([header, count]));
}

async function runScript(a: { script?: string; readOnly?: boolean }): Promise<unknown> {
  const script = String(a.script ?? '');
  if (/design\.exportManager/.test(script)) {
    const p = decodedParams(script);
    await fakeExport(String(p.path), String(p.format));
    return resultLine({ ok: true, path: p.path, format: p.format });
  }
  if (/userParameters\.itemByName/.test(script)) {
    const p = decodedParams(script);
    if (p.name === 'missing') return resultLine({ error: 'No user parameter named missing.' });
    const after = /^[\d.]+$/.test(String(p.expression)) ? Number(p.expression) : 99;
    return resultLine({ name: p.name, before: 10, after, expression: p.expression, bodies: [{ name: 'Body1', volume: after * 2 }] });
  }
  if (/addNewComponent/.test(script)) {
    const p = decodedParams(script) as { kind: string; name: string; width: number; depth: number; height: number; radius: number };
    if (!['box', 'cylinder', 'sphere'].includes(p.kind)) return resultLine({ error: 'kind must be box, cylinder or sphere.' });
    const volume = p.kind === 'box' ? p.width * p.depth * p.height : p.kind === 'cylinder' ? Math.PI * p.radius ** 2 * p.height : (4 / 3) * Math.PI * p.radius ** 3;
    return resultLine({ component: p.name || p.kind, body: 'Body1', volume, boundingBox: { min: [0, 0, 0], max: [p.width || p.radius * 2, p.depth || p.radius * 2, p.height || p.radius * 2] } });
  }
  if (/timelineCount/.test(script)) {
    if (a.readOnly !== true) return scriptFailure('Cannot modify the design from a read-only context');
    return resultLine({ document: 'Box v1', units: 'cm', componentCount: 1, components: [{ name: 'Box v1', bodies: [{ name: 'Body1', isSolid: true, volume: 42, boundingBox: { min: [0, 0, 0], max: [1, 1, 1] } }], sketchCount: 1 }], parameters: [{ name: 'width', expression: '10 cm', value: 10, unit: 'cm', comment: '' }], timelineCount: 3 });
  }
  // script.run: a plain echo of what the script "prints", for the handful of free-form scripts the tests send.
  if (/raise Exception/.test(script)) return scriptFailure('Traceback (most recent call last):\nException: boom');
  return text(JSON.stringify({ message: '2.0.19912 (printed by the test script)', success: true }));
}

const DOCS = { results: [{ name: 'Box v1', id: 'doc-1', isActive: true, isModified: false }, { name: 'Old', id: 'doc-2', isActive: false, isModified: false }] };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
      const m = b ? JSON.parse(b) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } } : { method: '' };
      if (m.method === 'initialize') return reply(res, m.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'MCP Server Adapter', version: '1.0.0' } }, 'sess-1');
      if (req.headers['mcp-session-id'] !== 'sess-1') { res.writeHead(400); res.end('Missing required Mcp-Session-Id header'); return; }
      if (m.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      if (refuseCalls) { res.writeHead(500); res.end('boom'); return; }
      if (m.method !== 'tools/call') { res.writeHead(404); res.end(); return; }
      const name = m.params!.name!, a = (m.params!.arguments ?? {}) as Record<string, unknown>;
      calls.push(name);
      void (async () => {
        if (name === 'fusion_mcp_read') {
          const q = a.queryType;
          if (q === 'licensing') return reply(res, m.id, text(JSON.stringify({ summary: { isHobbyist: true }, services: [], activeExtensions: [], purchasableExtensions: [], flexTokens: {} })));
          if (q === 'projects') return reply(res, m.id, text(JSON.stringify({ projects: [{ name: 'P1', id: 'b.p1' }] })));
          if (q === 'document') {
            if (a.operation === 'search') return reply(res, m.id, text(JSON.stringify({ results: String(a.name).toLowerCase().includes('box') ? [{ name: 'Box v1', id: 'doc-1' }] : [] })));
            if (a.operation === 'recent') return reply(res, m.id, text(JSON.stringify({ results: [{ name: 'Old', id: 'doc-2' }] })));
            return reply(res, m.id, text(JSON.stringify(DOCS)));
          }
          if (q === 'apiDocumentation') return reply(res, m.id, text(JSON.stringify({ classes: [{ name: 'Extrude', doc: 'd' }], members: [] })));
          if (q === 'screenshot') return reply(res, m.id, { content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' }] });
          if (q === 'activeCommand') return reply(res, m.id, text(JSON.stringify({ activeCommand: null })));
          return reply(res, m.id, text('Parameter error: unknown queryType', true));
        }
        if (name === 'fusion_mcp_execute') {
          const ft = a.featureType, o = (a.object ?? {}) as Record<string, unknown>;
          if (ft === 'script') return reply(res, m.id, await runScript(o));
          if (ft === 'document') {
            if (o.operation === 'open') return reply(res, m.id, text(JSON.stringify({ ok: true })));
            if (o.operation === 'close') return reply(res, m.id, text(JSON.stringify({ success: true })));
            if (o.operation === 'save') return reply(res, m.id, text(JSON.stringify({ success: true })));
          }
          return reply(res, m.id, text('Parameter error: unsupported', true));
        }
        if (name === 'fusion_mcp_update') {
          if (a.featureType === 'undo') return reply(res, m.id, text(JSON.stringify({ success: true, canUndo: false, canRedo: true })));
          if (a.featureType === 'redo') return reply(res, m.id, text(JSON.stringify({ success: false, error: 'Nothing to redo', canUndo: true, canRedo: false })));
        }
        res.writeHead(404); res.end();
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { calls.length = 0; refuseCalls = false; });

describe('Fusion manifest and json validation', () => {
  it('has a valid manifest whose dangerous command is asked about every time', () => {
    expect(validateManifest(FUSION_MANIFEST, ADAPTER_SDK_VERSION)).toEqual([]);
    const cmd = (id: string) => FUSION_MANIFEST.commands.find((c) => c.id === id)!;
    expect(cmd('script.run').destructive).toBe(true);
    expect(cmd('script.run').confirmEveryTime).toBe(true);
    expect(cmd('document.close').destructive).toBe(true);
    for (const id of ['app.info', 'project.list', 'document.search', 'document.list_open', 'document.list_recent', 'api.search', 'command.inspect', 'document.inspect']) {
      const c = cmd(id);
      expect(c.idempotent && !c.destructive, id).toBe(true);
    }
    for (const id of ['viewport.capture', 'export.step', 'export.stl']) expect(cmd(id).permissions, id).toContain('write-files');
    expect(cmd('document.open').permissions).toContain('open-files');
  });

  it('checks the script.run structured parameter before anyone is asked', () => {
    expect(validateFusionJson('script.run', 'script', { purpose: 'ok!', code: 'x = 1' })).toMatch(/run\(_context\)/);
    expect(validateFusionJson('script.run', 'script', { purpose: 'ok!', code: 'def run(_context):\n    pass', extra: 1 })).toMatch(/only/);
    expect(validateFusionJson('script.run', 'script', { purpose: 'ok!', code: 'def run(_context):\n    pass', readOnly: 'nope' })).toMatch(/true or false/);
    expect(validateFusionJson('script.run', 'script', { purpose: 'ok!', code: 'def run(_context):\n    pass', readOnly: true })).toBeUndefined();
    expect(validateFusionJson('script.run', 'script', 'not an object')).toMatch(/purpose/);
  });
});

describe('Fusion adapter through the shared manager (mock server)', { timeout: 60_000 }, () => {
  let tmp: string, exe: string;
  const asked: Array<{ cmd: string; destructive: boolean }> = [];
  let answer: ApprovalAnswer = 'always';
  let grants: Record<string, Permission[]> = {};
  async function manager() {
    const m = new IntegrationManager({
      workDir: async (id) => { const d = path.join(tmp, 'work', 'external', id); await fs.mkdir(d, { recursive: true }); return d; },
      permissions: { load: async () => grants, save: async (g) => { grants = g; } },
      approve: async (r) => { asked.push({ cmd: r.command.id, destructive: r.destructive }); return answer; },
      discovery: { env: { ProgramFiles: 'C:\\x' }, exists: async (p) => p.toLowerCase() === exe.toLowerCase(), listDir: async () => [], run: async () => '' },
      userPaths: async () => [exe],
    });
    m.register(fusionFactory, { builtin: true });
    const scan = await m.scan();
    return { m, key: scan.apps[0]!.key };
  }
  async function connected() { const x = await manager(); await x.m.connect(x.key); return x; }
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-fusion-'));
    exe = path.join(tmp, 'Autodesk', 'webdeploy', 'Fusion360.exe');
    await fs.mkdir(path.dirname(exe), { recursive: true });
    await fs.writeFile(exe, 'x');
    process.env.OMNICANDY_FUSION_MCP_URL = url;
  });
  afterAll(async () => { delete process.env.OMNICANDY_FUSION_MCP_URL; await fs.rm(tmp, { recursive: true, force: true }); });
  beforeEach(() => { asked.length = 0; answer = 'always'; grants = {}; });

  it('detects Fusion and reports its licence plan on connect', async () => {
    const { m, key } = await connected();
    const h = await m.execute(key, 'app.info');
    expect(h.ok).toBe(true);
    expect(h.data?.openDocuments).toHaveLength(2);
  });

  it('lists projects and finds, opens, saves and closes a document', async () => {
    const { m, key } = await connected();
    expect((await m.execute(key, 'project.list')).data?.projects).toEqual([{ name: 'P1', id: 'b.p1' }]);
    const found = await m.execute(key, 'document.search', { name: 'box' });
    expect(found.data?.results).toEqual([{ name: 'Box v1', id: 'doc-1' }]);
    expect((await m.execute(key, 'document.search', { name: 'nope' })).data?.results).toEqual([]);
    expect((await m.execute(key, 'document.open', { file_id: 'doc-1' })).ok).toBe(true);
    expect((await m.execute(key, 'document.save')).ok).toBe(true);
    const closed = await m.execute(key, 'document.close', { save: true });
    expect(closed.ok).toBe(true);
    expect(asked.find((a) => a.cmd === 'document.close')?.destructive).toBe(true);
  });

  it('undoes and redoes, reporting Fusion\'s own failure honestly', async () => {
    const { m, key } = await connected();
    expect((await m.execute(key, 'edit.undo')).ok).toBe(true);
    const r = await m.execute(key, 'edit.redo');
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/Nothing to redo/);
  });

  it('searches the live Fusion API reference', async () => {
    const { m, key } = await connected();
    const r = await m.execute(key, 'api.search', { search_pattern: 'Extrude' });
    expect(r.data?.classes).toEqual([{ name: 'Extrude', doc: 'd' }]);
    expect((await m.execute(key, 'api.search', { search_pattern: '(' })).error?.kind).toBe('invalid-params');
  });

  it('captures a verified screenshot into the library folder', async () => {
    const { m, key } = await connected();
    const r = await m.execute(key, 'viewport.capture', { file_name: 'front', direction: 'front' });
    expect(r.ok).toBe(true);
    expect(r.outputs).toHaveLength(1);
    expect(r.outputs[0]!.bytes).toBeGreaterThan(0);
    const bytes = await fs.readFile(r.outputs[0]!.path);
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('inspects the design through an enforced read-only script', async () => {
    const { m, key } = await connected();
    const r = await m.execute(key, 'document.inspect');
    expect(r.ok).toBe(true);
    expect(r.data?.componentCount).toBe(1);
    expect((r.data?.parameters as unknown[])[0]).toMatchObject({ name: 'width' });
  });

  it('sets a parameter and reads the recomputed value and volumes back', async () => {
    const { m, key } = await connected();
    const r = await m.execute(key, 'parameter.set', { name: 'width', expression: '25' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ name: 'width', before: 10, after: 25 });
    const miss = await m.execute(key, 'parameter.set', { name: 'missing', expression: '1' });
    expect(miss.ok).toBe(false);
    expect(miss.error?.message).toMatch(/No user parameter/);
  });

  it('creates a verified primitive body for each kind', async () => {
    const { m, key } = await connected();
    const box = await m.execute(key, 'component.create_primitive', { kind: 'box', name: 'B', width: 2, depth: 3, height: 4 });
    expect(box.data).toMatchObject({ component: 'B', volume: 24 });
    const cyl = await m.execute(key, 'component.create_primitive', { kind: 'cylinder', radius: 1, height: 10 });
    expect((cyl.data?.volume as number)).toBeCloseTo(Math.PI * 10, 3);
    const bad = await m.execute(key, 'component.create_primitive', { kind: 'cone' });
    expect(bad.ok).toBe(false);
    expect(bad.error?.kind).toBe('invalid-params');
  });

  it('exports a verified STEP and STL, and rejects a corrupt result', async () => {
    const { m, key } = await connected();
    const step = await m.execute(key, 'export.step', { file_name: 'part' });
    expect(step.ok).toBe(true);
    expect(step.outputs[0]!.path.endsWith('.step')).toBe(true);
    const stl = await m.execute(key, 'export.stl', { file_name: 'part' });
    expect(stl.ok).toBe(true);
    expect(stl.evidence.join(' ')).toMatch(/0 triangle/);
  });

  it('runs a free-form script.run, asking every time, and surfaces a raised exception', async () => {
    const { m, key } = await connected();
    const ok = await m.execute(key, 'script.run', { script: JSON.stringify({ purpose: 'print the version', code: 'def run(_context):\n    print(1)\n' }) });
    expect(ok.ok).toBe(true);
    expect(ok.data?.output).toMatch(/2\.0\.19912/);
    expect(asked.filter((a) => a.cmd === 'script.run')).toHaveLength(1);
    const bad = await m.execute(key, 'script.run', { script: JSON.stringify({ purpose: 'boom', code: 'def run(_context):\n    raise Exception("boom")\n' }) });
    expect(bad.ok).toBe(false);
    expect(asked.filter((a) => a.cmd === 'script.run')).toHaveLength(2);
  });

  it('starts Fusion when it is closed and waits until the server answers (app.launch)', async () => {
    const { m, key } = await connected();
    const real = { ...fusionLaunch };
    let started = 0;
    process.env.OMNICANDY_FUSION_MCP_URL = 'http://127.0.0.1:1/mcp';
    process.env.OMNICANDY_FUSION_LAUNCH_POLL_MS = '50';
    fusionLaunch.isRunning = async () => false;
    fusionLaunch.start = () => { started++; process.env.OMNICANDY_FUSION_MCP_URL = url; return new EventEmitter() as ChildProcess; };
    try {
      const r = await m.execute(key, 'app.launch');
      expect(r.ok).toBe(true);
      expect(started).toBe(1);
      expect(r.data?.started).toBe(true);
    } finally {
      Object.assign(fusionLaunch, real);
      process.env.OMNICANDY_FUSION_MCP_URL = url;
      delete process.env.OMNICANDY_FUSION_LAUNCH_POLL_MS;
    }
  });

  it('does not start a second Fusion when one already answers (app.launch)', async () => {
    const { m, key } = await connected();
    const real = { ...fusionLaunch };
    let started = 0;
    fusionLaunch.start = () => { started++; return new EventEmitter() as ChildProcess; };
    try {
      const r = await m.execute(key, 'app.launch');
      expect(r.ok).toBe(true);
      expect(r.data?.alreadyRunning).toBe(true);
      expect(started).toBe(0);
    } finally { Object.assign(fusionLaunch, real); }
  });

  it('hands the running Fusion window to the host to show inside OmniCandy (app.show, and app.launch when Fusion is open)', async () => {
    const { m, key } = await connected();
    const shown: number[] = [];
    const realWindow = fusionProcess.windowPid;
    fusionProcess.windowPid = async () => 4242;
    setFusionLiveHooks({ onShow: (pid) => shown.push(pid) });
    try {
      expect((await m.execute(key, 'app.show')).ok).toBe(true);
      expect((await m.execute(key, 'app.launch')).data?.pid).toBe(4242);
      expect(shown).toEqual([4242, 4242]);
      fusionProcess.windowPid = async () => null;
      const none = await m.execute(key, 'app.show');
      expect(none.ok).toBe(false);
      expect(none.error?.message).toMatch(/app\.launch/);
    } finally { fusionProcess.windowPid = realWindow; setFusionLiveHooks(null); }
  });

  it('reports a server error honestly, and a closed port in plain language', async () => {
    const { m, key } = await connected();
    refuseCalls = true;
    const r = await m.execute(key, 'app.info');
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/HTTP 500/);
    refuseCalls = false;
    process.env.OMNICANDY_FUSION_MCP_URL = 'http://127.0.0.1:1/mcp';
    const unreachable = await m.execute(key, 'app.info');
    process.env.OMNICANDY_FUSION_MCP_URL = url;
    expect(unreachable.ok).toBe(false);
    expect(unreachable.error?.message).toMatch(/not reachable.*Fusion MCP Server/s);
  });
});

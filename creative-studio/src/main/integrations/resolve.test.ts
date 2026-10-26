// Resolve adapter against a FAKE scripting module (a small DaVinciResolveScript.py that mimics the
// documented API and keeps its state in a JSON file). It runs the REAL adapter code and the REAL
// script templates in a real Python process, so it proves the adapter logic, the shared lifecycle
// and the error paths. It does NOT prove behaviour of the real Resolve; that is resolve.live.test.ts.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalAnswer, Permission } from '@shared/integrations';
import { IntegrationManager } from './index';
import type { BridgeOptions } from './adapters/resolveBridge';
import { resolveProcess, setResolveLiveHooks } from './adapters/resolveLive';
import { createResolveFactory, findPythons, RESOLVE_MANIFEST } from './adapters/resolve';

const FAKE_MODULE = `import json, os
_state_file = os.environ['FAKE_RESOLVE_STATE']
def _load():
    return json.load(open(_state_file))
def _save(s):
    json.dump(s, open(_state_file, 'w'))
class _Tl:
    def __init__(self, n): self.n = n
    def GetName(self): return self.n
    def GetTrackCount(self, k): return 1
    def GetStartFrame(self): return 0
    def GetEndFrame(self): return 100
    def Export(self, path, kind, sub=None):
        open(path, 'w').write('<fcpxml version="1.10"/>' if kind == 'fcp' else 'TITLE: fake')
        return True
class _Folder:
    def GetClipList(self): return ['a', 'b']
    def GetSubFolderList(self): return []
class _Pool:
    def GetRootFolder(self): return _Folder()
    def CreateEmptyTimeline(self, n):
        s = _load(); s['projects'][s['current']]['timelines'].append(n); _save(s); return _Tl(n)
class _Proj:
    def __init__(self, n): self.n = n
    def GetName(self): return self.n
    def GetTimelineCount(self): return len(_load()['projects'][self.n]['timelines'])
    def GetTimelineByIndex(self, i): return _Tl(_load()['projects'][self.n]['timelines'][i - 1])
    def GetCurrentTimeline(self):
        t = _load()['projects'][self.n]['timelines']
        return _Tl(t[0]) if t else None
    def GetMediaPool(self): return _Pool()
    def GetSetting(self, k): return {'timelineFrameRate': '24', 'timelineResolutionWidth': '1920', 'timelineResolutionHeight': '1080'}[k]
class _PM:
    def GetCurrentProject(self):
        s = _load(); return _Proj(s['current']) if s['current'] else None
    def GetProjectListInCurrentFolder(self): return list(_load()['projects'].keys())
    def CreateProject(self, n):
        s = _load()
        if n in s['projects']: return None
        s['projects'][n] = {'timelines': []}; s['current'] = n; _save(s); return _Proj(n)
    def SaveProject(self): return True
    def CloseProject(self, p):
        s = _load(); s['current'] = None; _save(s); return True
    def LoadProject(self, n):
        s = _load()
        if n not in s['projects']: return None
        s['current'] = n; _save(s); return _Proj(n)
    def DeleteProject(self, n):
        s = _load(); s['projects'].pop(n, None); _save(s); return True
class _Resolve:
    EXPORT_FCPXML_1_10 = 'fcp'
    EXPORT_EDL = 'edl'
    EXPORT_NONE = 'none'
    def GetProductName(self): return _load().get('product', 'DaVinci Resolve Studio')
    def GetVersionString(self): return '19.0.0.1'
    def GetCurrentPage(self): return 'edit'
    def GetProjectManager(self): return _PM()
def scriptapp(name):
    s = _load()
    if s.get('crash'):
        if s['crash'] == 'once':
            s['crash'] = None
            _save(s)
        os._exit(-1073741819)
    return None if s.get('refuse') else _Resolve()
`;

const find = await findPythons();
const havePython = find.length > 0;

describe.skipIf(!havePython)('DaVinci Resolve adapter (fake scripting module, real Python and adapter)', { timeout: 60_000 }, () => {
  let tmp: string, api: string, state: string, exe: string;
  const asked: Array<{ cmd: string; destructive: boolean }> = [];
  let answer: ApprovalAnswer = 'always';
  let grants: Record<string, Permission[]> = {};
  let running = true;
  const launched: number[] = [];
  const launchStarts = true;
  let pythons: string[] = find;

  const write = async (s: unknown) => fs.writeFile(state, JSON.stringify(s));
  const read = async () => JSON.parse(await fs.readFile(state, 'utf8')) as { current: string | null; projects: Record<string, { timelines: string[] }> };

  async function manager(bridge?: BridgeOptions) {
    const m = new IntegrationManager({
      workDir: async (id) => path.join(tmp, 'work', id),
      permissions: { load: async () => grants, save: async (g) => { grants = g; } },
      approve: async (r) => { asked.push({ cmd: r.command.id, destructive: r.destructive }); return answer; },
      discovery: { env: { ProgramFiles: 'C:\\x' }, exists: async (p) => p.toLowerCase() === exe.toLowerCase(), listDir: async () => [], run: async () => '' },
      userPaths: async () => [exe],
    });
    m.register(createResolveFactory({ apiDir: api, libPath: path.join(path.dirname(exe), 'fusionscript.dll'), pythons: async () => pythons, isRunning: async () => running, launch: () => { launched.push(1); if (launchStarts) running = true; }, bridge: bridge ?? { tokenPath: path.join(tmp, 'no-token') } }), { builtin: true });
    const scan = await m.scan();
    return { m, key: scan.apps[0]!.key, scan };
  }

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-resolve-'));
    api = path.join(tmp, 'api');
    await fs.mkdir(path.join(api, 'Modules'), { recursive: true });
    await fs.writeFile(path.join(api, 'Modules', 'DaVinciResolveScript.py'), FAKE_MODULE);
    exe = path.join(tmp, 'DaVinci Resolve', 'Resolve.exe');
    await fs.mkdir(path.dirname(exe), { recursive: true });
    await fs.writeFile(exe, 'x');
    await fs.writeFile(path.join(path.dirname(exe), 'fusionscript.dll'), 'x');
    state = path.join(tmp, 'state.json');
    process.env.FAKE_RESOLVE_STATE = state;
  });
  afterAll(async () => { delete process.env.FAKE_RESOLVE_STATE; await fs.rm(tmp, { recursive: true, force: true }); });

  it('registers through the same manifest validation as every adapter and is not Blender-specific', () => {
    expect(RESOLVE_MANIFEST.id).toBe('davinci.resolve');
    expect(RESOLVE_MANIFEST.methods[0]).toBe('scripting');
    // Only app.launch may start the program, and only with the person's approval; every other command needs it already running.
    expect(RESOLVE_MANIFEST.commands.filter((c) => c.permissions.includes('launch')).map((c) => c.id)).toEqual(['app.launch']);
  });

  it('is detected with the same scan, and reports "not running" instead of failing generically', async () => {
    await write({ current: 'Tomas Film', projects: { 'Tomas Film': { timelines: ['Main'] } } });
    running = false;
    const { m, key, scan } = await manager();
    expect(scan.apps[0]).toMatchObject({ adapterId: 'davinci.resolve', status: 'available' });
    await expect(m.connect(key)).rejects.toThrow(/not running/i);
    const [info] = await m.list();
    expect(info!.status).toBe('not-running');
    const r = await m.execute(key, 'app.info');
    expect(r.error?.kind).toBe('not-connected');
    running = true;
  });

  it('reports scripting unavailable when Resolve refuses the connection (Free edition or preference off)', async () => {
    await write({ current: null, projects: {}, refuse: true });
    const { m, key } = await manager();
    await expect(m.connect(key)).rejects.toThrow(/not reachable by scripting/i);
    expect((await m.list())[0]!.status).toBe('api-unavailable');
    expect((await m.list())[0]!.commands.length).toBeGreaterThan(0);
  });

  it('app.launch starts Resolve only when it is closed, asks first, and never opens a project', async () => {
    await write({ current: null, projects: {} });
    running = false; launched.length = 0; grants = {}; asked.length = 0;
    const { m, key } = await manager();
    const r = await m.execute(key, 'app.launch');
    expect(r.error).toBeUndefined();
    expect(r.data).toMatchObject({ started: true });
    expect(launched).toHaveLength(1);
    expect(asked.some((a) => a.cmd === 'app.launch')).toBe(true);
    const again = await m.execute(key, 'app.launch');
    expect(again.data).toMatchObject({ started: false });
    expect(launched).toHaveLength(1);
    running = true;
  });

  it('docks the running Resolve into OmniCandy after app.launch and on app.show, and says so when it cannot', async () => {
    await write({ current: null, projects: {} });
    const docked: number[] = [];
    const realPid = resolveProcess.windowPid;
    resolveProcess.windowPid = async () => (running ? 4242 : null);
    try {
      const { m, key } = await manager();
      running = true;
      // No host hooks (not Windows / no window): a clear 'unsupported', never a silent success.
      setResolveLiveHooks(null);
      expect((await m.execute(key, 'app.show')).error?.kind).toBe('unsupported');
      setResolveLiveHooks({ onShow: (pid) => { docked.push(pid); } });
      const shown = await m.execute(key, 'app.show');
      expect(shown.error).toBeUndefined();
      expect(docked).toEqual([4242]);
      // Already running: app.launch starts nothing but still docks it.
      launched.length = 0;
      const again = await m.execute(key, 'app.launch');
      expect(again.data).toMatchObject({ started: false, shown: true });
      expect(launched).toHaveLength(0);
      expect(docked).toEqual([4242, 4242]);
      // Closed: nothing to show.
      running = false;
      expect((await m.execute(key, 'app.show')).error?.kind).toBe('app-error');
    } finally { resolveProcess.windowPid = realPid; setResolveLiveHooks(null); running = true; }
  });

  it('Free edition: still writes an EDL and an SRT while scripting is refused, and checks the clips', async () => {
    await write({ current: null, projects: {}, refuse: true });
    const { m, key } = await manager();
    const edl = await m.execute(key, 'timeline.write_edl', { clips: JSON.stringify([{ file: 'a.mp4', duration_seconds: 2 }, { file: 'b.mp4', in_seconds: 1, duration_seconds: 1.4 }]), fps: 25 });
    expect(edl.error).toBeUndefined();
    const text = await fs.readFile(edl.outputs[0]!.path, 'utf8');
    expect(text).toContain('00:00:00:00 00:00:02:00 01:00:00:00 01:00:02:00');
    expect(text).toContain('00:00:01:00 00:00:02:10 01:00:02:00 01:00:03:10');
    expect(text).toContain('* FROM CLIP NAME: b.mp4');
    const srt = await m.execute(key, 'subtitles.write_srt', { cues: JSON.stringify([{ start: 0, end: 1.5, text: 'Hi' }, { start: 2, end: 3.25, text: 'There' }]) });
    expect(srt.error).toBeUndefined();
    expect(await fs.readFile(srt.outputs[0]!.path, 'utf8')).toContain('00:00:02,000 --> 00:00:03,250');
    const bad = await m.execute(key, 'subtitles.write_srt', { cues: JSON.stringify([{ start: 2, end: 1, text: 'x' }]) });
    expect(bad.error?.kind).toBe('invalid-params');
    const bad2 = await m.execute(key, 'timeline.write_edl', { clips: JSON.stringify([]) });
    expect(bad2.error?.kind).toBe('invalid-params');
  });

  it('Free edition: scripting refused, so it connects through the in-Resolve bridge (token required) and runs live commands', async () => {
    await write({ current: null, projects: {}, refuse: true });
    const token = 'a'.repeat(64);
    const seen: Array<{ method: string; url: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const send = (code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (req.headers['x-omnicandy-token'] !== token) return send(403, { error: 'Forbidden' });
        seen.push({ method: req.method!, url: req.url!, body });
        const route = req.url!;
        if (route === '/status') return send(200, { connected: true, product: 'DaVinci Resolve', version: '21.0.4.5' });
        if (route === '/project') return send(200, { name: 'Free Film', timelineCount: 2, settings: { timelineFrameRate: '24', timelineResolutionWidth: '1920', timelineResolutionHeight: '1080' } });
        if (route === '/mediapool') return send(200, { clips: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
        if (route === '/projects') return send(200, { projects: ['Free Film', 'Other'] });
        if (route === '/timeline') return send(200, { name: 'Main' });
        if (route === '/timeline/export') {
          const b = JSON.parse(body) as { fileName: string; exportType: string };
          if (b.exportType === 'FCPXML_1_10') return send(200, { error: "Resolve does not support export constant 'EXPORT_FCPXML_1_10'" });
          return fs.writeFile(b.fileName, '<fcpxml/>').then(() => send(200, { success: true }));
        }
        if (route === '/media/import') return send(200, { success: true, imported: ['clip.mp4'] });
        if (route === '/timeline/create') return send(200, { success: true, timeline: 'New' });
        return send(404, { error: 'Unknown' });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const good = path.join(tmp, 'good.token'), bad = path.join(tmp, 'bad.token');
    await fs.writeFile(good, token); await fs.writeFile(bad, 'b'.repeat(64));
    try {
      // Wrong token: stays blocked, with the scripting reason.
      const wrong = await manager({ url, tokenPath: bad });
      await expect(wrong.m.connect(wrong.key)).rejects.toThrow(/not reachable by scripting/i);

      const { m, key } = await manager({ url, tokenPath: good });
      await m.connect(key);
      expect((await m.list())[0]!.status).not.toBe('api-unavailable');
      const info = await m.execute(key, 'app.info');
      expect(info).toMatchObject({ ok: true, verified: true });
      expect(info.data).toMatchObject({ project: 'Free Film', via: 'bridge' });
      expect((await m.execute(key, 'project.list')).data).toMatchObject({ count: 2 });
      expect((await m.execute(key, 'project.inspect')).data).toMatchObject({ name: 'Free Film', clipCount: 3, width: '1920' });
      const exp = await m.execute(key, 'timeline.export', { format: 'fcpxml' });
      expect(exp.error).toBeUndefined();
      expect(exp.outputs[0]!.path).toMatch(/\.fcpxml$/);
      const tl = await m.execute(key, 'timeline.create', { name: 'New' });
      expect(tl.error).toBeUndefined();
      const media = path.join(tmp, 'clip.mp4'); await fs.writeFile(media, 'x');
      expect((await m.execute(key, 'media.import', { paths: JSON.stringify([media]) })).error).toBeUndefined();
      expect((await m.execute(key, 'media.import', { paths: JSON.stringify([path.join(tmp, 'missing.mp4')]) })).error?.kind).toBe('invalid-params');
      expect((await m.execute(key, 'media.import', { paths: JSON.stringify(['relative.mp4']) })).error?.kind).toBe('invalid-params');
      // Creating/deleting projects is scripting-only and says so; the file commands still work in bridge mode.
      expect((await m.execute(key, 'project.create_scratch', { name: 'X' })).error?.kind).toBe('unsupported');
      expect((await m.execute(key, 'subtitles.write_srt', { cues: JSON.stringify([{ start: 0, end: 1, text: 'Hi' }]) })).error).toBeUndefined();
      expect(seen.every((s) => s.url !== '/projects/create' && s.url !== '/projects/delete')).toBe(true);
    } finally { await new Promise((r) => server.close(r)); }
  });

  it('connects, reads info and inspects the open project without changing it', async () => {
    await write({ current: 'Tomas Film', projects: { 'Tomas Film': { timelines: ['Main', 'Alt'] } } });
    const before = await read();
    const { m, key } = await manager();
    // Experimental maturity: connected but reported as limited, honestly.
    expect((await m.connect(key)).status).toBe('limited');
    const info = await m.execute(key, 'app.info');
    expect(info).toMatchObject({ ok: true, verified: true });
    expect(info.data).toMatchObject({ studio: true, project: 'Tomas Film', page: 'edit' });
    const list = await m.execute(key, 'project.list');
    expect((list.data as { projects: string[] }).projects).toEqual(['Tomas Film']);
    const ins = await m.execute(key, 'project.inspect');
    expect(ins.data).toMatchObject({ open: true, name: 'Tomas Film', timelineCount: 2, clipCount: 2, width: '1920' });
    expect(await read()).toEqual(before);
  });

  it('creates a scratch project, restores the previous one, and refuses to switch away without permission', async () => {
    await write({ current: 'Tomas Film', projects: { 'Tomas Film': { timelines: ['Main'] } } });
    const { m, key } = await manager();
    const blocked = await m.execute(key, 'project.create_scratch', { name: 'Smoke' });
    expect(blocked.error?.kind).toBe('app-error');
    expect(blocked.error?.message).toMatch(/Tomas Film.*open/);
    expect(Object.keys((await read()).projects)).toEqual(['Tomas Film']);

    const ok = await m.execute(key, 'project.create_scratch', { name: 'Smoke', allow_switch: true });
    expect(ok.error).toBeUndefined();
    expect(ok.verified).toBe(true);
    expect(ok.data).toMatchObject({ name: 'CreateCraft Smoke', listed: true, previous: 'Tomas Film', restored: 'Tomas Film' });
    const st = await read();
    expect(st.current).toBe('Tomas Film');
    expect(Object.keys(st.projects)).toContain('CreateCraft Smoke');
    expect(st.projects['Tomas Film']!.timelines).toEqual(['Main']);
  });

  it('only deletes CreateCraft scratch projects and always asks first', async () => {
    await write({ current: null, projects: { 'Tomas Film': { timelines: [] }, 'CreateCraft Smoke': { timelines: [] } } });
    const { m, key } = await manager();
    asked.length = 0;
    const refused = await m.execute(key, 'project.delete_scratch', { name: 'Tomas Film' });
    expect(refused.error?.kind).toBe('invalid-params');
    expect(Object.keys((await read()).projects)).toContain('Tomas Film');
    answer = 'deny';
    expect((await m.execute(key, 'project.delete_scratch', { name: 'CreateCraft Smoke' })).error?.kind).toBe('permission-denied');
    answer = 'always';
    const del = await m.execute(key, 'project.delete_scratch', { name: 'CreateCraft Smoke' });
    expect(del).toMatchObject({ ok: true, verified: true });
    expect(Object.keys((await read()).projects)).toEqual(['Tomas Film']);
    expect(asked.filter((a) => a.cmd === 'project.delete_scratch').every((a) => a.destructive)).toBe(true);
  });

  it('exports the current timeline to a verified file', async () => {
    await write({ current: 'Tomas Film', projects: { 'Tomas Film': { timelines: ['Main'] } } });
    const { m, key } = await manager();
    const r = await m.execute(key, 'timeline.export', { file_name: 'cut one', format: 'fcpxml' });
    expect(r.error).toBeUndefined();
    expect(r.outputs[0]!.path.endsWith('cut one.fcpxml')).toBe(true);
    expect(await fs.readFile(r.outputs[0]!.path, 'utf8')).toContain('fcpxml');
    expect((await m.execute(key, 'timeline.export', { format: 'aaf' })).error?.kind).toBe('invalid-params');
  });

  it('skips an interpreter that crashes on import and uses the next one', async () => {
    await write({ current: 'Tomas Film', projects: { 'Tomas Film': { timelines: [] } } });
    // The fake library kills the process once (as fusionscript.dll does under some Python versions).
    await write({ current: 'Tomas Film', projects: { 'Tomas Film': { timelines: [] } }, crash: 'once' });
    pythons = [find[0]!, find[0]!];
    const { m, key } = await manager();
    expect((await m.connect(key)).status).toBe('limited');
    await write({ current: null, projects: {}, crash: 'always' });
    pythons = [find[0]!];
    const m2 = await manager();
    await expect(m2.m.connect(m2.key)).rejects.toThrow(/crashed every Python/);
    expect((await m2.m.list())[0]!.status).toBe('needs-repair');
    pythons = find;
  });

  it('shares the manager error paths: unknown command, unknown parameter, missing program', async () => {
    const { m, key } = await manager();
    expect((await m.execute(key, 'render.start')).error?.kind).toBe('unsupported');
    expect((await m.execute(key, 'project.list', { x: 1 })).error?.kind).toBe('invalid-params');
    await fs.rm(exe);
    expect((await m.execute(key, 'app.info')).error?.kind).toBe('missing-app');
    await fs.writeFile(exe, 'x');
  });
});

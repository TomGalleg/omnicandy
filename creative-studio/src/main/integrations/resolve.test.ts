// Resolve adapter against a FAKE scripting module (a small DaVinciResolveScript.py that mimics the
// documented API and keeps its state in a JSON file). It runs the REAL adapter code and the REAL
// script templates in a real Python process, so it proves the adapter logic, the shared lifecycle
// and the error paths. It does NOT prove behaviour of the real Resolve; that is resolve.live.test.ts.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalAnswer, Permission } from '@shared/integrations';
import { IntegrationManager } from './index';
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
  let pythons: string[] = find;

  const write = async (s: unknown) => fs.writeFile(state, JSON.stringify(s));
  const read = async () => JSON.parse(await fs.readFile(state, 'utf8')) as { current: string | null; projects: Record<string, { timelines: string[] }> };

  async function manager() {
    const m = new IntegrationManager({
      workDir: async (id) => path.join(tmp, 'work', id),
      permissions: { load: async () => grants, save: async (g) => { grants = g; } },
      approve: async (r) => { asked.push({ cmd: r.command.id, destructive: r.destructive }); return answer; },
      discovery: { env: { ProgramFiles: 'C:\\x' }, exists: async (p) => p.toLowerCase() === exe.toLowerCase(), listDir: async () => [], run: async () => '' },
      userPaths: async () => [exe],
    });
    m.register(createResolveFactory({ apiDir: api, libPath: path.join(path.dirname(exe), 'fusionscript.dll'), pythons: async () => pythons, isRunning: async () => running }));
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
    // No Resolve command asks to launch the program: it must already be running.
    expect(RESOLVE_MANIFEST.commands.flatMap((c) => c.permissions)).not.toContain('launch');
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

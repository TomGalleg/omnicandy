// project.create / project.list / editor.launch: OmniCandy making an Unreal project from nothing and starting it. A FAKE engine folder with a tiny
// template stands in for the real one (the real template is exercised by unrealProject.live.test.ts), and a fake launcher stands in for the
// editor, so nothing is started. Everything the real commands claim is checked on disk.
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult, ExternalAppInfo } from '@shared/integrations';
import { IntegrationManager } from './index';
import { UNREAL_MANIFEST, unrealFactory } from './adapters/unreal';
import { pickEditor, processHooks, setUnrealLiveHooks } from './adapters/unrealLive';
import { createProject, engineRootOf, launchHooks, parseTemplateDefs, renameInText, validateProjectName } from './adapters/unrealProject';
import { externalTools } from '../agentHarness/externalTools';

const DEFS = `[/Script/GameProjectGeneration.TemplateProjectDefs]
Categories=Games
FoldersToIgnore=Binaries
FoldersToIgnore=Build
FoldersToIgnore=Intermediate
FoldersToIgnore=Saved
FoldersToIgnore=Media
FilesToIgnore="%TEMPLATENAME%.uproject"
FilesToIgnore="%TEMPLATENAME%.png"
FilesToIgnore="Config/TemplateDefs.ini"
FilesToIgnore="Config/config.ini"
SharedContentPacks=(MountName="Characters",DetailLevels=("High"))
SharedContentPacks=(MountName="Input",DetailLevels=("High"))
;SharedContentPacks=(MountName="Variant_Combat",DetailLevels=("Standard"))
`;
const ENGINE_INI = `[/Script/EngineSettings.GeneralProjectSettings]\nProjectID=ABC\n[/Script/Engine.Engine]\nGameName=TP_ThirdPersonBP\n[/Script/EngineSettings.GameMapsSettings]\nEditorStartupMap=/Game/ThirdPerson/Lvl_ThirdPerson.Lvl_ThirdPerson\n`;

let tmp: string, engine: string, exe: string;
const put = async (rel: string, data: string | Buffer, base = engine) => { const f = path.join(base, ...rel.split('/')); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, data); };

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-uproj-'));
  engine = path.join(tmp, 'UE_5.8');
  exe = path.join(engine, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');
  await put('Engine/Binaries/Win64/UnrealEditor.exe', 'x');
  await put('Engine/Build/Build.version', JSON.stringify({ MajorVersion: 5, MinorVersion: 8, PatchVersion: 4 }));
  const t = 'Templates/TP_ThirdPersonBP';
  await put(`${t}/TP_ThirdPersonBP.uproject`, JSON.stringify({ FileVersion: 3, EngineAssociation: '', Plugins: [{ Name: 'GameplayStateTree', Enabled: true }, { Name: 'ModelContextProtocol', Enabled: false }] }));
  await put(`${t}/Config/TemplateDefs.ini`, DEFS);
  await put(`${t}/Config/config.ini`, 'x');
  await put(`${t}/Config/DefaultEngine.ini`, ENGINE_INI);
  await put(`${t}/Config/DefaultEditorPerProjectUserSettings.ini`, '[ContentBrowser]\nContentBrowserTab1.SelectedPaths=/Game/ThirdPersonBP');
  await put(`${t}/Content/ThirdPerson/Lvl_ThirdPerson.umap`, 'level');
  await put(`${t}/Content/ThirdPerson/Blueprints/BP_Game.uasset`, Buffer.from([0, 1, 2, 3, 255, 254]));
  await put(`${t}/Media/readme.mp4`, 'ignored');
  await put(`${t}/Saved/junk.log`, 'ignored');
  await put('Templates/TemplateResources/High/Characters/Mannequin.uasset', 'mannequin');
  await put('Templates/TemplateResources/High/Input/IA_Move.uasset', 'move');
  await put('Templates/TemplateResources/High/Variant_Combat/Combat.uasset', 'not requested');
});
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('template rules and names', () => {
  it('reads the template\'s own rules and skips commented-out content packs', () => {
    const r = parseTemplateDefs(DEFS, 'TP_ThirdPersonBP');
    expect(r.foldersToIgnore).toEqual(['Binaries', 'Build', 'Intermediate', 'Saved', 'Media']);
    expect(r.filesToIgnore).toEqual(['TP_ThirdPersonBP.uproject', 'TP_ThirdPersonBP.png', 'Config/TemplateDefs.ini', 'Config/config.ini']);
    expect(r.packs).toEqual(['Characters', 'Input']);
  });
  it('renames the template in all three spellings, and only the template', () => {
    expect(renameInText('GameName=TP_ThirdPersonBP /Script/TP_THIRDPERSONBP tp_thirdpersonbp /Game/ThirdPerson/X', 'TP_ThirdPersonBP', 'Plaza')).toBe('GameName=Plaza /Script/PLAZA plaza /Game/ThirdPerson/X');
  });
  it('accepts normal project names and refuses ones Unreal cannot use', () => {
    for (const n of ['Plaza', 'My_Game2', 'a']) expect(validateProjectName(n), n).toBeUndefined();
    for (const n of ['', '2fast', 'has space', 'a-b', 'a.b', 'x'.repeat(41), 'Engine', 'content', 'TP_Custom', 'ünï']) expect(validateProjectName(n), n).toBeDefined();
    expect(engineRootOf(exe)).toBe(engine);
  });
});

describe('createProject (fake engine, real files)', () => {
  const make = (name: string, extra: Partial<Parameters<typeof createProject>[0]> = {}) => createProject({ engineRoot: engine, engineVersion: '5.8.4', template: 'third_person', name, location: path.join(tmp, 'projects'), progress: () => undefined, ...extra });
  it('copies by the template\'s rules, renames, adds the shared content, enables the MCP plugins and Auto Start, and proves it', async () => {
    const r = await make('Plaza');
    const dir = r.projectDir;
    const has = (rel: string) => fsSync.existsSync(path.join(dir, ...rel.split('/')));
    // kept
    for (const rel of ['Plaza.uproject', 'Content/ThirdPerson/Lvl_ThirdPerson.umap', 'Content/ThirdPerson/Blueprints/BP_Game.uasset', 'Config/DefaultEngine.ini', 'Content/Characters/Mannequin.uasset', 'Content/Input/IA_Move.uasset']) expect(has(rel), rel).toBe(true);
    // skipped by the template's rules, or not asked for
    for (const rel of ['TP_ThirdPersonBP.uproject', 'Config/TemplateDefs.ini', 'Config/config.ini', 'Media/readme.mp4', 'Saved/junk.log', 'Content/Variant_Combat/Combat.uasset']) expect(has(rel), rel).toBe(false);
    // binary content is byte-identical
    expect((await fs.readFile(path.join(dir, 'Content/ThirdPerson/Blueprints/BP_Game.uasset'))).equals(Buffer.from([0, 1, 2, 3, 255, 254]))).toBe(true);
    // renamed in config text, but the content paths stay
    const ini = await fs.readFile(path.join(dir, 'Config/DefaultEngine.ini'), 'utf8');
    expect(ini).toContain('GameName=Plaza');
    expect(ini).not.toMatch(/TP_ThirdPersonBP/i);
    expect(ini).toContain('EditorStartupMap=/Game/ThirdPerson/Lvl_ThirdPerson');
    // project file: this engine, template's own plugin kept, both MCP plugins on (one that was off is now on, once)
    const up = JSON.parse(await fs.readFile(path.join(dir, 'Plaza.uproject'), 'utf8')) as { EngineAssociation: string; Plugins: Array<{ Name: string; Enabled: boolean }> };
    expect(up.EngineAssociation).toBe('5.8');
    expect(up.Plugins.filter((p) => p.Name === 'ModelContextProtocol')).toEqual([{ Name: 'ModelContextProtocol', Enabled: true }]);
    expect(up.Plugins).toEqual(expect.arrayContaining([{ Name: 'AllToolsets', Enabled: true }, { Name: 'GameplayStateTree', Enabled: true }]));
    // Auto Start added after what the template already had
    const user = await fs.readFile(path.join(dir, 'Config/DefaultEditorPerProjectUserSettings.ini'), 'utf8');
    expect(user).toContain('[ContentBrowser]');
    expect(user).toMatch(/\[\/Script\/ModelContextProtocolEngine\.ModelContextProtocolSettings\]\s+bAutoStartServer=True/);
    expect(r).toMatchObject({ plugins: ['ModelContextProtocol', 'AllToolsets'], startupMap: '/Game/ThirdPerson/Lvl_ThirdPerson', packs: ['Characters', 'Input'] });
  });
  it('refuses, without leaving anything behind, an existing folder, a bad name, bad places and unknown templates', async () => {
    await make('Taken');
    await expect(make('Taken')).rejects.toThrow(/already exists/);
    await expect(make('2bad')).rejects.toThrow(/must start with a letter/);
    await expect(make('Fine', { location: 'relative/folder' })).rejects.toThrow(/full folder path/);
    await expect(make('Fine', { location: path.join(engine, 'Engine', 'Mine') })).rejects.toThrow(/inside the Unreal Engine installation/);
    await expect(make('Fine', { template: 'racing' })).rejects.toThrow(/template must be one of/);
    expect(fsSync.existsSync(path.join(tmp, 'projects', 'Fine'))).toBe(false);
  });
  it('removes a half-made project when something is wrong with the engine\'s content', async () => {
    await fs.rename(path.join(engine, 'Templates/TemplateResources/High/Input'), path.join(engine, 'Templates/TemplateResources/High/Input_away'));
    try {
      await expect(make('Broken')).rejects.toThrow(/shared content "Input" is missing/);
      expect(fsSync.existsSync(path.join(tmp, 'projects', 'Broken'))).toBe(false);
    } finally { await fs.rename(path.join(engine, 'Templates/TemplateResources/High/Input_away'), path.join(engine, 'Templates/TemplateResources/High/Input')); }
  });
});

// ---- through the manager, with the editor CLOSED ----
let server: http.Server | null = null;
const startServer = (port: number, level = '/Game/ThirdPerson/Lvl_ThirdPerson') => new Promise<http.Server>((resolve) => {
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const m = b ? JSON.parse(b) : {};
      const ok = (result: unknown, sid?: string) => { res.writeHead(200, { 'Content-Type': 'application/json', ...(sid ? { 'Mcp-Session-Id': sid } : {}) }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); };
      if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
      if (m.method === 'initialize') return ok({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} }, 's1');
      if (m.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      if (m.params?.name === 'list_toolsets') return ok({ content: [{ type: 'text', text: '- A.One: first' }] });
      if (m.params?.name === 'call_tool') return ok({ content: [{ type: 'text', text: JSON.stringify({ returnValue: level }) }] });
      res.writeHead(404); res.end();
    });
  });
  s.listen(port, '127.0.0.1', () => resolve(s));
});
const freePort = () => new Promise<number>((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); }); });
const fakeChild = (opts: { exitCode?: number } = {}) => { const c = new EventEmitter() as ChildProcess; Object.assign(c, { pid: 4242, unref: () => undefined }); if (opts.exitCode !== undefined) setTimeout(() => c.emit('exit', opts.exitCode), 50); return c; };

describe('project.create / editor.launch through the manager while the editor is closed', { timeout: 60_000 }, () => {
  const asked: Array<{ cmd: string; needed: string[] }> = [];
  let answer: 'always' | 'deny' = 'always';
  let key = '', port = 0;
  async function manager() {
    const m = new IntegrationManager({
      workDir: async (id) => { const d = path.join(tmp, 'omni', 'work', 'external', id); await fs.mkdir(d, { recursive: true }); return d; },
      permissions: { load: async () => ({}), save: async () => undefined },
      approve: async (r) => { asked.push({ cmd: r.command.id, needed: r.needed }); return answer; },
      discovery: { env: { ProgramFiles: 'C:\\x' }, exists: async (p) => p.toLowerCase() === exe.toLowerCase(), listDir: async () => [], run: async () => '' },
      userPaths: async () => [exe],
    });
    m.register(unrealFactory, { builtin: true });
    const scan = await m.scan();
    key = scan.apps[0]!.key;
    return m;
  }
  beforeAll(async () => { port = await freePort(); process.env.OMNICANDY_UNREAL_MCP_URL = `http://127.0.0.1:${port}/mcp`; });
  beforeEach(() => { asked.length = 0; answer = 'always'; });
  afterAll(async () => { delete process.env.OMNICANDY_UNREAL_MCP_URL; server?.close(); });

  it('creates and lists a project with no editor running, asking only for permission to write files', async () => {
    const m = await manager();
    const loc = path.join(tmp, 'made');
    const r = await m.execute(key, 'project.create', { name: 'Plaza_Test', template: 'third_person', location: loc });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.verified).toBe(true);
    expect(asked).toEqual([{ cmd: 'project.create', needed: ['write-files'] }]);
    expect(fsSync.existsSync(path.join(loc, 'Plaza_Test', 'Plaza_Test.uproject'))).toBe(true);
    // the same app cannot run commands that need the editor...
    const down = await m.execute(key, 'app.info');
    expect(down.ok).toBe(false);
    expect(down.error?.kind).toBe('not-connected');
    // ...but it can list what was made
    const list = await m.execute(key, 'project.list');
    expect(list.data).toMatchObject({ count: 1, projects: [{ name: 'Plaza_Test', template: 'third_person', exists: true }] });
    // a second create of the same place is refused
    expect((await m.execute(key, 'project.create', { name: 'Plaza_Test', location: loc })).error?.message).toMatch(/already exists/);
    // declined permission writes nothing (a fresh manager has no earlier grant)
    answer = 'deny';
    const denied = await (await manager()).execute(key, 'project.create', { name: 'Never', location: loc });
    expect(denied.error?.kind).toBe('permission-denied');
    expect(fsSync.existsSync(path.join(loc, 'Never'))).toBe(false);
  });

  it('starts the editor on a project, waits until its server answers and a level is open, and never claims readiness early', async () => {
    const m = await manager();
    const loc = path.join(tmp, 'launch');
    expect((await m.execute(key, 'project.create', { name: 'Launched', location: loc })).ok).toBe(true);
    const started: string[][] = [];
    const orig = launchHooks.start;
    launchHooks.start = (e, args) => { started.push([e, ...args]); setTimeout(() => { void startServer(port).then((s) => { server = s; }); }, 1500); return fakeChild(); };
    process.env.OMNICANDY_UNREAL_LAUNCH_POLL_MS = '300';
    try {
      const t0 = Date.now();
      const r = await m.execute(key, 'editor.launch', { project: 'Launched' });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      expect(Date.now() - t0).toBeGreaterThan(1200); // it waited for the server
      expect(started).toEqual([[exe, path.join(loc, 'Launched', 'Launched.uproject'), '-ModelContextProtocolStartServer']]);
      expect(r.data).toMatchObject({ level: '/Game/ThirdPerson/Lvl_ThirdPerson', pid: 4242 });
      expect(asked.at(-1)).toMatchObject({ cmd: 'editor.launch' });
      // once the server is up, a second launch is refused and starts nothing
      started.length = 0;
      const again = await m.execute(key, 'editor.launch', { project: 'Launched' });
      expect(again.error?.message).toMatch(/already serving OmniCandy/);
      expect(started).toEqual([]);
      // and the normal commands now work with a real connection
      expect((await m.execute(key, 'app.info')).ok).toBe(true);
    } finally { launchHooks.start = orig; delete process.env.OMNICANDY_UNREAL_LAUNCH_POLL_MS; await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = null; }
  });

  it('reports an editor that closes early, an unknown project, a missing file and a start that fails', async () => {
    const m = await manager();
    const orig = launchHooks.start;
    process.env.OMNICANDY_UNREAL_LAUNCH_POLL_MS = '200';
    try {
      expect((await m.execute(key, 'editor.launch', { project: 'NoSuchProject' })).error?.message).toMatch(/No project named "NoSuchProject"/);
      expect((await m.execute(key, 'editor.launch', { project: path.join(tmp, 'nope', 'X.uproject') })).error?.message).toMatch(/no project file/);
      expect((await m.execute(key, 'editor.launch', { project: path.join(tmp, 'notes.txt').replace(/\\/g, '/') })).error).toBeDefined();
      launchHooks.start = () => fakeChild({ exitCode: 3 });
      expect((await m.execute(key, 'editor.launch', { project: 'Launched' })).error?.message).toMatch(/closed with code 3 before it was ready/);
      launchHooks.start = () => { const c = fakeChild(); setTimeout(() => c.emit('error', new Error('spawn ENOENT')), 50); return c; };
      expect((await m.execute(key, 'editor.launch', { project: 'Launched' })).error?.message).toMatch(/could not be started: spawn ENOENT/);
      // never ready: the wait ends with an honest message and the editor is left alone
      launchHooks.start = () => fakeChild();
      process.env.OMNICANDY_UNREAL_LAUNCH_WAIT_MS = '700';
      expect((await m.execute(key, 'editor.launch', { project: 'Launched' })).error?.message).toMatch(/did not become ready within 1 s/);
    } finally { launchHooks.start = orig; delete process.env.OMNICANDY_UNREAL_LAUNCH_POLL_MS; delete process.env.OMNICANDY_UNREAL_LAUNCH_WAIT_MS; }
  });

  it('docks the editor into OmniCandy: launch hands over the new process, and its exit is reported', async () => {
    const m = await manager();
    const loc = path.join(tmp, 'dock');
    expect((await m.execute(key, 'project.create', { name: 'Docked', location: loc })).ok).toBe(true);
    const events: string[] = [];
    setUnrealLiveHooks({ onSpawn: (pid) => events.push(`spawn ${pid}`), onShow: (pid) => events.push(`show ${pid}`), onExit: (pid) => events.push(`exit ${pid}`) });
    const orig = launchHooks.start;
    let child: ChildProcess | null = null;
    launchHooks.start = () => { child = fakeChild(); setTimeout(() => { void startServer(port).then((s) => { server = s; }); }, 300); return child; };
    process.env.OMNICANDY_UNREAL_LAUNCH_POLL_MS = '200';
    try {
      expect((await m.execute(key, 'editor.launch', { project: 'Docked' })).ok).toBe(true);
      expect(events).toEqual(['spawn 4242']); // handed over as soon as it was started, before it was ready
      child!.emit('exit', 0);
      expect(events).toEqual(['spawn 4242', 'exit 4242']);
    } finally { setUnrealLiveHooks(null); launchHooks.start = orig; delete process.env.OMNICANDY_UNREAL_LAUNCH_POLL_MS; await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = null; }
  });

  it('shows an editor that is already open: by project, else the newest with a project, and says so when there is none', async () => {
    const m = await manager();
    const loc = path.join(tmp, 'show');
    expect((await m.execute(key, 'project.create', { name: 'ShowMe', location: loc })).ok).toBe(true);
    const up = path.join(loc, 'ShowMe', 'ShowMe.uproject');
    const origList = processHooks.list;
    const shown: number[] = [];
    try {
      processHooks.list = async () => [
        { pid: 11, startedAt: 100, commandLine: '"E:\\UE\\UnrealEditor.exe"' },                 // project browser, no project
        { pid: 22, startedAt: 200, commandLine: `"E:\\UE\\UnrealEditor.exe" "${up}" -x` },
        { pid: 33, startedAt: 300, commandLine: '"E:\\UE\\UnrealEditor.exe" "C:\\other\\Other.uproject"' },
      ];
      // with no hooks (not Windows / no host) the command says so and does nothing
      setUnrealLiveHooks(null);
      expect((await m.execute(key, 'editor.show', {})).error?.kind).toBe('unsupported');
      setUnrealLiveHooks({ onShow: (pid) => shown.push(pid) });
      expect((await m.execute(key, 'editor.show', { project: 'ShowMe' })).data).toMatchObject({ pid: 22 });
      expect((await m.execute(key, 'editor.show', {})).data).toMatchObject({ pid: 33 }); // newest with a project
      expect(shown).toEqual([22, 33]);
      processHooks.list = async () => [{ pid: 11, startedAt: 100, commandLine: '"E:\\UE\\UnrealEditor.exe"' }];
      expect((await m.execute(key, 'editor.show', {})).error?.message).toMatch(/No Unreal Editor with a project open is running/);
      processHooks.list = async () => [];
      expect((await m.execute(key, 'editor.show', { project: 'ShowMe' })).error?.message).toMatch(/No running Unreal Editor has ShowMe\.uproject open/);
    } finally { processHooks.list = origList; setUnrealLiveHooks(null); }
    // the same choice, as a plain function
    expect(pickEditor([{ pid: 1, startedAt: 5, commandLine: 'a.uproject' }, { pid: 2, startedAt: 9, commandLine: 'B.UPROJECT' }], null)?.pid).toBe(2);
    expect(pickEditor([{ pid: 1, startedAt: 5, commandLine: 'C:\\p\\a.uproject' }], 'c:/p/A.uproject')?.pid).toBe(1);
  });

  it('is only allowed for built-in adapters: the flag does nothing on a command in an installed package', () => {
    // the manager checks this.builtin before using a transient session; the manifest of every OTHER adapter has no offline command
    expect(UNREAL_MANIFEST.commands.filter((c) => c.offline).map((c) => c.id).sort()).toEqual(['editor.launch', 'editor.show', 'project.create', 'project.list']);
  });
});

describe('the AI harness still offers a closed Unreal that can make and start a project', () => {
  const closed = (status: string, offline: boolean) => ({ key: 'k', name: 'Unreal Engine', status, adapterId: 'unreal', adapterName: 'Unreal Engine', commands: UNREAL_MANIFEST.commands.filter((c) => !offline || c.offline) } as unknown as ExternalAppInfo);
  const backendFor = (apps: ExternalAppInfo[]) => ({ list: async () => apps, isBuiltin: () => true, execute: async (): Promise<CommandResult> => ({ ok: true, verified: true, message: 'ok', evidence: [], outputs: [], durationMs: 1 }) }) as unknown as Parameters<typeof externalTools>[0];
  const exec = async (tools: ReturnType<typeof externalTools>, name: string, args: unknown) => { const t = tools.find((x) => x.name === name) as unknown as { execute: (a: unknown) => Promise<{ text: string } | string> }; const r = await t.execute(args); return typeof r === 'string' ? r : r.text; };
  /** The strict harness lists only applications it can really use. */
  const run = async (apps: ExternalAppInfo[]) => JSON.parse(await exec(externalTools(backendFor(apps)), 'external_apps', {})) as Array<{ key: string }>;
  it('lists a closed (unreachable) Unreal because it has commands that work closed, but not a closed app without any', async () => {
    expect(await run([closed('api-unavailable', false)])).toHaveLength(1);
    expect(await run([closed('not-running', false)])).toHaveLength(1);
    const noOffline = { ...closed('api-unavailable', false), commands: UNREAL_MANIFEST.commands.filter((c) => !c.offline) } as ExternalAppInfo;
    expect(await run([noOffline])).toEqual([]);
    expect(await run([{ ...closed('unsupported', false) } as ExternalAppInfo])).toEqual([]); // a placeholder stays hidden
    expect(await run([{ ...closed('connected', false) } as ExternalAppInfo])).toHaveLength(1); // unchanged for a normal connected app
  });
  it('lets the Claude-style AI read a closed Unreal\'s commands, and refuses an app that has nothing to offer while closed', async () => {
    const tools = externalTools(backendFor([closed('api-unavailable', false)]), { claudeStyle: true });
    const text = await exec(tools, 'external_apps', { app_key: 'Unreal Engine' });
    expect(text).toContain('project.create');
    const none = externalTools(backendFor([{ ...closed('api-unavailable', false), commands: UNREAL_MANIFEST.commands.filter((c) => !c.offline) } as ExternalAppInfo]), { claudeStyle: true });
    await expect(exec(none, 'external_apps', { app_key: 'Unreal Engine' })).rejects.toThrow(/is not connected \(status: api-unavailable\)/);
  });
  it('keeps what the AI reads about Unreal small enough to be shown whole', async () => {
    const tools = externalTools({ list: async () => [{ ...closed('connected', false), key: 'unreal-key' } as ExternalAppInfo], isBuiltin: () => true, execute: async () => ({}) } as unknown as Parameters<typeof externalTools>[0], { claudeStyle: true });
    const t = tools.find((x) => x.name === 'external_apps') as unknown as { execute: (a: unknown) => Promise<{ text: string } | string> };
    const r = await t.execute({ app_key: 'unreal-key' });
    const text = typeof r === 'string' ? r : r.text;
    expect(text).toContain('project.create');
    expect(text).toContain('editor.launch');
    expect(text.length).toBeLessThan(24_000);
  });
});

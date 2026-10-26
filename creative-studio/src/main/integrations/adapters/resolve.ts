// DaVinci Resolve adapter (second real external adapter; uses the same SDK, manager, permissions,
// router and screen as Blender, no Resolve-specific infrastructure).
//
// Control method: Resolve's supported scripting API (Python, DaVinciResolveScript / fusionscript.dll).
// What Resolve itself dictates, and the adapter reports instead of hiding:
//  * Resolve must be RUNNING for a script to connect; this adapter never starts it, so it never
//    touches a session the user did not start.
//  * External scripting (what a program outside Resolve uses) is a Studio feature and must be set to
//    Local in Preferences > System > General. A Free edition, or a disabled preference, makes the
//    connection return nothing; that is reported as "Scripting not available", never as success.
//  * The API library can crash some Python versions at import (seen with 3.13 here). Scripts always
//    run in a child process, so a crash cannot reach OmniCandy; other interpreters are then tried.
// Scripts are fixed templates; parameters travel in a JSON file and are never spliced into code.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ADAPTER_SDK_VERSION, type AdapterManifest, type CommandSpec, type DiscoveredApp } from '@shared/integrations';
import { parseResultLine, runProcess, safeFileName, type RunResult } from '../process';
import { BridgeError, bridgeCall, BRIDGE_START_HINT, readBridgeToken, type BridgeOptions } from './resolveBridge';
import { buildEdl, buildSrt, EDL_FPS, validateResolveJson, type EdlClip, type SrtCue } from './resolveFiles';
import { AdapterError, type AdapterFactory, type AdapterOutcome, type ExecuteContext, type ExternalAdapter, type HealthResult, type ProbeResult } from '../sdk';

/** Only projects whose name starts with this may be created or deleted by OmniCandy. */
export const SCRATCH_PREFIX = 'CreateCraft';

const COMMANDS: CommandSpec[] = [
  {
    id: 'app.info', label: 'Check DaVinci Resolve',
    description: 'Reads the edition, version, current page and open project name from the running Resolve (read only).',
    params: {}, permissions: ['read-info', 'execute-scripts'], idempotent: true, timeoutMs: 60_000,
  },
  {
    id: 'project.list', label: 'List Resolve projects',
    description: 'Lists the project names in the current Resolve database folder (read only).',
    params: {}, permissions: ['read-project', 'execute-scripts'], idempotent: true, timeoutMs: 60_000,
  },
  {
    id: 'project.inspect', label: 'Inspect the open Resolve project',
    description: 'Reports timelines, frame rate, resolution and the number of media pool clips of the project that is open in Resolve (read only).',
    params: {}, permissions: ['read-project', 'execute-scripts'], idempotent: true, timeoutMs: 60_000,
  },
  {
    id: 'project.create_scratch', label: 'Create a scratch Resolve project',
    description: `Creates a NEW project named "${SCRATCH_PREFIX} ..." (optionally with an empty timeline) and re-opens the project that was open before. Existing projects are never modified.`,
    params: {
      name: { type: 'string', description: `Project name; "${SCRATCH_PREFIX} " is added when missing.`, default: `${SCRATCH_PREFIX} Scratch` },
      with_timeline: { type: 'boolean', description: 'Also create an empty timeline.', default: true },
      allow_switch: { type: 'boolean', description: 'Allow switching away from a project that is currently open (Resolve closes it; unsaved work is the user\'s to save first).', default: false },
    },
    permissions: ['modify-project', 'execute-scripts'], idempotent: false, timeoutMs: 90_000,
  },
  {
    id: 'project.delete_scratch', label: 'Delete a CreateCraft scratch project',
    description: `Deletes one project whose name starts with "${SCRATCH_PREFIX}". Any other name is refused. Always asks first.`,
    params: { name: { type: 'string', description: `Exact name of the scratch project (starts with "${SCRATCH_PREFIX}").`, required: true } },
    permissions: ['modify-project', 'execute-scripts'], destructive: true, idempotent: true, timeoutMs: 90_000,
  },
  {
    id: 'timeline.export', label: 'Export the current timeline',
    description: 'Exports the current timeline of the open project to an FCPXML or EDL file in the project\'s Resolve folder. The Resolve project is not changed.',
    params: {
      file_name: { type: 'string', description: 'Output file name (letters, digits, space, dash).', default: 'timeline' },
      format: { type: 'string', description: 'fcpxml or edl.', default: 'fcpxml' },
    },
    permissions: ['read-project', 'write-files', 'execute-scripts'], idempotent: true, timeoutMs: 120_000,
  },
  {
    id: 'media.import', label: 'Import media into Resolve',
    description: 'FREE EDITION ROUTE (needs the OmniCandy Resolve Bridge script running inside Resolve). Imports files into the open project\'s Media Pool. Files must exist on this PC; give full paths. Nothing is deleted or overwritten.',
    params: { paths: { type: 'json', description: 'A JSON ARRAY of full file paths, e.g. ["C:\\\\Media\\\\shot1.mp4"].', required: true, maxChars: 40_000, maxDepth: 2 } },
    permissions: ['open-files', 'modify-project'], idempotent: false, timeoutMs: 120_000,
  },
  {
    id: 'timeline.create', label: 'Create an empty timeline in Resolve',
    description: 'FREE EDITION ROUTE (needs the OmniCandy Resolve Bridge script running inside Resolve). Creates a new empty timeline in the open project. Existing timelines are not changed.',
    params: { name: { type: 'string', description: 'Timeline name.', required: true } },
    permissions: ['modify-project'], idempotent: false, timeoutMs: 60_000,
  },
  {
    id: 'timeline.write_edl', label: 'Write a timeline for Resolve (EDL)',
    description: 'FREE EDITION ROUTE, works with Resolve closed or Free. Writes an EDL cut list from clips in order (file name, optional in_seconds, duration_seconds). The person imports it in Resolve: put the media in the Media Pool first, then File > Import > Timeline > Import AAF, EDL, XML. Resolve matches clips by file name. Nothing in Resolve is touched.',
    params: {
      clips: { type: 'json', description: 'A JSON ARRAY [{"file": "shot1.mp4", "in_seconds": 0, "duration_seconds": 5}, ...] in timeline order.', required: true, maxChars: 60_000, maxDepth: 3 },
      file_name: { type: 'string', description: 'Output file name (letters, digits, space, dash).', default: 'timeline' },
      fps: { type: 'number', description: 'Frame rate: 23.976, 24, 25, 30, 50 or 60.', default: 24 },
      with_audio: { type: 'boolean', description: 'Include the clips\' audio as well as video.', default: true },
    },
    permissions: ['write-files'], offline: true, idempotent: true, timeoutMs: 30_000,
  },
  {
    id: 'subtitles.write_srt', label: 'Write subtitles for Resolve (SRT)',
    description: 'FREE EDITION ROUTE, works with Resolve closed or Free. Writes an SRT subtitle file from timed cues. The person imports it in Resolve: right-click the subtitle track > Import Subtitle (or File > Import > Subtitle). Nothing in Resolve is touched.',
    params: {
      cues: { type: 'json', description: 'A JSON ARRAY [{"start": 0, "end": 2.5, "text": "Hello"}, ...] in seconds, in time order without overlap.', required: true, maxChars: 120_000, maxDepth: 3 },
      file_name: { type: 'string', description: 'Output file name (letters, digits, space, dash).', default: 'subtitles' },
    },
    permissions: ['write-files'], offline: true, idempotent: true, timeoutMs: 30_000,
  },
];

export const RESOLVE_MANIFEST: AdapterManifest = {
  id: 'davinci.resolve', name: 'DaVinci Resolve', vendor: 'Blackmagic Design', sdkVersion: ADAPTER_SDK_VERSION, maturity: 'experimental',
  exeNames: ['Resolve.exe'], displayNames: ['^DaVinci Resolve( Studio)?$'],
  versions: { min: '17.0' },
  methods: ['scripting', 'file-exchange'],
  capabilities: ['detect', 'inspectCapabilities', 'connect', 'disconnect', 'healthCheck', 'executeCommand', 'cancelOperation', 'exportFile', 'dispose'],
  commands: COMMANDS,
  notes: 'Live control needs Resolve to be running and External scripting set to Local (Preferences > System > General). That is a Studio-edition feature; with the Free edition this integration reports "Scripting not available" for live commands, but live commands still work through the OmniCandy Resolve Bridge script (Workspace > Scripts > Utility), and EDL timelines and SRT subtitles can be written for you to import (Resolve does not have to be open). OmniCandy never starts Resolve or opens your projects; only projects named "OmniCandy ..." can be created or deleted.',
};

const PRELUDE = `import json, os, sys
_p = json.load(open(sys.argv[1]))
def _out(d):
    print('CREATECRAFT_RESULT ' + json.dumps(d))
    sys.stdout.flush()
os.environ['RESOLVE_SCRIPT_API'] = _p['_api']
os.environ['RESOLVE_SCRIPT_LIB'] = _p['_lib']
sys.path.append(os.path.join(_p['_api'], 'Modules'))
try:
    import DaVinciResolveScript as _dvr
    resolve = _dvr.scriptapp('Resolve')
except Exception as _e:
    _out({'_state': 'api-unavailable', '_why': 'could not load the scripting module: ' + str(_e)})
    sys.exit(0)
if resolve is None:
    _out({'_state': 'api-unavailable', '_why': 'Resolve did not accept the scripting connection'})
    sys.exit(0)
pm = resolve.GetProjectManager()
if pm is None:
    _out({'_state': 'api-unavailable', '_why': 'Resolve returned no project manager (is the database open?)'})
    sys.exit(0)
def _cur():
    p = pm.GetCurrentProject()
    return p, (p.GetName() if p else None)
`;

const SCRIPTS: Record<string, string> = {
  'app.info': `${PRELUDE}
p, name = _cur()
prod = resolve.GetProductName() or ''
_out({'product': prod, 'version': resolve.GetVersionString(), 'studio': 'studio' in prod.lower(), 'page': resolve.GetCurrentPage(), 'project': name})
`,
  'project.list': `${PRELUDE}
names = pm.GetProjectListInCurrentFolder() or []
_out({'projects': list(names), 'count': len(names)})
`,
  'project.inspect': `${PRELUDE}
p, name = _cur()
if p is None:
    _out({'open': False})
else:
    tls = []
    for i in range(1, int(p.GetTimelineCount() or 0) + 1):
        t = p.GetTimelineByIndex(i)
        if t is None:
            continue
        tls.append({'name': t.GetName(), 'videoTracks': t.GetTrackCount('video'), 'audioTracks': t.GetTrackCount('audio'), 'startFrame': t.GetStartFrame(), 'endFrame': t.GetEndFrame()})
    def walk(f):
        n = len(f.GetClipList() or [])
        for s in (f.GetSubFolderList() or []):
            n += walk(s)
        return n
    mp = p.GetMediaPool()
    clips = walk(mp.GetRootFolder()) if mp else 0
    _out({'open': True, 'name': name, 'frameRate': p.GetSetting('timelineFrameRate'), 'width': p.GetSetting('timelineResolutionWidth'),
          'height': p.GetSetting('timelineResolutionHeight'), 'timelines': tls, 'timelineCount': len(tls), 'clipCount': clips})
`,
  'project.create_scratch': `${PRELUDE}
prefix = _p['prefix']
name = _p['name']
prev, prevname = _cur()
if prevname and not prevname.startswith(prefix) and not _p['allow_switch']:
    _out({'_error': 'The project "' + prevname + '" is open in Resolve. Close it first, or allow switching.'})
    sys.exit(0)
if name in (pm.GetProjectListInCurrentFolder() or []):
    _out({'_error': 'A project named "' + name + '" already exists.'})
    sys.exit(0)
proj = pm.CreateProject(name)
if proj is None:
    _out({'_error': 'Resolve did not create the project.'})
    sys.exit(0)
timeline = None
if _p['with_timeline']:
    mp = proj.GetMediaPool()
    tl = mp.CreateEmptyTimeline(name + ' Timeline') if mp else None
    timeline = tl.GetName() if tl else None
pm.SaveProject()
pm.CloseProject(proj)
restored = None
if prevname:
    reopened = pm.LoadProject(prevname)
    restored = reopened.GetName() if reopened else False
_out({'created': name, 'listed': name in (pm.GetProjectListInCurrentFolder() or []), 'timeline': timeline, 'previous': prevname, 'restored': restored})
`,
  'project.delete_scratch': `${PRELUDE}
name = _p['name']
if not name.startswith(_p['prefix']):
    _out({'_error': 'Only projects whose name starts with "' + _p['prefix'] + '" may be deleted.'})
    sys.exit(0)
if name not in (pm.GetProjectListInCurrentFolder() or []):
    _out({'deleted': name, 'listedAfter': False, 'existed': False})
    sys.exit(0)
cur, curname = _cur()
if curname == name:
    pm.CloseProject(cur)
ok = pm.DeleteProject(name)
_out({'deleted': name, 'existed': True, 'apiResult': bool(ok), 'listedAfter': name in (pm.GetProjectListInCurrentFolder() or [])})
`,
  'timeline.export': `${PRELUDE}
p, name = _cur()
if p is None:
    _out({'_error': 'No project is open in Resolve.'})
    sys.exit(0)
tl = p.GetCurrentTimeline()
if tl is None:
    _out({'_error': 'The open project has no current timeline.'})
    sys.exit(0)
if _p['format'] == 'edl':
    kind = getattr(resolve, 'EXPORT_EDL', None)
else:
    kind = None
    for n in ('EXPORT_FCPXML_1_10', 'EXPORT_FCPXML_1_9', 'EXPORT_FCPXML_1_8'):
        kind = getattr(resolve, n, None)
        if kind is not None:
            break
if kind is None:
    _out({'_error': 'This Resolve version has no ' + _p['format'] + ' export.'})
    sys.exit(0)
sub = getattr(resolve, 'EXPORT_NONE', None)
ok = tl.Export(_p['output'], kind, sub) if sub is not None else tl.Export(_p['output'], kind)
_out({'exported': bool(ok), 'timeline': tl.GetName(), 'project': name})
`,
};

/** Interpreter candidates, newest first (Resolve 21 loads in 3.14 here and crashes 3.13). */
export async function findPythons(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const out: string[] = [];
  const add = (p: string | undefined) => { if (p && !out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p); };
  add(env.CREATECRAFT_PYTHON);
  const ls = (dir: string) => fs.readdir(dir, { withFileTypes: true }).then((es) => es.filter((e) => e.isDirectory()).map((e) => e.name), () => [] as string[]);
  const roots: string[] = [];
  if (env.LOCALAPPDATA) {
    for (const n of await ls(path.join(env.LOCALAPPDATA, 'Python'))) if (/^pythoncore-\d/i.test(n)) roots.push(path.join(env.LOCALAPPDATA, 'Python', n));
    for (const n of await ls(path.join(env.LOCALAPPDATA, 'Programs', 'Python'))) if (/^Python3\d+/i.test(n)) roots.push(path.join(env.LOCALAPPDATA, 'Programs', 'Python', n));
  }
  for (const n of await ls('C:\\')) if (/^Python3\d+/i.test(n)) roots.push(path.join('C:\\', n));
  if (env.ProgramFiles) for (const n of await ls(env.ProgramFiles)) if (/^Python3\d+/i.test(n)) roots.push(path.join(env.ProgramFiles, n));
  const minor = (r: string) => { const m = /3[._-]?(\d{1,2})/.exec(path.basename(r)); return m ? parseInt(m[1]!, 10) : 0; };
  roots.sort((a, b) => minor(b) - minor(a));
  for (const r of roots) {
    const exe = path.join(r, 'python.exe');
    if (await fs.stat(exe).then((s) => s.isFile(), () => false)) add(exe);
  }
  return out;
}

export interface ResolveAdapterOptions {
  /** Scripting folder (contains Modules/DaVinciResolveScript.py). */
  apiDir?: string;
  /** fusionscript library; defaults to the one next to Resolve.exe. */
  libPath?: string;
  pythons?: () => Promise<string[]>;
  /** Replaces the tasklist check (tests). */
  isRunning?: () => Promise<boolean>;
  /** The in-Resolve bridge used when Resolve refuses outside scripting (Free edition). */
  bridge?: BridgeOptions;
}

/** Commands only the in-Resolve bridge provides. */
const BRIDGE_ONLY = new Set(['media.import', 'timeline.create']);
/** Commands that write a file and never talk to a running Resolve. */
const FILE_ONLY = new Set(['timeline.write_edl', 'subtitles.write_srt']);

/** Exit codes of a native crash (access violation, abort, segfault). */
const CRASH_CODES = new Set([3221225477, -1073741819, 139, 134, 3221226356]);

async function resolveIsRunning(): Promise<boolean> {
  try {
    const r = await runProcess('tasklist', ['/FI', 'IMAGENAME eq Resolve.exe', '/FO', 'CSV', '/NH'], { timeoutMs: 15_000, label: 'tasklist' });
    return /"Resolve\.exe"/i.test(r.out);
  } catch { return false; }
}

class ResolveAdapter implements ExternalAdapter {
  private app: DiscoveredApp | null = null;
  private python: string | null = null;
  edition: 'studio' | 'free' | 'unknown' = 'unknown';
  /** How live commands reach Resolve: its scripting API (Studio) or the bridge script inside it (Free). */
  mode: 'scripting' | 'bridge' = 'scripting';

  constructor(private readonly o: ResolveAdapterOptions) {}

  private apiDir(): string { return this.o.apiDir ?? path.join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Developer', 'Scripting'); }
  private libPath(): string { return this.o.libPath ?? path.join(path.dirname(this.app!.exePath), 'fusionscript.dll'); }

  async probe(app: DiscoveredApp): Promise<ProbeResult> {
    // Never start Resolve to read its version: take it from the installer record or the file itself.
    if (app.version) return { version: app.version, detail: 'version from the installer record' };
    const r = await runProcess('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${app.exePath.replace(/'/g, "''")}').VersionInfo.ProductVersion`], { timeoutMs: 20_000, label: 'PowerShell' });
    const v = /(\d+\.\d+(?:\.\d+)*)/.exec(r.out)?.[1] ?? null;
    return { version: v, detail: 'version from the executable' };
  }
  async connect(app: DiscoveredApp): Promise<void> { this.app = app; }
  async disconnect(): Promise<void> { this.app = null; this.python = null; }

  async healthCheck(): Promise<HealthResult> {
    const s = await this.scriptingHealth();
    if (s.ok) { this.mode = 'scripting'; return s; }
    if (s.state === 'not-running' || !this.app) return s;
    // Scripting refused or unavailable: the bridge script inside Resolve may still be running (works on Free).
    const b = await this.bridgeHealth();
    if (b) { this.mode = 'bridge'; return b; }
    const hasToken = !!(await readBridgeToken(this.o.bridge ?? {}));
    return { ...s, detail: `${s.detail}${hasToken ? ` Free edition alternative: ${BRIDGE_START_HINT}` : ''}` };
  }

  private async bridgeHealth(): Promise<HealthResult | null> {
    try {
      const r = await bridgeCall(this.o.bridge ?? {}, 'GET', '/status', undefined, { timeoutMs: 8_000 });
      if (r.connected !== true) return null;
      const prod = String(r.product ?? 'DaVinci Resolve');
      this.edition = /studio/i.test(prod) ? 'studio' : 'free';
      return { ok: true, detail: `${prod} ${String(r.version ?? '')} answers through the OmniCandy Resolve Bridge (${this.edition} edition).` };
    } catch { return null; }
  }

  private async scriptingHealth(): Promise<HealthResult> {
    if (!this.app) return { ok: false, detail: 'Not connected.' };
    if (!(await (this.o.isRunning ?? resolveIsRunning)())) {
      return { ok: false, state: 'not-running', detail: 'DaVinci Resolve is not running. Start Resolve (OmniCandy never starts it or opens your projects), then connect again.' };
    }
    const lib = this.libPath();
    if (!(await fs.stat(lib).then(() => true, () => false))) return { ok: false, detail: `The Resolve scripting library was not found at ${lib}.` };
    if (!(await fs.stat(path.join(this.apiDir(), 'Modules', 'DaVinciResolveScript.py')).then(() => true, () => false))) {
      return { ok: false, detail: `Resolve's scripting module was not found in ${this.apiDir()}. Reinstall Resolve or repair it.` };
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-resolve-health-'));
    try {
      const r = await this.run(dir, 'app.info', {}, undefined, 60_000);
      if (r.state === 'api-unavailable') {
        return { ok: false, state: 'api-unavailable', detail: `Resolve is running but not reachable by scripting (${r.why}). External scripting needs the Studio edition and Preferences > System > General > "External scripting using" set to Local. A Free edition looks exactly like this from outside.` };
      }
      const prod = String(r.data.product ?? '');
      this.edition = r.data.studio === true ? 'studio' : 'free';
      return { ok: true, detail: `${prod || 'DaVinci Resolve'} ${String(r.data.version ?? '')} answers scripting (${this.edition} edition).` };
    } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) }; } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }

  /** Runs one template. Tries interpreters until one gets past the import without crashing. */
  private async run(dir: string, commandId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<{ data: Record<string, unknown>; state?: 'api-unavailable'; why?: string }> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const py = path.join(dir, `${stamp}.py`), js = path.join(dir, `${stamp}.json`);
    await fs.writeFile(py, SCRIPTS[commandId]!);
    await fs.writeFile(js, JSON.stringify({ ...params, _api: this.apiDir(), _lib: this.libPath() }));
    try {
      const candidates = this.python ? [this.python] : await (this.o.pythons ?? findPythons)();
      if (!candidates.length) throw new AdapterError('missing-app', 'No Python 3 interpreter was found. Install Python 3 (64-bit) or set CREATECRAFT_PYTHON; Resolve scripting needs one.');
      const crashed: string[] = [];
      for (const exe of candidates) {
        const r: RunResult = await runProcess(exe, [py, js], { signal, timeoutMs, label: 'Python', env: { ...process.env, RESOLVE_SCRIPT_API: this.apiDir(), RESOLVE_SCRIPT_LIB: this.libPath() } });
        const res = parseResultLine(r.out);
        if (res) {
          this.python = exe;
          if (res._state === 'api-unavailable') return { data: {}, state: 'api-unavailable', why: String(res._why ?? 'no connection') };
          if (typeof res._error === 'string') throw new AdapterError('app-error', res._error);
          return { data: res };
        }
        // No result: a crash at import (try the next interpreter) or a Python error (report it).
        if (r.code !== null && CRASH_CODES.has(r.code)) { crashed.push(`${exe} (exit ${r.code})`); continue; }
        throw new AdapterError('app-error', `Resolve script failed (exit ${r.code}): ${(r.err || r.out).trim().split(/\r?\n/).slice(-4).join(' | ').slice(0, 400)}`);
      }
      throw new AdapterError('app-error', `The Resolve scripting library crashed every Python tried: ${crashed.join('; ')}. Install another Python 3 version or set CREATECRAFT_PYTHON.`);
    } finally { await fs.rm(py, { force: true }); await fs.rm(js, { force: true }); }
  }

  async execute(cmd: CommandSpec, params: Record<string, string | number | boolean>, ctx: ExecuteContext): Promise<AdapterOutcome> {
    if (!this.app) throw new AdapterError('app-error', 'DaVinci Resolve is not connected.');
    const tmp = path.join(ctx.workDir, '.scripts');
    await fs.mkdir(tmp, { recursive: true });
    const go = async (extra: Record<string, unknown> = {}) => {
      const r = await this.run(tmp, cmd.id, { ...params, ...extra, prefix: SCRATCH_PREFIX }, ctx.signal, cmd.timeoutMs ?? 60_000);
      if (r.state) throw new AdapterError('app-error', `Resolve scripting stopped answering (${r.why}). Check that Resolve is still running with External scripting enabled.`);
      return r.data;
    };
    const readEvidence = ['read from Resolve through its scripting API'];
    if ((this.mode === 'bridge' && !FILE_ONLY.has(cmd.id)) || BRIDGE_ONLY.has(cmd.id)) return this.executeViaBridge(cmd, params, ctx);
    switch (cmd.id) {
      case 'timeline.write_edl': {
        const clips = JSON.parse(String(params.clips)) as EdlClip[];
        const fps = Number(params.fps);
        if (!(EDL_FPS as readonly number[]).includes(fps)) throw new AdapterError('invalid-params', `fps must be one of ${EDL_FPS.join(', ')}.`);
        const file = safeFileName(String(params.file_name), '.edl');
        const output = path.join(ctx.workDir, file);
        await fs.writeFile(output, buildEdl(file.replace(/\.edl$/, ''), fps, clips, params.with_audio !== false));
        const secs = clips.reduce((n, c) => n + c.duration_seconds, 0);
        return { message: `Wrote ${file}: ${clips.length} clip(s), ${secs.toFixed(1)} s at ${fps} fps. In Resolve: add the media to the Media Pool, then File > Import > Timeline and choose this file.`, outputs: [output], data: { clips: clips.length, seconds: secs, fps }, evidence: ['written as a CMX3600 EDL for Resolve to import (not yet imported into Resolve)'] };
      }
      case 'subtitles.write_srt': {
        const cues = JSON.parse(String(params.cues)) as SrtCue[];
        const file = safeFileName(String(params.file_name), '.srt');
        const output = path.join(ctx.workDir, file);
        await fs.writeFile(output, buildSrt(cues));
        return { message: `Wrote ${file} with ${cues.length} subtitle(s). In Resolve: right-click the subtitle track and choose Import Subtitle.`, outputs: [output], data: { cues: cues.length }, evidence: ['written as an SRT file for Resolve to import (not yet imported into Resolve)'] };
      }
      case 'app.info': {
        const d = await go();
        return { message: `${String(d.product)} ${String(d.version)}${d.project ? `, project "${String(d.project)}" open` : ', no project open'}.`, outputs: [], data: d, verified: true, evidence: readEvidence };
      }
      case 'project.list': {
        const d = await go();
        return { message: `${String(d.count)} project(s) in the current Resolve folder.`, outputs: [], data: d, verified: true, evidence: readEvidence };
      }
      case 'project.inspect': {
        const d = await go();
        if (d.open === false) return { message: 'No project is open in Resolve.', outputs: [], data: d, verified: true, evidence: readEvidence };
        return { message: `"${String(d.name)}": ${String(d.timelineCount)} timeline(s), ${String(d.clipCount)} clip(s), ${String(d.width)}x${String(d.height)} at ${String(d.frameRate)} fps.`, outputs: [], data: d, verified: true, evidence: readEvidence };
      }
      case 'project.create_scratch': {
        let name = String(params.name).trim();
        if (!name.startsWith(SCRATCH_PREFIX)) name = `${SCRATCH_PREFIX} ${name}`;
        name = name.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 60);
        if (!name.startsWith(SCRATCH_PREFIX)) throw new AdapterError('invalid-params', 'The project name has no usable characters.');
        const d = await go({ name });
        if (d.listed !== true) throw new AdapterError('verification-failed', `Resolve did not list "${name}" after creating it.`);
        const ev = [`"${name}" is listed in Resolve's project list after creation`];
        if (d.previous) ev.push(d.restored ? `previous project "${String(d.previous)}" re-opened` : `previous project "${String(d.previous)}" could NOT be re-opened`);
        return { message: `Created the scratch project "${name}"${d.timeline ? ' with an empty timeline' : ''}. Delete it with project.delete_scratch when you are done.`, outputs: [], data: { ...d, name }, verified: true, evidence: ev };
      }
      case 'project.delete_scratch': {
        const name = String(params.name);
        if (!name.startsWith(SCRATCH_PREFIX)) throw new AdapterError('invalid-params', `Only projects whose name starts with "${SCRATCH_PREFIX}" may be deleted.`);
        const d = await go({ name });
        if (d.listedAfter === true) throw new AdapterError('verification-failed', `"${name}" is still in Resolve's project list after deleting it.`);
        return { message: d.existed === false ? `"${name}" does not exist (nothing to delete).` : `Deleted the scratch project "${name}".`, outputs: [], data: d, verified: true, evidence: [`"${name}" is no longer in Resolve's project list`] };
      }
      case 'timeline.export': {
        const format = String(params.format).toLowerCase();
        if (format !== 'fcpxml' && format !== 'edl') throw new AdapterError('invalid-params', 'format must be fcpxml or edl.');
        const output = path.join(ctx.workDir, safeFileName(String(params.file_name), format === 'edl' ? '.edl' : '.fcpxml'));
        ctx.progress('Exporting the timeline', 0.3);
        const d = await go({ output, format });
        if (d.exported !== true) throw new AdapterError('app-error', 'Resolve reported that the export failed.');
        return { message: `Exported timeline "${String(d.timeline)}" to ${path.basename(output)}.`, outputs: [output], data: d, evidence: [`exported by Resolve from project "${String(d.project)}"`] };
      }
    }
    throw new AdapterError('unsupported', `DaVinci Resolve cannot run "${cmd.id}".`);
  }

  /** Live commands through the bridge script inside Resolve (Free edition). Same answers as the scripting versions. */
  private async executeViaBridge(cmd: CommandSpec, params: Record<string, string | number | boolean>, ctx: ExecuteContext): Promise<AdapterOutcome> {
    const call = async (method: 'GET' | 'POST', route: string, body?: unknown) => {
      try { return await bridgeCall(this.o.bridge ?? {}, method, route, body, { signal: ctx.signal, timeoutMs: cmd.timeoutMs }); }
      catch (e) { if (e instanceof BridgeError) throw new AdapterError('app-error', e.message); throw e; }
    };
    const optional = async (route: string) => { try { return await call('GET', route); } catch { return null; } };
    const ev = ['read from Resolve through the OmniCandy Resolve Bridge'];
    switch (cmd.id) {
      case 'app.info': {
        const st = await call('GET', '/status');
        const proj = await optional('/project');
        const product = String(st.product ?? ''), name = typeof proj?.name === 'string' ? proj.name : null;
        const d = { product, version: st.version, studio: /studio/i.test(product), project: name, via: 'bridge' };
        return { message: `${product} ${String(st.version)}${name ? `, project "${name}" open` : ', no project open'} (through the bridge).`, outputs: [], data: d, verified: true, evidence: ev };
      }
      case 'project.list': {
        const r = await call('GET', '/projects');
        const projects = Array.isArray(r.projects) ? r.projects : [];
        return { message: `${projects.length} project(s) in the current Resolve folder.`, outputs: [], data: { projects, count: projects.length }, verified: true, evidence: ev };
      }
      case 'project.inspect': {
        const proj = await optional('/project');
        if (!proj || typeof proj.name !== 'string') return { message: 'No project is open in Resolve.', outputs: [], data: { open: false }, verified: true, evidence: ev };
        const pool = await optional('/mediapool');
        const settings = (proj.settings ?? {}) as Record<string, unknown>;
        const clipCount = Array.isArray(pool?.clips) ? pool.clips.length : 0;
        const d = { open: true, name: proj.name, frameRate: settings.timelineFrameRate, width: settings.timelineResolutionWidth, height: settings.timelineResolutionHeight, timelineCount: proj.timelineCount, clipCount, clipCountScope: 'current Media Pool folder' };
        return { message: `"${proj.name}": ${String(proj.timelineCount)} timeline(s), ${clipCount} clip(s) in the current folder, ${String(d.width)}x${String(d.height)} at ${String(d.frameRate)} fps.`, outputs: [], data: d, verified: true, evidence: ev };
      }
      case 'timeline.export': {
        const format = String(params.format).toLowerCase();
        if (format !== 'fcpxml' && format !== 'edl') throw new AdapterError('invalid-params', 'format must be fcpxml or edl.');
        const output = path.join(ctx.workDir, safeFileName(String(params.file_name), format === 'edl' ? '.edl' : '.fcpxml'));
        ctx.progress('Exporting the timeline', 0.3);
        const tl = await call('GET', '/timeline');
        let last = 'Resolve reported that the export failed.';
        for (const exportType of format === 'edl' ? ['EDL'] : ['FCPXML_1_10', 'FCPXML_1_9', 'FCPXML_1_8']) {
          try {
            const r = await call('POST', '/timeline/export', { fileName: output, exportType, exportSubtype: 'EXPORT_NONE' });
            if (r.success === true) return { message: `Exported timeline "${String(tl.name)}" to ${path.basename(output)}.`, outputs: [output], data: { exported: true, timeline: tl.name, exportType }, evidence: ['exported by Resolve through the OmniCandy Resolve Bridge'] };
          } catch (e) { last = e instanceof Error ? e.message : String(e); }
        }
        throw new AdapterError('app-error', last);
      }
      case 'media.import': {
        const paths = JSON.parse(String(params.paths)) as string[];
        for (const f of paths) if (!(await fs.stat(f).then((st) => st.isFile(), () => false))) throw new AdapterError('invalid-params', `File not found: ${f}`);
        const r = await call('POST', '/media/import', { filePaths: paths });
        const names = Array.isArray(r.imported) ? r.imported.map(String) : [];
        if (r.success !== true || !names.length) throw new AdapterError('verification-failed', 'Resolve did not report any imported clips.');
        return { message: `Imported ${names.length} clip(s) into the Media Pool: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', ...' : ''}.`, outputs: [], data: { imported: names }, verified: true, evidence: [`Resolve reported ${names.length} imported clip(s)`] };
      }
      case 'timeline.create': {
        const name = String(params.name).replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 80);
        if (!name) throw new AdapterError('invalid-params', 'The timeline name has no usable characters.');
        const r = await call('POST', '/timeline/create', { name });
        if (r.success !== true) throw new AdapterError('app-error', 'Resolve did not create the timeline.');
        return { message: `Created the empty timeline "${name}".`, outputs: [], data: { timeline: name }, verified: true, evidence: [`Resolve reported creating "${name}"`] };
      }
    }
    throw new AdapterError('unsupported', `"${cmd.id}" needs Resolve Studio's scripting; creating and deleting projects is not offered through the bridge. Everything else works on the Free edition.`);
  }

  async dispose(): Promise<void> { this.app = null; this.python = null; }
}

export function createResolveFactory(o: ResolveAdapterOptions = {}): AdapterFactory {
  return { manifest: RESOLVE_MANIFEST, create: () => new ResolveAdapter(o), validateJson: validateResolveJson };
}

export const resolveFactory: AdapterFactory = createResolveFactory();

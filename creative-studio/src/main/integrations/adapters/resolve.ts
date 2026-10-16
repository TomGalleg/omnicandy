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
//    run in a child process, so a crash cannot reach CreateCraft; other interpreters are then tried.
// Scripts are fixed templates; parameters travel in a JSON file and are never spliced into code.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ADAPTER_SDK_VERSION, type AdapterManifest, type CommandSpec, type DiscoveredApp } from '@shared/integrations';
import { parseResultLine, runProcess, safeFileName, type RunResult } from '../process';
import { AdapterError, type AdapterFactory, type AdapterOutcome, type ExecuteContext, type ExternalAdapter, type HealthResult, type ProbeResult } from '../sdk';

/** Only projects whose name starts with this may be created or deleted by CreateCraft. */
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
];

export const RESOLVE_MANIFEST: AdapterManifest = {
  id: 'davinci.resolve', name: 'DaVinci Resolve', vendor: 'Blackmagic Design', sdkVersion: ADAPTER_SDK_VERSION, maturity: 'experimental',
  exeNames: ['Resolve.exe'], displayNames: ['^DaVinci Resolve( Studio)?$'],
  versions: { min: '17.0' },
  methods: ['scripting', 'file-exchange'],
  capabilities: ['detect', 'inspectCapabilities', 'connect', 'disconnect', 'healthCheck', 'executeCommand', 'cancelOperation', 'exportFile', 'dispose'],
  commands: COMMANDS,
  notes: 'Needs Resolve to be running and External scripting set to Local (Preferences > System > General). Resolve\'s external scripting is a Studio-edition feature; with the Free edition this integration reports "Scripting not available". CreateCraft never starts Resolve or opens your projects; only projects named "CreateCraft ..." can be created or deleted.',
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
}

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
    if (!this.app) return { ok: false, detail: 'Not connected.' };
    if (!(await (this.o.isRunning ?? resolveIsRunning)())) {
      return { ok: false, state: 'not-running', detail: 'DaVinci Resolve is not running. Start Resolve (CreateCraft never starts it or opens your projects), then connect again.' };
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
    switch (cmd.id) {
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

  async dispose(): Promise<void> { this.app = null; this.python = null; }
}

export function createResolveFactory(o: ResolveAdapterOptions = {}): AdapterFactory {
  return { manifest: RESOLVE_MANIFEST, create: () => new ResolveAdapter(o) };
}

export const resolveFactory: AdapterFactory = createResolveFactory();

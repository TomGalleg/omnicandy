// Blender adapter (Blender 3.6 and newer; developed and verified against Blender 4.0).
// Control method: scripting. Blender runs in the background (`--background --factory-startup --python`),
// so no window is opened and a crash cannot touch OmniCandy. The scripts are fixed templates;
// parameters travel in a JSON file and are never spliced into code. Version differences are handled
// inside the templates (only API calls that are stable across 3.6 to 4.x are used).

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ADAPTER_SDK_VERSION, type AdapterManifest, type CommandSpec, type DiscoveredApp } from '@shared/integrations';
import { LiveBlenderSession, blenderLiveEnabled } from './blenderLive';
import { SCENE_COMMANDS, SCENE_PRELUDE, SCENE_SCRIPTS, EDIT_COMMAND_IDS } from './blenderScene';
import { BATCH_COMMANDS, BATCH_PRELUDE, BATCH_SCRIPTS, BATCH_VOCAB, assembleDiscovery, type DiscoveryFacts } from './blenderBatch';
import { SCRIPT_COMMAND, SCRIPT_RUN_BODY, SCRIPT_WINDOW_RELOAD_BODY, SCRIPT_WINDOW_SAVE_BODY } from './blenderScript';
import { SCRIPT_RULES, assessScriptRun, fileHashOf, scriptHashOf, validateScript, type ScriptMarker, type ScriptSpec } from './blenderScriptSpec';
import { BATCH_ID, MAX_BATCH_OBJECTS, assessBatchReadback, chunkOf, expectedBatchFromParams, specHashOf, validateBuildSpec, type BuildSpec } from './blenderBatchSpec';
import { runProcess, safeFileName, parseResultLine, type RunResult } from '../process';
import { AdapterError, type AdapterFactory, type AdapterOutcome, type ExecuteContext, type ExternalAdapter, type HealthResult, type ProbeResult } from '../sdk';

const COMMANDS: CommandSpec[] = [
  {
    id: 'scene.create_basic', label: 'Create a basic 3D scene',
    description: 'Creates a new Blender scene with a cube, a camera aimed at it and a light, and saves it as a .blend file in the project.',
    params: {
      file_name: { type: 'string', description: 'Name of the .blend file to create (letters, digits, space, dash).', default: 'basic-scene.blend' },
      cube_size: { type: 'number', description: 'Cube edge length in metres.', default: 2, min: 0.1, max: 100 },
      light_energy: { type: 'number', description: 'Point light power in watts.', default: 1000, min: 0, max: 100000 },
    },
    permissions: ['launch', 'execute-scripts', 'write-files'], idempotent: true, timeoutMs: 120_000,
  },
  {
    id: 'scene.inspect', label: 'Inspect a Blender file',
    description: 'Opens a .blend file from the Blender folder of this project (read only) and lists its objects with location, rotation, scale, size, materials, modifiers and keyframes, plus the scene settings.',
    params: { file_name: { type: 'string', description: 'Name of an existing .blend file in the Blender folder.', required: true } },
    permissions: ['launch', 'open-files', 'read-project', 'execute-scripts'], idempotent: true, timeoutMs: 120_000,
  },
  {
    id: 'scene.render_still', label: 'Render a still image',
    description: 'Renders the active camera of a .blend file to a PNG (fast Workbench engine).',
    params: {
      file_name: { type: 'string', description: 'Name of an existing .blend file in the Blender folder.', required: true },
      width: { type: 'number', description: 'Width in pixels.', default: 960, min: 64, max: 4096 },
      height: { type: 'number', description: 'Height in pixels.', default: 540, min: 64, max: 4096 },
      engine: { type: 'string', description: 'workbench (fast), eevee or cycles.', default: 'workbench' },
    },
    permissions: ['launch', 'open-files', 'write-files', 'execute-scripts'], idempotent: true, timeoutMs: 300_000,
  },
];

COMMANDS.push(...SCENE_COMMANDS, ...BATCH_COMMANDS, SCRIPT_COMMAND);

export const BLENDER_MANIFEST: AdapterManifest = {
  id: 'blender', name: 'Blender', vendor: 'Blender Foundation', sdkVersion: ADAPTER_SDK_VERSION, maturity: 'verified',
  exeNames: ['blender.exe'], displayNames: ['^Blender( \\d|$)'],
  versions: { min: '3.6' },
  methods: ['scripting', 'cli', 'file-exchange'],
  capabilities: ['detect', 'inspectCapabilities', 'connect', 'disconnect', 'healthCheck', 'launch', 'openProject', 'executeCommand', 'cancelOperation', 'saveProject', 'exportFile', 'dispose'],
  commands: COMMANDS,
  notes: 'Uses Blender in the background with Python scripts; no add-on is installed and Blender does not need to be open. Verified with Blender 4.0.',
};

const PRELUDE = `import bpy, json, sys
_p = json.load(open(sys.argv[sys.argv.index('--') + 1]))
def _result(d):
    print('CREATECRAFT_RESULT ' + json.dumps(d))
def _summary():
    kinds = {}
    for o in bpy.data.objects:
        kinds.setdefault(o.type, []).append(o.name)
    return {'objects': {k: sorted(v) for k, v in kinds.items()}, 'count': len(bpy.data.objects), 'blender': bpy.app.version_string}
`;
// What the always-open window needs once (no parameter file, and its own _result): the helper functions only.
const LIVE_PRELUDE = `${PRELUDE.slice(PRELUDE.indexOf('def _summary'))}${SCENE_PRELUDE}`;
const OPEN_CALL = "bpy.ops.wm.open_mainfile(filepath=_p['input'])";
/** The same fixed script a background run uses, minus its prelude, working on the open window's scene. */
function liveBody(commandId: string): { script: string; opensFile: boolean } {
  const full = SCRIPTS[commandId]!;
  const withScene = `${PRELUDE}${SCENE_PRELUDE}`;
  const body = full.startsWith(withScene) ? full.slice(withScene.length) : full.startsWith(PRELUDE) ? full.slice(PRELUDE.length) : full;
  // The window loads the file itself (only when it is not already the open one) before the script runs; a script that
  // starts from an empty scene clears the open scene instead of reloading Blender's startup settings, which would replace the window.
  return {
    script: body.split(OPEN_CALL).join('pass').split('bpy.ops.wm.read_factory_settings(use_empty=True)').join(LIVE_CLEAR),
    opensFile: body.includes(OPEN_CALL),
  };
}
const LIVE_CLEAR = `for _o in list(bpy.data.objects):
    bpy.data.objects.remove(_o, do_unlink=True)
for _c in (bpy.data.meshes, bpy.data.cameras, bpy.data.lights, bpy.data.materials, bpy.data.curves):
    for _x in list(_c):
        _c.remove(_x)`;

const SCRIPTS: Record<string, string> = {
  'scene.create_basic': `${PRELUDE}
bpy.ops.wm.read_factory_settings(use_empty=True)
size = float(_p['cube_size'])
bpy.ops.mesh.primitive_cube_add(size=size, location=(0, 0, size / 2))
cube = bpy.context.active_object
cube.name = 'Cube'
cam = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
bpy.context.scene.collection.objects.link(cam)
d = size * 4
cam.location = (d, -d, d * 0.8)
tc = cam.constraints.new('TRACK_TO')
tc.target = cube
tc.track_axis = 'TRACK_NEGATIVE_Z'
tc.up_axis = 'UP_Y'
bpy.context.scene.camera = cam
ld = bpy.data.lights.new('Light', 'POINT')
ld.energy = float(_p['light_energy'])
light = bpy.data.objects.new('Light', ld)
light.location = (d * 0.5, -d * 0.3, d * 1.2)
bpy.context.scene.collection.objects.link(light)
bpy.ops.wm.save_as_mainfile(filepath=_p['output'])
_result(_summary())
`,
  'scene.inspect': `${PRELUDE}${SCENE_PRELUDE}
bpy.ops.wm.open_mainfile(filepath=_p['input'])
_result(dict(_summary(), **_details()))
`,
  'scene.render_still': `${PRELUDE}${SCENE_PRELUDE}
bpy.ops.wm.open_mainfile(filepath=_p['input'])
sc = bpy.context.scene
if sc.camera is None:
    raise SystemExit('The scene has no active camera.')
_engine(sc, _p.get('engine', 'workbench'))
sc.render.resolution_x = int(_p['width'])
sc.render.resolution_y = int(_p['height'])
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = 'PNG'
sc.render.filepath = _p['output']
bpy.ops.render.render(write_still=True)
_result(_summary())
`,
};

for (const [id, body] of Object.entries(SCENE_SCRIPTS)) SCRIPTS[id] = `${PRELUDE}${SCENE_PRELUDE}\n${body}`;
// Batch commands share one extra prelude; in the open window it is simply part of each (short-lived) script body.
for (const [id, body] of Object.entries(BATCH_SCRIPTS)) SCRIPTS[id] = `${PRELUDE}${SCENE_PRELUDE}${BATCH_PRELUDE}\n${body}`;
// script.run and the two open-window helpers around it (save what the window holds, reload the replaced project).
for (const [id, body] of Object.entries({ 'script.run': SCRIPT_RUN_BODY, 'script.window_save': SCRIPT_WINDOW_SAVE_BODY, 'script.window_reload': SCRIPT_WINDOW_RELOAD_BODY })) SCRIPTS[id] = `${PRELUDE}${SCENE_PRELUDE}${BATCH_PRELUDE}\n${body}`;

export function runBlender(exe: string, args: string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<RunResult> {
  return runProcess(exe, args, { signal, timeoutMs, label: 'Blender' });
}

const safeName = safeFileName;

const MARKER_FILE = '.cc-script-marker.json';
const writeMarker = async (dir: string, m: ScriptMarker): Promise<void> => {
  const tmp = path.join(dir, `${MARKER_FILE}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(m));
  await fs.rename(tmp, path.join(dir, MARKER_FILE));
};
const readMarker = async (dir: string): Promise<ScriptMarker | null> => {
  try { const m = JSON.parse(await fs.readFile(path.join(dir, MARKER_FILE), 'utf8')) as ScriptMarker; return m && typeof m === 'object' ? m : null; } catch { return null; }
};
const BACKUPS_KEPT = 10;

class BlenderAdapter implements ExternalAdapter {
  private app: DiscoveredApp | null = null;
  private version: string | null = null;

  async probe(app: DiscoveredApp): Promise<ProbeResult> {
    const r = await runBlender(app.exePath, ['--version'], undefined, 30_000);
    const m = /Blender\s+(\d+\.\d+(?:\.\d+)?)/.exec(r.out);
    if (!m) throw new AdapterError('app-error', `Blender did not report a version (exit ${r.code}).`);
    this.version = m[1]!;
    return { version: this.version, detail: r.out.split(/\r?\n/)[0] };
  }
  private live: LiveBlenderSession | null = null;
  private liveStarting: Promise<void> | null = null;

  async connect(app: DiscoveredApp): Promise<void> { this.app = app; }
  async disconnect(): Promise<void> { await this.releaseLive(); this.app = null; }

  /** Leaves an open Blender window to the user (it keeps running; OmniCandy stops sending it commands). */
  private async releaseLive(): Promise<void> {
    const l = this.live;
    this.live = null;
    if (l?.alive) await l.detach();
  }

  /** Opens the Blender window (docked into OmniCandy by the host) the first time a command needs it. Falls back to background runs if it cannot start. */
  private async ensureLive(ctx: ExecuteContext): Promise<void> {
    if (!blenderLiveEnabled() || !this.app || this.live?.alive) return;
    this.liveStarting ??= (async () => {
      const session = new LiveBlenderSession(this.app!.exePath, path.join(ctx.workDir, '.live'), LIVE_PRELUDE);
      try { await session.start(); this.live = session; } catch { session.kill(); this.live = null; }
    })().finally(() => { this.liveStarting = null; });
    await this.liveStarting;
  }
  async healthCheck(): Promise<HealthResult> {
    if (!this.app) return { ok: false, detail: 'Not connected.' };
    // A real, tiny background run: Python works and `bpy` imports.
    const dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'cc-blender-health-'));
    try {
      const script = path.join(dir, 'h.py');
      await fs.writeFile(script, "import bpy\nprint('CREATECRAFT_HEALTH ' + bpy.app.version_string)\n");
      const r = await runBlender(this.app.exePath, ['--background', '--factory-startup', '--python', script], undefined, 60_000);
      const m = /CREATECRAFT_HEALTH (\S+)/.exec(r.out);
      return m ? { ok: true, detail: `Blender ${m[1]} runs scripts.` } : { ok: false, detail: `Blender started but its Python did not answer (exit ${r.code}). ${r.err.slice(-200)}` };
    } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) }; } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }

  private async script(ctx: ExecuteContext, commandId: string, params: Record<string, unknown>, opts: { background?: boolean } = {}): Promise<{ summary: Record<string, unknown>; r: RunResult }> {
    if (!opts.background && this.live?.alive) {
      const lb = liveBody(commandId);
      let summary: Record<string, unknown>;
      try {
        summary = await this.live.run(lb.script, params, { timeoutMs: commandId === 'scene.render_animation' ? 1_800_000 : 300_000, signal: ctx.signal, restore: commandId.startsWith('scene.render'), open: lb.opensFile ? String(params.input) : undefined, reload: commandId === 'script.window_reload' });
      } catch (e) { throw new AdapterError('app-error', e instanceof Error ? e.message : String(e)); }
      return { summary, r: { out: '', err: '', code: 0 } as RunResult };
    }
    const tmp = path.join(ctx.workDir, '.scripts');
    await fs.mkdir(tmp, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const py = path.join(tmp, `${stamp}.py`), js = path.join(tmp, `${stamp}.json`);
    await fs.writeFile(py, SCRIPTS[commandId]!);
    await fs.writeFile(js, JSON.stringify(params));
    try {
      const r = await runBlender(this.app!.exePath, ['--background', '--factory-startup', '--python', py, '--', js], ctx.signal, 300_000);
      const summary = parseResultLine(r.out);
      if (r.code !== 0 || !summary) {
        const tail = (r.err || r.out).trim().split(/\r?\n/).slice(-6).join(' | ');
        throw new AdapterError('app-error', `Blender stopped with exit code ${r.code}: ${tail.slice(0, 400)}`);
      }
      return { summary, r };
    } finally { await fs.rm(py, { force: true }); await fs.rm(js, { force: true }); }
  }

  async execute(cmd: CommandSpec, params: Record<string, string | number | boolean>, ctx: ExecuteContext): Promise<AdapterOutcome> {
    if (!this.app) throw new AdapterError('app-error', 'Blender is not connected.');
    await this.ensureLive(ctx);
    const existing = async (name: string) => {
      const f = path.join(ctx.workDir, safeName(name, '.blend'));
      if (!(await fs.stat(f).then((s) => s.isFile(), () => false))) throw new AdapterError('invalid-params', `${path.basename(f)} is not in the Blender folder of this project.`);
      return f;
    };
    if (cmd.id === 'scene.create_basic') {
      const output = path.join(ctx.workDir, safeName(String(params.file_name), '.blend'));
      ctx.progress('Creating the scene', 0.2);
      const { summary } = await this.script(ctx, cmd.id, { output, cube_size: params.cube_size, light_energy: params.light_energy });
      // Verification: open the saved file again in a fresh Blender and count what is really in it.
      ctx.progress('Checking the saved file', 0.7);
      const check = await this.script(ctx, 'scene.inspect', { input: output }, { background: true });
      const objs = (check.summary.objects ?? {}) as Record<string, string[]>;
      const ok = (objs.MESH?.length ?? 0) >= 1 && (objs.CAMERA?.length ?? 0) >= 1 && (objs.LIGHT?.length ?? 0) >= 1;
      if (!ok) throw new AdapterError('verification-failed', `The saved file does not contain a cube, camera and light: ${JSON.stringify(objs)}`);
      return {
        message: `Created ${path.basename(output)} with a cube, a camera and a light in Blender ${String(summary.blender)}.`,
        outputs: [output], data: { objects: objs, blender: summary.blender }, verified: true,
        evidence: [`re-opened in a fresh Blender: ${objs.MESH!.length} mesh, ${objs.CAMERA!.length} camera, ${objs.LIGHT!.length} light`],
      };
    }
    if (cmd.id === 'scene.inspect') {
      const input = await existing(String(params.file_name));
      const { summary } = await this.script(ctx, cmd.id, { input });
      return { message: `${path.basename(input)} has ${String(summary.count)} object(s).`, outputs: [], data: summary, verified: true, evidence: ['read from the file by Blender'] };
    }
    if (cmd.id === 'scene.render_still') {
      const input = await existing(String(params.file_name));
      const output = path.join(ctx.workDir, safeName(String(params.file_name), '.png'));
      ctx.progress('Rendering', 0.3);
      await this.script(ctx, cmd.id, { input, output, width: params.width, height: params.height, engine: params.engine });
      return { message: `Rendered ${path.basename(output)} (${params.width}x${params.height}).`, outputs: [output] };
    }
    if (EDIT_COMMAND_IDS.has(cmd.id)) {
      const input = await existing(String(params.file_name));
      const { file_name: _f, ...rest } = params;
      ctx.progress('Editing the scene', 0.3);
      const { summary } = await this.script(ctx, cmd.id, { input, ...rest });
      // Verification: re-open the saved file in a fresh Blender and read it back.
      ctx.progress('Checking the saved file', 0.7);
      const check = await this.script(ctx, 'scene.inspect', { input }, { background: true });
      const details = (check.summary.details ?? []) as Array<{ name: string }>;
      const name = String(params.new_name ?? params.name ?? '');
      if (cmd.id === 'object.delete' ? details.some((d) => d.name === name) : cmd.id === 'object.add' && params.name ? !details.some((d) => d.name === name) : false) {
        throw new AdapterError('verification-failed', `${cmd.id} did not change the saved file as expected (${name}).`);
      }
      return {
        message: `${cmd.label} done in ${path.basename(input)}; it now has ${String(check.summary.count)} object(s).`,
        outputs: [], data: { objects: check.summary.objects, details: check.summary.details, scene: check.summary.scene, blender: summary.blender }, verified: true,
        evidence: ['re-opened in a fresh Blender and read back'],
      };
    }
    if (cmd.id === 'discover.search') {
      const kind = String(params.kind ?? 'all').toLowerCase(), query = String(params.query ?? ''), name = String(params.name ?? '');
      const wantOps = kind === 'operators' || name.includes('.') || (kind === 'all' && query.trim() !== '');
      // Read only and independent of any project: always a short background run, never the user's open window.
      const { summary } = await this.script(ctx, cmd.id, { vocab: BATCH_VOCAB, want_ops: wantOps, ops_query: query, op_name: name }, { background: true });
      const data = assembleDiscovery({ kind, query, name, limit: Number(params.limit ?? 12) }, summary as DiscoveryFacts);
      return { message: `Found ${String(data.total)} matching item(s) in Blender ${String(data.blender)}.`, outputs: [], data, verified: true, evidence: [`read from the running Blender ${String(data.blender)}`] };
    }
    if (cmd.id === 'scene.inspect_detail') {
      const ids = String(params.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length > MAX_BATCH_OBJECTS || ids.some((i) => !BATCH_ID.test(i))) throw new AdapterError('invalid-params', `ids must be at most ${MAX_BATCH_OBJECTS} comma-separated cc_ids.`);
      const batch = String(params.batch_id ?? '').trim();
      if (batch && !BATCH_ID.test(batch)) throw new AdapterError('invalid-params', 'batch_id is not a valid batch id.');
      // Asked about a batch in a project file that does not exist: scene.build only ever changes an EXISTING file, so nothing of the
      // batch can have been saved. That is a real, checkable answer (absent), not an error - recovery needs it to get unstuck.
      const wanted = path.join(ctx.workDir, safeName(String(params.file_name), '.blend'));
      if (batch && !(await fs.stat(wanted).then((st) => st.isFile(), () => false))) {
        const data = { blender: this.version, count: 0, objects: {}, project: { file: path.basename(wanted), project_id: null, exists: false }, object_count: 0, truncated: false, cc_ids: [], cc_ids_truncated: false, details: [], ledger: { ok: true, error: null, entries: [], entries_total: 0 }, batch: { batch_id: batch, chunk: Number(params.chunk ?? 0), state: 'absent', ledger_hash: null, ids_present: [], ids_missing: ids }, source: 'saved-file', read_at: new Date().toISOString() };
        return { message: `${path.basename(wanted)} does not exist in the Blender folder, so batch ${batch} cannot have been saved to it.`, outputs: [], data, verified: true, evidence: ['the project file does not exist in the Blender folder (scene.build only changes existing files)'] };
      }
      const input = await existing(String(params.file_name));
      const { summary } = await this.script(ctx, cmd.id, { input, ids, batch_id: batch || null, chunk: params.chunk ?? 0, max_objects: params.max_objects ?? 60 }, { background: true });
      // Identity of the saved file by content, and the latest script run record: what recovery of a script.run compares.
      const sha = fileHashOf(await fs.readFile(input));
      const marker = await readMarker(ctx.workDir);
      const project: { file?: unknown; [k: string]: unknown } = { ...(summary.project as Record<string, unknown>), file_sha256: sha };
      const scriptHash = String(params.script_hash ?? '').trim();
      const script = /^[0-9a-f]{64}$/.test(scriptHash) ? { script_hash: scriptHash, ...assessScriptRun(marker, sha, project, { file: String(params.file_name), script_hash: scriptHash }) } : undefined;
      Object.assign(summary, { project, script_marker: marker, ...(script ? { script } : {}) });
      const n = Array.isArray(summary.cc_ids) ? summary.cc_ids.length : 0;
      // Always the SAVED file read by a process that has never seen the edit: that is what makes this a fresh read-back.
      return { message: `${path.basename(input)} has ${String(summary.count)} object(s), ${n} with a cc_id.`, outputs: [], data: { ...summary, source: 'saved-file', read_at: new Date().toISOString() }, verified: true, evidence: ['read from the saved file by a fresh Blender process'] };
    }
    if (cmd.id === 'scene.build') {
      const input = await existing(String(params.file_name));
      const canonical = String(params.spec);
      const spec = JSON.parse(canonical) as BuildSpec;
      const problem = validateBuildSpec(spec);
      if (problem) throw new AdapterError('invalid-params', `Invalid parameter "spec": ${problem}`);
      const hash = specHashOf(canonical);
      const c = chunkOf(spec);
      ctx.progress('Building the scene', 0.2);
      const { summary } = await this.script(ctx, cmd.id, { input, spec, spec_hash: hash, vocab: BATCH_VOCAB, fault: process.env.CREATECRAFT_BATCH_FAULT ?? null });
      // Verification: a fresh Blender reads the saved file; the requested content and the batch ledger are judged separately.
      ctx.progress('Checking the saved file', 0.7);
      const ids = spec.objects.map((o) => o.id);
      const check = await this.script(ctx, 'scene.inspect_detail', { input, ids, batch_id: spec.batch_id, chunk: c.index, max_objects: MAX_BATCH_OBJECTS }, { background: true });
      const expected = expectedBatchFromParams({ file_name: String(params.file_name), spec: canonical });
      const verdict = expected ? assessBatchReadback({ data: check.summary }, expected) : undefined;
      if (!verdict || verdict.outcome !== 'applied') {
        throw new AdapterError('verification-failed', `The saved file does not show batch ${spec.batch_id} (chunk ${c.index + 1} of ${c.total}) as built: ${verdict ? `${verdict.outcome} - ${verdict.reason}` : 'the expectation could not be derived'}.`);
      }
      const replay = summary.status === 'already_applied';
      return {
        message: replay
          ? `Batch ${spec.batch_id} (chunk ${c.index + 1} of ${c.total}) was already applied with this exact content; nothing was changed.`
          : `Built ${ids.length} object(s) in ${path.basename(input)} (batch ${spec.batch_id}, chunk ${c.index + 1} of ${c.total}); read back from the saved file.`,
        outputs: [],
        data: { status: summary.status, batch_id: spec.batch_id, chunk: c.index, total: c.total, spec_hash: hash, created: summary.created, updated: summary.updated, names: summary.names, project_id: summary.project_id, ledger_complete: verdict.ledgerComplete, content_matches: verdict.contentMatches, object_count: check.summary.count },
        verified: true,
        evidence: [`re-read from the saved file by a fresh Blender: ledger records ${spec.batch_id}#${c.index}; ${ids.length} object(s) present with the requested content`],
      };
    }
    if (cmd.id === 'script.run') return this.runScript(ctx, String(params.file_name), String(params.script), await existing(String(params.file_name)));
    if (cmd.id === 'scene.render_animation') {
      const input = await existing(String(params.file_name));
      const output = path.join(ctx.workDir, safeName(String(params.file_name), '.mp4'));
      ctx.progress('Rendering the animation', 0.2);
      await this.script(ctx, cmd.id, { input, output, width: params.width, height: params.height, engine: params.engine, frame_start: params.frame_start, frame_end: params.frame_end });
      const made = (await fs.readdir(ctx.workDir)).filter((f) => /\.mp4$/i.test(f) && f.startsWith(path.basename(output, '.mp4')));
      const file = made.find((f) => f === path.basename(output)) ?? made[0];
      if (!file) throw new AdapterError('verification-failed', 'Blender finished but no MP4 was written.');
      const out = path.join(ctx.workDir, file);
      return { message: `Rendered ${file} (${params.width}x${params.height}).`, outputs: [out], verified: true, evidence: [`${(await fs.stat(out)).size} bytes written`] };
    }
    if (cmd.id === 'scene.open_window') {
      const input = await existing(String(params.file_name));
      if (this.live?.alive) {
        await this.script(ctx, 'scene.inspect', { input });
      } else {
        const child = spawn(this.app.exePath, [input], { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
      }
      return { message: `Opened ${path.basename(input)} in the Blender window. Stop now; when the user says they are done, run scene.inspect to see their changes (it reads the open window, so unsaved hand edits count).`, outputs: [] };
    }
    throw new AdapterError('unsupported', `Blender cannot run "${cmd.id}".`);
  }

  /**
   * script.run: the user's code runs in a background Blender on a COPY; only a script that ran and produced a file that opens
   * replaces the project, after a backup, with a run marker that lets recovery prove later whether the swap happened.
   */
  private async runScript(ctx: ExecuteContext, fileName: string, scriptText: string, input: string): Promise<AdapterOutcome> {
    const spec = JSON.parse(scriptText) as ScriptSpec;
    const problem = validateScript(spec);
    if (problem) throw new AdapterError('invalid-params', `Invalid parameter "script": ${problem}`);
    const hash = scriptHashOf(spec.code);
    const dir = path.dirname(input);
    const stem = path.basename(input, '.blend');
    const fault = process.env.CREATECRAFT_BATCH_FAULT; // test seam: can only abort, at the two points that matter for recovery
    // The open window may hold hand edits: write them to the project so the script starts from what the user sees.
    if (this.live?.alive) { ctx.progress('Saving the open Blender window', 0.05); await this.script(ctx, 'script.window_save', { input }); }
    const before = fileHashOf(await fs.readFile(input));
    await writeMarker(ctx.workDir, { file: path.basename(input), script_hash: hash, state: 'started', before_sha256: before, at: new Date().toISOString() });
    const copy = path.join(dir, `.cc-script-${stem}-${Math.random().toString(36).slice(2, 8)}.tmp.blend`);
    let summary: Record<string, unknown>;
    let log = '';
    let backup = '';
    try {
      await fs.copyFile(input, copy);
      ctx.progress('Running the script on a copy of the project', 0.2);
      const run = await this.script(ctx, 'script.run', { input: copy, code: spec.code, rules: SCRIPT_RULES }, { background: true });
      summary = run.summary;
      log = run.r.out.split(/\r?\n/).filter((l) => l && !l.startsWith('CREATECRAFT_RESULT')).slice(-12).join('\n').slice(-1500);
      ctx.progress('Checking the result', 0.6);
      const bytes = await fs.readFile(copy);
      const head = bytes.subarray(0, 12);
      const magic = head.subarray(0, 7).toString('latin1') === 'BLENDER' || (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) || (head[0] === 0x1f && head[1] === 0x8b);
      if (bytes.length < 1024 || !magic) throw new AdapterError('verification-failed', 'The script finished but its result is not a Blender file; the project was not changed.');
      await this.script(ctx, 'scene.inspect', { input: copy }, { background: true }); // the result must open in a fresh Blender
      const after = fileHashOf(bytes);
      if (fault === 'script_before_swap') throw new AdapterError('app-error', 'injected fault before the swap');
      await writeMarker(ctx.workDir, { file: path.basename(input), script_hash: hash, state: 'swapping', before_sha256: before, after_sha256: after, at: new Date().toISOString() });
      // keep what was there: a backup folder (last ten per project) and Blender's own previous-version file
      const bdir = path.join(dir, '.cc-backups');
      await fs.mkdir(bdir, { recursive: true });
      backup = `${stem}.${new Date().toISOString().replace(/[:.]/g, '-')}.blend`;
      await fs.copyFile(input, path.join(bdir, backup));
      const olds = (await fs.readdir(bdir)).filter((f) => f.startsWith(`${stem}.`) && f.endsWith('.blend')).sort();
      for (const f of olds.slice(0, Math.max(0, olds.length - BACKUPS_KEPT))) await fs.rm(path.join(bdir, f), { force: true });
      await fs.copyFile(input, input + '1').catch(() => undefined);
      await fs.rename(copy, input);
      if (fault === 'script_after_swap') throw new AdapterError('app-error', 'injected fault after the swap');
    } finally { await fs.rm(copy, { force: true }); }
    if (this.live?.alive) { ctx.progress('Reloading the open Blender window', 0.85); await this.script(ctx, 'script.window_reload', { input }); }
    const check = await this.script(ctx, 'scene.inspect', { input }, { background: true });
    return {
      message: `Ran the script "${spec.purpose}" in ${path.basename(input)}; the project now has ${String(check.summary.count)} object(s). The script succeeded; whether it did what was meant must still be read back (scene.inspect_detail).`,
      outputs: [],
      data: { status: 'applied', script_hash: hash, purpose: spec.purpose, result: summary.result ?? null, objects: check.summary.count, armatures: summary.armatures, meshes: summary.meshes, log, backup: path.join('.cc-backups', backup), file: fileName },
      verified: true,
      evidence: ['ran on a copy, the result opened in a fresh Blender, then replaced the project (backup kept)'],
    };
  }

  async dispose(): Promise<void> { await this.releaseLive(); this.app = null; }
}

export const blenderFactory: AdapterFactory = {
  manifest: BLENDER_MANIFEST,
  create: () => new BlenderAdapter(),
  validateJson: (commandId, param, value) => commandId === 'scene.build' && param === 'spec' ? validateBuildSpec(value)
    : commandId === 'script.run' && param === 'script' ? validateScript(value)
    : `${commandId}.${param} is not a structured parameter.`,
};

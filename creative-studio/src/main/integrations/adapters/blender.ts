// Blender adapter (Blender 3.6 and newer; developed and verified against Blender 4.0).
// Control method: scripting. Blender runs in the background (`--background --factory-startup --python`),
// so no window is opened and a crash cannot touch CreateCraft. The scripts are fixed templates;
// parameters travel in a JSON file and are never spliced into code. Version differences are handled
// inside the templates (only API calls that are stable across 3.6 to 4.x are used).

import fs from 'node:fs/promises';
import path from 'node:path';
import { ADAPTER_SDK_VERSION, type AdapterManifest, type CommandSpec, type DiscoveredApp } from '@shared/integrations';
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
    description: 'Opens a .blend file from the Blender folder of this project (read only) and lists its objects.',
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
    },
    permissions: ['launch', 'open-files', 'write-files', 'execute-scripts'], idempotent: true, timeoutMs: 300_000,
  },
];

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
  'scene.inspect': `${PRELUDE}
bpy.ops.wm.open_mainfile(filepath=_p['input'])
_result(_summary())
`,
  'scene.render_still': `${PRELUDE}
bpy.ops.wm.open_mainfile(filepath=_p['input'])
sc = bpy.context.scene
if sc.camera is None:
    raise SystemExit('The scene has no active camera.')
sc.render.engine = 'BLENDER_WORKBENCH'
sc.render.resolution_x = int(_p['width'])
sc.render.resolution_y = int(_p['height'])
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = 'PNG'
sc.render.filepath = _p['output']
bpy.ops.render.render(write_still=True)
_result(_summary())
`,
};

export function runBlender(exe: string, args: string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<RunResult> {
  return runProcess(exe, args, { signal, timeoutMs, label: 'Blender' });
}

const safeName = safeFileName;

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
  async connect(app: DiscoveredApp): Promise<void> { this.app = app; }
  async disconnect(): Promise<void> { this.app = null; }
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

  private async script(ctx: ExecuteContext, commandId: string, params: Record<string, unknown>): Promise<{ summary: Record<string, unknown>; r: RunResult }> {
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
      const check = await this.script(ctx, 'scene.inspect', { input: output });
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
      await this.script(ctx, cmd.id, { input, output, width: params.width, height: params.height });
      return { message: `Rendered ${path.basename(output)} (${params.width}x${params.height}).`, outputs: [output] };
    }
    throw new AdapterError('unsupported', `Blender cannot run "${cmd.id}".`);
  }

  async dispose(): Promise<void> { this.app = null; }
}

export const blenderFactory: AdapterFactory = { manifest: BLENDER_MANIFEST, create: () => new BlenderAdapter() };

// A Blender window that stays open, so the user can watch Claude work in it (docked into CreateCraft) and
// edit by hand. Blender has no remote-control port, so the window starts with one fixed script
// (LISTENER below) that checks a private folder for command files. CreateCraft only ever writes the
// SAME fixed command scripts the background mode uses, with the parameters in a JSON file; nothing else
// is run. Every edit is saved to the .blend file in place, so the file on disk is always current.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Called by the host (ipc.ts) so the new window can be docked into CreateCraft. */
export interface BlenderLiveHooks { onSpawn?: (pid: number) => void; onExit?: () => void }
let hooks: BlenderLiveHooks | null = null;
export function setBlenderLiveHooks(h: BlenderLiveHooks | null): void { hooks = h; }
export const blenderLiveEnabled = (): boolean => hooks !== null;

const LISTENER = `import bpy, json, os, sys, traceback, math
_dir = sys.argv[sys.argv.index('--') + 1]
_ns = {'bpy': bpy, 'json': json, 'sys': sys, 'math': math, 'os': os}
exec(open(os.path.join(_dir, 'prelude.py')).read(), _ns)
def _live_open(path):
    cur = os.path.normcase(os.path.abspath(bpy.data.filepath)) if bpy.data.filepath else ''
    if cur != os.path.normcase(os.path.abspath(path)):
        bpy.ops.wm.open_mainfile(filepath=path)
try:
    bpy.context.preferences.view.render_display_type = 'NONE'
except Exception:
    pass
def _object_mode():
    try:
        o = bpy.context.object
        if o is not None and o.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
    except Exception:
        pass
def _snapshot():
    sc = bpy.context.scene
    r = sc.render
    return (r.engine, r.resolution_x, r.resolution_y, r.resolution_percentage, r.filepath, r.image_settings.file_format, sc.frame_start, sc.frame_end)
def _restore(s):
    sc = bpy.context.scene
    r = sc.render
    try:
        r.engine, r.resolution_x, r.resolution_y, r.resolution_percentage, r.filepath, r.image_settings.file_format, sc.frame_start, sc.frame_end = s
    except Exception:
        pass
def _ctx():
    wm = bpy.context.window_manager
    if not wm.windows:
        return {}
    win = wm.windows[0]
    kw = {'window': win, 'screen': win.screen, 'scene': win.scene, 'view_layer': win.view_layer}
    for a in win.screen.areas:
        if a.type == 'VIEW_3D':
            kw['area'] = a
            for r in a.regions:
                if r.type == 'WINDOW':
                    kw['region'] = r
            break
    return kw
def _write(name, data):
    tmp = os.path.join(_dir, name + '.tmp')
    with open(tmp, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, os.path.join(_dir, name))
_registered = [True]
def _tick():
    if os.path.exists(os.path.join(_dir, 'detach.flag')):
        return None
    try:
        names = sorted(f for f in os.listdir(_dir) if f.startswith('cmd-') and f.endswith('.json'))
        if names:
            path = os.path.join(_dir, names[0])
            job = json.load(open(path))
            os.remove(path)
            res = {'id': job['id'], 'ok': True}
            out = []
            snap = _snapshot() if job.get('restore') else None
            try:
                _ns['_p'] = job['params']
                _ns['_result'] = lambda d: out.append(d)
                if job.get('open'):
                    _live_open(job['open'])
                with bpy.context.temp_override(**_ctx()):
                    _object_mode()
                    exec(job['script'], _ns)
                res['result'] = out[-1] if out else {}
            except SystemExit as e:
                res['ok'] = False
                res['error'] = str(e.code)
            except Exception:
                res['ok'] = False
                res['error'] = traceback.format_exc().strip().splitlines()[-1]
            finally:
                if snap is not None:
                    _restore(snap)
            _write('res-' + str(job['id']) + '.json', res)
    except Exception:
        pass
    return 0.15
bpy.app.timers.register(_tick, first_interval=0.5, persistent=True)
_write('ready.json', {'blender': bpy.app.version_string})
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LiveBlenderSession {
  private proc: ChildProcess | null = null;
  private seq = 0;
  private exited = false;

  constructor(private readonly exe: string, private readonly dir: string, preludePy: string) {
    this.prelude = preludePy;
  }
  private readonly prelude: string;

  get alive(): boolean { return !!this.proc && !this.exited; }
  get pid(): number | null { return this.alive ? this.proc!.pid ?? null : null; }

  async start(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    for (const f of await fs.readdir(this.dir).catch(() => [] as string[])) await fs.rm(path.join(this.dir, f), { force: true });
    await fs.writeFile(path.join(this.dir, 'prelude.py'), this.prelude);
    const listener = path.join(this.dir, 'listener.py');
    await fs.writeFile(listener, LISTENER);
    const proc = spawn(this.exe, ['--factory-startup', '--python', listener, '--', this.dir], { stdio: 'ignore', windowsHide: false });
    this.proc = proc;
    proc.on('exit', () => { if (this.proc === proc) { this.exited = true; hooks?.onExit?.(); } });
    proc.on('error', () => { this.exited = true; });
    if (proc.pid) hooks?.onSpawn?.(proc.pid);
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      if (this.exited) throw new Error('Blender closed while starting.');
      if (await fs.stat(path.join(this.dir, 'ready.json')).then(() => true, () => false)) return;
      await sleep(200);
    }
    this.kill();
    throw new Error('Blender did not become ready in time.');
  }

  /** Runs one fixed command script in the open window; resolves with the script's result dictionary. */
  async run(script: string, params: Record<string, unknown>, opts: { timeoutMs: number; signal?: AbortSignal; restore?: boolean; open?: string }): Promise<Record<string, unknown>> {
    if (!this.alive) throw new Error('The Blender window is not open.');
    const id = ++this.seq;
    await fs.writeFile(path.join(this.dir, `cmd-${String(id).padStart(6, '0')}.json.tmp`), JSON.stringify({ id, script, params, restore: !!opts.restore, open: opts.open ?? null }));
    await fs.rename(path.join(this.dir, `cmd-${String(id).padStart(6, '0')}.json.tmp`), path.join(this.dir, `cmd-${String(id).padStart(6, '0')}.json`));
    const resFile = path.join(this.dir, `res-${id}.json`);
    const end = Date.now() + opts.timeoutMs;
    while (Date.now() < end) {
      if (opts.signal?.aborted) throw new Error('Cancelled.');
      if (this.exited) throw new Error('The Blender window was closed.');
      const txt = await fs.readFile(resFile, 'utf8').catch(() => null);
      if (txt) {
        await fs.rm(resFile, { force: true });
        const res = JSON.parse(txt) as { ok: boolean; error?: string; result?: Record<string, unknown> };
        if (!res.ok) throw new Error(res.error || 'Blender reported an error.');
        return res.result ?? {};
      }
      await sleep(120);
    }
    throw new Error('Blender did not answer in time.');
  }

  /** Stops polling and leaves the window open for the user (CreateCraft is closing or disconnecting). */
  async detach(): Promise<void> {
    await fs.writeFile(path.join(this.dir, 'detach.flag'), '1').catch(() => undefined);
    this.proc = null;
  }

  kill(): void { try { this.proc?.kill(); } catch { /* already gone */ } this.proc = null; }
}

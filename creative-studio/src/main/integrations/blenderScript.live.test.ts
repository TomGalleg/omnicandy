// REAL Blender on disposable files (CS_LIVE_TESTS=1): script.run (rigging as the example), the copy-first workflow, backups,
// the restricted-Python guard inside Blender, crashes around the swap, and recovery by file hash.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CommandResult, Permission } from '@shared/integrations';
import { createIntegrationManager } from './index';
import { setBlenderLiveHooks } from './adapters/blenderLive';
import { assessScriptReadback, expectedScriptFromParams, scriptHashOf } from './adapters/blenderScriptSpec';

const on = process.env.CS_LIVE_TESTS === '1';

const RIG = [
  'import bpy',
  "arm = bpy.data.armatures.new('Rig')",
  "obj = bpy.data.objects.new('RigObject', arm)",
  'bpy.context.scene.collection.objects.link(obj)',
  'bpy.context.view_layer.objects.active = obj',
  "bpy.ops.object.mode_set(mode='EDIT')",
  "root = arm.edit_bones.new('root'); root.head = (0, 0, 0); root.tail = (0, 0, 1)",
  "spine = arm.edit_bones.new('spine'); spine.head = (0, 0, 1); spine.tail = (0, 0, 2); spine.parent = root",
  "bpy.ops.object.mode_set(mode='OBJECT')",
  "result = {'bones': sorted(b.name for b in arm.bones)}",
].join('\n');
const script = (code: string, purpose = 'add a two bone rig') => ({ purpose, code });

describe.skipIf(!on)('Blender script.run (real Blender)', { timeout: 300_000 }, () => {
  let tmp: string;
  let granted: Record<string, Permission[]> = {};
  const approvals: Array<{ id: string; destructive: boolean; params: Record<string, unknown> }> = [];
  let deny = false;
  let m: ReturnType<typeof createIntegrationManager>;
  let key = '';
  let dir = '';
  const sha = async (f: string) => createHash('sha256').update(await fs.readFile(path.join(dir, f))).digest('hex');
  const data = (r: CommandResult) => r.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const run = (file: string, s: unknown) => m.execute(key, 'script.run', { file_name: file, script: s });
  const detail = async (file: string, hash?: string) => { const r = await m.execute(key, 'scene.inspect_detail', { file_name: file, ...(hash ? { script_hash: hash } : {}) }); expect(r.error, r.error?.message).toBeUndefined(); return r; };
  const fresh = async (file: string) => { const r = await m.execute(key, 'scene.create_basic', { file_name: file }); expect(r.error, r.error?.message).toBeUndefined(); };
  const leftovers = async () => (await fs.readdir(dir)).filter((f) => f.startsWith('.cc-script-') && f.endsWith('.tmp.blend'));

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-script-'));
    m = createIntegrationManager({
      workDir: async (id) => path.join(tmp, id),
      permissions: { load: async () => granted, save: async (g) => { granted = g; } },
      approve: async (r) => { approvals.push({ id: r.command.id, destructive: r.destructive, params: r.params }); return deny ? 'deny' : 'always'; },
    });
    const b = (await m.scan()).apps.find((a) => a.adapterId === 'blender');
    expect(b, 'Blender not found on this PC').toBeTruthy();
    key = b!.key;
    await m.connect(key);
    dir = path.join(tmp, 'blender');
  });
  afterAll(async () => { delete process.env.CREATECRAFT_BATCH_FAULT; await m.shutdown(); await fs.rm(tmp, { recursive: true, force: true }); });
  afterEach(() => { delete process.env.CREATECRAFT_BATCH_FAULT; deny = false; });

  it('builds a rig from a script: runs on a copy, keeps a backup, replaces the project, and the result is proven by file hash', async () => {
    await fresh('s1.blend');
    const before = await sha('s1.blend');
    const r = await run('s1.blend', script(RIG));
    expect(r.error, r.error?.message).toBeUndefined();
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(data(r)).toMatchObject({ status: 'applied', result: { bones: ['root', 'spine'] }, armatures: 1 });
    expect(await sha('s1.blend')).not.toBe(before);
    expect(await leftovers()).toEqual([]);
    const backups = await fs.readdir(path.join(dir, '.cc-backups'));
    expect(backups.length).toBe(1);
    expect(await fs.readFile(path.join(dir, '.cc-backups', backups[0]!)).then((b) => createHash('sha256').update(b).digest('hex'))).toBe(before); // the backup IS the old project
    expect(await fs.stat(path.join(dir, 's1.blend1')).then(() => true, () => false)).toBe(true);
    // the editable .blend now holds a real armature, readable by the typed commands
    const d = data(await detail('s1.blend', scriptHashOf(RIG)));
    expect(d.details.find((o: { name: string }) => o.name === 'RigObject')).toMatchObject({ type: 'ARMATURE' });
    expect(d.script).toMatchObject({ outcome: 'applied', releasesLock: true });
    expect(d.script_marker).toMatchObject({ state: 'swapping', script_hash: scriptHashOf(RIG) });
    // and it composes with the typed workflow afterwards
    expect((await m.execute(key, 'scene.build', { file_name: 's1.blend', spec: { batch_id: 'after-rig', objects: [{ id: 'mesh-a', kind: 'box' }] } })).error).toBeUndefined();
  });

  it('asks the user every time with the destructive flag and the code, never remembers the answer, and a refusal runs nothing', async () => {
    await fresh('s2.blend');
    const n = approvals.length;
    expect((await run('s2.blend', script("result = {'n': 1}"))).error).toBeUndefined();
    expect(approvals.slice(n)).toEqual([expect.objectContaining({ id: 'script.run', destructive: true })]);
    expect(JSON.stringify(approvals.at(-1)!.params)).toContain("result = {'n': 1}");
    expect(granted[Object.keys(granted)[0]!]).not.toContain('script.run'); // grants are per permission; destructive commands never become "always"
    const before = await sha('s2.blend');
    deny = true;
    const refused = await run('s2.blend', script(RIG));
    expect(refused.error?.kind).toBe('permission-denied');
    expect(await sha('s2.blend')).toBe(before);
    expect(await fs.stat(path.join(dir, '.cc-backups')).then((s) => s.isDirectory(), () => false)).toBe(true); // only the earlier successful run made one
  });

  it('a script that fails leaves the project byte for byte unchanged, reports the error, and recovery reads it as absent', async () => {
    await fresh('s3.blend');
    const before = await sha('s3.blend');
    const code = "import bpy\nbpy.data.objects.new('half', None)\nraise RuntimeError('boom')";
    const r = await run('s3.blend', script(code));
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/script_error: RuntimeError: boom/);
    expect(r.error?.message).toMatch(/project was not changed/);
    expect(await sha('s3.blend')).toBe(before);
    expect(await leftovers()).toEqual([]);
    const d = data(await detail('s3.blend', scriptHashOf(code)));
    expect(d.details.some((o: { name: string }) => o.name === 'half')).toBe(false);
    expect(d.script).toMatchObject({ outcome: 'absent', releasesLock: true });
  });

  it('refuses restricted code inside Blender even when it slips past the pre-approval screen, and before the user is asked when it does not', async () => {
    await fresh('s4.blend');
    const before = await sha('s4.blend');
    const n = approvals.length;
    // pre-approval screen
    const early = await run('s4.blend', script('import os\nos.listdir(".")'));
    expect(early.error?.kind).toBe('invalid-params');
    expect(approvals.length).toBe(n);
    // slips past the regex screen (second module of one import line, a nested import statement) but not the AST walk in Blender
    for (const code of ['import json, os', 'x = 1\nif x:\n    import subprocess', 'from bpy import app\nimport socket as s']) {
      const r = await run('s4.blend', script(code));
      expect(r.ok, code).toBe(false);
      expect(r.error?.message, code).toMatch(/script_refused|only these modules/);
    }
    const syntax = await run('s4.blend', script('def broken(:'));
    expect(syntax.error?.message).toMatch(/script_syntax/);
    expect(await sha('s4.blend')).toBe(before);
    // ordinary allowed work still runs, and `result` comes back
    const fine = await run('s4.blend', script("import math\nfrom mathutils import Vector\nresult = {'len': Vector((3, 4, 0)).length, 'pi': round(math.pi, 3)}"));
    expect(fine.error, fine.error?.message).toBeUndefined();
    expect(data(fine).result).toEqual({ len: 5, pi: 3.142 });
  });

  it('a crash before the swap leaves the old project and the run provably absent; after the swap provably applied; a later change is ambiguous', async () => {
    await fresh('s5.blend');
    const code = RIG;
    const hash = scriptHashOf(code);
    const exp = expectedScriptFromParams({ file_name: 's5.blend', script: script(code) })!;
    const before = await sha('s5.blend');
    process.env.CREATECRAFT_BATCH_FAULT = 'script_before_swap';
    const lostBefore = await run('s5.blend', script(code));
    delete process.env.CREATECRAFT_BATCH_FAULT;
    expect(lostBefore.ok).toBe(false);
    expect(await sha('s5.blend')).toBe(before);
    expect(await leftovers()).toEqual([]);
    const rb1 = await detail('s5.blend', hash);
    expect(assessScriptReadback({ ok: true, data: rb1.data }, exp)).toMatchObject({ outcome: 'absent', releasesLock: true });
    // ... so the very same script may run again
    process.env.CREATECRAFT_BATCH_FAULT = 'script_after_swap';
    const lostAfter = await run('s5.blend', script(code));
    delete process.env.CREATECRAFT_BATCH_FAULT;
    expect(lostAfter.ok).toBe(false);
    expect(await sha('s5.blend')).not.toBe(before);
    const rb2 = await detail('s5.blend', hash);
    expect(assessScriptReadback({ ok: true, data: rb2.data }, exp)).toMatchObject({ outcome: 'applied', releasesLock: true });
    expect(data(rb2).details.find((o: { name: string }) => o.name === 'RigObject')).toMatchObject({ type: 'ARMATURE' });
    // someone edits the project after the run: the record can no longer vouch for it
    expect((await m.execute(key, 'object.transform', { file_name: 's5.blend', name: 'Cube', x: 9 })).error).toBeUndefined();
    expect(assessScriptReadback({ ok: true, data: (await detail('s5.blend', hash)).data }, exp)).toMatchObject({ outcome: 'ambiguous', releasesLock: false });
    expect(assessScriptReadback({ ok: true, data: (await detail('s5.blend', hash)).data }, { ...exp, script_hash: 'e'.repeat(64) })).toMatchObject({ outcome: 'ambiguous' });
  });

  it('keeps ten backups at most and never touches other projects', async () => {
    await fresh('s6.blend');
    await fresh('s6-other.blend');
    const other = await sha('s6-other.blend');
    for (let i = 0; i < 12; i++) expect((await run('s6.blend', script(`result = {'i': ${i}}\nimport bpy\nbpy.data.objects.new('o${i}', None)`))).error).toBeUndefined();
    const mine = (await fs.readdir(path.join(dir, '.cc-backups'))).filter((f) => f.startsWith('s6.'));
    expect(mine.length).toBe(10);
    expect(await sha('s6-other.blend')).toBe(other);
  });

  it('works with the always-open window: hand edits are saved first, the window picks up the result, and it stays open for hand editing', async () => {
    const pids: number[] = [];
    setBlenderLiveHooks({ onSpawn: (pid) => pids.push(pid) });
    try {
      await fresh('s7.blend');
      expect(pids.length).toBe(1);
      expect((await m.execute(key, 'object.transform', { file_name: 's7.blend', name: 'Cube', x: 4 })).error).toBeUndefined(); // stands in for a hand edit made in the window
      const r = await run('s7.blend', script(RIG));
      expect(r.error, r.error?.message).toBeUndefined();
      expect(pids.length).toBe(1); // the same window
      const win = await m.execute(key, 'scene.inspect', { file_name: 's7.blend' }); // reads the OPEN window
      const names = (win.data as { details: Array<{ name: string; location: number[] }> }).details;
      expect(names.map((o) => o.name)).toContain('RigObject');
      expect(names.find((o) => o.name === 'Cube')!.location[0]).toBe(4); // the earlier edit survived the swap and reload
      expect((await m.execute(key, 'object.transform', { file_name: 's7.blend', name: 'Cube', z: 2 })).error).toBeUndefined(); // the window keeps working
      expect((await m.execute(key, 'scene.open_window', { file_name: 's7.blend' })).error).toBeUndefined();
    } finally {
      setBlenderLiveHooks(null);
      await m.disconnect(key);
      await m.connect(key);
      for (const pid of pids) { try { process.kill(pid); } catch { /* already closed */ } }
    }
  });
});

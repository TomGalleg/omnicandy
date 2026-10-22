// REAL Blender (background mode) on disposable files. Runs only with CS_LIVE_TESTS=1 and an installed Blender.
// Covers discover.search, scene.build (idempotency, conflicts, duplicate names, chunks, atomic save, crashes at every
// point of the save) and scene.inspect_detail, and feeds the real read-backs to the same recovery assessment the agent uses.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CommandResult, Permission } from '@shared/integrations';
import { createIntegrationManager } from './index';
import { setBlenderLiveHooks } from './adapters/blenderLive';
import { assessBatchReadback, expectedBatchFromParams } from './adapters/blenderBatchSpec';

const on = process.env.CS_LIVE_TESTS === '1';

const castle = (batch = 'castle', over: Record<string, unknown> = {}) => ({
  batch_id: batch,
  objects: [
    { id: 'tower-a', kind: 'cylinder', loc: [4, 4, 0], origin: 'base', shape: { radius: 1.2, depth: 6, segments: 24 }, material: { name: 'stone', color: '#8a8d91', roughness: 0.9 }, collection: 'Castle', modifiers: [{ type: 'bevel', props: { width: 0.05, segments: 2 } }] },
    { id: 'roof-a', kind: 'cone', parent_id: 'tower-a', loc: [0, 0, 6], origin: 'base', shape: { radius: 1.5, depth: 2 }, material: { name: 'tile', color: '#9b2d20' }, collection: 'Castle' },
    { id: 'wall-n', kind: 'box', loc: [0, 4, 1.5], shape: { size: [8, 0.6, 3] }, material: { name: 'stone' }, collection: 'Castle' },
    { id: 'keep', kind: 'box', name: 'Cube', loc: [0, 0, 2], shape: { size: [3, 3, 4] }, material: { name: 'keep-stone', color: '#777777' } },
  ],
  ...over,
});

describe.skipIf(!on)('Blender batch modeling (real Blender)', { timeout: 300_000 }, () => {
  let tmp: string;
  let granted: Record<string, Permission[]> = {};
  const asked: string[] = [];
  let m: ReturnType<typeof createIntegrationManager>;
  let key = '';
  let exe = '';
  let dir = '';
  const sha = async (f: string) => createHash('sha256').update(await fs.readFile(path.join(dir, f))).digest('hex');
  const build = (file: string, spec: unknown) => m.execute(key, 'scene.build', { file_name: file, spec });
  const detail = async (file: string, extra: Record<string, unknown> = {}) => {
    const r = await m.execute(key, 'scene.inspect_detail', { file_name: file, ...extra });
    expect(r.error, r.error?.message).toBeUndefined();
    return r;
  };
  const fresh = async (file: string) => {
    const r = await m.execute(key, 'scene.create_basic', { file_name: file });
    expect(r.error, r.error?.message).toBeUndefined();
  };
  const data = (r: CommandResult) => r.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const doc = (r: CommandResult) => ({ ok: true, data: r.data });
  const expectation = (file: string, spec: unknown) => expectedBatchFromParams({ file_name: file, spec })!;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-batch-'));
    m = createIntegrationManager({
      workDir: async (id) => path.join(tmp, id),
      permissions: { load: async () => granted, save: async (g) => { granted = g; } },
      approve: async (r) => { asked.push(r.command.id); return 'always'; },
    });
    const scan = await m.scan();
    const b = scan.apps.find((a) => a.adapterId === 'blender');
    expect(b, 'Blender not found on this PC').toBeTruthy();
    key = b!.key;
    exe = b!.exePath;
    await m.connect(key);
    dir = path.join(tmp, 'blender');
  });
  afterAll(async () => { delete process.env.CREATECRAFT_BATCH_FAULT; await m.shutdown(); await fs.rm(tmp, { recursive: true, force: true }); });
  afterEach(() => { delete process.env.CREATECRAFT_BATCH_FAULT; });

  it('discovers the runtime vocabulary, schemas on demand, and marks bpy.ops as informational', async () => {
    const mods = await m.execute(key, 'discover.search', { kind: 'modifiers', query: 'bevel' });
    expect(mods.error, mods.error?.message).toBeUndefined();
    expect(data(mods).items).toEqual([expect.objectContaining({ name: 'bevel', kind: 'modifier', executable: true })]);
    const schema = await m.execute(key, 'discover.search', { name: 'bevel' });
    const props = (data(schema).schema.props as Array<{ key: string; type: string; min?: number }>);
    expect(props.map((p) => p.key)).toEqual(expect.arrayContaining(['width', 'segments', 'limit_method']));
    expect(props.find((p) => p.key === 'segments')).toMatchObject({ type: 'int', min: 1 });
    const ops = await m.execute(key, 'discover.search', { kind: 'operators', query: 'primitive_cube' });
    expect(data(ops).items).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'mesh.primitive_cube_add', kind: 'operator', executable: false })]));
    const op = await m.execute(key, 'discover.search', { name: 'mesh.primitive_cube_add' });
    expect(data(op).schema).toMatchObject({ executable: false, id: 'mesh.primitive_cube_add' });
    const spec = await m.execute(key, 'discover.search', { name: 'spec' });
    expect(data(spec).schema.example.batch_id).toBeTruthy();
    expect(JSON.stringify(data(mods)).length).toBeLessThan(1500); // compact enough for small models
  });

  it('builds a multi-object scene, reads it back in a fresh process, and keeps duplicate Blender names apart by cc_id', async () => {
    await fresh('b1.blend');
    const spec = castle();
    const r = await build('b1.blend', spec);
    expect(r.error, r.error?.message).toBeUndefined();
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(data(r)).toMatchObject({ status: 'applied', ledger_complete: true, content_matches: true });
    expect(data(r).names['keep']).toBe('Cube.001'); // the basic scene already owns "Cube"
    const d = data(await detail('b1.blend', { ids: 'tower-a,roof-a,wall-n,keep', batch_id: 'castle' }));
    expect(d.project).toMatchObject({ file: 'b1.blend' });
    expect(d.project.project_id).toMatch(/^[a-f0-9]{32}$/);
    expect(d.cc_ids).toEqual(['keep', 'roof-a', 'tower-a', 'wall-n']);
    expect(d.batch).toMatchObject({ state: 'recorded', ids_missing: [] });
    const by = Object.fromEntries((d.details as Array<Record<string, any>>).map((o) => [o.id ?? o.name, o])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(by['tower-a']).toMatchObject({ type: 'MESH', location: [4, 4, 0], collections: ['Castle'], modifiers: [{ type: 'BEVEL' }] });
    expect(by['tower-a'].bbox_min[2]).toBeCloseTo(0, 3); // origin: base
    expect(by['tower-a'].bbox_max[2]).toBeCloseTo(6, 3);
    expect(by['tower-a'].size[0]).toBeCloseTo(2.4, 1);
    expect(by['tower-a'].verts).toBeGreaterThan(40);
    expect(by['roof-a']).toMatchObject({ parent_id: 'tower-a', parent: 'tower-a' });
    expect(by['roof-a'].bbox_max[2]).toBeCloseTo(8, 3); // local [0,0,6] under a parent at z=0, cone 2 tall from its base
    expect(by['roof-a'].materials[0].color[0]).toBeCloseTo(0x9b / 255, 2);
    expect(by['keep'].name).toBe('Cube.001');
    expect(by['wall-n'].size).toEqual([8, 0.6, 3]);
    expect(d.ledger.entries).toEqual([expect.objectContaining({ batch: 'castle', chunk: 0, total: 1, n: 4 })]);
    expect(assessBatchReadback(doc(await detail('b1.blend', { ids: 'tower-a,roof-a,wall-n,keep', batch_id: 'castle' })), expectation('b1.blend', spec)).outcome).toBe('applied');
    // The project is still a normal editable .blend: the existing commands work on built objects.
    const t = await m.execute(key, 'object.transform', { file_name: 'b1.blend', name: 'tower-a', z: 1 });
    expect(t.error, t.error?.message).toBeUndefined();
    const back = data(await detail('b1.blend', { ids: 'tower-a' }));
    expect(back.details[0]).toMatchObject({ id: 'tower-a', location: [4, 4, 1] });
    expect(await fs.stat(path.join(dir, 'b1.blend1')).then(() => true, () => false)).toBe(true); // the previous version is kept
  });

  it('makes a repeated identical batch a no-op and refuses the same batch id with different content', async () => {
    await fresh('b2.blend');
    expect((await build('b2.blend', castle())).error).toBeUndefined();
    const before = await sha('b2.blend');
    const again = await build('b2.blend', castle());
    expect(again.error, again.error?.message).toBeUndefined();
    expect(data(again)).toMatchObject({ status: 'already_applied', created: [] });
    expect(await sha('b2.blend')).toBe(before); // nothing was written
    const changed = castle();
    (changed.objects[0] as Record<string, unknown>).loc = [9, 9, 0];
    const conflict = await build('b2.blend', changed);
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.message).toMatch(/batch_conflict/);
    expect(await sha('b2.blend')).toBe(before);
    expect(data(await detail('b2.blend', { ids: 'tower-a' })).details[0].location).toEqual([4, 4, 0]);
  });

  it('refuses unknown references, properties and foreign ids before changing anything', async () => {
    await fresh('b3.blend');
    const before = await sha('b3.blend');
    const cases: Array<[unknown, RegExp]> = [
      [{ batch_id: 'x1', objects: [{ id: 'a', kind: 'box', parent_id: 'ghost' }] }, /parent_id ghost/],
      [{ batch_id: 'x2', objects: [{ id: 'a', kind: 'box', modifiers: [{ type: 'bevel', props: { nonsense: 1 } }] }] }, /no property nonsense/],
      [{ batch_id: 'x3', objects: [{ id: 'a', kind: 'box', modifiers: [{ type: 'bevel', props: { segments: 9999 } }] }] }, /at most/],
      [{ batch_id: 'x4', objects: [{ id: 'a', kind: 'box', modifiers: [{ type: 'bevel', props: { limit_method: 'NOPE' } }] }] }, /must be one of/],
      [{ batch_id: 'x5', objects: [{ id: 'a', kind: 'box', modifiers: [{ type: 'boolean', props: { object_id: 'ghost' } }] }] }, /unknown id ghost/],
      [{ batch_id: 'x6', scene: { camera_id: 'a' }, objects: [{ id: 'a', kind: 'box' }] }, /not a camera/],
    ];
    for (const [spec, re] of cases) {
      const r = await build('b3.blend', spec);
      expect(r.ok, JSON.stringify(spec)).toBe(false);
      expect(r.error?.message).toMatch(re);
    }
    // Rejected by the schema before dispatch (nothing reaches Blender, nothing is approved).
    const askedBefore = asked.length;
    for (const spec of [{ batch_id: 'y1', objects: [{ id: 'a', kind: 'box', exec: 'import os' }] }, { batch_id: 'y2', objects: [{ id: 'a', kind: 'bpy.ops.wm.quit_blender' }] }, { batch_id: 'y3', objects: [] }, '{not json', { batch_id: 'Bad Id', objects: [{ id: 'a', kind: 'box' }] }]) {
      const r = await build('b3.blend', spec);
      expect(r.error?.kind).toBe('invalid-params');
    }
    expect(asked.length).toBe(askedBefore);
    expect(await sha('b3.blend')).toBe(before);
    // An id made by another batch is not silently taken over.
    expect((await build('b3.blend', { batch_id: 'own1', objects: [{ id: 'shared', kind: 'box' }] })).error).toBeUndefined();
    const steal = await build('b3.blend', { batch_id: 'own2', objects: [{ id: 'shared', kind: 'box' }] });
    expect(steal.error?.message).toMatch(/already belongs to batch own1/);
  });

  it('builds large scenes in chunks that can refer to earlier chunks', async () => {
    await fresh('b4.blend');
    const c0 = { batch_id: 'big', chunk: { index: 0, total: 2 }, objects: [{ id: 'base', kind: 'box', loc: [0, 0, 0] }] };
    const c1 = { batch_id: 'big', chunk: { index: 1, total: 2 }, objects: [{ id: 'top', kind: 'uv_sphere', parent_id: 'base', loc: [0, 0, 2], modifiers: [{ type: 'subsurf', props: { levels: 1 } }] }] };
    expect((await build('b4.blend', c0)).error).toBeUndefined();
    expect((await build('b4.blend', c1)).error).toBeUndefined();
    const d = data(await detail('b4.blend', { ids: 'base,top', batch_id: 'big', chunk: 1 }));
    expect(d.ledger.entries.map((e: { chunk: number }) => e.chunk)).toEqual([0, 1]);
    expect(d.details.find((o: { id: string }) => o.id === 'top')).toMatchObject({ parent_id: 'base' });
    const wrongTotal = await build('b4.blend', { batch_id: 'big', chunk: { index: 2, total: 5 }, objects: [{ id: 'extra', kind: 'box' }] });
    expect(wrongTotal.error?.message).toMatch(/batch_conflict/);
    const redeclare = await build('b4.blend', { batch_id: 'big', chunk: { index: 1, total: 2 }, objects: [{ id: 'top', kind: 'box' }] });
    expect(redeclare.error?.message).toMatch(/batch_conflict/);
  });

  it('refuses a batch written for another project identity', async () => {
    await fresh('b5.blend');
    expect((await build('b5.blend', { batch_id: 'p1', objects: [{ id: 'a', kind: 'box' }] })).error).toBeUndefined();
    const pid = data(await detail('b5.blend')).project.project_id as string;
    const before = await sha('b5.blend');
    const wrong = await build('b5.blend', { batch_id: 'p2', project_id: 'deadbeefdeadbeef', objects: [{ id: 'b', kind: 'box' }] });
    expect(wrong.error?.message).toMatch(/project_identity/);
    expect(await sha('b5.blend')).toBe(before);
    expect((await build('b5.blend', { batch_id: 'p3', project_id: pid, objects: [{ id: 'c', kind: 'box' }] })).error).toBeUndefined();
  });

  it('a crash before the save leaves the project untouched and the batch provably absent, so the same batch can be retried', async () => {
    await fresh('b6.blend');
    const before = await sha('b6.blend');
    const spec = castle('crash1');
    process.env.CREATECRAFT_BATCH_FAULT = 'before_save';
    const r = await build('b6.blend', spec);
    delete process.env.CREATECRAFT_BATCH_FAULT;
    expect(r.ok).toBe(false);
    expect(await sha('b6.blend')).toBe(before);
    const rb = await detail('b6.blend', { ids: 'tower-a,roof-a,wall-n,keep', batch_id: 'crash1' });
    expect(data(rb).batch).toMatchObject({ state: 'absent' });
    const verdict = assessBatchReadback(doc(rb), expectation('b6.blend', spec));
    expect(verdict).toMatchObject({ outcome: 'absent', releasesLock: true });
    const retry = await build('b6.blend', spec);
    expect(retry.error, retry.error?.message).toBeUndefined();
    expect(assessBatchReadback(doc(await detail('b6.blend', { ids: 'tower-a,roof-a,wall-n,keep', batch_id: 'crash1' })), expectation('b6.blend', spec)).outcome).toBe('applied');
  });

  it('a crash with the temporary copy written but not yet swapped in leaves the old project, and the leftover is cleaned up', async () => {
    await fresh('b7.blend');
    const before = await sha('b7.blend');
    process.env.CREATECRAFT_BATCH_FAULT = 'tmp_written';
    const r = await build('b7.blend', castle('crash2'));
    delete process.env.CREATECRAFT_BATCH_FAULT;
    expect(r.ok).toBe(false);
    expect(await sha('b7.blend')).toBe(before);
    expect((await fs.readdir(dir)).some((f) => f.startsWith('.cc-b7-') && f.endsWith('.tmp.blend'))).toBe(true);
    expect(data(await detail('b7.blend', { ids: 'tower-a', batch_id: 'crash2' })).batch.state).toBe('absent');
    expect((await build('b7.blend', castle('crash2'))).error).toBeUndefined();
    expect((await fs.readdir(dir)).some((f) => f.startsWith('.cc-b7-'))).toBe(false);
  });

  it('a crash right after the swap leaves the batch fully present and recorded: applied, never replayed', async () => {
    await fresh('b8.blend');
    const spec = castle('crash3');
    process.env.CREATECRAFT_BATCH_FAULT = 'after_save';
    const r = await build('b8.blend', spec);
    delete process.env.CREATECRAFT_BATCH_FAULT;
    expect(r.ok).toBe(false); // the response was lost
    const rb = await detail('b8.blend', { ids: 'tower-a,roof-a,wall-n,keep', batch_id: 'crash3' });
    expect(data(rb).batch.state).toBe('recorded');
    expect(assessBatchReadback(doc(rb), expectation('b8.blend', spec))).toMatchObject({ outcome: 'applied', ledgerComplete: true, contentMatches: true });
    const replay = await build('b8.blend', spec); // even a blind replay changes nothing
    expect(data(replay).status).toBe('already_applied');
    expect(data(await detail('b8.blend')).object_count).toBe(3 + 4);
  });

  it('judges a damaged ledger, a different hash, wrong content and a wrong project as ambiguous, and objects without a ledger entry as partial', async () => {
    await fresh('b9.blend');
    const spec = castle('amb');
    expect((await build('b9.blend', spec)).error).toBeUndefined();
    const ids = 'tower-a,roof-a,wall-n,keep';
    const good = await detail('b9.blend', { ids, batch_id: 'amb' });
    // wrong project identity
    const other = { ...doc(good), data: { ...data(good), project: { ...data(good).project, file: 'someone-else.blend' } } };
    expect(assessBatchReadback(other, expectation('b9.blend', spec))).toMatchObject({ outcome: 'ambiguous', releasesLock: false });
    expect(assessBatchReadback(doc(good), { ...expectation('b9.blend', spec), project_id: 'aaaaaaaa' })).toMatchObject({ outcome: 'ambiguous' });
    // a different spec hash under the same batch id
    expect(assessBatchReadback(doc(good), { ...expectation('b9.blend', spec), spec_hash: '0'.repeat(64) })).toMatchObject({ outcome: 'ambiguous' });
    // requested content that no longer matches (someone moved the tower by hand)
    await m.execute(key, 'object.transform', { file_name: 'b9.blend', name: 'tower-a', x: 40 });
    expect(assessBatchReadback(doc(await detail('b9.blend', { ids, batch_id: 'amb' })), expectation('b9.blend', spec))).toMatchObject({ outcome: 'ambiguous', ledgerComplete: true, contentMatches: false });
    // damaged ledger: the build refuses, the read-back says so, recovery stays locked
    const script = path.join(tmp, 'corrupt.py');
    await fs.writeFile(script, "import bpy, sys\nbpy.ops.wm.open_mainfile(filepath=sys.argv[-1])\nbpy.context.scene['cc_ledger'] = '{broken'\nbpy.ops.wm.save_mainfile()\n");
    await new Promise<void>((res, rej) => { const p = spawn(exe, ['--background', '--factory-startup', '--python', script, '--', path.join(dir, 'b9.blend')], { stdio: 'ignore' }); p.on('exit', (c) => c === 0 ? res() : rej(new Error(`exit ${c}`))); });
    const damaged = await detail('b9.blend', { ids, batch_id: 'amb' });
    expect(data(damaged).ledger.ok).toBe(false);
    expect(data(damaged).batch.state).toBe('corrupt');
    expect(assessBatchReadback(doc(damaged), expectation('b9.blend', spec))).toMatchObject({ outcome: 'ambiguous', releasesLock: false });
    const before = await sha('b9.blend');
    const refused = await build('b9.blend', castle('amb2'));
    expect(refused.error?.message).toMatch(/ledger_corrupt/);
    expect(await sha('b9.blend')).toBe(before);
    // objects without any ledger entry (ledger removed): partial, and an explicit rebuild repairs by cc_id instead of duplicating
    const script2 = path.join(tmp, 'drop.py');
    await fs.writeFile(script2, "import bpy, sys\nbpy.ops.wm.open_mainfile(filepath=sys.argv[-1])\ndel bpy.context.scene['cc_ledger']\nbpy.ops.wm.save_mainfile()\n");
    await new Promise<void>((res, rej) => { const p = spawn(exe, ['--background', '--factory-startup', '--python', script2, '--', path.join(dir, 'b9.blend')], { stdio: 'ignore' }); p.on('exit', (c) => c === 0 ? res() : rej(new Error(`exit ${c}`))); });
    const noLedger = await detail('b9.blend', { ids, batch_id: 'amb' });
    expect(assessBatchReadback(doc(noLedger), expectation('b9.blend', spec))).toMatchObject({ outcome: 'partial', releasesLock: false });
    const countBefore = data(noLedger).object_count;
    const repaired = await build('b9.blend', spec);
    expect(repaired.error, repaired.error?.message).toBeUndefined();
    expect(data(repaired).updated.sort()).toEqual(['keep', 'roof-a', 'tower-a', 'wall-n']);
    expect(data(await detail('b9.blend')).object_count).toBe(countBefore); // upsert by cc_id: no duplicates
  });

  it('builds in the always-open Blender window, keeps it open for hand editing, and the saved file stays editable', async () => {
    const pids: number[] = [];
    setBlenderLiveHooks({ onSpawn: (pid) => pids.push(pid) });
    try {
      await fresh('b11.blend');
      expect(pids.length).toBe(1);
      const spec = castle('live1');
      const r = await build('b11.blend', spec);
      expect(r.error, r.error?.message).toBeUndefined();
      expect(pids.length).toBe(1); // the same window did the work
      expect(data(r)).toMatchObject({ status: 'applied', ledger_complete: true, content_matches: true });
      // the window shows the built objects (scene.inspect reads the open window) ...
      const win = await m.execute(key, 'scene.inspect', { file_name: 'b11.blend' });
      expect((win.data as { details: Array<{ name: string }> }).details.map((o) => o.name)).toEqual(expect.arrayContaining(['tower-a', 'roof-a', 'wall-n', 'Cube.001']));
      // ... a hand edit style change in the window is kept by the next build (it saves what the window holds) ...
      expect((await m.execute(key, 'object.transform', { file_name: 'b11.blend', name: 'wall-n', y: 7 })).error).toBeUndefined();
      expect((await build('b11.blend', { batch_id: 'live2', objects: [{ id: 'extra', kind: 'ico_sphere', loc: [1, 1, 1] }] })).error).toBeUndefined();
      const saved = data(await detail('b11.blend', { ids: 'wall-n,extra' }));
      expect(saved.details.find((o: { id: string }) => o.id === 'wall-n').location[1]).toBe(7);
      expect(saved.cc_ids).toEqual(expect.arrayContaining(['extra', 'wall-n']));
      // ... a failed build in the window rolls the open scene back and the window keeps working
      const bad = await build('b11.blend', { batch_id: 'live3', objects: [{ id: 'oops', kind: 'box', parent_id: 'ghost' }] });
      expect(bad.ok).toBe(false);
      const after = await m.execute(key, 'scene.inspect', { file_name: 'b11.blend' });
      expect((after.data as { details: Array<{ name: string }> }).details.some((o) => o.name === 'oops')).toBe(false);
      // an error after everything was built (or while saving) undoes it all in the open scene and leaves the file alone
      const fileBefore = await sha('b11.blend');
      for (const fault of ['raise_before_save', 'raise_tmp_written']) {
        process.env.CREATECRAFT_BATCH_FAULT = fault;
        const mid = await build('b11.blend', { batch_id: 'live4', objects: [{ id: 'good-box', kind: 'box', material: { name: 'rb-mat', color: '#112233' }, collection: 'RollbackOnly' }, { id: 'sphere-x', kind: 'uv_sphere', modifiers: [{ type: 'subsurf', props: { levels: 2 } }] }] });
        delete process.env.CREATECRAFT_BATCH_FAULT;
        expect(mid.ok).toBe(false);
        expect(mid.error?.message).toMatch(/apply_failed/);
        const win2 = ((await m.execute(key, 'scene.inspect', { file_name: 'b11.blend' })).data as { details: Array<{ name: string }> }).details.map((o) => o.name);
        expect(win2).not.toContain('good-box');
        expect(win2).not.toContain('sphere-x');
        expect(await sha('b11.blend')).toBe(fileBefore);
        expect(data(await detail('b11.blend', { ids: 'good-box', batch_id: 'live4' })).batch.state).toBe('absent');
      }
      // and the very same batch then goes through (nothing was left behind in the window: no ledger entry, no stray collection)
      expect((await build('b11.blend', { batch_id: 'live4', objects: [{ id: 'good-box', kind: 'box', material: { name: 'rb-mat', color: '#112233' }, collection: 'RollbackOnly' }] })).error).toBeUndefined();
      expect((await m.execute(key, 'scene.open_window', { file_name: 'b11.blend' })).error).toBeUndefined();
      expect(pids.length).toBe(1);
    } finally {
      setBlenderLiveHooks(null);
      await m.disconnect(key); // leaves the window to the user: detach, not kill
      await m.connect(key);
      for (const pid of pids) { try { process.kill(pid); } catch { /* already closed */ } }
    }
  });

  it('refuses the commands for a project that is missing or not in the Blender folder, and the manager enforces approval', async () => {
    expect((await build('nope.blend', castle())).error?.kind).toBe('invalid-params');
    expect((await m.execute(key, 'scene.inspect_detail', { file_name: 'nope.blend' })).error?.kind).toBe('invalid-params');
    const denying = createIntegrationManager({ workDir: async (id) => path.join(tmp, id), permissions: { load: async () => ({}), save: async () => undefined }, approve: async () => 'deny' });
    const k = (await denying.scan()).apps.find((a) => a.adapterId === 'blender')!.key;
    await fresh('b10.blend');
    const before = await sha('b10.blend');
    const r = await denying.execute(k, 'scene.build', { file_name: 'b10.blend', spec: castle('denied') });
    expect(r.error?.kind).toBe('permission-denied');
    expect(await sha('b10.blend')).toBe(before);
    await denying.shutdown();
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeJsonParam } from '@shared/jsonParam';
import { EditIntentJournal, expectedEditIntent, MAX_JOURNAL_BYTES } from '../../agentHarness/editIntentJournal';
import type { CheckpointCrypto } from '../../agentHarness/taskCheckpoint';
import { assembleDiscovery, BATCH_COMMANDS, BATCH_SCRIPTS, BATCH_VOCAB, SPEC_GRAMMAR, type DiscoveryFacts } from './blenderBatch';
import {
  MAX_BATCH_OBJECTS, assessBatchReadback, buildSpecSchema, chunkOf, expectedBatchFromParams, specHashOf, validateBuildSpec, type ExpectedBatch,
} from './blenderBatchSpec';

const ok = (spec: unknown) => expect(validateBuildSpec(spec), JSON.stringify(spec)).toBeUndefined();
const bad = (spec: unknown, re: RegExp) => expect(validateBuildSpec(spec), JSON.stringify(spec)).toMatch(re);
const obj = (over: Record<string, unknown> = {}) => ({ id: 'a', kind: 'box', ...over });
const spec = (objects: unknown[], over: Record<string, unknown> = {}) => ({ batch_id: 'b1', objects, ...over });

describe('scene.build spec schema', () => {
  it('accepts the documented example and every supported primitive, light, camera and modifier', () => {
    ok(SPEC_GRAMMAR.example);
    ok(spec([
      obj({ id: 'box', shape: { size: [1, 2, 3] } }), obj({ id: 'sph', kind: 'uv_sphere', shape: { radius: 1, segments: 16, rings: 8 } }),
      obj({ id: 'ico', kind: 'ico_sphere', shape: { subdivisions: 2 } }), obj({ id: 'cyl', kind: 'cylinder', shape: { radius: 1, depth: 2, segments: 12 } }),
      obj({ id: 'con', kind: 'cone', shape: { radius: 1, radius2: 0.2, depth: 2 } }), obj({ id: 'pln', kind: 'plane', shape: { size: 4 } }),
      obj({ id: 'cir', kind: 'circle', shape: { radius: 1 } }), obj({ id: 'mky', kind: 'monkey', shape: { size: 2 } }),
      { id: 'emp', kind: 'empty' }, { id: 'lgt', kind: 'light', light: { type: 'sun', energy: 3, color: '#ffffff' } }, { id: 'cam', kind: 'camera', camera: { lens: 35 } },
      obj({ id: 'mods', modifiers: [{ type: 'subsurf', props: { levels: 2 } }, { type: 'array', props: { count: 3, relative_offset_displace: [1, 0, 0], offset_object_id: 'emp' } }] }),
    ], { chunk: { index: 1, total: 3 }, scene: { camera_id: 'cam' }, project_id: 'abcdef0123456789' }));
  });
  it('rejects unknown operations, properties and any attempt to smuggle code', () => {
    bad(spec([obj({ exec: 'import os' })]), /exec/);
    bad(spec([obj({ kind: 'bpy.ops.wm.quit_blender' })]), /kind/);
    bad(spec([obj()], { python: 'x' }), /python|unrecognized/i);
    bad(spec([obj({ modifiers: [{ type: 'hook' }] })]), /type/);
    bad(spec([obj({ modifiers: [{ type: 'bevel', props: { 'Not-A-Key': 1 } }] })]), /props/);
    bad(spec([obj({ modifiers: [{ type: 'bevel', props: { width: 'import os; os.system("x")' } }] })]), /enum names/);
    bad(spec([obj({ material: { color: 'red' } })]), /#rrggbb/);
    bad(spec([obj({ material: { colour: '#ffffff' } })]), /material|unrecognized/i);
  });
  it('rejects wrong shapes, ranges and references', () => {
    bad(spec([obj({ shape: { radius: 1 } })]), /does not apply to box/);
    bad(spec([obj({ kind: 'cylinder', shape: { size: 2 } })]), /does not apply to cylinder/);
    bad(spec([obj({ shape: { size: -1 } })]), /shape/);
    bad(spec([obj({ kind: 'cylinder', shape: { segments: 2 } })]), /shape/);
    bad(spec([obj({ loc: [1, 2] })]), /loc/);
    bad(spec([obj({ loc: [1, 2, Number.POSITIVE_INFINITY] })]), /loc/);
    bad(spec([{ id: 'l', kind: 'light' }]), /light needs/);
    bad(spec([obj({ light: { type: 'sun' } })]), /only applies to kind "light"/);
    bad(spec([{ id: 'e', kind: 'empty', material: { color: '#ffffff' } }]), /only mesh objects/);
    bad(spec([{ id: 'e', kind: 'empty', modifiers: [{ type: 'subsurf' }] }]), /only mesh objects/);
    bad(spec([]), /objects/);
    bad(spec(Array.from({ length: MAX_BATCH_OBJECTS + 1 }, (_, i) => obj({ id: `o${i}` }))), /objects/);
    bad(spec([obj(), obj()]), /duplicate object id "a"/);
    bad(spec([obj({ parent_id: 'a' })]), /own parent/);
    bad(spec([obj({ id: 'a', parent_id: 'b' }), obj({ id: 'b', parent_id: 'a' })]), /parent cycle/);
    bad(spec([obj({ id: 'a', modifiers: [{ type: 'boolean', props: { object_id: 'a' } }] })]), /itself/);
    bad(spec([obj({ id: 'a', modifiers: [{ type: 'boolean', props: { object_id: 5 } }] })]), /props|id of another object/);
    bad(spec([obj()], { chunk: { index: 2, total: 2 } }), /chunk.index must be below/);
    bad(spec([obj({ id: 'Upper' })]), /id/);
    bad(spec([obj()], { batch_id: 'has space' }), /batch_id/);
    bad(spec([obj()], { project_id: 'x' }), /project_id/);
  });
  it('is the single source for the vocabulary the fixed Python receives', () => {
    expect(Object.keys(BATCH_VOCAB.mesh).sort()).toEqual(['box', 'circle', 'cone', 'cylinder', 'ico_sphere', 'monkey', 'plane', 'uv_sphere']);
    expect(Object.keys(BATCH_VOCAB.modifiers).length).toBeGreaterThanOrEqual(10);
    expect(BATCH_COMMANDS.map((c) => c.id).sort()).toEqual(['discover.search', 'scene.build', 'scene.inspect_detail']);
    expect(buildSpecSchema).toBeTruthy();
  });
  it('ships fixed templates: the spec never reaches code, and nothing evaluates a string', () => {
    for (const [id, body] of Object.entries(BATCH_SCRIPTS)) {
      expect(body, id).not.toMatch(/\beval\(|\bexec\(|__import__|subprocess|os\.system|compile\(/);
      expect(body, id).not.toMatch(/\$\{/); // no interpolation of parameters into the script text
    }
    expect(BATCH_SCRIPTS['scene.build']).not.toMatch(/bpy\.ops\.(?!wm\.(open_mainfile|save_as_mainfile))/); // only opening and saving use operators
  });
});

describe('spec hashing and journal expectations', () => {
  const canon = (v: unknown) => { const r = normalizeJsonParam(v, 'spec'); if (!r.ok) throw new Error(r.error); return r.text; };
  it('hashes the canonical content: key order is irrelevant, any change is not', () => {
    const a = canon({ batch_id: 'b', objects: [{ id: 'a', kind: 'box', loc: [1, 2, 3] }] });
    const b = canon({ objects: [{ loc: [1, 2, 3], kind: 'box', id: 'a' }], batch_id: 'b' });
    expect(specHashOf(a)).toBe(specHashOf(b));
    expect(specHashOf(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(specHashOf(a)).not.toBe(specHashOf(canon({ batch_id: 'b', objects: [{ id: 'a', kind: 'box', loc: [1, 2, 4] }] })));
    expect(chunkOf({})).toEqual({ index: 0, total: 1 });
  });
  it('derives the journal expectation from the model\'s own arguments only, before dispatch', () => {
    const s = spec([obj({ id: 'a', loc: [1, 2, 3], material: { color: '#AABBCC' } }), obj({ id: 'b' })], { chunk: { index: 1, total: 2 } });
    const e = expectedBatchFromParams({ file_name: 'castle.blend', spec: s })!;
    expect(e).toMatchObject({ kind: 'blender.scene.batch', file: 'castle.blend', batch_id: 'b1', chunk: 1, total: 2, ids: ['a', 'b'], objects: [{ i: 0, loc: [1, 2, 3], color: '#aabbcc' }] });
    expect(e.spec_hash).toBe(specHashOf(canon(s)));
    expect(expectedBatchFromParams({ file_name: 'castle.blend', spec: JSON.stringify(s) })).toEqual(e); // text or object: same record
    expect(expectedEditIntent('external_command', { app_key: 'k', command: 'scene.build', params: { file_name: 'castle.blend', spec: s } })).toEqual(e);
    expect(expectedBatchFromParams({ file_name: 'a.blend', spec: { batch_id: 'b', objects: [] } })).toBeUndefined();
    expect(expectedBatchFromParams({ spec: s })).toBeUndefined();
    expect(expectedBatchFromParams({ file_name: 'a.blend', spec: '{nope' })).toBeUndefined();
  });
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }))); });
  const crypto: CheckpointCrypto = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString('utf8') };
  it('records the largest allowed batch with the longest goal in the encrypted journal and reads it back', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-batch-journal-'));
    roots.push(root);
    const objects = Array.from({ length: MAX_BATCH_OBJECTS }, (_, i) => obj({ id: `${'x'.repeat(40)}-${String(i).padStart(7, '0')}`, loc: [i + 0.123456, -i - 0.654321, 100000.5], material: { color: '#abcdef' } }));
    const params = { file_name: 'f'.repeat(190) + '.blend', spec: spec(objects, { chunk: { index: 63, total: 64 } }) };
    const j = new EditIntentJournal(root, crypto);
    const intent = await j.begin('g'.repeat(4000), 'external_command', 'scene.build', { app_key: 'k', command: 'scene.build', params });
    expect(intent.expected?.kind).toBe('blender.scene.batch');
    const size = (await fs.stat(path.join(root, '.omnicandy-edit-intent.enc'))).size;
    expect(size).toBeLessThan(MAX_JOURNAL_BYTES);
    expect((await j.load())?.expected).toEqual(intent.expected);
    await expect(j.begin('again', 'external_command', 'scene.build', { app_key: 'k', command: 'scene.build', params })).rejects.toThrow(/unresolved/); // never replaced
    expect(await j.load()).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
const HASH = 'a'.repeat(64);
const IDS = ['a', 'b', 'c'];
const expected = (over: Partial<ExpectedBatch> = {}): ExpectedBatch => ({
  kind: 'blender.scene.batch', file: 'castle.blend', batch_id: 'b1', chunk: 0, total: 1, spec_hash: HASH, ids: IDS,
  objects: [{ i: 0, loc: [1, 2, 3], color: '#ff0000' }, { i: 2, loc: [0, 0, 0] }], ...over,
});
const detail = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, type: 'MESH', location: [0, 0, 0], materials: [{ name: 'm', color: [0.5, 0.5, 0.5] }], ...over });
const good = () => [detail('a', { location: [1, 2, 3], materials: [{ name: 'm', color: [1, 0, 0] }] }), detail('b'), detail('c')];
function readback(o: { file?: string; project_id?: string | null; ledger?: unknown; ids?: string[]; truncated?: boolean; details?: unknown[]; hash?: string; chunk?: number; entry?: boolean } = {}) {
  const entries = o.entry === false ? [] : [{ batch: 'b1', chunk: o.chunk ?? 0, total: 1, hash: o.hash ?? HASH, n: 3 }];
  return { ok: true, data: {
    project: { file: o.file ?? 'castle.blend', project_id: o.project_id === undefined ? 'pid0123456789' : o.project_id },
    cc_ids: o.ids ?? IDS, cc_ids_truncated: o.truncated ?? false, details: o.details ?? good(),
    ledger: o.ledger ?? { ok: true, entries },
  } };
}

describe('what a fresh read-back proves about a batch', () => {
  it('applied: the ledger records the exact spec AND every requested object has the requested content', () => {
    expect(assessBatchReadback(readback(), expected())).toMatchObject({ outcome: 'applied', ledgerComplete: true, contentMatches: true, releasesLock: true });
    expect(assessBatchReadback(readback(), expected({ file: 'castle', project_id: 'pid0123456789' })).outcome).toBe('applied'); // file stem, pinned identity
  });
  it('absent: nothing of the batch exists, in the right project, with a complete id list', () => {
    const r = assessBatchReadback(readback({ entry: false, ids: ['other'], details: [] }), expected());
    expect(r).toMatchObject({ outcome: 'absent', releasesLock: true, ledgerComplete: false });
    expect(assessBatchReadback(readback({ chunk: 1, ids: [], details: [] }), expected()).outcome).toBe('absent'); // another chunk's entry is not this chunk's
  });
  it('absent is never concluded from an incomplete id list', () => {
    expect(assessBatchReadback(readback({ entry: false, ids: [], truncated: true, details: [] }), expected())).toMatchObject({ outcome: 'ambiguous', releasesLock: false });
  });
  it('partial: some or all objects exist without a ledger entry (no automatic retry, no release)', () => {
    expect(assessBatchReadback(readback({ entry: false, ids: ['a'], details: [detail('a')] }), expected())).toMatchObject({ outcome: 'partial', releasesLock: false });
    expect(assessBatchReadback(readback({ entry: false }), expected())).toMatchObject({ outcome: 'partial', releasesLock: false, contentMatches: true, ledgerComplete: false });
  });
  it('ambiguous: wrong or unidentifiable project, damaged ledger, other content under the same batch id', () => {
    const amb = (rb: unknown, e = expected()) => expect(assessBatchReadback(rb, e), JSON.stringify(rb).slice(0, 80)).toMatchObject({ outcome: 'ambiguous', releasesLock: false });
    amb(readback({ file: 'other.blend' }));
    amb(readback({ project_id: null }), expected({ project_id: 'pid0123456789' }));
    amb(readback({ project_id: 'someone-else' }), expected({ project_id: 'pid0123456789' }));
    amb({ ok: true, data: { ...readback().data, project: {} } });
    amb(readback({ ledger: { ok: false, error: 'the ledger is not valid JSON', entries: [] } }));
    amb(readback({ ledger: 'garbage' }));
    amb(readback({ hash: 'b'.repeat(64) }));
    amb({ ok: true });
    amb(null);
    amb({ ok: true, data: { ...readback().data, cc_ids: undefined } });
  });
  it('judges requested content separately from the ledger: ledger complete but content different is ambiguous', () => {
    const moved = [detail('a', { location: [1.5, 2, 3], materials: [{ name: 'm', color: [1, 0, 0] }] }), detail('b'), detail('c')];
    expect(assessBatchReadback(readback({ details: moved }), expected())).toMatchObject({ outcome: 'ambiguous', ledgerComplete: true, contentMatches: false });
    const recolored = [detail('a', { location: [1, 2, 3], materials: [{ name: 'm', color: [0, 1, 0] }] }), detail('b'), detail('c')];
    expect(assessBatchReadback(readback({ details: recolored }), expected())).toMatchObject({ outcome: 'ambiguous', contentMatches: false });
    expect(assessBatchReadback(readback({ details: [detail('b'), detail('c')] }), expected())).toMatchObject({ outcome: 'ambiguous', contentMatches: false }); // not listed: cannot be shown
    expect(assessBatchReadback(readback({ ids: ['a', 'b'], details: good().slice(0, 2) }), expected())).toMatchObject({ outcome: 'ambiguous', ledgerComplete: true }); // an object is gone
    const dup = [...good(), detail('a', { location: [1, 2, 3], materials: [{ name: 'm', color: [1, 0, 0] }] })];
    expect(assessBatchReadback(readback({ details: dup }), expected()).contentMatches).toBe(false); // two objects claiming one id
  });
  it('tolerates only the rounding the read-back itself applies', () => {
    const near = [detail('a', { location: [1.0004, 2, 3], materials: [{ name: 'm', color: [1, 0.001, 0] }] }), detail('b'), detail('c')];
    expect(assessBatchReadback(readback({ details: near }), expected()).outcome).toBe('applied');
    const far = [detail('a', { location: [1.01, 2, 3], materials: [{ name: 'm', color: [1, 0, 0] }] }), detail('b'), detail('c')];
    expect(assessBatchReadback(readback({ details: far }), expected()).outcome).toBe('ambiguous');
  });
});

describe('discover.search results', () => {
  const facts: DiscoveryFacts = {
    blender: '4.0.2', bmesh_ops: ['create_cube', 'create_cone', 'create_uvsphere', 'create_icosphere', 'create_grid', 'create_circle', 'create_monkey'],
    modifiers: { bevel: { available: true, props: [{ key: 'width', type: 'float', min: 0, max: 100 }] }, hook: { available: false, props: [] } },
    ops: ['mesh.primitive_cube_add'], ops_total: 1,
  };
  it('lists a small, relevant page and marks unavailable items and operators as not executable', () => {
    const r = assembleDiscovery({ kind: 'modifiers', query: 'bevel' }, facts) as { items: Array<{ name: string; executable: boolean }>; total: number };
    expect(r.items).toEqual([expect.objectContaining({ name: 'bevel', executable: true })]);
    const all = assembleDiscovery({}, facts) as { items: unknown[]; total: number; next?: string };
    expect(all.items.length).toBe(12);
    expect(all.total).toBeGreaterThan(12);
    expect(all.next).toMatch(/Narrow/);
    expect(JSON.stringify(all).length).toBeLessThan(3000);
    const ops = assembleDiscovery({ kind: 'operators' }, facts) as { items: Array<{ name: string; executable: boolean }> };
    expect(ops.items).toEqual([expect.objectContaining({ name: 'mesh.primitive_cube_add', executable: false })]);
    const noCube = assembleDiscovery({ kind: 'primitives', query: 'box' }, { ...facts, bmesh_ops: ['create_cone'] }) as { items: Array<{ executable: boolean }> };
    expect(noCube.items[0]!.executable).toBe(false); // this Blender lacks the bmesh operation
  });
  it('returns full schemas only on request', () => {
    expect((assembleDiscovery({ name: 'bevel' }, facts).schema as { props: unknown[] }).props).toHaveLength(1);
    expect(assembleDiscovery({ name: 'cone' }, facts).schema).toMatchObject({ shape: { radius2: expect.any(String) } });
    expect(assembleDiscovery({ name: 'spec' }, facts).schema).toBe(SPEC_GRAMMAR);
    expect(assembleDiscovery({ name: 'nothing-here' }, facts).schema).toMatchObject({ error: expect.stringMatching(/Nothing named/) });
    expect(assembleDiscovery({ name: 'mesh.primitive_cube_add' }, { ...facts, op: { id: 'mesh.primitive_cube_add', description: 'Construct a cube mesh', props: [] } }).schema).toMatchObject({ executable: false });
  });
});

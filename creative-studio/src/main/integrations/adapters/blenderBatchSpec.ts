// The strict scene specification behind Blender's scene.build, plus the pure logic that decides what a read-back of the
// saved project proves about one batch. Nothing here runs Blender and nothing here is a script: a spec is data that the
// fixed template in blenderBatch.ts interprets, and every field is checked here (shape, ranges, references between
// objects) and again against Blender's own runtime schema before a single object is changed.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { normalizeJsonParam } from '@shared/jsonParam';

export const BATCH_ID = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
export const MAX_BATCH_OBJECTS = 64;
export const MAX_CHUNKS = 64;
export const BUILD_SPEC_MAX_CHARS = 48_000;
export const BUILD_SPEC_MAX_DEPTH = 8;
/** Content facts recorded in the edit journal per batch (the journal file is small and holds no raw spec). */
export const MAX_JOURNAL_CONTENT = 16;

/** Mesh primitives made with bmesh.ops.create_* (no context, no selection, no mode); every kind is available on Blender 3.6 to 4.x. */
export const MESH_KINDS = {
  box: { keys: ['size'], summary: 'Rectangular box; size is one number or [x,y,z] metres.' },
  uv_sphere: { keys: ['radius', 'segments', 'rings'], summary: 'UV sphere.' },
  ico_sphere: { keys: ['radius', 'subdivisions'], summary: 'Icosphere (even triangles).' },
  cylinder: { keys: ['radius', 'depth', 'segments'], summary: 'Cylinder: towers, pillars, drums.' },
  cone: { keys: ['radius', 'radius2', 'depth', 'segments'], summary: 'Cone or truncated cone (radius2 = top radius, default 0): roofs, spikes.' },
  plane: { keys: ['size'], summary: 'Flat plane; size is one number or [x,y].' },
  circle: { keys: ['radius', 'segments'], summary: 'Filled circle (flat disc).' },
  monkey: { keys: ['size'], summary: 'Suzanne test mesh.' },
} as const;
export type MeshKind = keyof typeof MESH_KINDS;
export const OTHER_KINDS = ['empty', 'light', 'camera'] as const;
export const OBJECT_KINDS = [...(Object.keys(MESH_KINDS) as MeshKind[]), ...OTHER_KINDS] as unknown as [string, ...string[]];

/** Supported modifiers: spec name -> Blender type and RNA class used to validate every property against the running Blender. */
export const MODIFIERS: Record<string, { type: string; rna: string; summary: string }> = {
  subsurf: { type: 'SUBSURF', rna: 'SubsurfModifier', summary: 'Smooths the surface (levels, render_levels).' },
  bevel: { type: 'BEVEL', rna: 'BevelModifier', summary: 'Rounds edges (width, segments, limit_method).' },
  solidify: { type: 'SOLIDIFY', rna: 'SolidifyModifier', summary: 'Gives surfaces thickness (thickness, offset).' },
  mirror: { type: 'MIRROR', rna: 'MirrorModifier', summary: 'Mirrors across axes (use_axis, mirror_object_id).' },
  array: { type: 'ARRAY', rna: 'ArrayModifier', summary: 'Repeats the object (count, relative_offset_displace, offset_object_id).' },
  wireframe: { type: 'WIREFRAME', rna: 'WireframeModifier', summary: 'Turns edges into struts (thickness).' },
  decimate: { type: 'DECIMATE', rna: 'DecimateModifier', summary: 'Reduces the polygon count (ratio).' },
  triangulate: { type: 'TRIANGULATE', rna: 'TriangulateModifier', summary: 'Triangulates faces.' },
  boolean: { type: 'BOOLEAN', rna: 'BooleanModifier', summary: 'Cuts/joins with another object (operation, object_id).' },
  screw: { type: 'SCREW', rna: 'ScrewModifier', summary: 'Lathe/spiral (angle, steps, axis).' },
  edge_split: { type: 'EDGE_SPLIT', rna: 'EdgeSplitModifier', summary: 'Sharp edges (split_angle).' },
  simple_deform: { type: 'SIMPLE_DEFORM', rna: 'SimpleDeformModifier', summary: 'Twist, bend, taper, stretch.' },
};
/** A modifier property that names another spec object: `<key>_id` points at the Blender property it fills. */
export const POINTER_PROPS: Record<string, string> = { object_id: 'object', mirror_object_id: 'mirror_object', offset_object_id: 'offset_object' };

export const LIGHT_TYPES = ['point', 'sun', 'spot', 'area'] as const;

const num = z.number().finite().min(-1_000_000).max(1_000_000);
const pos = z.number().finite().positive().max(1_000_000);
const vec3 = z.tuple([num, num, num]);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be #rrggbb');
const unit = z.number().finite().min(0).max(1);
const idText = z.string().regex(BATCH_ID, 'must be 1-48 chars: a-z, 0-9, "_", ".", "-"; starting with a letter or digit');
const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,62}$/, 'must be 1-63 chars: letters, digits, space, "_", ".", "-"');

const material = z.object({
  name: label.optional(), color: hex.optional(), metallic: unit.optional(), roughness: unit.optional(), alpha: unit.optional(),
  emission_color: hex.optional(), emission_strength: z.number().finite().min(0).max(1000).optional(),
}).strict();

const shape = z.object({
  size: z.union([pos, z.tuple([pos, pos, pos])]).optional(), radius: pos.optional(), radius2: z.number().finite().min(0).max(1_000_000).optional(),
  depth: pos.optional(), segments: z.number().int().min(3).max(128).optional(), rings: z.number().int().min(3).max(64).optional(),
  subdivisions: z.number().int().min(1).max(4).optional(),
}).strict();

const propValue = z.union([z.number().finite(), z.boolean(), z.string().min(1).max(48), z.array(z.number().finite()).min(1).max(4)]);
const modifier = z.object({
  type: z.enum(Object.keys(MODIFIERS) as [string, ...string[]]),
  props: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), propValue).refine((o) => Object.keys(o).length <= 24, 'at most 24 properties').optional(),
}).strict();

const light = z.object({ type: z.enum(LIGHT_TYPES), energy: z.number().finite().min(0).max(1_000_000).optional(), color: hex.optional(), size: pos.optional() }).strict();
const camera = z.object({ lens: z.number().finite().min(1).max(500).optional(), clip_start: pos.optional(), clip_end: pos.optional() }).strict();

const buildObject = z.object({
  id: idText, kind: z.enum(OBJECT_KINDS), name: label.optional(), collection: label.optional(), parent_id: idText.optional(),
  loc: vec3.optional(), rot_deg: vec3.optional(), scale: z.union([pos, z.tuple([pos, pos, pos])]).optional(),
  shape: shape.optional(), origin: z.enum(['center', 'base']).optional(), smooth: z.boolean().optional(),
  material: material.optional(), modifiers: z.array(modifier).max(8).optional(), light: light.optional(), camera: camera.optional(),
}).strict().superRefine((o, ctx) => {
  const bad = (message: string, p: string[] = []) => ctx.addIssue({ code: 'custom', message, path: p });
  const mesh = o.kind in MESH_KINDS;
  if (o.shape) {
    if (!mesh) bad(`kind "${o.kind}" takes no shape`, ['shape']);
    else for (const k of Object.keys(o.shape)) if (!(MESH_KINDS[o.kind as MeshKind].keys as readonly string[]).includes(k)) bad(`shape.${k} does not apply to ${o.kind} (allowed: ${MESH_KINDS[o.kind as MeshKind].keys.join(', ')})`, ['shape', k]);
  }
  if (!mesh) {
    if (o.material) bad('only mesh objects can have a material', ['material']);
    if (o.modifiers?.length) bad('only mesh objects can have modifiers', ['modifiers']);
    if (o.origin || o.smooth !== undefined) bad('origin and smooth only apply to mesh objects');
  }
  if (o.kind === 'light' && !o.light) bad('a light needs light {type}', ['light']);
  if (o.kind !== 'light' && o.light) bad('light only applies to kind "light"', ['light']);
  if (o.kind === 'camera' ? false : !!o.camera) bad('camera only applies to kind "camera"', ['camera']);
  if (o.parent_id === o.id) bad('an object cannot be its own parent', ['parent_id']);
  for (const [i, m] of (o.modifiers ?? []).entries()) {
    for (const [k, v] of Object.entries(m.props ?? {})) {
      if (k in POINTER_PROPS) { if (typeof v !== 'string' || !BATCH_ID.test(v)) bad(`${k} must be the id of another object`, ['modifiers', String(i), 'props', k]); else if (v === o.id) bad(`${k} cannot point at the object itself`, ['modifiers', String(i), 'props', k]); }
      else if (typeof v === 'string' && !/^[A-Za-z0-9_]{1,40}$/.test(v)) bad(`${k}: text values are enum names (letters, digits, "_")`, ['modifiers', String(i), 'props', k]);
    }
  }
});

export const buildSpecSchema = z.object({
  batch_id: idText,
  chunk: z.object({ index: z.number().int().min(0).max(MAX_CHUNKS - 1), total: z.number().int().min(1).max(MAX_CHUNKS) }).strict().refine((c) => c.index < c.total, 'chunk.index must be below chunk.total').optional(),
  project_id: z.string().regex(/^[a-f0-9-]{8,64}$/).optional(),
  objects: z.array(buildObject).min(1).max(MAX_BATCH_OBJECTS),
  scene: z.object({ camera_id: idText.optional() }).strict().optional(),
}).strict().superRefine((s, ctx) => {
  const ids = new Map<string, number>();
  s.objects.forEach((o, i) => { if (ids.has(o.id)) ctx.addIssue({ code: 'custom', message: `duplicate object id "${o.id}"`, path: ['objects', i, 'id'] }); ids.set(o.id, i); });
  // Parent cycles inside the spec. (A parent that is not in the spec must already exist in the project; Blender checks that.)
  const parentOf = new Map(s.objects.map((o) => [o.id, o.parent_id] as const));
  for (const o of s.objects) {
    const seen = new Set<string>([o.id]);
    for (let p = o.parent_id; p !== undefined; p = parentOf.get(p)) {
      if (seen.has(p)) { ctx.addIssue({ code: 'custom', message: `parent cycle through "${p}"`, path: ['objects', ids.get(o.id)!, 'parent_id'] }); break; }
      seen.add(p);
    }
  }
});
export type BuildSpec = z.infer<typeof buildSpecSchema>;

/** Problem text for the first schema error, or undefined. Never throws. */
export function validateBuildSpec(value: unknown): string | undefined {
  const r = buildSpecSchema.safeParse(value);
  if (r.success) return undefined;
  const i = r.error.issues[0]!;
  const where = i.path.length ? i.path.join('.') : 'spec';
  const extra = r.error.issues.length > 1 ? ` (+${r.error.issues.length - 1} more)` : '';
  return `${where}: ${i.message}${extra}`;
}

export const specHashOf = (canonicalText: string): string => createHash('sha256').update(canonicalText, 'utf8').digest('hex');

export const chunkOf = (s: Pick<BuildSpec, 'chunk'>): { index: number; total: number } => s.chunk ?? { index: 0, total: 1 };
export const ledgerKey = (batch: string, chunk: number): string => `${batch}#${chunk}`;

// ---- what the edit journal remembers about a batch ----

export const expectedBatchSchema = z.object({
  kind: z.literal('blender.scene.batch'), file: z.string().min(1).max(200), batch_id: idText,
  chunk: z.number().int().min(0).max(MAX_CHUNKS - 1), total: z.number().int().min(1).max(MAX_CHUNKS),
  spec_hash: z.string().regex(/^[0-9a-f]{64}$/), project_id: z.string().regex(/^[a-f0-9-]{8,64}$/).optional(),
  ids: z.array(idText).min(1).max(MAX_BATCH_OBJECTS),
  /** A few requested facts per object (index into ids): what "the content is right" means, separate from the ledger. */
  objects: z.array(z.object({ i: z.number().int().min(0).max(MAX_BATCH_OBJECTS - 1), loc: z.tuple([num, num, num]).optional(), color: hex.optional() }).strict()).max(MAX_JOURNAL_CONTENT),
}).strict();
export type ExpectedBatch = z.infer<typeof expectedBatchSchema>;

const record = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

/** The intent the journal records BEFORE scene.build is dispatched: derived only from the model's own arguments, never from Blender. */
export function expectedBatchFromParams(params: Record<string, unknown>): ExpectedBatch | undefined {
  if (typeof params.file_name !== 'string') return undefined;
  const j = normalizeJsonParam(params.spec, 'spec', { maxChars: BUILD_SPEC_MAX_CHARS, maxDepth: BUILD_SPEC_MAX_DEPTH });
  if (!j.ok || validateBuildSpec(j.value) !== undefined) return undefined;
  const spec = j.value as BuildSpec;
  const c = chunkOf(spec);
  const objects: ExpectedBatch['objects'] = [];
  spec.objects.forEach((o, i) => {
    if (objects.length >= MAX_JOURNAL_CONTENT || (!o.loc && !o.material?.color)) return;
    objects.push({ i, ...(o.loc ? { loc: o.loc } : {}), ...(o.material?.color ? { color: o.material.color.toLowerCase() as `#${string}` } : {}) });
  });
  const r = expectedBatchSchema.safeParse({ kind: 'blender.scene.batch', file: params.file_name.slice(0, 200), batch_id: spec.batch_id, chunk: c.index, total: c.total,
    spec_hash: specHashOf(j.text), ...(spec.project_id ? { project_id: spec.project_id } : {}), ids: spec.objects.map((o) => o.id), objects });
  return r.success ? r.data : undefined;
}

// ---- reading a batch back ----

export type BatchOutcome = 'applied' | 'absent' | 'partial' | 'ambiguous';
export interface BatchAssessment {
  outcome: BatchOutcome; reason: string;
  /** The batch ledger records this chunk with the expected spec hash. */
  ledgerComplete: boolean;
  /** Every requested object exists with the requested location and colour. Judged separately from the ledger. */
  contentMatches: boolean;
  /** Only an applied batch (whose result is there) or an authoritatively absent one lets the recovery lock go. */
  releasesLock: boolean;
}
const stem = (f: string) => path.basename(f).replace(/\.blend$/i, '').toLowerCase();
const near = (a: unknown, b: number, tol: number) => typeof a === 'number' && Math.abs(a - b) <= tol;
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

/**
 * Decides, from ONE fresh scene.inspect_detail read-back of the saved project, what happened to the batch the journal recorded.
 *  applied   - the ledger records the chunk with the expected hash AND every requested object is there with the requested content
 *  absent    - no ledger entry and none of the objects exist, in the right project, with a complete id list (the save never happened)
 *  partial   - some objects (or all of them, without a ledger entry) exist but the ledger does not record the chunk
 *  ambiguous - anything else: wrong or unidentifiable project, unreadable/corrupt ledger, a different hash, ledger and content disagree
 * Only `applied` and `absent` release the recovery lock; a retry is allowed only after `absent`.
 */
export function assessBatchReadback(doc: unknown, exp: ExpectedBatch): BatchAssessment {
  const mk = (outcome: BatchOutcome, reason: string, ledgerComplete = false, contentMatches = false): BatchAssessment => ({ outcome, reason, ledgerComplete, contentMatches, releasesLock: outcome === 'applied' || outcome === 'absent' });
  const data = record(record(doc)?.data);
  if (!data) return mk('ambiguous', 'the read-back has no structured data');
  const project = record(data.project);
  if (!project || typeof project.file !== 'string') return mk('ambiguous', 'the read-back does not identify the project');
  if (stem(project.file) !== stem(exp.file)) return mk('ambiguous', `the read-back is about ${project.file}, not ${exp.file}`);
  if (exp.project_id && project.project_id !== exp.project_id) return mk('ambiguous', 'the project identity differs from the one the batch was meant for');
  const ledger = record(data.ledger);
  if (!ledger || ledger.ok !== true || !Array.isArray(ledger.entries)) return mk('ambiguous', `the batch ledger cannot be read${typeof ledger?.error === 'string' ? ` (${ledger.error})` : ''}`);
  const entry = (ledger.entries as unknown[]).map(record).find((e) => e && e.batch === exp.batch_id && e.chunk === exp.chunk);
  const ccIds = Array.isArray(data.cc_ids) ? data.cc_ids.filter((x): x is string => typeof x === 'string') : undefined;
  if (!ccIds) return mk('ambiguous', 'the read-back does not list the object ids');
  const present = exp.ids.filter((id) => ccIds.includes(id));
  const details = Array.isArray(data.details) ? data.details.map(record).filter((d): d is Record<string, unknown> => !!d) : [];
  const contentMatches = present.length === exp.ids.length && exp.objects.every((want) => {
    const d = details.filter((x) => x.id === exp.ids[want.i]);
    if (d.length !== 1) return false;
    const e = d[0]!;
    if (want.loc && !(Array.isArray(e.location) && want.loc.every((v, k) => near((e.location as unknown[])[k], v, 0.001)))) return false;
    if (want.color) {
      const want3 = rgb(want.color);
      const ok = Array.isArray(e.materials) && e.materials.some((m) => { const c = record(m)?.color; return Array.isArray(c) && want3.every((v, k) => near(c[k], v, 0.002)); });
      if (!ok) return false;
    }
    return true;
  });
  if (entry) {
    if (entry.hash !== exp.spec_hash) return mk('ambiguous', 'the ledger records this batch id with different content', true, contentMatches);
    if (contentMatches) return mk('applied', 'the ledger records the batch and every requested object is there with the requested content', true, true);
    return mk('ambiguous', `the ledger records the batch but ${present.length} of ${exp.ids.length} objects exist and/or their content differs`, true, false);
  }
  if (present.length === 0) {
    if (data.cc_ids_truncated === true) return mk('ambiguous', 'the object id list is incomplete, so absence cannot be proven');
    return mk('absent', 'neither a ledger entry nor any of the requested objects exist in the saved project');
  }
  return mk('partial', `${present.length} of ${exp.ids.length} requested objects exist but the ledger does not record the batch`, false, contentMatches);
}

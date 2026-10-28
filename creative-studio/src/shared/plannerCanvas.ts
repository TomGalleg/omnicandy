// The visual layout of a plan (docs/planner-2.0/stage-1-blueprint.md, sections 4.5 and 6). It lives in its own file beside the plan and is NOT part
// of the accepted plan: moving a card never changes a revision, the history or an execution package. Pure; the store reads and writes the file.
import { z } from 'zod';
import type { ProjectView } from './projectView';

export const CANVAS_LIMITS = {
  maxNodes: 10_000, maxGroups: 500, maxNotes: 500, maxLinks: 5_000,
  maxNoteChars: 2_000, maxTitleChars: 120, maxBytes: 2 * 1024 * 1024, maxCoord: 1_000_000,
} as const;

export const VIEW_MODES = ['canvas', 'cards', 'board', 'timeline', 'list'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export interface CanvasNodePos { x: number; y: number; w?: number; h?: number; collapsed?: boolean; group?: string | null }
export interface CanvasGroup { title: string; x: number; y: number; w: number; h: number; color?: string }
/** A sticky note: presentation only, never plan content. */
export interface CanvasNote { text: string; x: number; y: number; color?: string }
/** A visual link. Real dependencies stay in PlanTask.dependsOn. */
export interface CanvasLink { from: string; to: string; label?: string }

export interface CanvasLayout {
  version: 1;
  layoutRev: number;
  updatedAt: string;
  mode: ViewMode;
  viewport: { x: number; y: number; zoom: number } | null;
  nodes: Record<string, CanvasNodePos>;
  groups: Record<string, CanvasGroup>;
  notes: Record<string, CanvasNote>;
  links: Record<string, CanvasLink>;
}

export interface CanvasPatch {
  mode?: ViewMode;
  viewport?: CanvasLayout['viewport'];
  upsertNodes?: Record<string, CanvasNodePos>; removeNodes?: string[];
  upsertGroups?: Record<string, CanvasGroup>; removeGroups?: string[];
  upsertNotes?: Record<string, CanvasNote>; removeNotes?: string[];
  upsertLinks?: Record<string, CanvasLink>; removeLinks?: string[];
}

export class CanvasLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'CanvasLimitError'; }
}

/** Entity ids (task_ab12…), the plan root, ghosts, and the canvas's own groups, notes and links. No other keys are accepted (no `__proto__`). */
const ID = /^(?:[a-z]{2,10}_[a-z0-9]{4,24}|project:plan_[a-z0-9]{6,20}|ghost:[a-z]{2,10}_[a-z0-9]{4,24}:\d{1,3})$/;
const idKey = z.string().max(80).regex(ID);
const num = z.number().finite().min(-CANVAS_LIMITS.maxCoord).max(CANVAS_LIMITS.maxCoord);
const size = z.number().finite().min(1).max(CANVAS_LIMITS.maxCoord);
const color = z.string().max(32).regex(/^[#a-zA-Z0-9(),.% -]*$/);

const posSchema = z.object({ x: num, y: num, w: size.optional(), h: size.optional(), collapsed: z.boolean().optional(), group: idKey.nullable().optional() }).strict();
const groupSchema = z.object({ title: z.string().max(CANVAS_LIMITS.maxTitleChars), x: num, y: num, w: size, h: size, color: color.optional() }).strict();
const noteSchema = z.object({ text: z.string().max(CANVAS_LIMITS.maxNoteChars), x: num, y: num, color: color.optional() }).strict();
const linkSchema = z.object({ from: idKey, to: idKey, label: z.string().max(CANVAS_LIMITS.maxTitleChars).optional() }).strict();
const viewportSchema = z.object({ x: num, y: num, zoom: z.number().finite().min(0.05).max(20) }).strict().nullable();
const modeSchema = z.enum(VIEW_MODES);
const rec = <T extends z.ZodTypeAny>(v: T) => z.record(idKey, v);

export const canvasLayoutSchema = z.object({
  version: z.literal(1), layoutRev: z.number().int().min(0), updatedAt: z.string().max(40), mode: modeSchema, viewport: viewportSchema,
  nodes: rec(posSchema), groups: rec(groupSchema), notes: rec(noteSchema), links: rec(linkSchema),
}).strict();

export const canvasPatchSchema = z.object({
  mode: modeSchema.optional(), viewport: viewportSchema.optional(),
  upsertNodes: rec(posSchema).optional(), removeNodes: z.array(idKey).max(CANVAS_LIMITS.maxNodes).optional(),
  upsertGroups: rec(groupSchema).optional(), removeGroups: z.array(idKey).max(CANVAS_LIMITS.maxGroups).optional(),
  upsertNotes: rec(noteSchema).optional(), removeNotes: z.array(idKey).max(CANVAS_LIMITS.maxNotes).optional(),
  upsertLinks: rec(linkSchema).optional(), removeLinks: z.array(idKey).max(CANVAS_LIMITS.maxLinks).optional(),
}).strict();

export const emptyCanvas = (now: Date): CanvasLayout => ({ version: 1, layoutRev: 0, updatedAt: now.toISOString(), mode: 'canvas', viewport: null, nodes: {}, groups: {}, notes: {}, links: {} });

function merge<T>(base: Record<string, T>, upsert: Record<string, T> | undefined, remove: string[] | undefined): Record<string, T> {
  const out: Record<string, T> = { ...base };
  for (const [k, v] of Object.entries(upsert ?? {})) out[k] = v;
  for (const k of remove ?? []) delete out[k];
  return out;
}

/** Applies a patch. Last writer wins per key; nothing is rejected for being "old". Over-limit results are refused whole. */
export function applyCanvasPatch(base: CanvasLayout, patchIn: CanvasPatch, now: Date): CanvasLayout {
  const patch = canvasPatchSchema.parse(patchIn);
  const next: CanvasLayout = {
    ...base,
    layoutRev: base.layoutRev + 1,
    updatedAt: now.toISOString(),
    mode: patch.mode ?? base.mode,
    viewport: patch.viewport === undefined ? base.viewport : patch.viewport,
    nodes: merge(base.nodes, patch.upsertNodes, patch.removeNodes),
    groups: merge(base.groups, patch.upsertGroups, patch.removeGroups),
    notes: merge(base.notes, patch.upsertNotes, patch.removeNotes),
    links: merge(base.links, patch.upsertLinks, patch.removeLinks),
  };
  const L = CANVAS_LIMITS;
  if (Object.keys(next.nodes).length > L.maxNodes) throw new CanvasLimitError(`The canvas can hold at most ${L.maxNodes} positioned cards.`);
  if (Object.keys(next.groups).length > L.maxGroups) throw new CanvasLimitError(`The canvas can hold at most ${L.maxGroups} groups.`);
  if (Object.keys(next.notes).length > L.maxNotes) throw new CanvasLimitError(`The canvas can hold at most ${L.maxNotes} notes.`);
  if (Object.keys(next.links).length > L.maxLinks) throw new CanvasLimitError(`The canvas can hold at most ${L.maxLinks} links.`);
  if (JSON.stringify(next).length > L.maxBytes) throw new CanvasLimitError('The canvas is too large to save.');
  return next;
}

/** Drops positions of things that no longer exist in the plan, and links to them. In memory only: callers decide whether to write it back. */
export function pruneOrphans(layout: CanvasLayout, view: ProjectView): CanvasLayout {
  const ids = new Set(view.nodes.map((n) => n.id));
  const nodes = Object.fromEntries(Object.entries(layout.nodes).filter(([k]) => ids.has(k)));
  const known = (k: string) => ids.has(k) || k in layout.notes || k in layout.groups;
  const links = Object.fromEntries(Object.entries(layout.links).filter(([, l]) => known(l.from) && known(l.to)));
  return { ...layout, nodes, links };
}

export const CARD_W = 240;
export const CARD_H = 96;
const COL_W = 300;
const ROW_H = 130;

/**
 * A position for every node of the view, from the plan alone (so an old project opens with a sensible layout and nothing is written).
 * Prerequisites sit to the left of what depends on them; milestone groups are bands; ideas, resources and proposals have their own columns.
 */
export function autoLayout(view: ProjectView): Record<string, CanvasNodePos> {
  const pos: Record<string, CanvasNodePos> = {};
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, string[]>();
  for (const e of view.edges) if (e.kind === 'dependsOn' || e.kind === 'ghostDependsOn') incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = Math.max(-1, ...(incoming.get(id) ?? []).map(depthOf)) + 1;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  const place = (id: string, x: number, y: number) => { pos[id] = { x, y, w: CARD_W, h: CARD_H }; };
  const workKinds = new Set(['chunk', 'task']);
  const container = (id: string): string => {
    let n = byId.get(id);
    for (let guard = 0; n && guard < 50; guard++) {
      if (n.kind === 'milestone') return n.id;
      n = n.parentId ? byId.get(n.parentId) : undefined;
    }
    return '';
  };

  // Work: one band per milestone (in stored order), then the tasks that belong to none.
  const bands = [...view.nodes.filter((n) => n.kind === 'milestone').map((n) => n.id), ''];
  let y = 0;
  for (const band of bands) {
    const members = view.nodes.filter((n) => workKinds.has(n.kind) && container(n.id) === band);
    if (!members.length) continue;
    if (band) { const m = byId.get(band)!; place(m.id, -COL_W, y); }
    const perColumn = new Map<number, number>();
    let rows = 0;
    for (const n of members) {
      const col = depthOf(n.id);
      const row = perColumn.get(col) ?? 0;
      perColumn.set(col, row + 1);
      rows = Math.max(rows, row + 1);
      place(n.id, col * COL_W, y + row * ROW_H);
    }
    y += rows * ROW_H + 40;
  }
  const maxCol = Math.max(0, ...view.nodes.filter((n) => workKinds.has(n.kind)).map((n) => depthOf(n.id)));

  const stack = (kinds: Set<string>, x: number) => { let row = 0; for (const n of view.nodes) if (kinds.has(n.kind) && !pos[n.id]) place(n.id, x, row++ * ROW_H); };
  place(view.nodes[0]?.id ?? `project:${view.planId}`, -2 * COL_W, -ROW_H * 1.5);
  stack(new Set(['idea', 'question', 'requirement', 'decision', 'reference']), -2 * COL_W);
  stack(new Set(['resource']), -3 * COL_W);
  for (const n of view.nodes) {
    if (n.kind === 'result' && !pos[n.id]) { const t = pos[n.parentId ?? '']; place(n.id, (t?.x ?? 0) + COL_W / 2, (t?.y ?? 0) + 40); }
  }
  let g = 0;
  for (const n of view.nodes) {
    if (n.kind !== 'ghost' || pos[n.id]) continue;
    const dep = (incoming.get(n.id) ?? []).map(depthOf);
    place(n.id, (dep.length ? Math.max(...dep) + 1 : maxCol + 1) * COL_W, y + g * ROW_H);
    g++;
  }
  for (const n of view.nodes) if (!pos[n.id]) place(n.id, 0, y += ROW_H);
  return pos;
}

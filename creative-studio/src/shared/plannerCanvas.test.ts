import { describe, expect, it } from 'vitest';
import type { PlannerProject, PlanTask } from './planner';
import { applyCanvasPatch, autoLayout, canvasLayoutSchema, canvasPatchSchema, CANVAS_LIMITS, CanvasLimitError, emptyCanvas, pruneOrphans } from './plannerCanvas';
import { buildProjectView } from './projectView';

const NOW = new Date('2026-06-01T12:00:00Z');
const bare = (): PlannerProject => ({
  id: 'plan_abc123', title: 'x', goal: '', description: '', scope: '', constraints: [], deliverables: [], kinds: [], revision: 1, planRevision: 1, metaRev: 1, createdAt: '', updatedAt: '',
  items: [], tasks: [], assets: [], milestones: [], proposals: [], packages: [], reports: [], planVersions: [], counters: { package: 0, activity: 0 },
});
const task = (id: string, over: Partial<PlanTask> = {}): PlanTask => ({
  id, title: id, description: '', status: 'todo', priority: 'normal', parentId: null, dependsOn: [], completionChecks: [], expectedOutputs: [], assetIds: [], milestoneId: null,
  appRef: null, packageId: null, claim: null, progressNote: '', rev: 1, createdAt: '', updatedAt: '', createdBy: { kind: 'user', name: 'You' }, ...over,
});

describe('canvas schema', () => {
  it('accepts normal ids and positions, and rejects anything that could be abused', () => {
    expect(canvasPatchSchema.safeParse({ upsertNodes: { task_ab12cd: { x: 10, y: -20 } } }).success).toBe(true);
    for (const bad of ['constructor', 'a'.repeat(100), 'task ab', '../x', '']) {
      expect(canvasPatchSchema.safeParse({ upsertNodes: { [bad]: { x: 1, y: 1 } } }).success, bad).toBe(false);
    }
    // The schema library drops a `__proto__` key instead of keeping it, so it can never reach the stored layout.
    const proto = canvasPatchSchema.safeParse({ upsertNodes: { ['__proto__']: { x: 1, y: 1 } } });
    expect(proto.success ? Object.keys(proto.data.upsertNodes ?? {}) : []).toEqual([]);
    expect(canvasPatchSchema.safeParse({ upsertNodes: { task_ab12cd: { x: Number.NaN, y: 1 } } }).success).toBe(false);
    expect(canvasPatchSchema.safeParse({ upsertNodes: { task_ab12cd: { x: 1e9, y: 1 } } }).success).toBe(false);
    expect(canvasPatchSchema.safeParse({ upsertNodes: { task_ab12cd: { x: 1, y: 1, extra: true } } }).success).toBe(false);
    expect(canvasPatchSchema.safeParse({ mode: 'hologram' }).success).toBe(false);
  });
  it('validates a whole layout', () => {
    expect(canvasLayoutSchema.safeParse(emptyCanvas(NOW)).success).toBe(true);
    expect(canvasLayoutSchema.safeParse({ ...emptyCanvas(NOW), version: 2 }).success).toBe(false);
  });
});

describe('applyCanvasPatch', () => {
  it('merges per key, bumps the layout revision, and removing is idempotent', () => {
    const base = emptyCanvas(NOW);
    const a = applyCanvasPatch(base, { upsertNodes: { task_aaaa: { x: 1, y: 2 } }, mode: 'board' }, NOW);
    expect(a).toMatchObject({ layoutRev: 1, mode: 'board', nodes: { task_aaaa: { x: 1, y: 2 } } });
    const b = applyCanvasPatch(a, { upsertNodes: { task_aaaa: { x: 5, y: 2 }, task_bbbb: { x: 0, y: 0 } }, removeNodes: ['task_nope1'] }, NOW);
    expect(b.layoutRev).toBe(2);
    expect(b.nodes.task_aaaa).toEqual({ x: 5, y: 2 });
    expect(applyCanvasPatch(b, { removeNodes: ['task_aaaa'] }, NOW).nodes).toEqual({ task_bbbb: { x: 0, y: 0 } });
    expect(base.layoutRev).toBe(0);
  });
  it('refuses a result over any limit, whole', () => {
    const nodes: Record<string, { x: number; y: number }> = {};
    for (let i = 0; i < CANVAS_LIMITS.maxNodes + 1; i++) nodes[`task_${i.toString(36).padStart(6, '0')}`] = { x: i, y: 0 };
    expect(() => applyCanvasPatch(emptyCanvas(NOW), { upsertNodes: nodes }, NOW)).toThrow(CanvasLimitError);
    const notes: Record<string, { text: string; x: number; y: number }> = {};
    for (let i = 0; i < CANVAS_LIMITS.maxNotes + 1; i++) notes[`note_${i.toString(36).padStart(6, '0')}`] = { text: 'hi', x: 0, y: 0 };
    expect(() => applyCanvasPatch(emptyCanvas(NOW), { upsertNotes: notes }, NOW)).toThrow(CanvasLimitError);
  });
});

describe('pruneOrphans', () => {
  it('drops positions and links of things that no longer exist, in memory only', () => {
    const p = bare();
    p.tasks.push(task('task_aaaa'));
    const view = buildProjectView(p, { now: NOW });
    const layout = applyCanvasPatch(emptyCanvas(NOW), { upsertNodes: { task_aaaa: { x: 1, y: 1 }, task_gone1: { x: 2, y: 2 } }, upsertLinks: { link_aaaa: { from: 'task_aaaa', to: 'task_gone1' } } }, NOW);
    const pruned = pruneOrphans(layout, view);
    expect(Object.keys(pruned.nodes)).toEqual(['task_aaaa']);
    expect(pruned.links).toEqual({});
    expect(Object.keys(layout.nodes)).toHaveLength(2);
  });
});

describe('autoLayout', () => {
  it('positions every node and puts dependents to the right of what they wait for', () => {
    const p = bare();
    p.milestones.push({ id: 'ms_aaaa', title: 'One', due: '', rev: 1 });
    p.tasks.push(task('task_a', { milestoneId: 'ms_aaaa' }), task('task_b', { milestoneId: 'ms_aaaa', dependsOn: ['task_a'] }), task('task_c', { dependsOn: ['task_b'] }), task('task_d'));
    p.items.push({ id: 'item_aaaa', type: 'idea', title: 'Idea', text: '', reason: '', status: 'open', rev: 1, createdAt: '', updatedAt: '', createdBy: { kind: 'user', name: 'You' } });
    p.proposals.push({ id: 'prop_aaaa', proposedBy: { kind: 'other', name: 'AI' }, at: '', note: '', status: 'pending', source: 'connection', changes: [{ op: 'add_task', title: 'New', description: '', priority: 'normal', dependsOn: ['task_d'], completionChecks: [] }] });
    const v = buildProjectView(p, { now: NOW });
    const pos = autoLayout(v);
    for (const n of v.nodes) expect(pos[n.id], n.id).toBeDefined();
    expect(pos.task_b!.x).toBeGreaterThan(pos.task_a!.x);
    expect(pos.task_c!.x).toBeGreaterThan(pos.task_b!.x);
    expect(pos['ghost:prop_aaaa:0']!.x).toBeGreaterThan(pos.task_d!.x);
    expect(autoLayout(v)).toEqual(pos);
  });
  it('copes with a dependency cycle and with 2,000 tasks quickly', () => {
    const p = bare();
    p.tasks.push(task('task_a', { dependsOn: ['task_b'] }), task('task_b', { dependsOn: ['task_a'] }));
    expect(Object.keys(autoLayout(buildProjectView(p, { now: NOW })))).toHaveLength(3);
    const big = bare();
    for (let i = 0; i < 2000; i++) big.tasks.push(task(`task_${i.toString(36).padStart(5, '0')}`, i ? { dependsOn: [`task_${(i - 1).toString(36).padStart(5, '0')}`] } : {}));
    const v = buildProjectView(big, { now: NOW });
    const t0 = Date.now();
    const pos = autoLayout(v);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(Object.keys(pos)).toHaveLength(v.nodes.length);
  });
});

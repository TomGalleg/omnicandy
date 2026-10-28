import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlannerService, userCtx } from './service';
import { PlannerStore, type StoreWrite } from './store';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitown-canvas-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const make = (events: StoreWrite[] = []) => {
  const store = new PlannerStore(tmp, undefined, { onWrite: (w) => events.push(w) });
  return { store, svc: new PlannerService(store), u: userCtx() };
};
const planDir = (id: string) => path.join(tmp, 'projects', id);
const read = (id: string, f: string) => fs.readFileSync(path.join(planDir(id), f));

describe('the canvas layout', () => {
  it('moving cards never touches the plan: same file, revision, history, and an open package is still the same package', async () => {
    const { store, svc, u } = make();
    const p = await svc.createProject(u, { title: 'Castle' });
    const t = await svc.addTask(u, p.id, { title: 'Model the walls' });
    const first = await svc.prepareSend(u, p.id, { taskIds: [t.id], destination: 'tools' });
    const before = { json: read(p.id, 'project.json'), history: read(p.id, 'history.jsonl'), plan: await store.read(p.id) };

    for (let i = 0; i < 50; i++) await store.patchCanvas(p.id, { upsertNodes: { [t.id]: { x: i * 3, y: -i } }, mode: i % 2 ? 'board' : 'canvas' });

    expect(read(p.id, 'project.json').equals(before.json)).toBe(true);
    expect(read(p.id, 'history.jsonl').equals(before.history)).toBe(true);
    const after = await store.read(p.id);
    expect(after.revision).toBe(before.plan.revision);
    expect(after.planRevision).toBe(before.plan.planRevision);
    const again = await svc.prepareSend(u, p.id, { taskIds: [t.id], destination: 'tools' });
    expect(again.reused).toBe(true);
    expect(again.package.contentKey).toBe(first.package.contentKey);
    const { layout } = await store.readCanvas(p.id);
    expect(layout.layoutRev).toBe(50);
    expect(layout.nodes[t.id]).toEqual({ x: 147, y: -49 });
  });

  it('a project with no canvas file gets an empty layout and nothing is written', async () => {
    const { store, svc, u } = make();
    const p = await svc.createProject(u, { title: 'Old' });
    const { layout, recovered } = await store.readCanvas(p.id);
    expect(recovered).toBe(false);
    expect(layout.nodes).toEqual({});
    expect(fs.existsSync(path.join(planDir(p.id), 'canvas.json'))).toBe(false);
  });

  it('sets a damaged layout aside, starts again, and says so', async () => {
    const events: StoreWrite[] = [];
    const { store, svc, u } = make(events);
    const p = await svc.createProject(u, { title: 'Hurt' });
    fs.writeFileSync(path.join(planDir(p.id), 'canvas.json'), '{ not json');
    const r = await store.readCanvas(p.id);
    expect(r.recovered).toBe(true);
    expect(r.layout.nodes).toEqual({});
    const files = fs.readdirSync(planDir(p.id));
    expect(files.some((f) => f.startsWith('canvas.corrupt-'))).toBe(true);
    expect(files).not.toContain('canvas.json');
    expect(events.some((e) => e.kind === 'recovered' && e.what === 'canvas')).toBe(true);
    await store.patchCanvas(p.id, { upsertNodes: { task_abcd12: { x: 1, y: 2 } } });
    expect((await store.readCanvas(p.id)).recovered).toBe(false);
  });

  it('keeps a layout written by a newer version untouched', async () => {
    const { store, svc, u } = make();
    const p = await svc.createProject(u, { title: 'Future' });
    const newer = JSON.stringify({ version: 2, shiny: true });
    fs.writeFileSync(path.join(planDir(p.id), 'canvas.json'), newer);
    const r = await store.readCanvas(p.id);
    expect(r.recovered).toBe(true);
    expect(fs.readFileSync(path.join(planDir(p.id), 'canvas.v2.json'), 'utf8')).toBe(newer);
  });

  it('lets two moves at once both land, refuses an oversized change whole, and rejects an unknown plan', async () => {
    const { store, svc, u } = make();
    const p = await svc.createProject(u, { title: 'Busy' });
    await Promise.all([
      store.patchCanvas(p.id, { upsertNodes: { task_aaaa11: { x: 1, y: 1 } } }),
      store.patchCanvas(p.id, { upsertNodes: { task_bbbb22: { x: 2, y: 2 } } }),
      store.patchCanvas(p.id, { upsertGroups: { group_cccc33: { title: 'Act one', x: 0, y: 0, w: 100, h: 100 } } }).catch(() => undefined),
    ]);
    const { layout } = await store.readCanvas(p.id);
    expect(Object.keys(layout.nodes).sort()).toEqual(['task_aaaa11', 'task_bbbb22']);
    const notes: Record<string, { text: string; x: number; y: number }> = {};
    for (let i = 0; i < 501; i++) notes[`note_${i.toString(36).padStart(6, '0')}`] = { text: 'x', x: 0, y: 0 };
    await expect(store.patchCanvas(p.id, { upsertNotes: notes })).rejects.toMatchObject({ code: 'invalid' });
    expect((await store.readCanvas(p.id)).layout.layoutRev).toBe(layout.layoutRev);
    await expect(store.patchCanvas('plan_zzzzzz', { mode: 'list' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a copied project folder keeps its layout', async () => {
    const { store, svc, u } = make();
    const p = await svc.createProject(u, { title: 'Twin' });
    await store.patchCanvas(p.id, { upsertNodes: { task_aaaa11: { x: 9, y: 9 } } });
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitown-copy-'));
    try {
      fs.cpSync(tmp, copy, { recursive: true });
      expect((await new PlannerStore(copy).readCanvas(p.id)).layout.nodes.task_aaaa11).toEqual({ x: 9, y: 9 });
    } finally { fs.rmSync(copy, { recursive: true, force: true }); }
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlannerService, userCtx } from './service';
import { PlannerStore } from './store';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitown-export-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('export and import with a layout', () => {
  it('a plan exported with a layout comes back with it, and one without simply has none', async () => {
    const store = new PlannerStore(tmp);
    const svc = new PlannerService(store);
    const u = userCtx();
    const a = await svc.createProject(u, { title: 'With layout' });
    const b = await svc.createProject(u, { title: 'Without' });
    await store.patchCanvas(a.id, { upsertNodes: { task_abcd12: { x: 7, y: 8 } }, mode: 'timeline' });

    const withLayout = await svc.importProject(u, await svc.exportProject(u, a.id, 'reference'));
    expect(withLayout.id).not.toBe(a.id);
    expect((await store.readCanvas(withLayout.id)).layout).toMatchObject({ mode: 'timeline', nodes: { task_abcd12: { x: 7, y: 8 } } });

    const without = await svc.importProject(u, await svc.exportProject(u, b.id, 'reference'));
    expect(fs.existsSync(path.join(store.dir(without.id), 'canvas.json'))).toBe(false);
    expect((await store.readCanvas(without.id)).layout.nodes).toEqual({});
  });
});

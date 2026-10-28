import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlannerEvent } from '@shared/plannerEvents';
import { PlannerEventHub } from './events';
import { PlannerService, userCtx } from './service';
import { PlannerStore } from './store';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitown-events-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const setup = () => {
  const seen: PlannerEvent[] = [];
  const hub = new PlannerEventHub({ broadcast: (e) => seen.push(e), now: () => new Date('2026-06-01T12:00:00Z') });
  const store = new PlannerStore(tmp, undefined, { onWrite: (w) => hub.emitWrite(w) });
  return { seen, hub, store, svc: new PlannerService(store), u: userCtx() };
};
const target = (id: string) => async () => ({ planId: id, file: path.join(tmp, 'projects', id, 'project.json') });

describe('planner events', () => {
  it('a change made here sends exactly one event with the new revision and no plan content', async () => {
    const { seen, svc, u } = setup();
    const p = await svc.createProject(u, { title: 'Secret title', goal: 'Secret goal' });
    seen.length = 0;
    await svc.addTask(u, p.id, { title: 'A private task' });
    expect(seen).toEqual([{ type: 'plan.changed', planId: p.id, revision: 2, planRevision: 1, origin: 'app', at: '2026-06-01T12:00:00.000Z' }]);
    expect(JSON.stringify(seen)).not.toMatch(/private|Secret/);
  });

  it('a change with no effect sends nothing', async () => {
    const { seen, svc, u } = setup();
    const p = await svc.createProject(u, { title: 'Quiet' });
    seen.length = 0;
    await svc.updateProject(u, p.id, { title: 'Quiet' });
    expect(seen).toEqual([]);
  });

  it('notices a write by another process, and does not repeat what this app wrote itself', async () => {
    const { seen, hub, svc, u } = setup();
    const p = await svc.createProject(u, { title: 'Shared' });
    await hub.check(target(p.id)); // first look: remembers where things stand
    seen.length = 0;

    // another process: its own store on the same folder, no listener
    const other = new PlannerService(new PlannerStore(tmp));
    await other.addTask(u, p.id, { title: 'Added by a connection' });
    await hub.check(target(p.id));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'plan.changed', planId: p.id, revision: 2, origin: 'external' });

    seen.length = 0;
    await hub.check(target(p.id));
    expect(seen).toEqual([]); // nothing new

    await svc.addTask(u, p.id, { title: 'Added here' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ origin: 'app', revision: 3 });
    await hub.check(target(p.id));
    expect(seen).toHaveLength(1); // the file change from our own write is not announced again
  });

  it('tells windows about canvas and chat writes, and stops cleanly', async () => {
    const { seen, hub, store, svc, u } = setup();
    const p = await svc.createProject(u, { title: 'More' });
    seen.length = 0;
    await store.patchCanvas(p.id, { mode: 'list' });
    await store.appendChat(p.id, { messages: [{ role: 'user', text: 'hello' }] });
    expect(seen.map((e) => e.type)).toEqual(['canvas.changed', 'chat.changed']);
    hub.watch(async () => null);
    hub.stop();
    hub.stop();
  });

  it('survives a window that throws and a plan that is not there', async () => {
    const hub = new PlannerEventHub({ broadcast: () => { throw new Error('window gone'); } });
    expect(() => hub.emitWrite({ kind: 'canvas', planId: 'plan_x', layoutRev: 1 })).not.toThrow();
    await expect(hub.check(async () => null)).resolves.toBeUndefined();
    await expect(hub.check(async () => ({ planId: 'plan_x', file: path.join(tmp, 'nope.json') }))).resolves.toBeUndefined();
  });
});

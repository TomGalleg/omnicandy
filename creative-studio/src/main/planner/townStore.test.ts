import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlannerEvent } from '@shared/plannerEvents';
import { coordinatorOf } from '@shared/town';
import { ProjectCoordinator } from './coordinator';
import { PlannerEventHub } from './events';
import { ProjectPlanner, type OpenProject } from './projectPlanner';
import { RoutedPlannerStore } from './routedStore';
import { PlannerService, userCtx } from './service';
import { createTownMethods } from './townMethods';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitown-town-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const setup = () => {
  const seen: PlannerEvent[] = [];
  const hub = new PlannerEventHub({ broadcast: (e) => seen.push(e) });
  const projectRoot = path.join(tmp, 'My Project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const store = new RoutedPlannerStore(path.join(tmp, 'shared'), undefined, { onWrite: (w) => hub.emitWrite(w) });
  const svc = new PlannerService(store);
  const planner = new ProjectPlanner(svc, store, async (): Promise<OpenProject> => ({ id: 'proj_castle', name: 'Castle', root: projectRoot, store: {} as OpenProject['store'] }));
  const coordinator = new ProjectCoordinator({ service: svc, planner });
  return { seen, store, svc, planner, coordinator, u: userCtx(), m: createTownMethods({ store, coordinator, service: svc }) };
};
const planDir = (store: RoutedPlannerStore, id: string) => store.dir(id);

describe('the town of a project', () => {
  it('is made the first time it is asked for, saved, and is the same town every time after', async () => {
    const { store, planner, seen } = setup();
    const plan = await planner.startPlan({ title: 'Castle' });
    const a = await store.readTown(plan.id);
    const b = await store.readTown(plan.id);
    expect(a.town.agents).toHaveLength(1);
    expect(b.town).toEqual(a.town);
    expect(coordinatorOf(b.town)!.id).toBe(coordinatorOf(a.town)!.id);
    expect(seen.filter((e) => e.type === 'town.changed')).toHaveLength(1);
  });

  it('leaves the plan alone: a town change never touches the plan file, its revisions or its history', async () => {
    const { store, svc, planner, m, u } = setup();
    const plan = await planner.startPlan({ title: 'Castle' });
    const before = { json: fs.readFileSync(path.join(planDir(store, plan.id), 'project.json')), history: fs.readFileSync(path.join(planDir(store, plan.id), 'history.jsonl')) };
    await m.townApply!(plan.id, [{ op: 'add_business', name: 'Art', trade: '' }, { op: 'add_agent', name: 'Ana', specialty: 'Concepts', businessId: '@last' }]);
    expect(fs.readFileSync(path.join(planDir(store, plan.id), 'project.json')).equals(before.json)).toBe(true);
    expect(fs.readFileSync(path.join(planDir(store, plan.id), 'history.jsonl')).equals(before.history)).toBe(true);
    expect((await svc.getProject(u, plan.id)).revision).toBe(plan.revision);
  });

  it('sets a damaged town aside and starts a fresh one, keeping the old file', async () => {
    const { store, planner, seen } = setup();
    const plan = await planner.startPlan({ title: 'Castle' });
    await store.readTown(plan.id);
    fs.writeFileSync(path.join(planDir(store, plan.id), 'town.json'), '{{ nope');
    const r = await store.readTown(plan.id);
    expect(r.recovered).toBe(true);
    expect(r.town.agents).toHaveLength(1);
    expect(fs.readdirSync(planDir(store, plan.id)).some((f) => f.startsWith('town.corrupt-'))).toBe(true);
    expect(seen.some((e) => e.type === 'plan.recovered' && e.what === 'town')).toBe(true);
  });

  it('writes nothing when a change is refused', async () => {
    const { store, planner, m } = setup();
    const plan = await planner.startPlan({ title: 'Castle' });
    const before = (await store.readTown(plan.id)).town;
    await expect(m.townApply!(plan.id, [{ op: 'retire_agent', agentId: coordinatorOf(before)!.id }])).rejects.toThrow(/coordinator/);
    expect((await store.readTown(plan.id)).town).toEqual(before);
    await expect(m.townApply!(plan.id, [{ op: 'explode' }])).rejects.toThrow();
  });
});

describe('suggesting a team and holding a meeting', () => {
  it('suggests a studio and a specialist for each application the plan names, and only the owner adds them', async () => {
    const { store, svc, planner, m, u } = setup();
    const plan = await planner.startPlan({ title: 'Castle' });
    await expect(m.townSuggestFromPlan!(plan.id)).rejects.toThrow(/nothing new/);
    await svc.addTask(u, plan.id, { title: 'Model the walls', appRef: { kind: 'external', id: 'blender', note: '' } });
    await svc.addTask(u, plan.id, { title: 'Build the terrain', appRef: { kind: 'external', id: 'unreal', note: '' } });
    await svc.addTask(u, plan.id, { title: 'Walls again', appRef: { kind: 'external', id: 'blender', note: '' } });
    const asked = await m.townSuggestFromPlan!(plan.id) as { businesses: unknown[]; suggestions: Array<{ id: string; status: string; changes: unknown[] }> };
    expect(asked.businesses).toHaveLength(1);
    expect(asked.suggestions).toHaveLength(1);
    expect(asked.suggestions[0]!.changes).toHaveLength(4);
    const decided = await m.townDecide!(plan.id, asked.suggestions[0]!.id, true) as { businesses: Array<{ name: string }> };
    expect(decided.businesses.map((b) => b.name)).toEqual(['Town Hall', 'Blender Studio', 'Unreal Studio']);
    expect((await store.readTown(plan.id)).town.agents.map((a) => a.name)).toEqual(['Coordinator', 'Blender Specialist', 'Unreal Specialist']);
    await expect(m.townSuggestFromPlan!(plan.id)).rejects.toThrow(/nothing new/);
  });

  it('records a meeting and turns what it decided into one pending proposal for the plan', async () => {
    const { store, svc, planner, m, u } = setup();
    const plan = await planner.startPlan({ title: 'Castle' });
    await m.townApply!(plan.id, [{ op: 'add_business', name: 'Art', trade: '' }, { op: 'add_agent', name: 'Ana', specialty: '', businessId: '@last' }]);
    const { town } = await store.readTown(plan.id);
    const ana = town.agents.find((a) => a.name === 'Ana')!;
    const started = await m.meetingStart!(plan.id, { topic: 'The hero', kind: 'planning', participantIds: [ana.id] }) as { meeting: { id: string; participantIds: string[] } };
    expect(started.meeting.participantIds).toContain(ana.id);
    await m.meetingNote!(plan.id, started.meeting.id, { by: 'Ana', text: 'Concept first, then model.' });
    const r = await m.meetingPropose!(plan.id, started.meeting.id, { note: 'From the hero meeting', changes: [{ op: 'add_task', title: 'Concept art', description: '', priority: 'normal', dependsOn: [], completionChecks: [] }] }) as { proposalId: string };
    const plan2 = await svc.getProject(u, plan.id);
    expect(plan2.tasks).toEqual([]);
    expect(plan2.proposals).toMatchObject([{ id: r.proposalId, status: 'pending', source: 'coordinator' }]);
    const ended = await m.meetingEnd!(plan.id, started.meeting.id) as { meetings: Array<{ proposalIds: string[]; endedAt?: string; notes: unknown[] }> };
    expect(ended.meetings[0]).toMatchObject({ proposalIds: [r.proposalId], notes: [{ by: 'Ana' }] });
    expect(ended.meetings[0]!.endedAt).toBeTruthy();
    await expect(m.meetingNote!(plan.id, started.meeting.id, { by: 'x', text: 'late' })).rejects.toThrow(/over/);
    await expect(m.meetingPropose!(plan.id, 'meet_missing01', { note: '', changes: [{ op: 'add_milestone', title: 'x', due: '' }] })).rejects.toMatchObject({ code: 'not_found' });
  });
});

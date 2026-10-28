import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProjectView } from '@shared/projectView';
import { ProjectCoordinator, COORDINATOR_ACTOR } from './coordinator';
import { ProjectPlanner, type OpenProject } from './projectPlanner';
import { RoutedPlannerStore } from './routedStore';
import { PlannerService, userCtx } from './service';
import { createViewMethods } from './viewMethods';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitown-coord-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const setup = () => {
  const projectRoot = path.join(tmp, 'My Project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const store = new RoutedPlannerStore(path.join(tmp, 'shared'));
  const svc = new PlannerService(store);
  const open = async (): Promise<OpenProject> => ({ id: 'proj_castle', name: 'Castle', root: projectRoot, store: {} as OpenProject['store'] });
  const planner = new ProjectPlanner(svc, store, open);
  const coordinator = new ProjectCoordinator({ service: svc, planner, now: () => new Date('2026-06-01T12:00:00Z') });
  return { store, svc, planner, coordinator, u: userCtx(), methods: createViewMethods({ coordinator, store }) };
};

describe('the project coordinator', () => {
  it('views the open project\'s plan and equals the pure view of the same plan', async () => {
    const { svc, planner, coordinator, u } = setup();
    await expect(coordinator.view()).rejects.toMatchObject({ code: 'not_found' });
    const plan = await planner.startPlan({ title: 'Castle' });
    await svc.addTask(u, plan.id, { title: 'Model the walls' });
    const v = await coordinator.view();
    expect(v).toEqual(buildProjectView(await svc.getProject(u, plan.id), { now: new Date('2026-06-01T12:00:00Z') }));
    expect(v.projectId).toBe('proj_castle');
    expect(v.nodes.some((n) => n.title === 'Model the walls' && n.kind === 'chunk')).toBe(true);
  });

  it('only prepares a pending proposal: the plan itself does not change, and it shows up as a preview', async () => {
    const { svc, planner, coordinator, u } = setup();
    const plan = await planner.startPlan({ title: 'Castle' });
    const before = await svc.getProject(u, plan.id);
    const { proposalId } = await coordinator.proposeChanges(plan.id, { note: 'A first pass', changes: [{ op: 'add_task', title: 'Sketch the gatehouse', description: '', priority: 'normal', dependsOn: [], completionChecks: [] }] });
    const after = await svc.getProject(u, plan.id);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.planRevision).toBe(before.planRevision);
    expect(after.proposals).toHaveLength(1);
    expect(after.proposals[0]).toMatchObject({ id: proposalId, status: 'pending', source: 'coordinator', proposedBy: COORDINATOR_ACTOR });
    const v = await coordinator.view(plan.id);
    expect(v.nodes.filter((n) => n.kind === 'ghost').map((n) => n.title)).toEqual(['Sketch the gatehouse']);
    expect(v.needsYou.suggestions).toBe(1);
    // the owner decides, through the existing method
    await svc.decideProposal(u, plan.id, proposalId, true);
    expect((await svc.getProject(u, plan.id)).tasks.map((t) => t.title)).toEqual(['Sketch the gatehouse']);
  });

  it('cannot do anything that belongs to the owner, and rejects bad changes', async () => {
    const { svc, planner, coordinator } = setup();
    const plan = await planner.startPlan({ title: 'Castle' });
    await expect(svc.addTask(coordinator.ctx, plan.id, { title: 'Sneaky' })).rejects.toMatchObject({ code: 'forbidden' });
    const { proposalId } = await coordinator.proposeChanges(plan.id, { note: '', changes: [{ op: 'add_milestone', title: 'Act one', due: '' }] });
    await expect(svc.decideProposal(coordinator.ctx, plan.id, proposalId, true)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(coordinator.proposeChanges(plan.id, { note: '', changes: [] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(coordinator.proposeChanges(plan.id, { note: '', changes: [{ op: 'explode' } as never] })).rejects.toMatchObject({ code: 'invalid' });
    expect((await svc.getProject(coordinator.ctx, plan.id)).tasks).toEqual([]);
  });

  it('says what could be done next, most urgent first, without any AI', async () => {
    const { svc, planner, coordinator, u } = setup();
    const plan = await planner.startPlan({ title: 'Castle' });
    expect((await coordinator.nextSteps(plan.id)).map((s) => s.kind)).toEqual(['add-first-chunk']);
    const t = await svc.addTask(u, plan.id, { title: 'Walls' });
    await coordinator.proposeChanges(plan.id, { note: 'idea', changes: [{ op: 'add_milestone', title: 'Act one', due: '' }] });
    expect((await coordinator.nextSteps(plan.id)).map((s) => s.kind)).toEqual(['review-proposal', 'continue-current']);
    expect((await coordinator.readiness(plan.id, t.id)).state).toBe('manual-only');
    await expect(coordinator.readiness(plan.id, 'task_missing')).rejects.toMatchObject({ code: 'not_found' });
    await expect(coordinator.execution.dispatch({ planId: plan.id, taskId: t.id })).rejects.toThrow(/not available yet/);
  });
});

describe('the new planner calls', () => {
  it('validate their input and behave like the underlying methods', async () => {
    const { svc, planner, store, methods, u } = setup();
    const plan = await planner.startPlan({ title: 'Castle' });
    expect(await methods.canvasPatch!(plan.id, { upsertNodes: { task_abcd12: { x: 4, y: 5 } }, mode: 'board' })).toEqual({ layoutRev: 1 });
    expect(((await methods.canvasLoad!(plan.id)) as { layout: { nodes: unknown } }).layout.nodes).toEqual({ task_abcd12: { x: 4, y: 5 } });
    expect(await methods.chatAppend!(plan.id, { messages: [{ role: 'user', text: 'a castle' }], provider: 'claude', model: 'claude-sonnet-5-5' })).toEqual({ stored: 1 });
    expect((await store.readChat(plan.id)).messages).toHaveLength(1);
    expect(((await methods.view!(plan.id)) as { planId: string }).planId).toBe(plan.id);

    expect(() => methods.canvasPatch!(plan.id, { upsertNodes: { '__bad key': { x: 1, y: 1 } } })).toThrow();
    expect(() => methods.canvasPatch!(plan.id, { surprise: true })).toThrow();
    expect(() => methods.canvasLoad!('../../etc')).toThrow();
    expect(() => methods.chatAppend!(plan.id, { messages: [], provider: 'claude' })).toThrow();
    expect(() => methods.chatAppend!(plan.id, { messages: [{ role: 'system', text: 'hi' }] })).toThrow();
    expect(() => methods.proposeChanges!(plan.id, { note: '', changes: [] })).toThrow();
    // none of that touched the plan
    const after = await svc.getProject(u, plan.id);
    expect(after.revision).toBe(plan.revision);
  });
});

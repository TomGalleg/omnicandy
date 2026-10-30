import { describe, expect, it } from 'vitest';
import type { PlannerProject, PlanTask, Proposal } from './planner';
import { nextAction } from './plannerNext';
import { buildProjectView } from './projectView';

const NOW = new Date('2026-06-01T12:00:00Z');
const bare = (): PlannerProject => ({
  id: 'plan_abc123', title: 'Film', goal: '', description: '', scope: '', constraints: [], deliverables: [], kinds: [], revision: 3, planRevision: 2, metaRev: 1, createdAt: '', updatedAt: '',
  items: [], tasks: [], assets: [], milestones: [], proposals: [], packages: [], reports: [], planVersions: [], counters: { package: 0, activity: 0 },
});
const task = (id: string, over: Partial<PlanTask> = {}): PlanTask => ({
  id, title: id, description: '', status: 'todo', priority: 'normal', parentId: null, dependsOn: [], completionChecks: [], expectedOutputs: [], assetIds: [], milestoneId: null,
  appRef: null, packageId: null, claim: null, progressNote: '', rev: 1, createdAt: '', updatedAt: '', createdBy: { kind: 'user', name: 'You' }, ...over,
});
const act = (p: PlannerProject) => nextAction(buildProjectView(p, { now: NOW }));

describe('the one line that says what to do next', () => {
  it('asks a new project to start with the General Manager', () => {
    expect(act(bare())).toEqual({ text: expect.stringContaining('Tell the General Manager what you want to make'), talksToManager: true, button: { label: 'Talk to the General Manager', tab: 'studio' } });
  });

  it('points at the task to work on next, with that task brought to the front', () => {
    const p = { ...bare(), tasks: [task('task_a', { title: 'Sketch it' })] };
    const a = act(p)!;
    expect(a.text).toContain('Sketch it');
    expect(a.button).toEqual({ label: 'Work on this', tab: 'handoffs', taskId: 'task_a' });
    expect(a.talksToManager).toBeUndefined(); // a button that does something else stays everywhere
  });

  it('puts a suggestion that is waiting for the owner first', () => {
    const pr: Proposal = { id: 'prop_1', proposedBy: { kind: 'other', name: 'General Manager' }, at: '', note: '', changes: [{ op: 'add_task', title: 'X', description: '', priority: 'normal', dependsOn: [], completionChecks: [] }], status: 'pending', source: 'pasted' };
    const p = { ...bare(), tasks: [task('task_a')], proposals: [pr] };
    expect(act(p)!.button).toEqual({ label: 'Look at the suggestion', tab: 'studio' });
  });

  it('says so when every task is done, and says nothing for a plan that has nothing to say', () => {
    const done = { ...bare(), tasks: [task('task_a', { status: 'accepted' })] };
    expect(act(done)!.text).toContain('Every task is done');
    expect(act(done)!.button.tab).toBe('studio');
    expect(act(done)!.talksToManager).toBe(true);
  });

  it('never gives a button that opens an Advanced-only tab', () => {
    const p = { ...bare(), tasks: [task('task_a'), task('task_b', { status: 'reported' })] };
    for (const plan of [bare(), p, { ...p, tasks: [] }]) { const a = act(plan); if (a) expect(['studio', 'handoffs', 'town']).toContain(a.button.tab); }
  });
});

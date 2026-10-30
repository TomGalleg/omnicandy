import { describe, expect, it } from 'vitest';
import { defaultOrder, emptyQueue, nextStep, orderPrompt, parseOrder, respectDependencies } from './buildQueue';
import type { PlanTask } from './planner';

let n = 0;
const task = (title: string, o: Partial<PlanTask> = {}): PlanTask => ({
  id: `t${++n}`, title, description: '', status: 'todo', priority: 'normal', parentId: null, dependsOn: [], completionChecks: [], expectedOutputs: [], assetIds: [], milestoneId: null, appRef: null,
  packageId: null, claim: null, progressNote: '', rev: 1, createdAt: '', updatedAt: '', createdBy: { kind: 'user', name: 'You' }, ...o,
});
const works = (d: string) => ['creative-director', 'ai-director'].includes(d);

describe('putting the work in order', () => {
  it('puts what others need first, then urgent before low, then the order they were added', () => {
    const art = task('Draw it'); const brief = task('Write the brief'); const check = task('Check it', { priority: 'low' }); const urgent = task('Pick the model', { priority: 'urgent' });
    art.dependsOn = [brief.id];
    const order = defaultOrder([art, brief, check, urgent]);
    expect(order).toEqual([urgent.id, brief.id, art.id, check.id]);
  });
  it('ignores tasks that are not open, and cannot hang on a loop', () => {
    const a = task('A'); const b = task('B'); a.dependsOn = [b.id]; b.dependsOn = [a.id];
    expect(defaultOrder([a, b, task('Done', { status: 'accepted' }), task('Taken', { status: 'in_progress' })]).length).toBe(2);
  });
  it('keeps a task after the one it needs even when the AI puts it first', () => {
    const brief = task('Brief'); const art = task('Art', { dependsOn: [brief.id] });
    expect(respectDependencies([art.id, brief.id], [brief, art])).toEqual([brief.id, art.id]);
  });
});

describe('the Production Director\'s answer', () => {
  const a = task('Style brief', { assignee: 'creative-director' }); const b = task('Dragon art', { assignee: 'creative-director' }); const c = task('Check the art', { assignee: 'quality-director' });
  it('asks with numbers and the job of each task', () => {
    const p = orderPrompt([a, b, c]).user;
    expect(p).toContain('1. Style brief (for Creative Director)'); expect(p).toContain('3. Check the art (for Quality Director)'); expect(p).toContain('Order: 2, 1, 3');
  });
  it('uses a good answer', () => {
    const r = parseOrder('Order: 3, 1, 2\nThe check comes first here because it sets the bar.', [a, b, c]);
    expect(r.order).toEqual([c.id, a.id, b.id]); expect(r.usedAi).toBe(true); expect(r.why).toContain('sets the bar');
  });
  it('survives nonsense: unknown numbers, repeats, missing tasks, no answer at all', () => {
    expect(parseOrder('Order: 9, 2, 2, 0', [a, b, c]).order).toEqual([b.id, a.id, c.id]);
    const none = parseOrder('I think art is nice.', [a, b, c]);
    expect(none.usedAi).toBe(false); expect(none.order).toEqual(defaultOrder([a, b, c]));
    expect(parseOrder('', [a, b, c]).order).toHaveLength(3);
  });
});

describe('what is next', () => {
  it('runs the first open task whose needs are done, and treats a reported one as done', () => {
    const brief = task('Brief', { assignee: 'creative-director' }); const art = task('Art', { assignee: 'creative-director', dependsOn: [brief.id] });
    expect(nextStep([brief.id, art.id], [brief, art], works)).toMatchObject({ kind: 'run', director: 'creative-director', task: { id: brief.id } });
    const reported = { ...brief, status: 'reported' as const };
    expect(nextStep([brief.id, art.id], [reported, art], works)).toMatchObject({ kind: 'run', task: { id: art.id } });
  });
  it('is done when nothing open is left', () => { expect(nextStep(['x'], [task('A', { status: 'accepted' })], works)).toEqual({ kind: 'done' }); expect(nextStep([], [], works)).toEqual({ kind: 'done' }); });
  it('flags the owner for an adviser\'s task, and for a task whose need is unfinished', () => {
    const q = task('Quality pass', { assignee: 'quality-director' });
    expect(nextStep([q.id], [q], works)).toMatchObject({ kind: 'wait', director: 'quality-director' });
    const gm = task('Write the brief'); // no assignee: the General Manager
    expect(nextStep([gm.id], [gm], works)).toMatchObject({ kind: 'wait', director: 'general-manager' });
    const blocked = task('Blocked need', { status: 'blocked' }); const after = task('After', { assignee: 'creative-director', dependsOn: [blocked.id] });
    const s = nextStep([after.id], [blocked, after], works); expect(s.kind).toBe('wait'); expect(s.kind === 'wait' && s.message).toContain('needs "Blocked need"');
  });
  it('starts empty and idle', () => { expect(emptyQueue()).toMatchObject({ status: 'idle', order: [], finished: [] }); });
});

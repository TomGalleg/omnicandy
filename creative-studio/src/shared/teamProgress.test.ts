import { describe, expect, it } from 'vitest';
import { emptyQueue, type BuildQueue } from './buildQueue';
import type { PlanReport, PlannerProject, PlanTask } from './planner';
import { teamProgressLines } from './teamProgress';

let n = 0;
const task = (title: string, director: string | null, o: Partial<PlanTask> = {}): PlanTask => ({
  id: `t${++n}`, title, description: '', status: 'todo', priority: 'normal', parentId: null, dependsOn: [], completionChecks: [], expectedOutputs: [], assetIds: [], milestoneId: null, appRef: null,
  assignee: director, packageId: null, claim: null, progressNote: '', rev: 1, createdAt: '', updatedAt: '', createdBy: { kind: 'user', name: 'You' }, ...o,
});
const plan = (tasks: PlanTask[], reports: Partial<PlanReport>[] = []): PlannerProject => ({ tasks, reports } as unknown as PlannerProject);
const q = (o: Partial<BuildQueue>): BuildQueue => ({ ...emptyQueue(), ...o });

describe('what the directors are told about progress', () => {
  it('says nothing when the plan has no tasks', () => { expect(teamProgressLines(plan([]), null)).toEqual([]); });

  it('before a build: the order the open tasks would be done in, and what is next', () => {
    const brief = task('Style brief', 'creative-director'); const art = task('Dragon art', 'creative-director', { dependsOn: [brief.id] });
    const t = teamProgressLines(plan([art, brief]), null).join('\n');
    expect(t).toContain('Nobody has started building yet');
    expect(t.indexOf('Style brief')).toBeLessThan(t.indexOf('Dragon art'));
    expect(t).toContain('Next up: "Style brief" (Creative Director)');
  });

  it('during a build: follows the queue order, says who is working on what, and what is finished with what it made', () => {
    const brief = task('Style brief', 'creative-director', { status: 'reported' }); const art = task('Dragon art', 'ai-director'); const check = task('Check it', 'quality-director');
    const report = { taskId: brief.id, outcome: 'complete', status: 'submitted', submittedAt: '2026-01-02T00:00:00Z', outputs: [{ description: 'style-brief.docx' }] } as Partial<PlanReport>;
    const t = teamProgressLines(plan([brief, art, check], [report]), q({ status: 'running', order: [brief.id, art.id, check.id], current: art.id, finished: [brief.id] })).join('\n');
    expect(t).toContain('put the work in this order');
    expect(t).toContain('1. "Style brief" (Creative Director): finished, waiting for the owner to review. Result: complete, made style-brief.docx.');
    expect(t).toContain('Right now: AI Director is working on "Dragon art".');
    expect(t).not.toContain('Next up');
  });

  it('tells who needs the owner, and that a paused or finished build is so', () => {
    const a = task('A', 'quality-director');
    expect(teamProgressLines(plan([a]), q({ status: 'waiting', order: [a.id], waiting: { taskId: a.id, director: 'quality-director', message: 'Needs a talk.' } })).join('\n')).toContain('waiting for the owner: Quality Director needs them. Needs a talk.');
    expect(teamProgressLines(plan([a]), q({ status: 'paused', order: [a.id] })).join('\n')).toContain('The build is paused.');
    expect(teamProgressLines(plan([task('B', null, { status: 'reported' })]), q({ status: 'done', order: ['x'] })).join('\n')).toContain('The build is finished');
  });

  it('marks blocked, sent-back and accepted tasks, and leaves cancelled ones out', () => {
    const blocked = task('Stuck', 'creative-director', { status: 'blocked', progressNote: 'No AI maker is set up.' }); const gone = task('Dropped', null, { status: 'cancelled' }); const ok = task('Done one', 'media-manager', { status: 'accepted' });
    const t = teamProgressLines(plan([blocked, gone, ok]), null).join('\n');
    expect(t).toContain('blocked. No AI maker is set up.'); expect(t).toContain('accepted by the owner'); expect(t).not.toContain('Dropped');
  });

  it('is bounded for a very big plan, and always carries the rule not to redo or over-claim', () => {
    const many = Array.from({ length: 60 }, (_, i) => task(`Task ${i}`, 'creative-director'));
    const lines = teamProgressLines(plan(many), null);
    expect(lines.length).toBeLessThan(40); expect(lines.join('\n')).toContain('36 more tasks not listed');
    expect(lines.at(-1)).toContain('do not redo finished work');
  });
});

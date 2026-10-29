import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlannerProject, PlanTask } from '@shared/planner';
import { buildProjectView, currentTask, leafProgress } from '@shared/projectView';

const NOW = new Date('2026-06-01T12:00:00Z');
const FIX = path.join(__dirname, '__fixtures__');
const load = (n: string) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.project.json`), 'utf8')) as PlannerProject;

const bare = (): PlannerProject => ({
  id: 'plan_abc123', title: 'Film', goal: 'A short film', description: '', scope: '', constraints: [], deliverables: [], kinds: [], revision: 3, planRevision: 2, metaRev: 1, createdAt: '', updatedAt: '',
  items: [], tasks: [], assets: [], milestones: [], proposals: [], packages: [], reports: [], planVersions: [], counters: { package: 0, activity: 0 },
});
const task = (id: string, over: Partial<PlanTask> = {}): PlanTask => ({
  id, title: id, description: '', status: 'todo', priority: 'normal', parentId: null, dependsOn: [], completionChecks: [], expectedOutputs: [], assetIds: [], milestoneId: null,
  appRef: null, packageId: null, claim: null, progressNote: '', rev: 1, createdAt: '', updatedAt: '', createdBy: { kind: 'user', name: 'You' }, ...over,
});

describe('buildProjectView', () => {
  it.each(['fresh', 'mid-claim', 'outdated-report', 'superseded'])('builds a view of the %s fixture', (name) => {
    const p = load(name);
    const v = buildProjectView(p, { now: NOW });
    expect(v.planId).toBe(p.id);
    expect(v.revision).toBe(p.revision);
    expect(v.nodes[0]?.kind).toBe('project');
    const ids = v.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of p.tasks) expect(ids).toContain(t.id);
    for (const e of v.edges) { expect(ids).toContain(e.from); expect(ids).toContain(e.to); }
    expect(v.capabilities).toBeNull();
    expect(v.team).toBeNull();
    expect(v.town).toBeNull();
  });

  it('is deterministic and never changes the plan it reads', () => {
    const p = load('mid-claim');
    const before = JSON.stringify(p);
    expect(buildProjectView(p, { now: NOW })).toEqual(buildProjectView(p, { now: NOW }));
    expect(JSON.stringify(p)).toBe(before);
  });

  it('calls a top-level task a task and a subtask a task, and nests milestones, without caring which application is named', () => {
    const p = bare();
    p.milestones.push({ id: 'ms_aaaa', title: 'Act one', due: '', rev: 1 });
    p.tasks.push(task('task_a', { milestoneId: 'ms_aaaa', appRef: { kind: 'external', id: 'made-up.app', note: '' } }), task('task_b', { parentId: 'task_a' }), task('task_c', { dependsOn: ['task_a'] }));
    const v = buildProjectView(p, { now: NOW });
    const by = (id: string) => v.nodes.find((n) => n.id === id)!;
    expect(by('task_a')).toMatchObject({ kind: 'chunk', parentId: 'ms_aaaa', resourceHint: { id: 'made-up.app' } });
    expect(by('task_b')).toMatchObject({ kind: 'task', parentId: 'task_a' });
    expect(by('task_c')).toMatchObject({ kind: 'chunk', parentId: 'project:plan_abc123' });
    expect(v.edges).toContainEqual({ id: 'dep:task_a>task_c', from: 'task_a', to: 'task_c', kind: 'dependsOn' });
    expect(by('task_c').flags.waiting).toBe(true);
  });

  it('counts leaves only, and a task whose subtasks are all done is not marked accepted', () => {
    const p = bare();
    p.tasks.push(task('task_a'), task('task_b', { parentId: 'task_a', status: 'accepted' }), task('task_c', { parentId: 'task_a', status: 'accepted' }), task('task_d'));
    expect(leafProgress(p)).toEqual({ done: 2, total: 3, percent: 67 });
    expect(leafProgress(p, ['task_a'])).toEqual({ done: 2, total: 2, percent: 100 });
    const v = buildProjectView(p, { now: NOW });
    const a = v.nodes.find((n) => n.id === 'task_a')!;
    expect(a.progress).toEqual({ done: 2, total: 2, percent: 100 });
    expect(p.tasks.find((t) => t.id === 'task_a')!.status).toBe('todo');
    expect(a.status?.label).toBe('To Do');
  });

  it('shows pending proposals as ghosts that are not part of the plan, and ignores decided ones', () => {
    const p = bare();
    p.tasks.push(task('task_a'));
    p.proposals.push(
      { id: 'prop_1', proposedBy: { kind: 'other', name: 'Brainstorm AI' }, at: '', note: 'ideas', status: 'pending', source: 'connection', changes: [{ op: 'add_task', title: 'Rig the hero', description: '', priority: 'normal', dependsOn: ['task_a'], completionChecks: [] }, { op: 'add_milestone', title: 'Act two', due: '' }] },
      { id: 'prop_2', proposedBy: { kind: 'other', name: 'x' }, at: '', note: '', status: 'rejected', source: 'connection', changes: [{ op: 'add_milestone', title: 'Nope', due: '' }] },
    );
    const v = buildProjectView(p, { now: NOW });
    const ghosts = v.nodes.filter((n) => n.kind === 'ghost');
    expect(ghosts.map((g) => g.id)).toEqual(['ghost:prop_1:0', 'ghost:prop_1:1']);
    expect(ghosts[0]?.ghost).toMatchObject({ proposalId: 'prop_1', changeIndex: 0, by: 'Brainstorm AI', op: 'add_task' });
    expect(v.edges).toContainEqual({ id: 'gdep:task_a>ghost:prop_1:0', from: 'task_a', to: 'ghost:prop_1:0', kind: 'ghostDependsOn' });
    expect(v.progress.total).toBe(1);
    expect(v.pendingProposals).toHaveLength(1);
    expect(p.tasks).toHaveLength(1);
  });

  it('picks the current task like the Work tab does', () => {
    const p = bare();
    p.tasks.push(task('task_a', { status: 'accepted' }), task('task_b', { dependsOn: ['task_c'] }), task('task_c'));
    expect(currentTask(p)?.id).toBe('task_c');
    expect(currentTask(p, 'task_b')?.id).toBe('task_b');
    expect(buildProjectView(p, { now: NOW }).current?.taskId).toBe('task_c');
    p.lastActive = { taskId: 'task_b', title: 'b', at: '', what: 'opened' };
    expect(currentTask(p)?.id).toBe('task_b');
  });
});

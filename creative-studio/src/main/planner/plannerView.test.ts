import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASK_STATUSES, type PlannerProject, type PlanTask, type TaskStatus } from '@shared/planner';
import { displayStatus, needsYou, plannerTabBadge, SIMPLE_LABEL, SIMPLE_STATUSES } from '@shared/plannerView';

const NOW = new Date('2026-06-01T12:00:00Z');
const FIX = path.join(__dirname, '__fixtures__');
const load = (n: string) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.project.json`), 'utf8')) as PlannerProject;

const bare = (): PlannerProject => ({
  id: 'plan_x', title: 'x', goal: '', description: '', scope: '', constraints: [], deliverables: [], kinds: [], revision: 1, planRevision: 1, metaRev: 1, createdAt: '', updatedAt: '',
  items: [], tasks: [], assets: [], milestones: [], proposals: [], packages: [], reports: [], planVersions: [], counters: { package: 0, activity: 0 },
});
const task = (over: Partial<PlanTask> = {}): PlanTask => ({
  id: 't1', title: 'T', description: '', status: 'todo', priority: 'normal', parentId: null, dependsOn: [], completionChecks: [], expectedOutputs: [], assetIds: [], milestoneId: null,
  appRef: null, packageId: null, claim: null, progressNote: '', rev: 1, createdAt: '', updatedAt: '', createdBy: { kind: 'user', name: 'You' }, ...over,
});
const claim = (until: string) => ({ token: 'k', packageId: 'pkg_1', executor: { kind: 'claude-code' as const, name: 'Claude Code' }, claimedAt: '', leaseUntil: until, note: '' });

describe('displayStatus', () => {
  it('every stored status maps to one of the five labels (cancelled is flagged as removed)', () => {
    const p = bare();
    for (const s of TASK_STATUSES) {
      const d = displayStatus(task({ status: s }), p, NOW);
      expect(SIMPLE_STATUSES).toContain(d.label);
      expect(d.removed === true).toBe(s === 'cancelled');
    }
    for (const s of TASK_STATUSES as readonly TaskStatus[]) expect(SIMPLE_LABEL[s]).toBeTruthy();
  });

  it('done, blocked and revision keep their meaning', () => {
    const p = bare();
    expect(displayStatus(task({ status: 'accepted' }), p, NOW).label).toBe('Done');
    expect(displayStatus(task({ status: 'blocked', progressNote: 'No licence' }), p, NOW)).toMatchObject({ label: 'Blocked', chip: 'No licence' });
    expect(displayStatus(task({ status: 'revision', progressNote: 'Bigger logo' }), p, NOW)).toMatchObject({ label: 'To Do', chip: 'Changes requested: Bigger logo' });
  });

  it('a live claim is "working", an expired one is "stalled" and asks for attention', () => {
    const p = bare();
    expect(displayStatus(task({ status: 'in_progress', claim: claim('2026-06-01T20:00:00Z') }), p, NOW)).toMatchObject({ label: 'In Progress', chip: 'Claude Code is working on it' });
    const s = displayStatus(task({ status: 'in_progress', claim: claim('2026-06-01T01:00:00Z') }), p, NOW);
    expect(s).toMatchObject({ label: 'In Progress', stalled: true });
    expect(needsYou({ ...p, tasks: [task({ status: 'in_progress', claim: claim('2026-06-01T01:00:00Z') })] }, NOW).stalled).toBe(1);
  });

  it('waiting on a dependency stays To Do (not Blocked)', () => {
    const p = bare();
    p.tasks = [task({ id: 'a', title: 'First' }), task({ id: 'b', dependsOn: ['a'] })];
    expect(displayStatus(p.tasks[1]!, p, NOW)).toMatchObject({ label: 'To Do', chip: 'Waiting for First' });
  });

  it('works on projects made by the current build (golden fixtures)', () => {
    const mid = load('mid-claim');
    const t = mid.tasks.find((x) => x.claim)!;
    expect(displayStatus(t, mid, new Date(t.claim!.claimedAt)).label).toBe('In Progress');
    const sup = load('superseded');
    expect(displayStatus(sup.tasks.find((x) => x.packageId)!, sup, NOW)).toMatchObject({ label: 'In Progress', chip: 'Sent to AI, waiting for a result' });
    const out = load('outdated-report');
    const rep = out.tasks.find((x) => x.status === 'reported')!;
    expect(displayStatus(rep, out, NOW)).toMatchObject({ label: 'Needs Review', planChanged: true });
    expect(needsYou(out, NOW).reports).toBe(1);
    expect(needsYou(out, NOW).suggestions).toBe(1); // the question raised in the report
  });
});

describe('plainError', () => {
  it('rewrites known messages and leaves unknown ones alone', async () => {
    const { plainError } = await import('@shared/plannerView');
    expect(plainError('This task was changed by someone else (revision 4, you had 3). Reload it and apply your change again.')).toMatch(/changed while you were looking/);
    expect(plainError('Claude Code already claimed this task (until 2026-01-01T00:00:00Z).')).toMatch(/^Claude Code is already working on this/);
    expect(plainError('The plan changed after this work was handed off. Review what changed, then accept knowingly.')).toMatch(/tick the box/);
    expect(plainError('Not applied: "A" changed after this was proposed. Reject the proposal or deselect those changes.')).toMatch(/Untick those items/);
    expect(plainError('Something new and unexpected.')).toBe('Something new and unexpected.');
  });
});

describe('plannerTabBadge', () => {
  it('counts results to review plus suggestions, only for the plan of the open project', () => {
    expect(plannerTabBadge([])).toBe(0);
    expect(plannerTabBadge([{ inThisProject: false, awaitingReview: 5, pendingProposals: 5 }])).toBe(0);
    expect(plannerTabBadge([
      { inThisProject: false, awaitingReview: 9, pendingProposals: 9 },
      { inThisProject: true, awaitingReview: 2, pendingProposals: 1 },
    ])).toBe(3);
  });
});

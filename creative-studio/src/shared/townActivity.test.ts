import { describe, expect, it } from 'vitest';
import type { PlanTask, TaskClaim, TaskStatus } from './planner';
import { ACTIVITY_LABEL, directorActivity } from './townActivity';

const NOW = new Date('2026-06-01T12:00:00Z');
const claim = (leaseUntil: string): TaskClaim => ({ token: 't', packageId: 'pkg_1', executor: { kind: 'createcraft', name: 'OmniCandy Claude' }, claimedAt: '2026-06-01T11:00:00Z', leaseUntil, note: '' });
let n = 0;
const task = (over: Partial<PlanTask> & { status: TaskStatus }): PlanTask => ({
  id: `task_${++n}`, title: `Task ${n}`, description: '', priority: 'normal', parentId: null, dependsOn: [], completionChecks: [], expectedOutputs: [], assetIds: [], milestoneId: null,
  appRef: null, packageId: null, claim: null, progressNote: '', rev: 1, createdAt: '', updatedAt: '', createdBy: { kind: 'user', name: 'You' }, ...over,
});
const live = claim('2026-06-01T13:00:00Z');
const expired = claim('2026-06-01T11:30:00Z');

describe('what a director is really doing', () => {
  it('is nothing at all for a plan with no tasks, and for tasks nobody owns', () => {
    expect(directorActivity({ tasks: [] }, NOW)).toEqual({});
    expect(directorActivity({ tasks: [task({ status: 'in_progress', claim: live }), task({ status: 'reported' }), task({ status: 'blocked' })] }, NOW)).toEqual({});
  });

  it('is working only while the claim is live, never on an expired one or a bare in-progress mark', () => {
    const owned = (over: Partial<PlanTask> & { status: TaskStatus }) => task({ assignee: 'technical-director', ...over });
    expect(directorActivity({ tasks: [owned({ status: 'in_progress', claim: live })] }, NOW)['technical-director']?.state).toBe('working');
    expect(directorActivity({ tasks: [owned({ status: 'in_progress', claim: expired })] }, NOW)).toEqual({});
    expect(directorActivity({ tasks: [owned({ status: 'in_progress' })] }, NOW)).toEqual({});
    expect(directorActivity({ tasks: [owned({ status: 'todo', claim: live })] }, NOW)).toEqual({});
  });

  it('puts what needs the owner first, then work in progress, then blocks, and lists the tasks behind it', () => {
    const t = [
      task({ assignee: 'quality-director', status: 'blocked', title: 'Stuck one' }),
      task({ assignee: 'quality-director', status: 'in_progress', claim: live, title: 'Busy one' }),
      task({ assignee: 'quality-director', status: 'reported', title: 'Result one' }),
      task({ assignee: 'quality-director', status: 'reported', title: 'Result two' }),
    ];
    const a = directorActivity({ tasks: t }, NOW)['quality-director']!;
    expect(a.state).toBe('needs-you');
    expect(a.tasks.map((x) => x.title)).toEqual(['Result one', 'Result two']);
    expect(ACTIVITY_LABEL[a.state]).toBe('Waiting for you');
  });

  it('forgets finished and removed tasks, and a task owned by something that is not a director', () => {
    expect(directorActivity({ tasks: [task({ assignee: 'creative-director', status: 'accepted' }), task({ assignee: 'creative-director', status: 'cancelled' }), task({ assignee: 'bob', status: 'reported' })] }, NOW)).toEqual({});
  });

  it('keeps each director apart, and a claim running out takes the badge away without anything else changing', () => {
    const tasks = [task({ assignee: 'creative-director', status: 'in_progress', claim: claim('2026-06-01T12:30:00Z') }), task({ assignee: 'ai-director', status: 'reported' })];
    const early = directorActivity({ tasks }, NOW);
    expect(Object.keys(early).sort()).toEqual(['ai-director', 'creative-director']);
    const later = directorActivity({ tasks }, new Date('2026-06-01T13:00:00Z'));
    expect(Object.keys(later)).toEqual(['ai-director']);
  });

  it('never invents a state: for any mix of tasks, every result is backed by a task that really has it', () => {
    const statuses: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'reported', 'revision', 'accepted', 'cancelled'];
    const keys = ['creative-director', 'ai-director', 'bob', null, undefined] as const;
    const claims = [null, live, expired];
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let round = 0; round < 200; round++) {
      const tasks = Array.from({ length: Math.floor(rnd() * 8) }, () => task({ status: statuses[Math.floor(rnd() * statuses.length)]!, assignee: keys[Math.floor(rnd() * keys.length)], claim: claims[Math.floor(rnd() * claims.length)]! }));
      const result = directorActivity({ tasks }, NOW);
      for (const [dir, act] of Object.entries(result)) {
        for (const ref of act!.tasks) {
          const t = tasks.find((x) => x.id === ref.id)!;
          expect(t.assignee).toBe(dir);
          if (act!.state === 'working') { expect(t.status).toBe('in_progress'); expect(t.claim!.leaseUntil > NOW.toISOString()).toBe(true); }
          if (act!.state === 'needs-you') expect(t.status).toBe('reported');
          if (act!.state === 'blocked') expect(t.status).toBe('blocked');
        }
      }
    }
  });
});

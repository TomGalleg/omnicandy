import { describe, expect, it } from 'vitest';
import type { PlanTask, TaskClaim, TaskStatus } from './planner';
import { CHAT, chooseTrip, directorIntents, intentFor } from './townIntent';

const NOW = new Date('2026-06-01T12:00:00Z');
const claim = (leaseUntil: string): TaskClaim => ({ token: 't', packageId: 'pkg_1', executor: { kind: 'createcraft', name: 'OmniCandy Claude' }, claimedAt: '2026-06-01T11:00:00Z', leaseUntil, note: '' });
const live = claim('2026-06-01T13:00:00Z');
const expired = claim('2026-06-01T11:30:00Z');
let n = 0;
const task = (over: Partial<PlanTask> & { status: TaskStatus }): PlanTask => ({
  id: `task_${++n}`, title: `Chunk ${n}`, description: '', priority: 'normal', parentId: null, dependsOn: [], completionChecks: [], expectedOutputs: [], assetIds: [], milestoneId: null,
  appRef: null, packageId: null, claim: null, progressNote: '', rev: 1, createdAt: '', updatedAt: '', createdBy: { kind: 'user', name: 'You' }, ...over,
});

describe('why a director leaves their desk', () => {
  it('has no reason at all when nothing is going on, so they only chat', () => {
    expect(directorIntents({ tasks: [] }, NOW)).toEqual({});
    expect(intentFor({}, 'creative-director')).toEqual(CHAT);
    expect(intentFor({}, undefined)).toEqual(CHAT);
  });

  it('keeps a director with a result waiting, a block, or work running at their desk', () => {
    const t = [task({ assignee: 'quality-director', status: 'reported' }), task({ assignee: 'ai-director', status: 'blocked' }), task({ assignee: 'creative-director', status: 'in_progress', claim: live })];
    expect(directorIntents({ tasks: t }, NOW)).toEqual({ 'quality-director': { kind: 'stay' }, 'ai-director': { kind: 'stay' }, 'creative-director': { kind: 'stay' } });
  });

  it('sends a director to the owner of the chunk theirs builds on, only while their claim is live', () => {
    const base = task({ assignee: 'creative-director', status: 'accepted' });
    const mine = task({ assignee: 'technical-director', status: 'in_progress', claim: live, dependsOn: [base.id] });
    expect(directorIntents({ tasks: [base, mine] }, NOW)['technical-director']).toEqual({ kind: 'work-visit', target: 'creative-director' });
    const ended = task({ assignee: 'technical-director', status: 'in_progress', claim: expired, dependsOn: [base.id] });
    expect(directorIntents({ tasks: [base, ended] }, NOW)).toEqual({});
  });

  it('does not send anyone to themselves, to an unowned chunk, or to a removed one', () => {
    const own = task({ assignee: 'technical-director', status: 'accepted' });
    const nobody = task({ status: 'accepted' });
    const gone = task({ assignee: 'ai-director', status: 'cancelled' });
    const mine = task({ assignee: 'technical-director', status: 'in_progress', claim: live, dependsOn: [own.id, nobody.id, gone.id] });
    expect(directorIntents({ tasks: [own, nobody, gone, mine] }, NOW)['technical-director']).toEqual({ kind: 'stay' });
  });
});

describe('what a director does when their time at the desk is up', () => {
  const doors = ['creative', 'ai', 'prod'];
  it('goes to a random neighbour to chat when there is nothing going on', () => {
    expect(chooseTrip(CHAT, doors, undefined, () => 0)).toEqual({ go: true, to: 'creative', purpose: 'chat' });
    expect(chooseTrip(CHAT, doors, undefined, () => 0.99)).toEqual({ go: true, to: 'prod', purpose: 'chat' });
    expect(chooseTrip(CHAT, [], undefined, () => 0)).toEqual({ go: false });
  });

  it('never leaves for a chat while there is real work or a result waiting', () => {
    for (let i = 0; i < 20; i++) expect(chooseTrip({ kind: 'stay' }, doors, undefined, () => i / 20)).toEqual({ go: false });
  });

  it('goes to the one office a work visit is for, and nowhere else', () => {
    expect(chooseTrip({ kind: 'work-visit', target: 'creative-director' }, doors, 'creative', () => 0.99)).toEqual({ go: true, to: 'creative', purpose: 'work' });
    expect(chooseTrip({ kind: 'work-visit', target: 'creative-director' }, doors, undefined, () => 0)).toEqual({ go: false });
  });
});

import { describe, expect, it } from 'vitest';
import type { PlannerProject } from './planner';
import { generalManagerPrompt } from './generalManager';
import { READY_MARK } from './plannerChat';
import { defaultTown } from './town';

const NOW = new Date('2026-06-01T12:00:00Z');
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const town = defaultTown(NOW, rnd);
const plan = { id: 'plan_abc123', title: 'Dragon Burger', goal: 'A friendly game', description: '', scope: '', constraints: [], deliverables: [], kinds: [], revision: 1, planRevision: 1, metaRev: 1, createdAt: '', updatedAt: '', items: [], tasks: [], assets: [], milestones: [], proposals: [], packages: [], reports: [], planVersions: [], counters: { package: 0, activity: 0 } } as unknown as PlannerProject;
const base = { town, plan, context: ['OmniCandy project "Dragons".'], news: ['What changed in the plan lately (newest last):', '- today, You: Accepted 2 tasks'], apps: ['Blender'] };

describe('the General Manager is the same person behind every door', () => {
  it('knows who they are, their team, the project, what changed and what is connected, in every setting', () => {
    for (const setting of ['planning', 'meeting'] as const) {
      const p = generalManagerPrompt({ ...base, setting });
      expect(p).toContain('the General Manager and project coordinator');
      expect(p).toContain('Creative Director');
      expect(p).toContain('Quality Director');
      expect(p).toContain('Dragon Burger');
      expect(p).toContain('Accepted 2 tasks');
      expect(p).toContain('Blender');
      expect(p).toContain('OmniCandy project "Dragons"');
    }
  });

  it('in planning, talks the idea through and offers the plan: the ready question, its marker and the task format', () => {
    const p = generalManagerPrompt({ ...base, setting: 'planning' });
    expect(p).toContain(READY_MARK);
    expect(p).toContain('Ready to start building?');
    expect(p).toContain('which people on your team you would lean on');
    expect(generalManagerPrompt(base)).toBe(p); // planning is the default
  });

  it('when asked for the tasks, writes them in the plan format and nothing else', () => {
    const p = generalManagerPrompt({ ...base, mode: 'chunks' });
    expect(p).toContain('## Tasks');
    expect(p).not.toContain(READY_MARK);
    expect(p).toContain('the General Manager and project coordinator');
  });

  it('in a meeting, speaks briefly and never offers to start building', () => {
    const p = generalManagerPrompt({ ...base, setting: 'meeting' });
    expect(p).toContain('meeting at the Town Hall');
    expect(p).not.toContain(READY_MARK);
    expect(p).not.toContain('Ready to start building?');
  });

  it('leaves out what it was not given, without blank noise', () => {
    const p = generalManagerPrompt({ town, plan });
    expect(p).not.toContain('Applications connected');
    expect(p).not.toContain('What changed in the plan lately');
  });

  it('never carries file locations or the owner\'s private files', () => {
    expect(generalManagerPrompt({ ...base, setting: 'planning' })).not.toMatch(/[A-Za-z]:[\\/]Users/);
  });
});

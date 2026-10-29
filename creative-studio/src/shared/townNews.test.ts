import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from './planner';
import { recentChangeLines } from './townNews';

const NOW = new Date('2026-06-10T12:00:00Z');
let seq = 0;
const entry = (over: Partial<ActivityEntry> & { at: string; summary: string }): ActivityEntry => ({ seq: ++seq, actor: { kind: 'user', name: 'You' }, kind: 'proposal.accepted', revision: 1, planAffecting: false, ...over });

describe('what the General Manager is told has changed', () => {
  it('says nothing when nothing changed', () => {
    expect(recentChangeLines([], NOW)).toEqual([]);
    expect(recentChangeLines([entry({ at: '2026-05-01T00:00:00Z', summary: 'Old' })], NOW)).toEqual([]);
  });

  it('lists the latest changes, newest last, with who and when, and leaves out noise and old news', () => {
    const lines = recentChangeLines([
      entry({ at: '2026-06-01T10:00:00Z', summary: 'Too old' }),
      entry({ at: '2026-06-08T10:00:00Z', summary: 'Accepted 3 change(s) proposed by Creative Director', actor: { kind: 'user', name: 'You' } }),
      entry({ at: '2026-06-09T10:00:00Z', summary: 'Conversation saved', kind: 'chat' }),
      entry({ at: '2026-06-10T09:00:00Z', summary: 'Submitted a report for "Build the loader"', actor: { kind: 'createcraft', name: 'OmniCandy Claude' }, kind: 'report.submitted' }),
    ], NOW);
    expect(lines[0]).toContain('What changed in the plan lately');
    expect(lines.slice(1)).toEqual([
      '- 2 days ago, You: Accepted 3 change(s) proposed by Creative Director',
      '- today, OmniCandy Claude: Submitted a report for "Build the loader"',
    ]);
  });

  it('keeps only the newest few and cuts a long line', () => {
    const many = Array.from({ length: 30 }, (_, i) => entry({ at: '2026-06-10T08:00:00Z', summary: `Change ${i}` }));
    const lines = recentChangeLines(many, NOW);
    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toContain('Change 29');
    expect(recentChangeLines([entry({ at: '2026-06-10T08:00:00Z', summary: 'x'.repeat(500) })], NOW)[1]!.length).toBeLessThan(200);
  });
});

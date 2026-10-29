import { describe, expect, it } from 'vitest';
import { clampMeetingTurns, MEETING_TURNS, meetingConfirmText, summaryPrompt, turnOrder, turnPrompt } from './townMeeting';

const notes = Array.from({ length: 20 }, (_, i) => ({ by: `P${i}`, text: `said ${i}`, at: '' }));

describe('a meeting with AI help', () => {
  it('has a small number of replies, never fewer than two or more than twelve', () => {
    expect(clampMeetingTurns(undefined)).toBe(MEETING_TURNS.default);
    expect(clampMeetingTurns(0)).toBe(2);
    expect(clampMeetingTurns(5.9)).toBe(5);
    expect(clampMeetingTurns(500)).toBe(12);
    expect(clampMeetingTurns(Number.NaN)).toBe(6);
  });

  it('has everyone speak in turn, round and round, and exactly as many times as allowed', () => {
    expect(turnOrder(['a', 'b', 'c'], 5)).toEqual(['a', 'b', 'c', 'a', 'b']);
    expect(turnOrder(['a', 'a', 'b'], 3)).toEqual(['a', 'b', 'a']);
    expect(turnOrder([], 6)).toEqual([]);
    expect(turnOrder(['a'], 1000)).toHaveLength(12);
  });

  it('asks each speaker for a short view from their own job, and carries only the latest notes', () => {
    const p = turnPrompt({ topic: 'The dragon', kind: 'brainstorm' }, { name: 'Creative Director' }, ['AI Director'], notes);
    expect(p).toContain('brainstorm meeting about: The dragon');
    expect(p).toContain('It is your turn, Creative Director');
    expect(p).toContain('P19: said 19');
    expect(p).not.toContain('P11: said 11');
    expect(p.length).toBeLessThan(6000);
    expect(turnPrompt({ topic: 'x', kind: 'other' }, { name: 'A' }, [], [{ by: 'B', text: 'long '.repeat(2000), at: '' }]).length).toBeLessThan(6000);
    expect(p).toContain('do not say anything is done');
    expect(turnPrompt({ topic: 'x', kind: 'other' }, { name: 'A' }, [], [])).toContain('Nobody has spoken yet.');
  });

  it('asks for the plan format at the end, and allows "nothing decided"', () => {
    const s = summaryPrompt({ topic: 'The dragon' }, notes.slice(0, 2));
    expect(s).toContain('## Tasks');
    expect(s).toContain('If nothing clear was decided');
  });

  it('tells the owner the most it can cost in requests, and what it will and will not do', () => {
    const t = meetingConfirmText(6, 3, 'Claude', 'claude-opus-5-5');
    expect(t).toContain('up to 7 requests');
    expect(t).toContain('3 people');
    expect(t).toContain('at most one suggestion');
    expect(t).toContain('waits for you');
    expect(meetingConfirmText(100, 1, 'OpenAI', 'gpt')).toContain('up to 13 requests');
  });
});

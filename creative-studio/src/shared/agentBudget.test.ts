import { describe, expect, it } from 'vitest';
import { CLAUDE_SEND_TURNS, clampSendTurns } from './agentBudget';

describe('how many steps work started from the Planner may take', () => {
  it('uses the panel\'s own limit when nothing is asked for', () => {
    expect(clampSendTurns(undefined)).toBe(CLAUDE_SEND_TURNS.default);
    expect(clampSendTurns(Number.NaN)).toBe(CLAUDE_SEND_TURNS.default);
  });

  it('honours a smaller limit, rounds down, and never goes below one step or above the panel\'s own limit', () => {
    expect(clampSendTurns(40)).toBe(40);
    expect(clampSendTurns(20.9)).toBe(20);
    expect(clampSendTurns(0)).toBe(1);
    expect(clampSendTurns(-5)).toBe(1);
    expect(clampSendTurns(10_000)).toBe(300);
  });
});

import { describe, expect, it } from 'vitest';
import { parsePlanUsage } from './planUsage';

describe('parsePlanUsage', () => {
  it('reads session, weekly and credits like Claude Code shows them', () => {
    const p = parsePlanUsage({
      five_hour: { utilization: 4, resets_at: '2026-10-26T06:59:59.850572+00:00' },
      seven_day: { utilization: 38, resets_at: '2026-10-29T12:59:59+00:00' },
      seven_day_opus: null,
      extra_usage: { is_enabled: true, monthly_limit: 15000, used_credits: 2976 },
    }, 'pro', 1);
    expect(p.session?.percent).toBe(4);
    expect(p.weekly?.percent).toBe(38);
    expect(p.weeklyOpus).toBeNull();
    expect(p.credits).toEqual({ usedUsd: 29.76, limitUsd: 150 });
    expect(p.session?.resetsAt).toBe(Date.parse('2026-10-26T06:59:59.850572+00:00'));
  });
  it('shows no credits when extra usage is off', () => {
    expect(parsePlanUsage({ extra_usage: { is_enabled: false, monthly_limit: 0, used_credits: 0 } }, null).credits).toBeNull();
  });
});

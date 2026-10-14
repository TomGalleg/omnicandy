import { describe, expect, it } from 'vitest';
import type { ClaudeChatItem } from './claude';
import { buildResumeContext, parseHistory } from './claudeHistory';

const item = (n: number, role: ClaudeChatItem['role'], text = `m${n}`): ClaudeChatItem => ({ id: `i${n}`, role, text, at: '2026-10-14T00:00:00Z' });

describe('claude history', () => {
  it('drops malformed saved items', () => {
    const out = parseHistory({ items: [item(1, 'user'), { id: 1 }, null, { ...item(2, 'claude'), role: 'bogus' }] });
    expect(out.map((i) => i.id)).toEqual(['i1']);
    expect(parseHistory('x')).toEqual([]);
  });
  it('is empty without conversation and ignores activity', () => {
    expect(buildResumeContext([])).toBe('');
    expect(buildResumeContext([item(1, 'activity'), item(2, 'error')])).toBe('');
  });
  it('sends a short summary plus only the last few messages', () => {
    const items: ClaudeChatItem[] = [];
    for (let i = 0; i < 30; i++) items.push(item(i, i % 2 ? 'claude' : 'user', `${i % 2 ? 'answer' : 'request'} ${i} ${'x'.repeat(1000)}`));
    const ctx = buildResumeContext(items);
    expect(ctx).toContain('Earlier requests');
    expect(ctx).toContain('answer 29');
    expect(ctx).not.toContain('answer 1 ');
    expect(ctx.length).toBeLessThan(4000);
  });
});

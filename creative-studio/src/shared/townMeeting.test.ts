import { describe, expect, it } from 'vitest';
import { costText, invitePrompt, MAX_TASK_LINES, parseTaskLines, replyPrompt, summaryPrompt } from './townMeeting';

const notes = Array.from({ length: 20 }, (_, i) => ({ by: i % 2 ? 'General Manager' : 'You', text: `said ${i}`, at: '' }));

describe('a meeting run one person at a time', () => {
  it('asks the person the owner is talking with to answer them directly, from their own job', () => {
    const p = replyPrompt({ topic: 'The dragon', kind: 'brainstorm' }, { name: 'Creative Director' }, ['AI Director'], notes);
    expect(p).toContain('brainstorm meeting with the owner');
    expect(p).toContain('Creative Director, the owner is talking to you');
    expect(p).toContain('say who');
    expect(p).toContain('do not say anything is done');
    expect(p).toContain('said 19');
    expect(p).not.toContain('said 11');
    expect(p.length).toBeLessThan(6000);
    expect(replyPrompt({ topic: 'x', kind: 'other' }, { name: 'A' }, [], [{ by: 'B', text: 'long '.repeat(2000), at: '' }]).length).toBeLessThan(6000);
    expect(replyPrompt({ topic: 'x', kind: 'other' }, { name: 'A' }, [], [])).toContain('nobody else');
  });

  it('asks an invited colleague for what they would add, never to pass, and never to repeat', () => {
    const p = invitePrompt({ topic: 'The dragon', kind: 'brainstorm' }, { name: 'Quality Director' }, 'General Manager', notes);
    expect(p).toContain('Quality Director, the owner has invited you to add your view');
    expect(p).toContain('The owner has been talking with General Manager');
    expect(p).toContain('Do not repeat others');
    expect(p).toContain('Task: <short title>');
    expect(p).not.toContain('PASS');
    expect(p).toContain('said 19');
    expect(p).not.toContain('said 11');
    expect(p.length).toBeLessThan(6000);
  });

  it('lets a person recommend up to two tasks on lines of their own, and takes those lines out of what they say', () => {
    const r = parseTaskLines('Art comes first.\nTask: Pick a style for the dragon\n- **Task:** Sketch three dragon directions\nTask: Pick a style for the dragon\nTask: A third one');
    expect(r.tasks).toEqual(['Pick a style for the dragon', 'Sketch three dragon directions']);
    expect(r.tasks).toHaveLength(MAX_TASK_LINES);
    expect(r.text).toBe('Art comes first.');
    const plain = 'The next task is to decide the style. Tasks matter here.';
    expect(parseTaskLines(plain)).toEqual({ text: plain, tasks: [] });
    expect(parseTaskLines('Task:   \nhello').tasks).toEqual([]);
    expect(parseTaskLines(`Task: ${'x'.repeat(500)}`).tasks[0]).toHaveLength(200);
  });

  it('tells people how to recommend a task, and that the owner decides', () => {
    const a = replyPrompt({ topic: 'x', kind: 'other' }, { name: 'A' }, [], []);
    const b = invitePrompt({ topic: 'x', kind: 'other' }, { name: 'B' }, 'A', []);
    for (const p of [a, b]) { expect(p).toContain('Task: <short title>'); expect(p).toContain('the owner decides whether it is added'); }
  });

  it('asks for the plan format at the end, and allows "nothing decided"', () => {
    const s = summaryPrompt({ topic: 'The dragon' }, notes.slice(0, 2));
    expect(s).toContain('## Tasks');
    expect(s).toContain('If nothing clear was decided');
  });

  it('says plainly what a message costs, and that a ! is free', () => {
    expect(costText(true, 'Claude', 'claude-opus-5-5')).toContain('one request to Claude (claude-opus-5-5)');
    expect(costText(true, 'Claude', 'm')).toContain('costs nothing');
    expect(costText(true, 'Claude', 'm')).toContain('only if you click it');
    expect(costText(false, 'OpenAI', 'gpt')).toContain('Nobody else shows a !');
    expect(costText(false, 'OpenAI', 'gpt')).not.toContain('one more request');
  });
});

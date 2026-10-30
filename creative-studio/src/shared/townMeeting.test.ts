import { describe, expect, it } from 'vitest';
import { chimePickPrompt, chimePrompt, costText, isPass, parsePick, replyPrompt, summaryPrompt } from './townMeeting';

const notes = Array.from({ length: 20 }, (_, i) => ({ by: i % 2 ? 'General Manager' : 'You', text: `said ${i}`, at: '' }));

describe('a meeting run one person at a time', () => {
  it('knows a pass when it sees one, and only then', () => {
    for (const t of ['PASS', 'pass.', ' Pass! ', 'PASS\n', '"PASS"']) expect(isPass(t)).toBe(true);
    for (const t of ['Passing the loader to Quality makes sense because it is needed.', 'I think we should go with 2D.', '']) expect(isPass(t)).toBe(false);
  });

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

  it('asks who, if anyone, should speak up, lists only the others with their jobs, and makes NONE the usual answer', () => {
    const p = chimePickPrompt('General Manager', [{ name: 'Creative Director', job: 'Art and the look.' }, { name: 'Quality Director', specialty: 'Testing' }], ['Creative Director'], notes);
    expect(p).toContain('The owner is talking with General Manager');
    expect(p).toContain('- Creative Director: Art and the look.');
    expect(p).toContain('- Quality Director: Testing');
    expect(p).toContain('Do not pick anyone who spoke in the last few turns (Creative Director)');
    expect(p).toContain('Most of the time nobody needs to speak up');
    expect(p).toContain('or NONE');
    expect(p).not.toContain('- General Manager:');
    expect(chimePickPrompt('A', [{ name: 'B' }], [], []).length).toBeLessThan(2000);
  });

  it('reads the pick: the one title it names, the first if it rambles, and nobody for NONE or a stranger', () => {
    const names = ['Creative Director', 'Quality Director', 'AI Director'];
    expect(parsePick('Quality Director', names)).toBe('Quality Director');
    expect(parsePick('  "quality director".', names)).toBe('Quality Director');
    expect(parsePick('I would say the AI Director, not the Creative Director.', names)).toBe('AI Director');
    expect(parsePick('NONE', names)).toBeNull();
    expect(parsePick('Bob should speak', names)).toBeNull();
    expect(parsePick('', names)).toBeNull();
  });

  it('asks the chosen person for what the owner most needs to hear, or a pass', () => {
    const p = chimePrompt({ name: 'Quality Director' }, 'General Manager', notes);
    expect(p).toContain('You are Quality Director');
    expect(p).toContain('between the owner and General Manager');
    expect(p).toContain('reply with exactly: PASS');
    expect(p.length).toBeLessThan(6000);
  });

  it('asks for the plan format at the end, and allows "nothing decided"', () => {
    const s = summaryPrompt({ topic: 'The dragon' }, notes.slice(0, 2));
    expect(s).toContain('## Tasks');
    expect(s).toContain('If nothing clear was decided');
  });

  it('says plainly what a message costs, with and without others speaking up', () => {
    expect(costText(true, 'Claude', 'claude-opus-5-5')).toContain('one request to Claude (claude-opus-5-5)');
    expect(costText(true, 'Claude', 'm')).toContain('up to two short ones');
    expect(costText(false, 'OpenAI', 'gpt')).toContain('Nobody else speaks up unless you click them');
    expect(costText(false, 'OpenAI', 'gpt')).not.toContain('two short');
  });
});

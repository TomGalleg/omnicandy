import { describe, expect, it } from 'vitest';
import { isNo, isYes, wantsBuild } from './ownerReply';

describe('a plain yes', () => {
  it('is recognised in the ways people say it', () => {
    for (const t of ['yes', 'Yes!', 'yeah', 'yep do it', 'sure, go ahead', 'ok', 'okay', 'yes please', 'sounds good', 'do it', 'yes, do that', 'Absolutely', 'yeah let\'s do it', 'go for it']) expect(isYes(t), t).toBe(true);
  });
  it('is not a yes when it has a condition, a change, a question or is long', () => {
    for (const t of ['yes but make it blue', 'no', 'not yet', 'yes?', 'what would that cost', 'yes and also add a mushroom', 'sure, but wait', 'maybe', 'yes I think we should talk about the style first', '', '   ', 'do not do it', 'don\'t']) expect(isYes(t), t).toBe(false);
  });
});

describe('a plain no', () => {
  it('is recognised, and a yes is not a no', () => {
    for (const t of ['no', 'nope', 'no thanks', 'not now', 'skip', 'nah', 'never mind']) expect(isNo(t), t).toBe(true);
    for (const t of ['yes', 'no, make it red instead please do', 'what?', 'not sure about that one']) expect(isNo(t), t).toBe(false);
  });
});

describe('"let\'s build this"', () => {
  it('is recognised in a few words', () => {
    for (const t of ['let\'s build this', 'Lets build it!', 'start building', 'ok let\'s build this', 'build it now', 'get started', 'let\'s go', 'go ahead and build it', 'time to start', 'begin building']) expect(wantsBuild(t), t).toBe(true);
  });
  it('is not triggered by ordinary talk about building', () => {
    for (const t of ['I want to build a wall in the picture', 'how do we build this?', 'build a dragon with a long tail and green scales', 'what should we build first', 'yes', '']) expect(wantsBuild(t), t).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { handCandidates, HAND_THRESHOLD, pickHandRaiser, type HandInput } from './townHands';
import type { DirectorKey } from './town';

const people: Array<{ id: string; name: string; director: DirectorKey }> = [
  { id: 'agent_gm', name: 'General Manager', director: 'general-manager' },
  { id: 'agent_cd', name: 'Creative Director', director: 'creative-director' },
  { id: 'agent_td', name: 'Technical Director', director: 'technical-director' },
  { id: 'agent_qd', name: 'Quality Director', director: 'quality-director' },
  { id: 'agent_md', name: 'Media Manager', director: 'media-manager' },
  { id: 'agent_ai', name: 'AI Director', director: 'ai-director' },
];
const base = (over: Partial<HandInput> = {}): HandInput => ({ candidates: handCandidates(people, []), talkingWithId: 'agent_gm', ownerText: '', recentSpeakerIds: [], messagesSinceHand: 99, ...over });
const pick = (over: Partial<HandInput> = {}) => pickHandRaiser(base(over));

describe('who raises a hand, by rules and for free', () => {
  it('nobody raises a hand for a message that has nothing to do with their job', () => {
    expect(pick({ ownerText: 'Hello, how are you today?' })).toBeNull();
    expect(pick({ ownerText: 'We want to make something nice.', replyText: 'Lovely. Tell me more about it.' })).toBeNull();
  });

  it('the person the owner names raises a hand, by title or by the first word of it', () => {
    expect(pick({ ownerText: 'What does the Creative Director think?' })?.id).toBe('agent_cd');
    expect(pick({ ownerText: 'I wonder about quality here' })?.id).not.toBe('agent_gm');
    const named = pick({ ownerText: 'Maybe the technical side needs a look' });
    expect(named?.id).toBe('agent_td');
    expect(named?.reason).toContain('you mentioned them');
  });

  it('the person the owner is talking with names someone in their answer, and that person raises a hand', () => {
    const p = pick({ ownerText: 'I want to make a small game about a friendly dragon.', replyText: 'The Creative Director can sketch the look first, and then we decide.' });
    expect(p?.id).toBe('agent_cd');
    expect(p?.reason).toContain('named in the answer');
  });

  it('words that belong to a job raise that person\'s hand once enough of them come up', () => {
    expect(pick({ ownerText: 'I want a watercolour style with soft colours and a friendly character.' })?.id).toBe('agent_cd');
    expect(pick({ ownerText: 'Which model and prompt should write it, and what will it cost?' })?.id).toBe('agent_ai');
    // one stray word is not enough
    expect(pick({ ownerText: 'It will be a game.' })).toBeNull();
  });

  it('an open task of theirs that the conversation touches counts, and a task of someone else does not', () => {
    const withTask = handCandidates(people, [{ title: 'Test the loader on phone and PC', status: 'todo', assignee: 'quality-director' }, { title: 'Draw the dragon', status: 'todo', assignee: 'creative-director' }]);
    const p = pickHandRaiser(base({ candidates: withTask, ownerText: 'How is the loader coming along? Does it check out on the phone?' }));
    expect(p?.id).toBe('agent_qd');
    expect(p?.reason).toContain('has a task');
    expect(pickHandRaiser(base({ candidates: withTask, ownerText: 'How is the loader coming along?' }))?.id).not.toBe('agent_cd');
    const done = handCandidates(people, [{ title: 'Test the loader on phone and PC', status: 'accepted', assignee: 'quality-director' }]);
    expect(done.find((c) => c.id === 'agent_qd')!.taskTitles).toEqual([]);
  });

  it('the person being talked with never raises a hand', () => {
    expect(pick({ talkingWithId: 'agent_cd', ownerText: 'The Creative Director should pick a watercolour style and colour palette.' })).toBeNull();
  });

  it('someone who just spoke is passed over unless they were named', () => {
    const text = { ownerText: 'I want a watercolour style with soft colours and a friendly character.' };
    expect(pick({ ...text, recentSpeakerIds: ['agent_cd'] })).toBeNull();
    expect(pick({ ...text, recentSpeakerIds: ['agent_cd', 'agent_td', 'agent_qd'] })?.id).toBe('agent_cd'); // not one of the last two turns
    expect(pick({ ownerText: 'What would the Creative Director say?', recentSpeakerIds: ['agent_cd'] })?.id).toBe('agent_cd');
  });

  it('the person talked with already covers the topic, so a colleague with the same topics stays quiet', () => {
    // Talking with the Creative Director about art: the Media Manager only shares "format"/"size"-type words with nobody here, but the Creative Director\'s own words are covered.
    const p = pick({ talkingWithId: 'agent_cd', ownerText: 'Pick the style and the colour palette.', replyText: 'I would go with soft watercolour.' });
    expect(p).toBeNull();
  });

  it('is not on every message: after a hand a message must pass, unless the owner names someone', () => {
    const text = { ownerText: 'I want a watercolour style with soft colours and a friendly character.' };
    expect(pick({ ...text, messagesSinceHand: 0 })).toBeNull();
    expect(pick({ ...text, messagesSinceHand: 1 })?.id).toBe('agent_cd');
    expect(pick({ ownerText: 'And the Quality Director?', messagesSinceHand: 0 })?.id).toBe('agent_qd');
  });

  it('shows only the best candidate, and is deterministic', () => {
    const input = base({ ownerText: 'Ask the Creative Director about colour and style, and the Quality Director about tests.' });
    const a = pickHandRaiser(input); const b = pickHandRaiser(input);
    expect(a).toEqual(b);
    expect(a && a.score >= HAND_THRESHOLD).toBe(true);
  });

  it('does not care about case, and never invents a person who is not at the table', () => {
    expect(pick({ ownerText: 'THE CREATIVE DIRECTOR, PLEASE' })?.id).toBe('agent_cd');
    expect(pick({ ownerText: 'What would the Research Director say about this?' })).toBeNull(); // nobody by that name is seated
  });
});

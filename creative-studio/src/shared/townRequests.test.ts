import { describe, expect, it } from 'vitest';
import type { Proposal } from './planner';
import { directorActivity } from './townActivity';
import { isRequest, MAX_TEAM_LINES, noteText, parseTeamLines, pendingRequests, requestIntents, requestProposal, REQUEST_NOTE } from './townRequests';

describe('what a worker writes for another worker', () => {
  it('reads an Ask and a Note line, takes them out of the text, and keeps the rest', () => {
    const r = parseTeamLines('The dragon needs a rig.\n\nAsk: Technical Director — please build a loader for the model\nNote: Quality Director - it is two metres tall');
    expect(r.text).toBe('The dragon needs a rig.');
    expect(r.lines).toEqual([
      { kind: 'ask', to: 'technical-director', what: 'please build a loader for the model' },
      { kind: 'note', to: 'quality-director', what: 'it is two metres tall' },
    ]);
  });

  it('understands bullets, bold and a short title, and never guesses a name', () => {
    const r = parseTeamLines('- **Ask:** Creative — a sketch of the wings\nAsk: Bob — do it\nAsk: Director — do it too');
    expect(r.lines).toEqual([{ kind: 'ask', to: 'creative-director', what: 'a sketch of the wings' }]);
    expect(r.unknown).toEqual(['Bob', 'Director']);
    expect(r.text).toBe('');
  });

  it('reads at most two lines from one reply, and leaves ordinary sentences alone', () => {
    const many = Array.from({ length: 5 }, (_, i) => `Note: AI Director — fact ${i}`).join('\n');
    expect(parseTeamLines(many).lines).toHaveLength(MAX_TEAM_LINES);
    const plain = 'I will ask the Technical Director tomorrow: it is a good idea.\nNote that the art is done.';
    expect(parseTeamLines(plain)).toEqual({ text: plain, lines: [], unknown: [] });
  });

  it('turns a request into one pending task owned by the director it is for, from the worker who asked', () => {
    const r = requestProposal('Creative Director', { kind: 'ask', to: 'technical-director', what: 'Build a loader for the dragon model' });
    expect(r.proposer.name).toBe('Creative Director');
    expect(r.note).toBe(`${REQUEST_NOTE}Creative Director asks Technical Director`);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ op: 'add_task', title: 'Build a loader for the dragon model', assignee: 'technical-director' });
    expect(isRequest(r)).toBe(true);
    expect(isRequest({ note: 'Tasks from the planning chat' })).toBe(false);
    expect(noteText('Creative Director', 'It is two metres tall')).toBe('(Note from Creative Director) It is two metres tall');
  });
});

const proposal = (over: Partial<Proposal>): Proposal => ({ id: 'prop_1', proposedBy: { kind: 'other', name: 'Creative Director' }, at: '', note: '', changes: [], status: 'pending', source: 'pasted', ...over });
const ask = (from: string, to: Parameters<typeof requestProposal>[1]['to'], status: Proposal['status'] = 'pending') => { const r = requestProposal(from, { kind: 'ask', to, what: 'Do the thing' }); return proposal({ proposedBy: r.proposer, note: r.note, changes: r.changes, status }); };
const agents = [{ name: 'Creative Director', director: 'creative-director' as const }, { name: 'Technical Director', director: 'technical-director' as const }, { name: 'Mira' }];

describe('a request that is waiting for the owner', () => {
  it('shows the one it is for as waiting for the owner, and only while it waits', () => {
    expect(directorActivity({ tasks: [], proposals: [ask('Creative Director', 'technical-director')] }, new Date())['technical-director']?.state).toBe('needs-you');
    expect(directorActivity({ tasks: [], proposals: [ask('Creative Director', 'technical-director', 'accepted')] }, new Date())).toEqual({});
    expect(directorActivity({ tasks: [], proposals: [ask('Creative Director', 'technical-director', 'rejected')] }, new Date())).toEqual({});
  });

  it('is not confused with ordinary suggestions, which light up nobody', () => {
    const plain = proposal({ note: 'Tasks from the planning chat', changes: [{ op: 'add_task', title: 'X', description: '', priority: 'normal', dependsOn: [], completionChecks: [], assignee: 'technical-director' }] });
    expect(pendingRequests([plain])).toEqual([]);
    expect(directorActivity({ tasks: [], proposals: [plain] }, new Date())).toEqual({});
  });

  it('sends the one who asked to see the one they asked, only for a real director and never to themselves', () => {
    expect(requestIntents([ask('Creative Director', 'technical-director')], agents)).toEqual({ 'creative-director': { kind: 'work-visit', target: 'technical-director' } });
    expect(requestIntents([ask('Mira', 'technical-director')], agents)).toEqual({});
    expect(requestIntents([ask('Creative Director', 'creative-director')], agents)).toEqual({});
    expect(requestIntents([ask('Creative Director', 'technical-director', 'accepted')], agents)).toEqual({});
    expect(requestIntents(undefined, agents)).toEqual({});
  });
});

import { describe, expect, it } from 'vitest';
import {
  agentSystemPrompt, activeAgents, addMeetingNote, addTeamSuggestion, applyTeamChanges, coordinatorOf, decideTeamSuggestion, defaultTown, endMeeting, linkMeetingProposal, startMeeting, withDirectors,
  suggestTeamFromPlan, tierFor, TOWN_LIMITS, townStateSchema, TownError,
} from './town';

const NOW = new Date('2026-06-01T12:00:00Z');
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

describe('a new town', () => {
  it('starts with a Town Hall and the nine directors, each in their own office, valid against its own schema, and nobody else', () => {
    const t = defaultTown(NOW, rnd);
    expect(t.businesses[0]!.name).toBe('Town Hall');
    expect(t.workplaces[0]).toMatchObject({ kind: 'town-hall' });
    expect(t.agents.map((a) => a.name)).toEqual(['General Manager', 'Creative Director', 'AI Director', 'Software Director', 'Production Director', 'Technical Director', 'Quality Director', 'Research Director', 'Media Manager']);
    expect(new Set(t.agents.map((a) => a.workplaceId)).size).toBe(9); // nobody shares an office
    expect(t.agents.every((a) => (a.job ?? '').length > 40)).toBe(true); // each one understands their job
    expect(coordinatorOf(t)).toMatchObject({ name: 'General Manager', director: 'general-manager' });
    expect(townStateSchema.safeParse(t).success).toBe(true);
    expect(t.meetings).toEqual([]);
  });
  it('sizes a building by how many people work there, with any count allowed', () => {
    expect([0, 1, 2, 5, 6, 40].map(tierFor)).toEqual(['studio', 'studio', 'workshop', 'workshop', 'factory', 'factory']);
  });
});

describe('team changes', () => {
  it('adds businesses with their own workplace and workers with identities, and several of one kind are fine', () => {
    let t = defaultTown(NOW, rnd);
    t = applyTeamChanges(t, [{ op: 'add_business', name: 'Character Animation', trade: 'Animating people' }, { op: 'add_agent', name: 'Mira', specialty: 'Walk cycles', businessId: '@last' }, { op: 'add_agent', name: 'Teo', specialty: 'Faces', businessId: '@last' }], NOW, rnd);
    t = applyTeamChanges(t, [{ op: 'add_business', name: 'Environment Animation', trade: '' }], NOW, rnd);
    expect(t.businesses.slice(10).map((b) => b.name)).toEqual(['Character Animation', 'Environment Animation']);
    const anim = t.businesses.find((b) => b.name === 'Character Animation')!;
    expect(activeAgents(t, anim.id).map((a) => a.name)).toEqual(['Mira', 'Teo']);
    expect(anim.managerId).toBe(activeAgents(t, anim.id)[0]!.id);
    expect(new Set(t.workplaces.map((w) => w.id)).size).toBe(t.workplaces.length);
    expect(t.rev).toBe(3);
    expect(townStateSchema.safeParse(t).success).toBe(true);
  });

  it('moves, retires and renames, protects the coordinator and the Town Hall, and is all-or-nothing', () => {
    let t = defaultTown(NOW, rnd);
    t = applyTeamChanges(t, [{ op: 'add_business', name: 'Art', trade: '' }, { op: 'add_agent', name: 'Ana', specialty: '', businessId: '@last' }, { op: 'add_business', name: 'Sound', trade: '' }], NOW, rnd);
    const ana = t.agents.find((a) => a.name === 'Ana')!;
    const sound = t.businesses.find((b) => b.name === 'Sound')!;
    const moved = applyTeamChanges(t, [{ op: 'move_agent', agentId: ana.id, businessId: sound.id }], NOW, rnd);
    expect(moved.agents.find((a) => a.id === ana.id)).toMatchObject({ businessId: sound.id });
    expect(moved.businesses.find((b) => b.id === sound.id)!.managerId).toBe(ana.id);
    expect(moved.businesses.find((b) => b.name === 'Art')!.managerId).toBeNull();
    const coordinator = coordinatorOf(t)!;
    expect(() => applyTeamChanges(t, [{ op: 'retire_agent', agentId: coordinator.id }], NOW, rnd)).toThrow(TownError);
    expect(() => applyTeamChanges(t, [{ op: 'move_agent', agentId: coordinator.id, businessId: sound.id }], NOW, rnd)).toThrow(/own office/);
    expect(() => applyTeamChanges(t, [{ op: 'rename_business', businessId: t.businesses[0]!.id, name: 'Elsewhere' }], NOW, rnd)).toThrow(/keeps its name/);
    expect(() => applyTeamChanges(t, [{ op: 'add_business', name: 'art', trade: '' }], NOW, rnd)).toThrow(/already/);
    const before = JSON.stringify(t);
    expect(() => applyTeamChanges(t, [{ op: 'add_business', name: 'Fine', trade: '' }, { op: 'retire_agent', agentId: 'agent_missing1' }], NOW, rnd)).toThrow(TownError);
    expect(JSON.stringify(t)).toBe(before);
    const retired = applyTeamChanges(t, [{ op: 'retire_agent', agentId: ana.id }], NOW, rnd);
    expect(activeAgents(retired)).toHaveLength(9);
    expect(retired.agents).toHaveLength(10);
  });

  it('refuses a bad reference to a business that was not added first, and unknown operations', () => {
    const t = defaultTown(NOW, rnd);
    expect(() => applyTeamChanges(t, [{ op: 'add_agent', name: 'X', specialty: '', businessId: '@last' }], NOW, rnd)).toThrow(/not added before/);
    expect(() => applyTeamChanges(t, [{ op: 'conjure' } as never], NOW, rnd)).toThrow();
  });

  it('stops at the limits', () => {
    let t = defaultTown(NOW, rnd);
    for (let i = 0; i < TOWN_LIMITS.businesses - 10; i++) t = applyTeamChanges(t, [{ op: 'add_business', name: `B${i}`, trade: '' }], NOW, rnd);
    expect(() => applyTeamChanges(t, [{ op: 'add_business', name: 'One too many', trade: '' }], NOW, rnd)).toThrow(/more businesses/);
  });
});

describe('a worker understands its job', () => {
  const plan = { id: 'plan_abc123', title: 'Dragon Burger', goal: 'A branded launch kit', description: '', scope: '', constraints: [], deliverables: [], kinds: [], revision: 1, planRevision: 1, metaRev: 1, createdAt: '', updatedAt: '',
    items: [], tasks: [{ title: 'Design the logo', status: 'todo' }], assets: [], milestones: [], proposals: [], packages: [], reports: [], planVersions: [], counters: { package: 0, activity: 0 } } as never;

  it('is hired with a job, can have it changed or cleared, and the job is stored with the worker', () => {
    let t = defaultTown(NOW, rnd);
    t = applyTeamChanges(t, [{ op: 'add_business', name: 'Design Studio', trade: 'Branding' }, { op: 'add_agent', name: 'Mira', specialty: '', job: 'Design the logo and brand colours.', businessId: '@last' }], NOW, rnd);
    const mira = t.agents.find((a) => a.name === 'Mira')!;
    expect(mira.job).toBe('Design the logo and brand colours.');
    t = applyTeamChanges(t, [{ op: 'update_agent', agentId: mira.id, job: 'Design the logo only.' }], NOW, rnd);
    expect(t.agents.find((a) => a.id === mira.id)!.job).toBe('Design the logo only.');
    t = applyTeamChanges(t, [{ op: 'update_agent', agentId: mira.id, job: '' }], NOW, rnd);
    expect(t.agents.find((a) => a.id === mira.id)!.job).toBeUndefined();
    expect(townStateSchema.safeParse(t).success).toBe(true);
    expect(() => applyTeamChanges(t, [{ op: 'update_agent', agentId: 'agent_missing1', job: 'x' }], NOW, rnd)).toThrow(TownError);
  });

  it('is told who it is, its job, its place, its team and the project, and that the owner decides', () => {
    let t = defaultTown(NOW, rnd);
    t = applyTeamChanges(t, [{ op: 'add_business', name: 'Design Studio', trade: 'Branding and logos' }, { op: 'add_agent', name: 'Mira', specialty: 'Logos', job: 'Design the logo and brand colours.', businessId: '@last' }, { op: 'add_business', name: 'Sound', trade: '' }, { op: 'add_agent', name: 'Teo', specialty: 'Jingles', businessId: '@last' }], NOW, rnd);
    const mira = t.agents.find((a) => a.name === 'Mira')!;
    const prompt = agentSystemPrompt(t, mira, plan);
    expect(prompt).toContain('You are Mira');
    expect(prompt).toContain('Design Studio');
    expect(prompt).toContain('Your job: Design the logo and brand colours.');
    expect(prompt).toContain('Branding and logos');
    expect(prompt).toContain('- Teo: Jingles');
    expect(prompt).toContain('(coordinator)');
    expect(prompt).toContain('Dragon Burger');
    expect(prompt).toContain('A branded launch kit');
    expect(prompt).toContain('Design the logo');
    expect(prompt).toMatch(/owner decides/);
    expect(prompt).toMatch(/Never say that something is done/);
    expect(prompt).not.toContain('Mira:'); // not listed among its own teammates
  });

  it('falls back to a sensible job when none was written', () => {
    const t = defaultTown(NOW, rnd);
    const p = agentSystemPrompt(t, coordinatorOf(t)!, plan);
    expect(p).toContain('You are General Manager, the project coordinator');
    expect(p).toMatch(/Coordinate the whole project/);
  });
});

describe('suggestions from the coordinator', () => {
  it('proposes one studio and one specialist per kind of work named in the plan, for any application, and never twice', () => {
    const t = defaultTown(NOW, rnd);
    const changes = suggestTeamFromPlan(t, [{ id: 'blender', note: '' }, { id: 'made-up.app', note: 'x' }, { id: 'Blender', note: '' }, { id: '', note: '' }]);
    expect(changes.map((c) => c.op)).toEqual(['add_business', 'add_agent', 'add_business', 'add_agent']);
    expect(changes[0]).toMatchObject({ name: 'Blender Studio' });
    expect(changes[2]).toMatchObject({ name: 'Made Up App Studio' });
    const { town, suggestion } = addTeamSuggestion(t, 'Coordinator', 'From the plan', changes, NOW, rnd);
    expect(town.businesses).toHaveLength(10); // a suggestion changes nothing by itself
    const accepted = decideTeamSuggestion(town, suggestion.id, true, NOW, rnd);
    expect(accepted.businesses.slice(10).map((b) => b.name)).toEqual(['Blender Studio', 'Made Up App Studio']);
    expect(accepted.suggestions[0]!.status).toBe('accepted');
    expect(suggestTeamFromPlan(accepted, [{ id: 'blender', note: '' }])).toEqual([]);
    expect(() => decideTeamSuggestion(accepted, suggestion.id, false, NOW, rnd)).toThrow(/already decided/);
    const rejected = decideTeamSuggestion(town, suggestion.id, false, NOW, rnd);
    expect(rejected.businesses).toHaveLength(10);
    expect(rejected.suggestions[0]!.status).toBe('rejected');
  });
  it('refuses a suggestion that could never be applied', () => {
    expect(() => addTeamSuggestion(defaultTown(NOW, rnd), 'C', '', [{ op: 'retire_agent', agentId: 'agent_nothere1' }], NOW, rnd)).toThrow(TownError);
  });
});

describe('meetings', () => {
  it('records who came, what was said and what it led to; the coordinator always attends', () => {
    let t = defaultTown(NOW, rnd);
    t = applyTeamChanges(t, [{ op: 'add_business', name: 'Art', trade: '' }, { op: 'add_agent', name: 'Ana', specialty: '', businessId: '@last' }], NOW, rnd);
    const ana = t.agents.find((a) => a.name === 'Ana')!;
    const started = startMeeting(t, { topic: 'How do we build the hero?', kind: 'planning', participantIds: [ana.id] }, NOW, rnd);
    expect(started.meeting.participantIds).toEqual([coordinatorOf(t)!.id, ana.id]);
    let m = addMeetingNote(started.town, started.meeting.id, { by: 'Ana', text: 'Concept first.' }, NOW);
    m = linkMeetingProposal(m, started.meeting.id, 'prop_abc123', NOW);
    m = linkMeetingProposal(m, started.meeting.id, 'prop_abc123', NOW);
    m = endMeeting(m, started.meeting.id, NOW);
    expect(m.meetings[0]).toMatchObject({ notes: [{ by: 'Ana', text: 'Concept first.' }], proposalIds: ['prop_abc123'], endedAt: NOW.toISOString() });
    expect(() => addMeetingNote(m, started.meeting.id, { by: 'x', text: 'late' }, NOW)).toThrow(/over/);
    expect(townStateSchema.safeParse(m).success).toBe(true);
  });
  it('needs a topic, real attendees and a sensible size', () => {
    let t = defaultTown(NOW, rnd);
    expect(() => startMeeting(t, { topic: '  ', participantIds: [] }, NOW, rnd)).toThrow(/topic/);
    expect(() => startMeeting(t, { topic: 'x', participantIds: ['agent_ghost001'] }, NOW, rnd)).toThrow(/no worker/);
    const names = Array.from({ length: 13 }, (_, i) => `W${i}`);
    t = applyTeamChanges(t, [{ op: 'add_business', name: 'Crowd', trade: '' }, ...names.map((name) => ({ op: 'add_agent' as const, name, specialty: '', businessId: '@last' }))], NOW, rnd);
    expect(() => startMeeting(t, { topic: 'Everyone', participantIds: t.agents.map((a) => a.id) }, NOW, rnd)).toThrow(/at most/);
  });
});

describe('the nine main workers', () => {
  it('cannot be retired, moved or have their office renamed, but their job can be changed', () => {
    const t = defaultTown(NOW, rnd);
    const quality = t.agents.find((a) => a.director === 'quality-director')!;
    const media = t.agents.find((a) => a.director === 'media-manager')!;
    expect(() => applyTeamChanges(t, [{ op: 'retire_agent', agentId: quality.id }], NOW, rnd)).toThrow(/nine main workers/);
    expect(() => applyTeamChanges(t, [{ op: 'move_agent', agentId: quality.id, businessId: media.businessId }], NOW, rnd)).toThrow(/own office/);
    expect(() => applyTeamChanges(t, [{ op: 'rename_business', businessId: quality.businessId, name: 'Elsewhere' }], NOW, rnd)).toThrow(/nine offices/);
    const edited = applyTeamChanges(t, [{ op: 'update_agent', agentId: quality.id, job: 'Only check the audio.' }], NOW, rnd);
    expect(edited.agents.find((a) => a.id === quality.id)!.job).toBe('Only check the audio.');
  });

  it('can have helpers hired into their office, and each director is told who the others are', () => {
    const t0 = defaultTown(NOW, rnd);
    const creative = t0.agents.find((a) => a.director === 'creative-director')!;
    const t = applyTeamChanges(t0, [{ op: 'add_agent', name: 'Mira', specialty: '', job: 'Draw characters.', businessId: creative.businessId }], NOW, rnd);
    expect(activeAgents(t, creative.businessId).map((a) => a.name)).toEqual(['Creative Director', 'Mira']);
    const plan = { id: 'plan_abc123', title: 'Dragon Burger', goal: '', description: '', scope: '', constraints: [], deliverables: [], kinds: [], revision: 1, planRevision: 1, metaRev: 1, createdAt: '', updatedAt: '', items: [], tasks: [], assets: [], milestones: [], proposals: [], packages: [], reports: [], planVersions: [], counters: { package: 0, activity: 0 } } as never;
    const prompt = agentSystemPrompt(t, creative, plan);
    expect(prompt).toContain('one of the nine main workers');
    expect(prompt).toContain('Quality Director');
  });

  it('are added to a town made before they existed, keeping the old coordinator as the General Manager', () => {
    const fresh = defaultTown(NOW, rnd);
    const old = structuredClone(fresh);
    const gm = old.agents.find((a) => a.director === 'general-manager')!;
    const hall = old.businesses[0]!;
    old.agents = [{ ...gm, name: 'Coordinator', director: undefined, businessId: hall.id, workplaceId: old.workplaces[0]!.id }];
    delete old.agents[0]!.director; delete old.agents[0]!.job;
    old.businesses = [hall]; old.workplaces = [old.workplaces[0]!]; hall.managerId = gm.id;
    const up = withDirectors(old, NOW, rnd);
    expect(up.agents).toHaveLength(9);
    expect(up.agents.find((a) => a.director === 'general-manager')).toMatchObject({ id: gm.id, name: 'General Manager', role: 'coordinator' });
    expect(townStateSchema.safeParse(up).success).toBe(true);
    expect(withDirectors(up, NOW, rnd)).toBe(up); // nothing to add the second time
  });
});

import { describe, expect, it } from 'vitest';
import { addJob, cardState, loadJobs, MAX_JOBS, parseDraft, updateJob, type StudioJob } from './aiStudio';
import { studioModel } from './providerCapabilities';

const job = (o: Partial<StudioJob> = {}): StudioJob => ({ id: 'a', at: '2026-01-01', providerId: 'openai', modelId: 'm', modelLabel: 'M', prompt: 'p', settings: {}, count: 1, referenceAssetIds: [], state: 'done', ...o });

describe('card state', () => {
  it('ready only when wired and (free or keyed); planned providers are never ready', () => {
    const gpt = studioModel('openai', 'gpt-image-2.5-flare')!;
    expect(cardState(gpt, new Set())).toBe('needs-key');
    expect(cardState(gpt, new Set(['openai']))).toBe('ready');
    expect(cardState(studioModel('mock', 'mock-image')!, new Set())).toBe('ready');
    expect(cardState(studioModel('recraft', 'recraftv4_1')!, new Set(['recraft']))).toBe('ready');
    expect(cardState(studioModel('recraft', 'recraftv4_1')!, new Set())).toBe('needs-key');
    expect(cardState(studioModel('recraft', 'recraftv3')!, new Set(['recraft']))).toBe('soon');
    expect(cardState(studioModel('higgsfield', 'higgsfield-ai/soul/v2/standard')!, new Set(['higgsfield']))).toBe('soon');
  });
});

describe('job list', () => {
  it('survives garbage and never resumes a running job as running (no silent paid retry)', () => {
    expect(loadJobs(null)).toEqual([]);
    expect(loadJobs('not json')).toEqual([]);
    expect(loadJobs('{"a":1}')).toEqual([]);
    const jobs = loadJobs(JSON.stringify([job({ state: 'running' }), { id: 1 }, null, job({ id: 'b', state: 'done' })]));
    expect(jobs.map((j) => j.state)).toEqual(['failed', 'done']);
    expect(jobs[0]!.message).toMatch(/billing/);
  });
  it('adds newest first, caps the list and updates by id', () => {
    let jobs: StudioJob[] = [];
    for (let i = 0; i < MAX_JOBS + 5; i++) jobs = addJob(jobs, job({ id: String(i) }));
    expect(jobs).toHaveLength(MAX_JOBS);
    expect(jobs[0]!.id).toBe(String(MAX_JOBS + 4));
    expect(updateJob(jobs, '10', { state: 'failed' }).find((j) => j.id === '10')!.state).toBe('failed');
  });
});

describe('draft handover', () => {
  it('keeps only valid string fields', () => {
    expect(parseDraft(JSON.stringify({ providerId: 'gemini', prompt: 'hi', modelId: 5, x: 1 }))).toEqual({ providerId: 'gemini', prompt: 'hi' });
    expect(parseDraft('{}')).toBeNull();
    expect(parseDraft('oops')).toBeNull();
    expect(parseDraft(JSON.stringify({ prompt: 'x'.repeat(5000) }))).toBeNull();
  });
});

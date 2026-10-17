import { describe, expect, it } from 'vitest';
import { parseProjectPlan } from './projectPlan';

const plan = { name: 'Dune poster', kind: 'design', finishedOutput: 'A printable A2 poster', summary: 'Cinematic desert poster.', apps: ['PhotoCraft', 'DesignCraft'], aiTools: [], steps: ['Grade the photo', 'Add the title'], questions: [] };

describe('parseProjectPlan', () => {
  it('reads plain and fenced JSON', () => {
    expect(parseProjectPlan(JSON.stringify(plan)).name).toBe('Dune poster');
    expect(parseProjectPlan('Here you go:\n```json\n' + JSON.stringify(plan) + '\n```').kind).toBe('design');
  });
  it('rejects non-plans and unknown kinds', () => {
    expect(() => parseProjectPlan('sorry')).toThrow(/did not return a plan/);
    expect(() => parseProjectPlan(JSON.stringify({ ...plan, kind: 'hologram' }))).toThrow(/incomplete/);
    expect(() => parseProjectPlan(JSON.stringify({ ...plan, steps: [] }))).toThrow(/incomplete/);
  });
  it('cuts over-long lists to fit instead of rejecting the plan (all 13 apps, an extra step)', () => {
    const many = { ...plan, apps: Array.from({ length: 13 }, (_, i) => `App${i}`), steps: Array.from({ length: 11 }, (_, i) => `Step ${i}`), aiTools: ['a', 'b', 'c', 'd', 'e', 'f'] };
    const p = parseProjectPlan(JSON.stringify(many));
    expect(p.apps).toHaveLength(13);
    expect(p.steps).toHaveLength(8);
    expect(p.aiTools).toHaveLength(5);
  });
  it('reads list entries that Claude wrote as objects (model + purpose)', () => {
    const p = parseProjectPlan(JSON.stringify({ ...plan, aiTools: [{ model: 'Nano Banana', purpose: 'the dragon artwork' }, { name: 'GPT Image', for: 'text' }] }));
    expect(p.aiTools).toEqual(['Nano Banana - the dragon artwork', 'GPT Image - text']);
  });
});

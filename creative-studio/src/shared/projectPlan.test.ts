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
});

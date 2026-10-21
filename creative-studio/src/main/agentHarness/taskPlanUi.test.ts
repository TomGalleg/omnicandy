import { describe, it, expect } from 'vitest';
import { validatePlanEdit } from './taskPlan';

describe('editable agent task plans', () => {
  const steps = [{id:'one',title:'Inspect',status:'completed' as const,evidence:'Read back geometry'}, {id:'two',title:'Move',status:'pending' as const}];
  it('preserves step order, identifiers, and evidence', () => {
    const plan = validatePlanEdit('Arrange shapes',[...steps].reverse());
    expect(plan.steps.map(s=>s.id)).toEqual(['two','one']);
    expect(plan.steps[1]?.evidence).toBe('Read back geometry');
  });
  it('rejects unverified completions and duplicate IDs', () => {
    expect(() => validatePlanEdit('Goal',[{id:'a',title:'Done',status:'completed'}])).toThrow('verification evidence');
    expect(() => validatePlanEdit('Goal',[steps[0]!,{...steps[1]!,id:'one'}])).toThrow('unique');
  });
  it('allows an empty plan and rejects invalid fields', () => {
    expect(validatePlanEdit('Goal',[]).steps).toEqual([]);
    expect(() => validatePlanEdit('Goal',[{id:'a',title:'',status:'pending'}])).toThrow();
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlueprintError, parseBlueprint } from './blueprint';

const base = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'ai-generated', 'freecad-enclosure.blueprint.json'), 'utf8')) as { decision: Record<string, unknown>; commands: unknown[] };

describe('a "not feasible" answer from the AI', () => {
  it('is accepted without any control method, so the user is told the real reason', () => {
    const nf = { ...base, decision: { ...base.decision, feasible: false, notFeasibleReason: 'The pages describe no way to run commands from outside.', methods: [] }, commands: [] };
    const bp = parseBlueprint(nf);
    expect(bp.decision.feasible).toBe(false);
    expect(bp.decision.notFeasibleReason).toMatch(/no way to run commands/);
  });

  it('still requires a control method when the answer says it is feasible', () => {
    const bad = { ...base, decision: { ...base.decision, feasible: true, methods: [] } };
    expect(() => parseBlueprint(bad)).toThrow(BlueprintError);
    expect(() => parseBlueprint(bad)).toThrow(/methods/);
  });
});

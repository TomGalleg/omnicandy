import { describe, expect, it } from 'vitest';
import { TOOLBOXES } from './directorToolbox';
import { CAPABILITIES, decide, defaultPolicy, effectiveLevel, type AccessPolicy } from './teamAccess';
import { applyChange, buildView, centsToDollars, dollarsToCents } from './teamAccessView';

const box = TOOLBOXES['ai-director']; // the director who owns AI work, so it has the spending controls
const creative = TOOLBOXES['creative-director'];
const fresh = (): AccessPolicy => ({ ...defaultPolicy('w'), preset: box.preset, scope: { kind: 'project' } });

describe('the Team Access screen', () => {
  it('shows only what the job uses, at the level that really applies', () => {
    const v = buildView(fresh(), box);
    expect(v.rows.map((r) => r.capability).sort()).toEqual(['generate-media', 'propose-plan', 'read-project']);
    expect(v.rows.find((r) => r.capability === 'generate-media')).toMatchObject({ level: 'ask', max: 'allow' }); // Supervised asks about spending
    expect(v.canSpend).toBe(true); expect(v.works).toBe(true); expect(v.spendCapCents).toBeNull(); expect(v.aiVia).toBeUndefined();
    // the Creative Director's AI work goes through the AI Director, so the screen shows no AI row or spending box for them
    const c = buildView({ ...fresh(), preset: creative.preset }, creative);
    expect(c.rows.map((r) => r.capability)).not.toContain('generate-media'); expect(c.canSpend).toBe(false); expect(c.aiVia).toBe('ai-director');
    expect(buildView(fresh(), TOOLBOXES['quality-director']).canSpend).toBe(false);
  });

  it('a new preset replaces individual choices; a level change clamps to the job', () => {
    let p = applyChange(fresh(), creative, { kind: 'level', capability: 'edit-project', level: 'ask' });
    expect(buildView(p, creative).rows.find((r) => r.capability === 'edit-project')?.level).toBe('ask');
    p = applyChange(p, box, { kind: 'preset', preset: 'independent' });
    expect(p.levels).toBeUndefined();
    expect(buildView(p, box).rows.find((r) => r.capability === 'generate-media')?.level).toBe('allow');
    const gm = TOOLBOXES['general-manager'];
    const q = applyChange(fresh(), gm, { kind: 'level', capability: 'outside-apps', level: 'allow' });
    expect(effectiveLevel({ ...q, ceiling: gm.ceiling }, 'outside-apps')).toBe('read');
  });

  it('refuses a setting the job does not use, an unknown one, and a silly cap', () => {
    expect(() => applyChange(fresh(), creative, { kind: 'level', capability: 'outside-apps', level: 'allow' })).toThrow();
    expect(() => applyChange(fresh(), box, { kind: 'level', capability: 'nope' as never, level: 'allow' })).toThrow();
    expect(() => applyChange(fresh(), box, { kind: 'spend-cap', cents: -1 })).toThrow();
    expect(() => applyChange(fresh(), box, { kind: 'spend-cap', cents: 10_000_000 })).toThrow();
    expect(() => applyChange(fresh(), box, { kind: 'spend-cap', cents: Number.NaN })).toThrow();
  });

  it('sets and clears the spending cap, and the cap really lets an Allowed worker spend', () => {
    let p = applyChange(applyChange(fresh(), box, { kind: 'preset', preset: 'independent' }), box, { kind: 'spend-cap', cents: 500 });
    const spend = { capability: 'generate-media' as const, kind: 'spend' as const, label: 'x', costCents: 100, target: 'image', taskId: 't' };
    expect(decide({ ...p, ceiling: box.ceiling }, spend, { now: new Date() }).verdict).toBe('allow');
    p = applyChange(p, box, { kind: 'spend-cap', cents: null });
    expect(decide({ ...p, ceiling: box.ceiling }, spend, { now: new Date() }).verdict).toBe('ask');
  });

  it('switches a director off and back on, and resets to the starting settings', () => {
    let p = applyChange(fresh(), box, { kind: 'revoked', revoked: true });
    expect(buildView(p, box).revoked).toBe(true);
    p = applyChange(p, box, { kind: 'revoked', revoked: false });
    expect(p.revoked).toBeUndefined();
    p = applyChange(applyChange(p, box, { kind: 'preset', preset: 'independent' }), box, { kind: 'spend-cap', cents: 900 });
    const r = applyChange({ ...p, spentCents: 40 }, box, { kind: 'reset' });
    expect(r).toMatchObject({ preset: box.preset, spentCents: 40 }); expect(r.spendCapCents).toBeUndefined();
  });

  it('never produces more access than the ceiling, whatever is chosen', () => {
    for (const [, b] of Object.entries(TOOLBOXES)) for (const c of CAPABILITIES) {
      if ((b.ceiling[c] ?? 'none') === 'none') continue;
      const p = applyChange(fresh(), b, { kind: 'level', capability: c, level: 'allow' });
      expect(effectiveLevel({ ...p, ceiling: b.ceiling }, c)).toBe(b.ceiling[c]);
    }
  });

  it('reads dollars typed by a person', () => {
    expect(dollarsToCents('5')).toBe(500); expect(dollarsToCents('$5.50')).toBe(550); expect(dollarsToCents('  ')).toBeNull();
    expect(dollarsToCents('abc')).toBeUndefined(); expect(dollarsToCents('-3')).toBeUndefined(); expect(dollarsToCents('1.234')).toBeUndefined();
    expect(centsToDollars(550)).toBe('5.50');
  });
});

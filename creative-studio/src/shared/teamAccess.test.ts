import { describe, expect, it } from 'vitest';
import {
  ACCESS_LEVELS, CAPABILITIES, PRESETS, bindTask, consumeGrant, decide, decideChain, defaultPolicy, delegate, effectiveLevel, makeGrants, minLevel,
  type AccessLevel, type AccessPolicy, type AccessRequest, type Capability,
} from './teamAccess';

const now = new Date('2026-10-30T12:00:00Z');
const ctx = { now };
const req = (o: Partial<AccessRequest> = {}): AccessRequest => ({ capability: 'edit-project', kind: 'change', label: 'Change a file', taskId: 't1', ...o });
const project = (o: Partial<AccessPolicy> = {}): AccessPolicy => ({ ...defaultPolicy('creative'), scope: { kind: 'project' }, ...o });
let n = 0; const newId = () => `g${++n}`;

describe('what a worker may do', () => {
  it('starts with Balanced and only the task at hand', () => {
    const p = defaultPolicy('creative');
    expect(p.preset).toBe('balanced');
    expect(p.scope).toEqual({ kind: 'task' });
    expect(decide(p, req(), ctx).verdict).toBe('ask'); // no task bound yet
    expect(decide(bindTask(p, 't1'), req(), ctx).verdict).toBe('allow');
    expect(decide(bindTask(p, 't2'), req(), ctx).verdict).toBe('ask');
  });

  it('follows the presets', () => {
    const sup = project({ preset: 'supervised' }), bal = project(), ind = project({ preset: 'independent' });
    expect(decide(sup, req(), ctx).verdict).toBe('ask');
    expect(decide(sup, req({ capability: 'read-project', kind: 'read' }), ctx).verdict).toBe('allow');
    expect(decide(bal, req(), ctx).verdict).toBe('allow');
    expect(decide(bal, req({ capability: 'outside-apps' }), ctx).verdict).toBe('ask');
    expect(decide(ind, req({ capability: 'outside-apps' }), ctx).verdict).toBe('allow');
  });

  it('honours the four levels', () => {
    const at = (l: AccessLevel) => project({ levels: { 'edit-project': l } });
    expect(decide(at('none'), req(), ctx).verdict).toBe('deny');
    expect(decide(at('read'), req(), ctx).verdict).toBe('deny');
    expect(decide(at('read'), req({ kind: 'read' }), ctx).verdict).toBe('allow');
    expect(decide(at('ask'), req(), ctx).verdict).toBe('ask');
    expect(decide(at('allow'), req(), ctx).verdict).toBe('allow');
    expect(decide(at('none'), req({ kind: 'read' }), ctx).verdict).toBe('deny');
  });

  it('always asks for risky things, even when Independent', () => {
    const ind = project({ preset: 'independent' });
    for (const kind of ['destructive', 'install', 'publish', 'sensitive'] as const) expect(decide(ind, req({ kind }), ctx).verdict).toBe('ask');
  });

  it('refuses what OmniCandy never runs, and refuses everything once revoked or expired', () => {
    const ind = project({ preset: 'independent' });
    expect(decide(ind, req({ kind: 'never' }), ctx).verdict).toBe('deny');
    expect(decide({ ...ind, revoked: true }, req(), ctx).verdict).toBe('deny');
    expect(decide({ ...ind, expiresAt: '2026-10-30T11:00:00Z' }, req(), ctx).verdict).toBe('deny');
    expect(decide({ ...ind, expiresAt: '2026-10-30T13:00:00Z' }, req(), ctx).verdict).toBe('allow');
  });

  it('asks about anything outside what was given', () => {
    const p = project({ resources: ['a.png'] });
    expect(decide(p, req({ target: 'a.png' }), ctx).verdict).toBe('allow');
    expect(decide(p, req({ target: 'b.png' }), ctx).verdict).toBe('ask');
    expect(decide(project(), req({ outside: true }), ctx).verdict).toBe('ask');
  });

  it('keeps to the toolbox ceiling: a capability the job does not need is off', () => {
    const p = { ...project({ preset: 'independent' }), ceiling: { 'read-project': 'allow', 'generate-media': 'ask' } as Partial<Record<Capability, AccessLevel>> };
    expect(effectiveLevel(p, 'generate-media')).toBe('ask');
    expect(effectiveLevel(p, 'outside-apps')).toBe('none');
    expect(decide(p, req({ capability: 'outside-apps' }), ctx).verdict).toBe('deny');
  });
});

describe('spending', () => {
  const gen = (c: number): AccessRequest => ({ capability: 'generate-media', kind: 'spend', label: 'Make a picture', costCents: c, target: 'image' });
  it('asks every time with no cap, and when the level is Ask first', () => {
    expect(decide(project({ preset: 'independent' }), gen(5), ctx).verdict).toBe('ask');
    expect(decide(project({ levels: { 'generate-media': 'ask' }, spendCapCents: 1000 }), gen(5), ctx).verdict).toBe('ask');
  });
  it('is automatic inside the cap, and asks past it', () => {
    const p = project({ preset: 'independent', spendCapCents: 100, spentCents: 90 });
    expect(decide(p, gen(10), ctx).verdict).toBe('allow');
    expect(decide(p, gen(11), ctx).verdict).toBe('ask');
  });
});

describe('approvals', () => {
  const p = project({ preset: 'supervised' });
  it('cover the action named, once, then are used up', () => {
    const grants = makeGrants([p], req({ target: 'a.png' }), 'once', now, newId);
    const d = decide(p, req({ target: 'a.png' }), { now, grants });
    expect(d).toMatchObject({ verdict: 'allow' });
    expect(decide(p, req({ target: 'b.png' }), { now, grants }).verdict).toBe('ask');
    const used = consumeGrant(grants, grants[0]!.id, now);
    expect(decide(p, req({ target: 'a.png' }), { now, grants: used }).verdict).toBe('ask');
  });
  it('expire', () => {
    const grants = makeGrants([p], req(), 'once', now, newId);
    expect(decide(p, req(), { now: new Date(now.getTime() + 6 * 60_000), grants }).verdict).toBe('ask');
  });
  it('for a task cover that task only, and are never offered for risky actions', () => {
    const grants = makeGrants([p], req(), 'task', now, newId);
    expect(decide(p, req(), { now, grants }).verdict).toBe('allow');
    expect(decide(p, req({ taskId: 't2' }), { now, grants }).verdict).toBe('ask');
    const risky = decide(project({ preset: 'independent' }), req({ kind: 'install' }), ctx);
    expect(risky).toMatchObject({ verdict: 'ask', offer: ['once'] });
    expect(decide(p, req(), ctx)).toMatchObject({ offer: ['once', 'task'] });
  });
  it('belong to one worker and do not make a revoked one work', () => {
    const grants = makeGrants([p], req(), 'once', now, newId);
    expect(decide({ ...p, workerId: 'other' }, req(), { now, grants }).verdict).toBe('ask');
    expect(decide({ ...p, revoked: true }, req(), { now, grants }).verdict).toBe('deny');
  });
  it('do not raise a spend past the approved price', () => {
    const q = project({ preset: 'independent' });
    const spend = (c: number): AccessRequest => ({ capability: 'generate-media', kind: 'spend', label: 'x', costCents: c, target: 'image' });
    const grants = makeGrants([q], spend(5), 'once', now, newId);
    expect(decide(q, spend(5), { now, grants }).verdict).toBe('allow');
    expect(decide(q, spend(6), { now, grants }).verdict).toBe('ask');
  });
});

describe('hired experts', () => {
  const director = project({ preset: 'independent', spendCapCents: 500, spentCents: 100 });
  it('get only what is listed, cut down to what the director has', () => {
    const e = delegate(director, 'expert', { levels: { 'read-project': 'allow', 'edit-project': 'allow' } }, now);
    expect(effectiveLevel(e, 'read-project')).toBe('allow');
    expect(effectiveLevel(e, 'outside-apps')).toBe('none');
    const weak = delegate(project({ levels: { 'edit-project': 'read' } }), 'x', { levels: { 'edit-project': 'allow' } }, now);
    expect(effectiveLevel(weak, 'edit-project')).toBe('read');
  });
  it('get a smaller cap, an expiry and none of the director\'s approvals', () => {
    const e = delegate(director, 'expert', { levels: { 'generate-media': 'allow' }, spendCapCents: 9999 }, now);
    expect(e.spendCapCents).toBe(400);
    expect(Date.parse(e.expiresAt!)).toBeGreaterThan(now.getTime());
    expect(delegate(director, 'x', { levels: {} }, now).spendCapCents).toBe(0);
    expect(delegate(project(), 'x', { levels: { 'generate-media': 'allow' }, spendCapCents: 50 }, now).spendCapCents).toBe(0);
  });
  it('stop when the director\'s access is taken away', () => {
    const e = delegate(director, 'expert', { levels: { 'edit-project': 'allow' } }, now);
    expect(decideChain([e, director], req(), ctx).verdict).toBe('allow');
    expect(decideChain([e, { ...director, revoked: true }], req(), ctx).verdict).toBe('deny');
    expect(decideChain([e, { ...director, levels: { 'edit-project': 'none' } }], req(), ctx).verdict).toBe('deny');
  });
  it('one approval covers the whole chain', () => {
    const e = delegate(project({ preset: 'supervised' }), 'expert', { levels: { 'edit-project': 'allow' } }, now);
    const chain = [e, project({ preset: 'supervised' })];
    expect(decideChain(chain, req(), ctx).verdict).toBe('ask');
    expect(decideChain(chain, req(), { now, grants: makeGrants(chain, req(), 'once', now, newId) }).verdict).toBe('allow');
  });
});

// A small deterministic generator, so the property test is repeatable.
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const KINDS = ['read', 'change', 'destructive', 'spend', 'install', 'publish', 'sensitive', 'never'] as const;
const RANK = { deny: 0, ask: 1, allow: 2 } as const;

describe('property: a hired expert can never do more than the director', () => {
  it('holds for 3000 random directors, delegations and requests', () => {
    const r = rng(42);
    for (let i = 0; i < 3000; i++) {
      const levels: Partial<Record<Capability, AccessLevel>> = {};
      for (const c of CAPABILITIES) if (r() < 0.6) levels[c] = pick(r, ACCESS_LEVELS);
      const parent: AccessPolicy = {
        ...defaultPolicy('d'), preset: pick(r, PRESETS), levels, scope: r() < 0.5 ? { kind: 'project' } : { kind: 'task', taskId: 't1' },
        ...(r() < 0.5 ? { spendCapCents: Math.floor(r() * 500) } : {}), spentCents: Math.floor(r() * 200), ...(r() < 0.2 ? { revoked: true } : {}),
        ...(r() < 0.3 ? { resources: ['a', 'b'].slice(0, 1 + Math.floor(r() * 2)) } : {}),
      };
      const ask: Parameters<typeof delegate>[2] = { levels: {}, ...(r() < 0.5 ? { resources: ['a', 'c'] } : {}), ...(r() < 0.5 ? { spendCapCents: Math.floor(r() * 900) } : {}), ...(r() < 0.5 ? { taskId: 't2' } : {}) };
      for (const c of CAPABILITIES) if (r() < 0.7) ask.levels[c] = pick(r, ACCESS_LEVELS);
      const child = delegate(parent, 'e', ask, now);
      for (const c of CAPABILITIES) expect(minLevel(effectiveLevel(child, c), effectiveLevel(parent, c))).toBe(effectiveLevel(child, c));
      expect((child.spendCapCents ?? 0)).toBeLessThanOrEqual(Math.max(0, (parent.spendCapCents ?? 0) - parent.spentCents));
      for (let k = 0; k < 6; k++) {
        const q: AccessRequest = {
          capability: pick(r, CAPABILITIES), kind: pick(r, KINDS), label: 'x', taskId: pick(r, ['t1', 't2', undefined]), target: pick(r, ['a', 'b', 'c', undefined]),
          costCents: Math.floor(r() * 300), ...(r() < 0.1 ? { outside: true } : {}),
        };
        const dc = decide(child, q, ctx), dp = decide(parent, q, ctx);
        // wherever the child is allowed, the parent is allowed too (no grants in play)
        if (dc.verdict === 'allow') expect(dp.verdict).toBe('allow');
        // and the chain is never looser than either link
        const chain = decideChain([child, parent], q, ctx);
        expect(RANK[chain.verdict]).toBeLessThanOrEqual(Math.min(RANK[dc.verdict], RANK[dp.verdict]));
      }
    }
  });
});

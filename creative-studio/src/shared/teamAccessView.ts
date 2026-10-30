// What the Team Access screen shows and what its controls may change. Pure: the screen asks for a view, sends one change, and the rules here decide what that
// change means. Only what the owner may decide is changeable: a director can never be given more than their toolbox ceiling, and the things that always ask
// (deleting, installing, publishing, sensitive commands) are not on the screen because no setting turns them off.
import { ACCESS_LEVELS, CAPABILITIES, PRESETS, effectiveLevel, minLevel, type AccessLevel, type AccessPolicy, type Capability, type Preset } from './teamAccess';
import type { Toolbox } from './directorToolbox';

export interface AccessRow { capability: Capability; level: AccessLevel; /** The highest this director's job allows. The screen offers nothing above it. */ max: AccessLevel }
export interface AccessView {
  preset: Preset; revoked: boolean; rows: AccessRow[];
  /** Cents, or null for no cap (every paid action then asks). Shown only for a director whose job can make media. */
  spendCapCents: number | null; spentCents: number; canSpend: boolean; works: boolean;
  /** Set when this director's AI work is decided by another director (the AI Director). */
  aiVia?: string;
}
export type AccessChange =
  | { kind: 'preset'; preset: Preset }
  | { kind: 'level'; capability: Capability; level: AccessLevel }
  | { kind: 'spend-cap'; cents: number | null }
  | { kind: 'revoked'; revoked: boolean }
  | { kind: 'reset' };

export const MAX_CAP_CENTS = 100_000;

export function buildView(policy: AccessPolicy, box: Toolbox): AccessView {
  const withCeiling = { ...policy, ceiling: box.ceiling };
  const rows = CAPABILITIES.filter((c) => (box.ceiling[c] ?? 'none') !== 'none' && !(box.aiVia && c === 'generate-media')).map((c): AccessRow => ({ capability: c, level: effectiveLevel(withCeiling, c), max: box.ceiling[c] ?? 'none' }));
  return { preset: policy.preset, revoked: !!policy.revoked, rows, spendCapCents: policy.spendCapCents ?? null, spentCents: policy.spentCents, canSpend: !box.aiVia && (box.ceiling['generate-media'] ?? 'none') === 'allow', works: box.works, ...(box.aiVia ? { aiVia: box.aiVia } : {}) };
}

/** The policy after one change. Throws for a change that is not allowed; never returns more access than the toolbox ceiling. */
export function applyChange(policy: AccessPolicy, box: Toolbox, change: AccessChange): AccessPolicy {
  const base: AccessPolicy = { ...policy }; delete (base as { ceiling?: unknown }).ceiling;
  switch (change.kind) {
    case 'preset': {
      if (!PRESETS.includes(change.preset)) throw new Error('Unknown preset.');
      // A new preset replaces the individual choices, so what the screen shows is what the preset says.
      const next = { ...base, preset: change.preset }; delete (next as { levels?: unknown }).levels; return next;
    }
    case 'level': {
      if (!CAPABILITIES.includes(change.capability) || !ACCESS_LEVELS.includes(change.level)) throw new Error('Unknown setting.');
      const max = box.ceiling[change.capability] ?? 'none';
      if (max === 'none') throw new Error('This director\'s job does not use that.');
      return { ...base, levels: { ...base.levels, [change.capability]: minLevel(change.level, max) } };
    }
    case 'spend-cap': {
      if (change.cents === null) { const next = { ...base }; delete (next as { spendCapCents?: unknown }).spendCapCents; return next; }
      if (!Number.isFinite(change.cents) || change.cents < 0 || change.cents > MAX_CAP_CENTS) throw new Error('Choose a limit between $0 and $1,000.');
      return { ...base, spendCapCents: Math.round(change.cents) };
    }
    case 'revoked': { const next = { ...base, revoked: change.revoked }; if (!change.revoked) delete (next as { revoked?: unknown }).revoked; return next; }
    case 'reset': return { version: 1, workerId: base.workerId, preset: box.preset, scope: { kind: 'task' }, spentCents: base.spentCents };
  }
}

/** The cap typed in dollars ("5", "5.50", "$5") as cents; empty means no cap. NaN-safe: returns undefined when it cannot be read. */
export function dollarsToCents(text: string): number | null | undefined {
  const t = text.trim().replace(/^\$/, '');
  if (t === '') return null;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(t)) return undefined;
  return Math.round(Number(t) * 100);
}
export const centsToDollars = (c: number) => (c / 100).toFixed(2);

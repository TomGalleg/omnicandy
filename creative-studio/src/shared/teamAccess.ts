// What an AI worker (a director, a hired expert, a helper) may do. One policy model and one decision function, shared by every place work runs, so the rules
// are the same whichever AI engine is doing the work. Pure and deterministic: nothing here reads a file, shows a dialog or calls an AI. The enforcement that
// calls it, and the dialogs that answer "ask", live elsewhere and reuse OmniCandy's existing approval machinery (see docs/omnitown-ai-team-design.md).
//
// Four levels, from least to most:
//   none   switched off          read   look but never change          ask   may act, but each action needs the owner's OK          allow   may act
// Some actions ask WHATEVER the level (the "floor"): destructive, installing software, publishing outside the app, sensitive commands, anything outside what
// the worker was given, and spending beyond a cap the owner set. A command OmniCandy never runs stays refused: no level, preset or approval can change that.
// Access defaults to the minimum: the task at hand, and only the capabilities the worker's toolbox gives it.
import type { DirectorKey } from './town';

export const ACCESS_LEVELS = ['none', 'read', 'ask', 'allow'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export const LEVEL_LABEL: Record<AccessLevel, string> = { none: 'No access', read: 'Read only', ask: 'Ask first', allow: 'Allowed' };
const LEVEL_RANK: Record<AccessLevel, number> = { none: 0, read: 1, ask: 2, allow: 3 };
export const minLevel = (a: AccessLevel, b: AccessLevel): AccessLevel => (LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b);

/** The kinds of thing a worker can be given. */
export const CAPABILITIES = ['read-project', 'edit-project', 'native-apps', 'outside-apps', 'generate-media', 'propose-plan'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CAPABILITY_LABEL: Record<Capability, string> = {
  'read-project': 'Look at the project and its files',
  'edit-project': 'Change files in the project',
  'native-apps': 'Use OmniCandy\'s own apps (PhotoCraft, VectorCraft and the rest)',
  'outside-apps': 'Drive other programs (Blender and so on)',
  'generate-media': 'Make pictures and video with AI (may cost money)',
  'propose-plan': 'Suggest changes to the plan (only you can accept them)',
};

export const PRESETS = ['supervised', 'balanced', 'independent'] as const;
export type Preset = (typeof PRESETS)[number];
export const PRESET_LABEL: Record<Preset, string> = { supervised: 'Supervised', balanced: 'Balanced', independent: 'Independent' };
export const PRESET_BLURB: Record<Preset, string> = {
  supervised: 'Looks freely. Asks before it changes or makes anything.',
  balanced: 'Works inside the project on its own. Asks before anything risky, anything that costs money, or other programs.',
  independent: 'Works on its own within what it was given and the spending cap you set. Still asks for the risky things.',
};
/** What each preset means for each capability. Owner overrides sit on top of these. */
export const PRESET_LEVELS: Record<Preset, Record<Capability, AccessLevel>> = {
  supervised: { 'read-project': 'allow', 'edit-project': 'ask', 'native-apps': 'ask', 'outside-apps': 'ask', 'generate-media': 'ask', 'propose-plan': 'allow' },
  balanced: { 'read-project': 'allow', 'edit-project': 'allow', 'native-apps': 'allow', 'outside-apps': 'ask', 'generate-media': 'ask', 'propose-plan': 'allow' },
  independent: { 'read-project': 'allow', 'edit-project': 'allow', 'native-apps': 'allow', 'outside-apps': 'allow', 'generate-media': 'allow', 'propose-plan': 'allow' },
};

/** One line of the worker activity log: what was asked, the decision, and what happened. */
export interface ActivityEntry {
  at: string; workerId: string; worker: string; tool: string; label: string; target?: string; taskId?: string;
  verdict: 'allow' | 'ask' | 'deny'; why: string; approvedBy?: 'rule' | 'owner'; outcome: 'done' | 'failed' | 'refused'; note?: string;
}

/** Who is acting. A hired expert has a parent: the director who delegated to them. */
export interface WorkerRef { id: string; name: string; kind: 'director' | 'expert' | 'helper'; director?: DirectorKey; parentId?: string }

export interface AccessPolicy {
  version: 1;
  workerId: string;
  preset: Preset;
  /** The owner's choices on top of the preset. */
  levels?: Partial<Record<Capability, AccessLevel>>;
  /** Never above these. Set by the toolbox (what the job needs) and by delegation. A capability missing from a ceiling that exists is off. */
  ceiling?: Partial<Record<Capability, AccessLevel>>;
  /** `project`: any task. `task`: only the task being worked on (bound with `bindTask`). */
  scope: { kind: 'project' } | { kind: 'task'; taskId?: string };
  /** When set, only these targets (file names, apps, commands) are inside what was given. */
  resources?: string[];
  /** Money, in cents. With no cap every paid action asks; within the cap an "Allowed" worker may spend. */
  spendCapCents?: number;
  spentCents: number;
  expiresAt?: string;
  /** The owner switched this worker off. Takes effect at the next action. */
  revoked?: boolean;
}

/** The least a new worker gets: Balanced, and only the task at hand. Pass the toolbox ceiling so it can only have what its job needs. */
export function defaultPolicy(workerId: string, ceiling?: Partial<Record<Capability, AccessLevel>>): AccessPolicy {
  return { version: 1, workerId, preset: 'balanced', scope: { kind: 'task' }, spentCents: 0, ...(ceiling ? { ceiling } : {}) };
}

/** Ties a task-scoped policy to the task about to be worked on. */
export const bindTask = (p: AccessPolicy, taskId: string): AccessPolicy => (p.scope.kind === 'task' ? { ...p, scope: { kind: 'task', taskId } } : p);

/** What the worker really has for one capability: the owner's choice (or the preset), never above the ceiling. */
export function effectiveLevel(p: AccessPolicy, c: Capability): AccessLevel {
  const chosen = p.levels?.[c] ?? PRESET_LEVELS[p.preset][c];
  return p.ceiling ? minLevel(chosen, p.ceiling[c] ?? 'none') : chosen;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
/** What kind of action it is. `never` is a command OmniCandy refuses outright. */
export type ActionKind = 'read' | 'change' | 'destructive' | 'spend' | 'install' | 'publish' | 'sensitive' | 'never';
export interface AccessRequest {
  capability: Capability;
  kind: ActionKind;
  /** What is acted on (a file name, an app, a command). Shown in the approval, checked against `resources`, and part of what an approval covers. */
  target?: string;
  /** The action in plain words, for the approval and the activity log. */
  label: string;
  taskId?: string;
  costCents?: number;
  /** The caller knows this reaches outside what was given (for example a path outside the project). */
  outside?: boolean;
}

export type ApprovalOffer = 'once' | 'task';
export type Decision =
  | { verdict: 'allow'; why: string; usedGrantId?: string }
  | { verdict: 'ask'; why: string; offer: ApprovalOffer[] }
  | { verdict: 'deny'; why: string };

/** Always ask, whatever the level. */
export const ASK_FLOOR: readonly ActionKind[] = ['destructive', 'install', 'publish', 'sensitive'];
/** Approvals for these cover one action only, never "for this task". */
const ONCE_ONLY: readonly ActionKind[] = ['install', 'publish', 'sensitive', 'spend'];

/** An approval the owner gave: it names the action and its target, and it expires. */
export interface Grant {
  id: string; workerId: string; capability: Capability; kind: ActionKind; target?: string; taskId?: string;
  scope: ApprovalOffer; costCents?: number; expiresAt: string; usesLeft: number;
}
export const GRANT_MINUTES: Record<ApprovalOffer, number> = { once: 5, task: 60 };

const stricter = (a: Decision['verdict'], b: Decision['verdict']): Decision['verdict'] => {
  const rank = { deny: 0, ask: 1, allow: 2 } as const;
  return rank[a] <= rank[b] ? a : b;
};

/** Why a request is outside what was given, or null when it is inside. */
function outsideProblem(p: AccessPolicy, r: AccessRequest): string | null {
  if (r.outside) return 'It reaches outside what this worker was given.';
  if (p.scope.kind === 'task' && (!p.scope.taskId || r.taskId !== p.scope.taskId)) return 'It is not part of the task this worker was given.';
  if (p.resources && r.target !== undefined && !p.resources.includes(r.target)) return `"${r.target}" is not one of the things this worker was given.`;
  return null;
}

function covers(g: Grant, p: AccessPolicy, r: AccessRequest, now: Date): boolean {
  if (g.workerId !== p.workerId || g.usesLeft <= 0 || Date.parse(g.expiresAt) <= now.getTime()) return false;
  if (g.capability !== r.capability || g.kind !== r.kind) return false;
  if (g.scope === 'task') return !!g.taskId && g.taskId === r.taskId && (r.kind === 'change' || g.target === r.target);
  return g.target === r.target && (r.kind !== 'spend' || (r.costCents ?? 0) <= (g.costCents ?? 0));
}

export function decide(p: AccessPolicy, r: AccessRequest, ctx: { now: Date; grants?: readonly Grant[] }): Decision {
  if (p.revoked) return { verdict: 'deny', why: 'The owner switched this worker\'s access off.' };
  if (p.expiresAt && Date.parse(p.expiresAt) <= ctx.now.getTime()) return { verdict: 'deny', why: 'This access has expired.' };
  if (r.kind === 'never') return { verdict: 'deny', why: 'OmniCandy never runs this, whatever the settings.' };
  const level = effectiveLevel(p, r.capability);
  const label = CAPABILITY_LABEL[r.capability];
  if (level === 'none') return { verdict: 'deny', why: `This is switched off for this worker (${label}).` };

  let verdict: Decision['verdict'] = 'allow'; let why = 'Allowed.';
  if (r.kind !== 'read' && level === 'read') return { verdict: 'deny', why: `This worker can only look (${label}), not change anything.` };
  if (r.kind === 'change' && level === 'ask') { verdict = 'ask'; why = 'This worker asks before it changes things.'; }
  if (ASK_FLOOR.includes(r.kind)) { verdict = 'ask'; why = r.kind === 'destructive' ? 'It could destroy something, so it always asks.' : r.kind === 'install' ? 'Installing software always asks.' : r.kind === 'publish' ? 'Putting something outside OmniCandy always asks.' : 'A sensitive command always asks.'; }
  if (r.kind === 'spend') {
    const cost = r.costCents ?? 0;
    if (level === 'ask') { verdict = 'ask'; why = 'This worker asks before it spends money.'; }
    else if (p.spendCapCents === undefined) { verdict = 'ask'; why = 'No spending cap is set, so every paid action asks.'; }
    else if (p.spentCents + cost > p.spendCapCents) { verdict = 'ask'; why = 'This would go over the spending cap.'; }
  }
  const outside = outsideProblem(p, r);
  if (outside) { verdict = stricter(verdict, 'ask'); if (verdict === 'ask') why = outside; }

  if (verdict === 'ask') {
    const grant = (ctx.grants ?? []).find((g) => covers(g, p, r, ctx.now));
    if (grant) return { verdict: 'allow', why: grant.scope === 'once' ? 'You approved this action.' : 'You approved this for the task.', usedGrantId: grant.id };
    const offer: ApprovalOffer[] = ['once'];
    if (r.taskId && !ONCE_ONLY.includes(r.kind)) offer.push('task');
    return { verdict: 'ask', why, offer };
  }
  return { verdict, why };
}

/**
 * A worker who acts for a director (a hired expert) is checked against every policy up the chain, and the strictest answer wins. So taking access away from a
 * director takes it away from everyone working under them, at the next action.
 */
export function decideChain(chain: readonly AccessPolicy[], r: AccessRequest, ctx: { now: Date; grants?: readonly Grant[] }): Decision {
  let worst: Decision = { verdict: 'allow', why: 'Allowed.' };
  const usedGrantIds: string[] = [];
  for (const p of chain) {
    const d = decide(p, r, ctx);
    if (d.verdict === 'allow' && d.usedGrantId) usedGrantIds.push(d.usedGrantId);
    if (stricter(worst.verdict, d.verdict) !== worst.verdict || (worst.verdict === 'allow' && d.verdict !== 'allow')) worst = d;
    else if (worst.verdict === 'allow' && d.verdict === 'allow' && d.usedGrantId) worst = d;
  }
  return worst.verdict === 'allow' && usedGrantIds.length ? { ...worst, usedGrantId: usedGrantIds[0] } : worst;
}

/** Records an approval for everyone in the chain, so one OK from the owner covers the action wherever it is checked. */
export function makeGrants(chain: readonly AccessPolicy[], r: AccessRequest, scope: ApprovalOffer, now: Date, newId: () => string): Grant[] {
  return chain.map((p) => ({
    id: newId(), workerId: p.workerId, capability: r.capability, kind: r.kind, ...(r.target !== undefined ? { target: r.target } : {}),
    ...(scope === 'task' && r.taskId ? { taskId: r.taskId } : {}), scope, ...(r.costCents !== undefined ? { costCents: r.costCents } : {}),
    expiresAt: new Date(now.getTime() + GRANT_MINUTES[scope] * 60_000).toISOString(), usesLeft: scope === 'once' ? 1 : Number.MAX_SAFE_INTEGER,
  }));
}

/** Uses up a one-time approval. Expired or spent grants are dropped. */
export function consumeGrant(grants: readonly Grant[], id: string, now: Date): Grant[] {
  return grants
    .map((g) => (g.id === id && g.scope === 'once' ? { ...g, usesLeft: g.usesLeft - 1 } : g))
    .filter((g) => g.usesLeft > 0 && Date.parse(g.expiresAt) > now.getTime());
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
export interface DelegationAsk {
  /** What the expert is given. A capability not listed is off. Each is cut down to what the director has. */
  levels: Partial<Record<Capability, AccessLevel>>;
  resources?: string[];
  spendCapCents?: number;
  taskId?: string;
  minutes?: number;
}
export const DELEGATION_DEFAULT_MINUTES = 8 * 60;

/**
 * Access for a hired expert: only what is listed, never more than the director has, narrower in scope, with their own (smaller) spending cap and an expiry,
 * and none of the director's saved approvals. The result can never do anything its parent could not.
 */
export function delegate(parent: AccessPolicy, childWorkerId: string, ask: DelegationAsk, now: Date): AccessPolicy {
  const clamped: Partial<Record<Capability, AccessLevel>> = {};
  for (const c of CAPABILITIES) clamped[c] = minLevel(effectiveLevel(parent, c), ask.levels[c] ?? 'none');
  const scope: AccessPolicy['scope'] = parent.scope.kind === 'task' ? parent.scope : ask.taskId ? { kind: 'task', taskId: ask.taskId } : { kind: 'project' };
  const resources = parent.resources ? (ask.resources ? parent.resources.filter((x) => ask.resources!.includes(x)) : [...parent.resources]) : ask.resources ? [...ask.resources] : undefined;
  const room = parent.spendCapCents === undefined ? 0 : Math.max(0, parent.spendCapCents - parent.spentCents);
  const own = new Date(now.getTime() + (ask.minutes ?? DELEGATION_DEFAULT_MINUTES) * 60_000).toISOString();
  const expiresAt = parent.expiresAt && Date.parse(parent.expiresAt) < Date.parse(own) ? parent.expiresAt : own;
  return {
    version: 1, workerId: childWorkerId, preset: 'supervised', levels: clamped, ceiling: clamped, scope, ...(resources ? { resources } : {}),
    spendCapCents: Math.min(ask.spendCapCents ?? 0, room), spentCents: 0, expiresAt, ...(parent.revoked ? { revoked: true } : {}),
  };
}

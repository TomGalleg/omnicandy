// Project Planner: the data model and the pure rules around it (no Node, no Electron). One current plan per project, kept
// while the user brainstorms elsewhere and runs work through Claude Code, Cowork or CreateCraft. Everything optional except
// a title; AI is never required. Proposed changes live apart from accepted state; an executor's report is never acceptance.
import { z } from 'zod';

export const PLANNER_FORMAT = 'createcraft-planner-export';

// ---- who did it ---------------------------------------------------------------------------------------------------
export const ACTOR_KINDS = ['user', 'claude-code', 'cowork', 'createcraft', 'chatgpt', 'gemini', 'other'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];
export interface Actor { kind: ActorKind; name: string }
export const USER_ACTOR: Actor = { kind: 'user', name: 'You' };

/** What a caller may do. `edit` and `review` are the user's own (UI); a connection can only ever hold the other three. */
export const SCOPES = ['read', 'propose', 'package', 'execute', 'edit', 'review'] as const;
export type Scope = (typeof SCOPES)[number];
export const CONNECTION_SCOPES = ['read', 'propose', 'package', 'execute'] as const satisfies readonly Scope[];

// ---- plan content -------------------------------------------------------------------------------------------------
export const ITEM_TYPES = ['idea', 'reference', 'question', 'requirement', 'decision'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export type ItemStatus = 'open' | 'accepted' | 'rejected' | 'superseded' | 'answered';

export interface PlanItem {
  id: string;
  type: ItemType;
  title: string;
  text: string;
  /** Decisions: why. */
  reason: string;
  status: ItemStatus;
  rev: number;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor;
  /** Questions: the answer. */
  answer?: string;
}

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'reported', 'revision', 'accepted', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', reported: 'Reported done, awaiting your review',
  revision: 'Revision requested', accepted: 'Accepted', cancelled: 'Cancelled',
};
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface CompletionCheck { id: string; text: string; kind: string }
export interface AppRef { kind: 'native' | 'external' | 'workflow'; id: string; note: string }
export interface TaskClaim { token: string; packageId: string; executor: Actor; claimedAt: string; leaseUntil: string; note: string }

export interface PlanTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  parentId: string | null;
  dependsOn: string[];
  completionChecks: CompletionCheck[];
  expectedOutputs: string[];
  assetIds: string[];
  milestoneId: string | null;
  appRef: AppRef | null;
  /** The one open package this task is handed off in (a task is never in two open packages). */
  packageId: string | null;
  claim: TaskClaim | null;
  progressNote: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor;
}

export interface PlanAsset {
  id: string;
  role: 'reference' | 'working' | 'deliverable';
  title: string;
  /** A file on disk (linked, not copied), a web link, or an asset of a CreateCraft art project. */
  source: 'file' | 'link' | 'createcraft';
  path: string;
  url: string;
  createcraft: { projectKey: string; assetId: string } | null;
  note: string;
  /** Output versions: v1, v2... of the same deliverable share a group. */
  group: string;
  version: number;
  /** Set when the file's content was recorded (so a later change is visible). */
  sha256: string;
  rev: number;
  addedAt: string;
  addedBy: Actor;
}

export interface Milestone { id: string; title: string; due: string; rev: number }

export interface PlanSnapshot {
  goal: string; description: string; scope: string; constraints: string[]; deliverables: string[];
  requirements: Array<{ id: string; rev: number; title: string; text: string }>;
  decisions: Array<{ id: string; rev: number; title: string; text: string; reason: string }>;
}

// ---- proposals (kept apart from accepted state) -------------------------------------------------------------------
const s = (n: number) => z.string().trim().max(n);
export const changeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_item'), itemType: z.enum(ITEM_TYPES), title: s(200).min(1), text: s(4000).default(''), reason: s(2000).default('') }),
  z.object({ op: z.literal('update_item'), id: s(80).min(1), baseRev: z.number().int().min(1), patch: z.object({ title: s(200).min(1).optional(), text: s(4000).optional(), reason: s(2000).optional() }) }),
  z.object({
    op: z.literal('add_task'), title: s(200).min(1), description: s(4000).default(''), priority: z.enum(PRIORITIES).default('normal'),
    dependsOn: z.array(s(80)).max(30).default([]), parentId: s(80).nullish(), completionChecks: z.array(s(400)).max(20).default([]),
  }),
  z.object({
    op: z.literal('update_task'), id: s(80).min(1), baseRev: z.number().int().min(1),
    patch: z.object({ title: s(200).min(1).optional(), description: s(4000).optional(), priority: z.enum(PRIORITIES).optional(), completionChecks: z.array(s(400)).max(20).optional() }),
  }),
]);
export type ProposalChange = z.infer<typeof changeSchema>;

export interface Proposal {
  id: string;
  proposedBy: Actor;
  at: string;
  note: string;
  changes: ProposalChange[];
  status: 'pending' | 'accepted' | 'rejected';
  decidedAt?: string;
  /** Where it came from: a connection, or a returned report. */
  source: 'connection' | 'report' | 'pasted';
  reportId?: string;
}

// ---- execution packages and reports --------------------------------------------------------------------------------
export interface PackageTask {
  id: string; title: string; description: string; priority: Priority; dependsOn: string[];
  completionChecks: CompletionCheck[]; expectedOutputs: string[]; appRef: AppRef | null; assetIds: string[];
}
export interface ExecPackage {
  id: string;
  projectId: string;
  /** 1, 2, 3... per project. A new package for the same work supersedes the old one. */
  number: number;
  planRevision: number;
  createdAt: string;
  createdBy: Actor;
  objective: string;
  context: string;
  plan: PlanSnapshot;
  tasks: PackageTask[];
  assets: Array<{ id: string; role: PlanAsset['role']; title: string; source: PlanAsset['source']; path: string; url: string; note: string }>;
  reportInstructions: string;
  contentHash: string;
  state: 'open' | 'closed' | 'cancelled' | 'superseded';
  supersedes?: string;
}

export type ReportOutcome = 'complete' | 'partial' | 'blocked' | 'failed';
export const reportDraftSchema = z.object({
  outcome: z.enum(['complete', 'partial', 'blocked', 'failed']),
  workPerformed: s(8000).min(1),
  outputs: z.array(z.object({ description: s(500).default(''), path: s(1000).default(''), assetId: s(80).optional() })).max(50).default([]),
  changedFiles: z.array(s(1000)).max(200).default([]),
  verification: z.array(z.object({ check: s(500).min(1), checkId: s(80).optional(), result: z.enum(['pass', 'fail', 'not_run']), details: s(2000).default('') })).max(50).default([]),
  blockers: z.array(s(1000)).max(30).default([]),
  limitations: z.array(s(1000)).max(30).default([]),
  unresolvedQuestions: z.array(s(1000)).max(30).default([]),
  proposedChanges: z.array(changeSchema).max(30).default([]),
});
export type ReportDraft = z.infer<typeof reportDraftSchema>;

export interface PlanDrift { outdated: boolean; changes: Array<{ what: string; change: 'added' | 'changed' | 'removed'; title: string }> }

export interface PlanReport extends ReportDraft {
  id: string;
  packageId: string;
  packageNumber: number;
  taskId: string;
  /** The plan revision the executor worked from (the package's). */
  planRevision: number;
  submittedAt: string;
  executor: Actor;
  source: 'connection' | 'pasted';
  status: 'submitted' | 'accepted' | 'revision_requested' | 'rejected';
  review?: { at: string; note: string };
  contentHash: string;
  /** Pasted reports: what the reader was unsure about. */
  uncertain: string[];
  hasRawText: boolean;
  /** Plan changes between the package and the moment the report arrived. */
  driftAtSubmit: PlanDrift;
}

export interface PlanVersion { planRevision: number; at: string; by: Actor; reason: string; snapshot: PlanSnapshot }

export interface PlannerProject {
  id: string;
  title: string;
  goal: string;
  description: string;
  scope: string;
  constraints: string[];
  deliverables: string[];
  kinds: string[];
  /** Bumps on every change. Connections read "changes since" this number. */
  revision: number;
  /** Bumps only when the accepted plan changes (goal, scope, constraints, deliverables, requirements, decisions). */
  planRevision: number;
  /** Bumps on edits to the fields above, for conflict detection in the editor. */
  metaRev: number;
  createdAt: string;
  updatedAt: string;
  items: PlanItem[];
  tasks: PlanTask[];
  assets: PlanAsset[];
  milestones: Milestone[];
  proposals: Proposal[];
  packages: ExecPackage[];
  reports: PlanReport[];
  planVersions: PlanVersion[];
  counters: { package: number; activity: number };
}

export interface ActivityEntry {
  seq: number;
  at: string;
  actor: Actor;
  kind: string;
  summary: string;
  targetId?: string;
  revision: number;
  planAffecting: boolean;
}

export interface ProjectSummary {
  id: string; title: string; goal: string; kinds: string[]; revision: number; updatedAt: string;
  tasks: number; accepted: number; pendingProposals: number; awaitingReview: number; blocked: number;
}

// ---- pure rules ---------------------------------------------------------------------------------------------------
export function snapshotOf(p: PlannerProject): PlanSnapshot {
  const acc = (i: PlanItem) => i.status === 'accepted';
  return {
    goal: p.goal, description: p.description, scope: p.scope, constraints: [...p.constraints], deliverables: [...p.deliverables],
    requirements: p.items.filter((i) => i.type === 'requirement' && acc(i)).map((i) => ({ id: i.id, rev: i.rev, title: i.title, text: i.text })),
    decisions: p.items.filter((i) => i.type === 'decision' && acc(i)).map((i) => ({ id: i.id, rev: i.rev, title: i.title, text: i.text, reason: i.reason })),
  };
}

/** What changed in the accepted plan since a snapshot (a package's): shown wherever work is reviewed. */
export function planDrift(then: PlanSnapshot, now: PlanSnapshot): PlanDrift {
  const changes: PlanDrift['changes'] = [];
  const text = (k: 'goal' | 'description' | 'scope') => { if (then[k] !== now[k]) changes.push({ what: k, change: 'changed', title: k }); };
  text('goal'); text('description'); text('scope');
  if (JSON.stringify(then.constraints) !== JSON.stringify(now.constraints)) changes.push({ what: 'constraints', change: 'changed', title: 'constraints' });
  if (JSON.stringify(then.deliverables) !== JSON.stringify(now.deliverables)) changes.push({ what: 'deliverables', change: 'changed', title: 'deliverables' });
  for (const [what, a, b] of [['requirement', then.requirements, now.requirements], ['decision', then.decisions, now.decisions]] as const) {
    const was = new Map<string, { rev: number; title: string }>(a.map((x) => [x.id, x]));
    const is = new Map<string, { rev: number; title: string }>(b.map((x) => [x.id, x]));
    for (const [id, x] of is) { const o = was.get(id); if (!o) changes.push({ what, change: 'added', title: x.title }); else if (o.rev !== x.rev) changes.push({ what, change: 'changed', title: x.title }); }
    for (const [id, x] of was) if (!is.has(id)) changes.push({ what, change: 'removed', title: x.title });
  }
  return { outdated: changes.length > 0, changes };
}

/** A task can start when everything it depends on has been accepted by the user. */
export function unmetDependencies(p: PlannerProject, t: PlanTask): PlanTask[] {
  return t.dependsOn.map((id) => p.tasks.find((x) => x.id === id)).filter((x): x is PlanTask => !!x && x.status !== 'accepted' && x.status !== 'cancelled');
}

export function wouldCycle(tasks: PlanTask[], taskId: string, dependsOn: string[]): boolean {
  const seen = new Set<string>();
  const stack = [...dependsOn];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(tasks.find((t) => t.id === id)?.dependsOn ?? []));
  }
  return false;
}

export function isClaimLive(c: TaskClaim | null, now: Date): boolean { return !!c && new Date(c.leaseUntil).getTime() > now.getTime(); }

export interface ProgressInfo { total: number; accepted: number; reported: number; inProgress: number; blocked: number; percent: number }
export function progressOf(tasks: PlanTask[]): ProgressInfo {
  const live = tasks.filter((t) => t.status !== 'cancelled');
  const n = (st: TaskStatus) => live.filter((t) => t.status === st).length;
  return { total: live.length, accepted: n('accepted'), reported: n('reported'), inProgress: n('in_progress'), blocked: n('blocked'), percent: live.length ? Math.round((n('accepted') / live.length) * 100) : 0 };
}

export function summarize(p: PlannerProject): ProjectSummary {
  const pr = progressOf(p.tasks);
  return {
    id: p.id, title: p.title, goal: p.goal, kinds: p.kinds, revision: p.revision, updatedAt: p.updatedAt, tasks: pr.total, accepted: pr.accepted,
    pendingProposals: p.proposals.filter((x) => x.status === 'pending').length, awaitingReview: p.reports.filter((r) => r.status === 'submitted').length, blocked: pr.blocked,
  };
}

/** Checks of the task that the report does not mention (the reviewer should see these before accepting). */
export function uncoveredChecks(task: PlanTask | PackageTask, report: Pick<ReportDraft, 'verification'>): CompletionCheck[] {
  return task.completionChecks.filter((c) => !report.verification.some((v) => v.checkId === c.id));
}

/** Stable JSON (sorted keys) so a hash does not depend on key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// ---- templates: editable defaults, not separate project systems ------------------------------------------------------
export interface PlannerTemplate {
  id: string; label: string; blurb: string; kind: string;
  requirements: string[]; questions: string[]; deliverables: string[];
  tasks: Array<{ title: string; description?: string; checks: Array<{ text: string; kind: string }>; outputs?: string[]; dependsOn?: number[] }>;
}

export const PLANNER_TEMPLATES: PlannerTemplate[] = [
  { id: 'blank', label: 'Blank project', blurb: 'Just a title and a goal. Add structure when you need it.', kind: 'blank', requirements: [], questions: [], deliverables: [], tasks: [] },
  {
    id: 'software', label: 'Software', blurb: 'A program or feature, built and tested.', kind: 'software',
    requirements: ['It does what the goal says for a first-time user.'], questions: ['Which platforms must it run on?'], deliverables: ['Working source code', 'Short usage notes'],
    tasks: [
      { title: 'Outline the design', description: 'Describe the parts, the data and how they fit.', checks: [{ text: 'Design reviewed against the requirements', kind: 'review' }] },
      { title: 'Implement the first working version', checks: [{ text: 'Automated tests pass', kind: 'tests' }, { text: 'It builds from a clean checkout', kind: 'build' }], dependsOn: [0] },
      { title: 'Write usage notes', checks: [{ text: 'Every documented step was run as written', kind: 'review' }], dependsOn: [1] },
    ],
  },
  {
    id: 'art', label: 'Art or design', blurb: 'An image, illustration, layout or brand piece.', kind: 'art',
    requirements: ['The finished piece matches the mood and subject described in the goal.'], questions: ['What sizes or aspect ratios are needed?'], deliverables: ['Final artwork', 'Layered or source file'],
    tasks: [
      { title: 'Gather references and choose a direction', checks: [{ text: 'Direction approved by the user', kind: 'review' }] },
      { title: 'Create the artwork', checks: [{ text: 'Image has the required pixel dimensions', kind: 'dimensions' }, { text: 'Export opens and looks right', kind: 'export' }], outputs: ['Final artwork'], dependsOn: [0] },
    ],
  },
  {
    id: 'document', label: 'Document', blurb: 'A report, letter, guide or publication.', kind: 'document',
    requirements: ['The document is accurate, organised and written for its reader.'], questions: ['Who is the reader and how long should it be?'], deliverables: ['Finished document'],
    tasks: [
      { title: 'Outline the document', checks: [{ text: 'Outline covers every requirement', kind: 'review' }] },
      { title: 'Write the first full draft', checks: [{ text: 'All sections present; no placeholders left', kind: 'review' }, { text: 'Facts and numbers checked against sources', kind: 'citations' }], outputs: ['Draft document'], dependsOn: [0] },
      { title: 'Review and finalise', checks: [{ text: 'Exported file opens and pages look right', kind: 'export' }], dependsOn: [1] },
    ],
  },
  {
    id: 'research', label: 'Research', blurb: 'Find out something and report what is known, with sources.', kind: 'research',
    requirements: ['Every claim in the findings names its source.'], questions: ['What decision will this research inform?'], deliverables: ['Findings summary with sources'],
    tasks: [
      { title: 'Collect sources', checks: [{ text: 'Each source is cited with a link or reference', kind: 'citations' }] },
      { title: 'Summarise the findings', checks: [{ text: 'Every statement traces to a listed source', kind: 'citations' }, { text: 'Open uncertainties are listed', kind: 'review' }], outputs: ['Findings summary'], dependsOn: [0] },
    ],
  },
  {
    id: 'media', label: 'Video or audio', blurb: 'A clip, film, soundtrack or recording.', kind: 'media',
    requirements: ['Length and format match what was asked for.'], questions: ['Where will it be shown or played?'], deliverables: ['Final export'],
    tasks: [
      { title: 'Plan scenes or sections', checks: [{ text: 'Plan approved by the user', kind: 'review' }] },
      { title: 'Produce and assemble', checks: [{ text: 'Duration and format as required', kind: 'export' }, { text: 'Audio levels are not clipping', kind: 'export' }], outputs: ['Final video or audio'], dependsOn: [0] },
    ],
  },
  {
    id: 'engineering', label: 'Engineering', blurb: 'A part, drawing, model or system with measurable limits.', kind: 'engineering',
    requirements: ['Dimensions and tolerances are stated and met.'], questions: ['Which standards or tolerances apply?'], deliverables: ['Drawing or model file', 'Specification sheet'],
    tasks: [
      { title: 'Capture the specification', checks: [{ text: 'Every dimension has a unit and tolerance', kind: 'review' }] },
      { title: 'Model or draw it', checks: [{ text: 'Measured dimensions match the specification', kind: 'measurement' }], outputs: ['Model or drawing'], dependsOn: [0] },
    ],
  },
];

export const templateById = (id: string) => PLANNER_TEMPLATES.find((t) => t.id === id);

export const MAX_TEXT = 8000;
export const projectInputSchema = z.object({
  title: s(120).min(1),
  goal: s(2000).default(''),
  description: s(MAX_TEXT).default(''),
  scope: s(MAX_TEXT).default(''),
  constraints: z.array(s(500)).max(50).default([]),
  deliverables: z.array(s(500)).max(50).default([]),
  templates: z.array(s(40)).max(8).default([]),
});
export type ProjectInput = z.input<typeof projectInputSchema>;

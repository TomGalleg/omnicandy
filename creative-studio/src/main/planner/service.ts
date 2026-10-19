// The planner's rules. The app (as the user) and the MCP server (as a connection with limited scopes) both go through here, so
// there is one set of rules: proposals never change accepted state, only the user accepts a proposal or a report, a task has at most
// one open package and one live claim, and a report is a claim of completion that stays that until the user accepts it.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type Actor, type ActivityEntry, changeSchema, type AppRef, CONNECTION_SCOPES, type ExecPackage, isClaimLive, type ItemStatus, type ItemType, type Milestone, type PackageTask,
  type PlanAsset, type PlanItem, type PlannerProject, type PlanReport, type PlanTask, planDrift, type PlanDrift, PLANNER_FORMAT, type Priority, type Proposal, type ProposalChange,
  type ReportDraft, reportDraftSchema, type Scope, SCOPES, snapshotOf, type TaskStatus, templateById, unmetDependencies, uncoveredChecks, USER_ACTOR, wouldCycle, canonical,
  projectInputSchema, type ProjectInput, type ProjectSummary,
} from '@shared/planner';
import { buildContext, type Delivery } from '@shared/plannerContext';
import { packageToMarkdown, reportInstructionsFor } from '@shared/plannerHandoff';
import type { DestinationId } from '@shared/plannerSend';
import { readZip, writeZip } from '../integrations/zip';
import { newId, PlannerError, type LogFn, type PlannerStore } from './store';

export interface Ctx { actor: Actor; scopes: ReadonlySet<Scope> }
export const userCtx = (actor: Actor = USER_ACTOR): Ctx => ({ actor, scopes: new Set<Scope>(SCOPES) });
/** A connection can hold read / propose / package / execute and nothing else: editing and reviewing stay with the user. */
export function connectionCtx(actor: Actor, scopes: readonly string[]): Ctx {
  const ok = scopes.filter((x): x is Scope => (CONNECTION_SCOPES as readonly string[]).includes(x));
  const bad = scopes.filter((x) => !(CONNECTION_SCOPES as readonly string[]).includes(x));
  if (bad.length) throw new PlannerError('forbidden', `A connection cannot hold the scope(s): ${bad.join(', ')}. Allowed: ${CONNECTION_SCOPES.join(', ')}.`);
  return { actor, scopes: new Set<Scope>(['read', ...ok]) };
}

const need = (c: Ctx, s: Scope) => { if (!c.scopes.has(s)) throw new PlannerError('forbidden', `This connection is not allowed to do that (needs the "${s}" permission).`); };
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const LEASE_MINUTES = 8 * 60;
const find = <T extends { id: string }>(list: T[], id: string, what: string): T => {
  const x = list.find((i) => i.id === id);
  if (!x) throw new PlannerError('not_found', `No ${what} with id ${id}.`);
  return x;
};
const checkRev = (current: number, expected: number | undefined, what: string, now: unknown) => {
  if (expected !== undefined && expected !== current) throw new PlannerError('conflict', `This ${what} was changed by someone else (revision ${current}, you had ${expected}). Reload it and apply your change again.`, { current: now });
};

export interface TaskInput {
  title: string; description?: string; priority?: Priority; parentId?: string | null; dependsOn?: string[]; checks?: Array<{ text: string; kind?: string }>;
  expectedOutputs?: string[]; assetIds?: string[]; milestoneId?: string | null; appRef?: AppRef | null;
}
export interface AssetInput { role: PlanAsset['role']; title: string; source: PlanAsset['source']; path?: string; url?: string; createcraft?: PlanAsset['createcraft']; note?: string; group?: string; version?: number; sha256?: string }

export class PlannerService {
  constructor(readonly store: PlannerStore, private readonly now: () => Date = () => new Date()) {}

  // ---------------------------------------------------------------- reading
  async listProjects(c: Ctx): Promise<ProjectSummary[]> { need(c, 'read'); return this.store.list(); }
  async getProject(c: Ctx, id: string): Promise<PlannerProject> { need(c, 'read'); return this.store.read(id); }
  async changesSince(c: Ctx, id: string, revision: number): Promise<{ revision: number; planRevision: number; changes: ActivityEntry[] }> {
    need(c, 'read');
    const p = await this.store.read(id);
    return { revision: p.revision, planRevision: p.planRevision, changes: await this.store.history(id, revision) };
  }
  async activity(c: Ctx, id: string, limit = 200): Promise<ActivityEntry[]> { need(c, 'read'); return this.store.history(id, 0, limit); }

  /** What an AI needs to take part: the accepted plan, what is open, what is ready, and what it may not rely on yet. */
  async context(c: Ctx, id: string) {
    need(c, 'read');
    const p = await this.store.read(id);
    const drafts = p.items.filter((i) => i.status === 'open');
    return {
      project: { id: p.id, title: p.title, revision: p.revision, planRevision: p.planRevision },
      acceptedPlan: snapshotOf(p),
      notAcceptedYet: {
        ideas: drafts.filter((i) => i.type === 'idea').map((i) => ({ id: i.id, rev: i.rev, title: i.title, text: i.text })),
        openQuestions: drafts.filter((i) => i.type === 'question').map((i) => ({ id: i.id, rev: i.rev, title: i.title, text: i.text })),
        pendingProposals: p.proposals.filter((x) => x.status === 'pending').map((x) => ({ id: x.id, by: x.proposedBy.name, note: x.note, changes: x.changes.length })),
        note: 'Ideas, questions and proposals are NOT decisions. Do not treat them as requirements.',
      },
      references: p.items.filter((i) => i.type === 'reference').map((i) => ({ id: i.id, title: i.title, text: i.text })),
      tasks: p.tasks.map((t) => ({ id: t.id, rev: t.rev, title: t.title, status: t.status, priority: t.priority, dependsOn: t.dependsOn, blockedBy: unmetDependencies(p, t).map((x) => x.id), packageId: t.packageId, claimedBy: isClaimLive(t.claim, this.now()) ? t.claim?.executor.name : null })),
      milestones: p.milestones,
      assets: p.assets.map((a) => ({ id: a.id, role: a.role, title: a.title, source: a.source, path: a.path, url: a.url })),
    };
  }

  // ---------------------------------------------------------------- projects (the user edits these)
  async createProject(c: Ctx, input: ProjectInput): Promise<PlannerProject> {
    need(c, 'edit');
    const v = projectInputSchema.parse(input);
    const now = this.now().toISOString();
    const p: PlannerProject = {
      id: `plan_${randomBytes(6).toString('hex')}`, title: v.title, goal: v.goal, description: v.description, scope: v.scope, constraints: v.constraints, deliverables: [...v.deliverables],
      kinds: [], revision: 1, planRevision: 1, metaRev: 1, createdAt: now, updatedAt: now, items: [], tasks: [], assets: [], milestones: [], proposals: [], packages: [], reports: [], planVersions: [], counters: { package: 0, activity: 0 },
    };
    const tpls = v.templates.map((t) => templateById(t)).filter((t): t is NonNullable<typeof t> => !!t);
    const mk = (type: ItemType, title: string): PlanItem => ({ id: newId('item'), type, title, text: '', reason: '', status: type === 'requirement' || type === 'decision' ? 'accepted' : 'open', rev: 1, createdAt: now, updatedAt: now, createdBy: c.actor });
    for (const t of tpls) {
      if (!p.kinds.includes(t.kind)) p.kinds.push(t.kind);
      for (const r of t.requirements) p.items.push(mk('requirement', r));
      for (const q of t.questions) p.items.push(mk('question', q));
      for (const d of t.deliverables) if (!p.deliverables.includes(d)) p.deliverables.push(d);
      const ids: string[] = [];
      for (const [i, tk] of t.tasks.entries()) {
        const task = this.blankTask(c.actor, now, { title: tk.title, description: tk.description, checks: tk.checks, expectedOutputs: tk.outputs });
        task.dependsOn = (tk.dependsOn ?? []).map((n) => ids[n]).filter((x): x is string => !!x);
        ids[i] = task.id;
        p.tasks.push(task);
      }
    }
    return this.store.create(p, c.actor, `Created project "${p.title}"${tpls.length ? ` from ${tpls.map((t) => t.label).join(' + ')}` : ''}`);
  }

  async updateProject(c: Ctx, id: string, patch: Partial<Pick<PlannerProject, 'title' | 'goal' | 'description' | 'scope' | 'constraints' | 'deliverables' | 'kinds'>>, expectedMetaRev?: number): Promise<PlannerProject> {
    need(c, 'edit');
    await this.store.mutate(id, c.actor, (p, log) => {
      checkRev(p.metaRev, expectedMetaRev, 'project description', { metaRev: p.metaRev });
      const keys = Object.keys(patch) as Array<keyof typeof patch>;
      const changed = keys.filter((k) => canonical(patch[k]) !== canonical(p[k]));
      if (!changed.length) return;
      if (patch.title !== undefined && !patch.title.trim()) throw new PlannerError('invalid', 'A project needs a title.');
      Object.assign(p, Object.fromEntries(changed.map((k) => [k, patch[k]])));
      p.metaRev++;
      log('project.updated', `Edited ${changed.join(', ')}`, { planAffecting: changed.some((k) => ['goal', 'description', 'scope', 'constraints', 'deliverables'].includes(k)) });
    });
    return this.store.read(id);
  }

  // ---------------------------------------------------------------- plan items
  private blankItem(a: Actor, now: string, type: ItemType, title: string, text = '', reason = ''): PlanItem {
    return { id: newId('item'), type, title: title.trim(), text, reason, status: type === 'requirement' || type === 'decision' ? 'accepted' : 'open', rev: 1, createdAt: now, updatedAt: now, createdBy: a };
  }
  async addItem(c: Ctx, id: string, i: { type: ItemType; title: string; text?: string; reason?: string }): Promise<PlanItem> {
    need(c, 'edit');
    if (!i.title.trim()) throw new PlannerError('invalid', 'Give it a title.');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const it = this.blankItem(c.actor, now.toISOString(), i.type, i.title, i.text ?? '', i.reason ?? '');
      p.items.push(it);
      log(`${i.type}.added`, `Added ${i.type} "${it.title}"`, { targetId: it.id, planAffecting: it.status === 'accepted' });
      return it;
    });
  }
  async updateItem(c: Ctx, id: string, itemId: string, patch: Partial<Pick<PlanItem, 'title' | 'text' | 'reason' | 'answer'>>, expectedRev?: number): Promise<PlanItem> {
    need(c, 'edit');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const it = find(p.items, itemId, 'item');
      checkRev(it.rev, expectedRev, it.type, it);
      Object.assign(it, patch);
      it.rev++; it.updatedAt = now.toISOString();
      log(`${it.type}.updated`, `Edited ${it.type} "${it.title}"`, { targetId: it.id, planAffecting: it.status === 'accepted' });
      return it;
    });
  }
  /** accepted: a requirement or decision joins the plan (an idea can be promoted by changing its type). rejected/superseded drop it from the plan. */
  async setItemStatus(c: Ctx, id: string, itemId: string, status: ItemStatus, opts: { type?: ItemType; answer?: string; expectedRev?: number } = {}): Promise<PlanItem> {
    need(c, 'edit');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const it = find(p.items, itemId, 'item');
      checkRev(it.rev, opts.expectedRev, it.type, it);
      const wasAccepted = it.status === 'accepted';
      if (opts.type && opts.type !== it.type) {
        if (it.status !== 'open') throw new PlannerError('invalid', 'Only an open item can change type.');
        it.type = opts.type;
      }
      it.status = status;
      if (opts.answer !== undefined) it.answer = opts.answer;
      it.rev++; it.updatedAt = now.toISOString();
      log(`${it.type}.${status}`, `${it.type.charAt(0).toUpperCase()}${it.type.slice(1)} "${it.title}" is now ${status}`, { targetId: it.id, planAffecting: wasAccepted || status === 'accepted' });
      return it;
    });
  }
  async removeItem(c: Ctx, id: string, itemId: string): Promise<void> {
    need(c, 'edit');
    await this.store.mutate(id, c.actor, (p, log) => {
      const it = find(p.items, itemId, 'item');
      if (it.status === 'accepted') throw new PlannerError('blocked', 'An accepted requirement or decision is not deleted: mark it superseded so the history stays.');
      p.items = p.items.filter((x) => x.id !== itemId);
      log(`${it.type}.removed`, `Removed ${it.type} "${it.title}"`, { targetId: itemId });
    });
  }

  // ---------------------------------------------------------------- tasks
  private blankTask(a: Actor, now: string, i: TaskInput): PlanTask {
    return {
      id: newId('task'), title: i.title.trim(), description: i.description ?? '', status: 'todo', priority: i.priority ?? 'normal', parentId: i.parentId ?? null, dependsOn: [...(i.dependsOn ?? [])],
      completionChecks: (i.checks ?? []).map((k) => ({ id: newId('chk'), text: k.text, kind: k.kind ?? 'review' })), expectedOutputs: i.expectedOutputs ?? [], assetIds: i.assetIds ?? [],
      milestoneId: i.milestoneId ?? null, appRef: i.appRef ?? null, packageId: null, claim: null, progressNote: '', rev: 1, createdAt: now, updatedAt: now, createdBy: a,
    };
  }
  private validateTaskRefs(p: PlannerProject, taskId: string | null, t: { dependsOn: string[]; parentId: string | null; milestoneId: string | null; assetIds: string[] }) {
    for (const d of t.dependsOn) find(p.tasks, d, 'task (dependency)');
    if (t.parentId) find(p.tasks, t.parentId, 'parent task');
    if (t.milestoneId) find(p.milestones, t.milestoneId, 'milestone');
    for (const a of t.assetIds) find(p.assets, a, 'asset');
    if (taskId && (t.dependsOn.includes(taskId) || wouldCycle(p.tasks, taskId, t.dependsOn))) throw new PlannerError('invalid', 'That dependency would make the task wait for itself.');
    if (taskId && t.parentId && (t.parentId === taskId)) throw new PlannerError('invalid', 'A task cannot be its own subtask.');
  }
  async addTask(c: Ctx, id: string, i: TaskInput): Promise<PlanTask> {
    need(c, 'edit');
    if (!i.title.trim()) throw new PlannerError('invalid', 'Give the task a title.');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const t = this.blankTask(c.actor, now.toISOString(), i);
      this.validateTaskRefs(p, null, t);
      p.tasks.push(t);
      log('task.added', `Added task "${t.title}"`, { targetId: t.id });
      return t;
    });
  }
  async updateTask(c: Ctx, id: string, taskId: string, patch: Partial<Omit<PlanTask, 'id' | 'rev' | 'status' | 'claim' | 'packageId' | 'createdAt' | 'createdBy' | 'updatedAt'>>, expectedRev?: number): Promise<PlanTask> {
    need(c, 'edit');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const t = find(p.tasks, taskId, 'task');
      checkRev(t.rev, expectedRev, 'task', t);
      if (t.packageId && isClaimLive(t.claim, now) && (patch.completionChecks || patch.description !== undefined)) throw new PlannerError('claimed', 'An executor is working on this task. Release the claim before changing what it asks for.');
      const next = { ...t, ...patch };
      this.validateTaskRefs(p, t.id, next);
      Object.assign(t, patch);
      t.rev++; t.updatedAt = now.toISOString();
      log('task.updated', `Edited task "${t.title}"`, { targetId: t.id });
      return t;
    });
  }
  /** The user's own transitions: cancel, reopen, or mark done by hand (a person can accept their own work). */
  async setTaskStatus(c: Ctx, id: string, taskId: string, status: Extract<TaskStatus, 'todo' | 'in_progress' | 'blocked' | 'accepted' | 'cancelled'>, note = '', expectedRev?: number): Promise<PlanTask> {
    need(c, 'edit');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const t = find(p.tasks, taskId, 'task');
      checkRev(t.rev, expectedRev, 'task', t);
      if (t.status === 'reported') throw new PlannerError('blocked', 'This task has a report waiting. Review the report instead.');
      if (isClaimLive(t.claim, now) && status !== 'cancelled') throw new PlannerError('claimed', `${t.claim?.executor.name} has this task claimed. Release the claim first.`);
      t.status = status; t.claim = null; t.progressNote = note || t.progressNote;
      if (status === 'todo') t.packageId = null;
      t.rev++; t.updatedAt = now.toISOString();
      this.refreshPackages(p);
      log('task.status', `Task "${t.title}" is now ${status}`, { targetId: t.id });
      return t;
    });
  }
  async removeTask(c: Ctx, id: string, taskId: string): Promise<void> {
    need(c, 'edit');
    await this.store.mutate(id, c.actor, (p, log, now) => {
      const t = find(p.tasks, taskId, 'task');
      if (t.packageId || isClaimLive(t.claim, now) || p.reports.some((r) => r.taskId === taskId)) throw new PlannerError('blocked', 'This task has been handed off, so it is cancelled rather than deleted. The history stays.');
      p.tasks = p.tasks.filter((x) => x.id !== taskId);
      for (const o of p.tasks) { o.dependsOn = o.dependsOn.filter((d) => d !== taskId); if (o.parentId === taskId) o.parentId = null; }
      log('task.removed', `Removed task "${t.title}"`, { targetId: taskId });
    });
  }

  // ---------------------------------------------------------------- assets and milestones
  async addAsset(c: Ctx, id: string, i: AssetInput): Promise<PlanAsset> {
    need(c, 'edit');
    if (!i.title.trim()) throw new PlannerError('invalid', 'Give the asset a title.');
    if (i.source === 'file' && !i.path) throw new PlannerError('invalid', 'A file asset needs a path.');
    if (i.source === 'link' && !/^https?:\/\//i.test(i.url ?? '')) throw new PlannerError('invalid', 'A link needs an http(s) address.');
    if (i.source === 'createcraft' && !i.createcraft) throw new PlannerError('invalid', 'A CreateCraft asset needs a project and asset id.');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const group = i.group ?? '';
      const version = i.version ?? (group ? 1 + Math.max(0, ...p.assets.filter((a) => a.group === group).map((a) => a.version)) : 1);
      const a: PlanAsset = {
        id: newId('ast'), role: i.role, title: i.title.trim(), source: i.source, path: i.path ?? '', url: i.url ?? '', createcraft: i.createcraft ?? null, note: i.note ?? '', group, version,
        sha256: i.sha256 ?? '', rev: 1, addedAt: now.toISOString(), addedBy: c.actor,
      };
      p.assets.push(a);
      log('asset.added', `Added ${a.role} "${a.title}"${a.group ? ` (version ${a.version})` : ''}`, { targetId: a.id });
      return a;
    });
  }
  async updateAsset(c: Ctx, id: string, assetId: string, patch: Partial<Pick<PlanAsset, 'title' | 'note' | 'role' | 'path' | 'url' | 'group' | 'sha256'>>, expectedRev?: number): Promise<PlanAsset> {
    need(c, 'edit');
    return this.store.mutate(id, c.actor, (p, log) => {
      const a = find(p.assets, assetId, 'asset');
      checkRev(a.rev, expectedRev, 'asset', a);
      Object.assign(a, patch); a.rev++;
      log('asset.updated', `Edited asset "${a.title}"`, { targetId: a.id });
      return a;
    });
  }
  async removeAsset(c: Ctx, id: string, assetId: string): Promise<void> {
    need(c, 'edit');
    await this.store.mutate(id, c.actor, (p, log) => {
      const a = find(p.assets, assetId, 'asset');
      if (p.packages.some((k) => k.assets.some((x) => x.id === assetId))) throw new PlannerError('blocked', 'This asset was given to an executor in a package, so it stays listed. Change its note instead.');
      p.assets = p.assets.filter((x) => x.id !== assetId);
      for (const t of p.tasks) t.assetIds = t.assetIds.filter((x) => x !== assetId);
      log('asset.removed', `Removed asset "${a.title}"`, { targetId: assetId });
    });
  }
  async addMilestone(c: Ctx, id: string, m: { title: string; due?: string }): Promise<Milestone> {
    need(c, 'edit');
    if (!m.title.trim()) throw new PlannerError('invalid', 'Give the milestone a title.');
    return this.store.mutate(id, c.actor, (p, log) => {
      const ms: Milestone = { id: newId('ms'), title: m.title.trim(), due: m.due ?? '', rev: 1 };
      p.milestones.push(ms);
      log('milestone.added', `Added milestone "${ms.title}"`, { targetId: ms.id });
      return ms;
    });
  }
  async removeMilestone(c: Ctx, id: string, msId: string): Promise<void> {
    need(c, 'edit');
    await this.store.mutate(id, c.actor, (p, log) => {
      const ms = find(p.milestones, msId, 'milestone');
      p.milestones = p.milestones.filter((x) => x.id !== msId);
      for (const t of p.tasks) if (t.milestoneId === msId) t.milestoneId = null;
      log('milestone.removed', `Removed milestone "${ms.title}"`, { targetId: msId });
    });
  }

  // ---------------------------------------------------------------- proposals
  async propose(c: Ctx, id: string, note: string, changes: ProposalChange[], source: Proposal['source'] = 'connection', reportId?: string): Promise<Proposal> {
    need(c, source === 'connection' ? 'propose' : 'execute');
    if (!changes.length) throw new PlannerError('invalid', 'A proposal needs at least one change.');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const pr = this.addProposal(p, c.actor, now, note, changes, source, reportId);
      log('proposal.created', `${c.actor.name} proposed ${changes.length} change(s): ${note.slice(0, 80)}`, { targetId: pr.id });
      return pr;
    });
  }
  private addProposal(p: PlannerProject, actor: Actor, now: Date, note: string, changes: ProposalChange[], source: Proposal['source'], reportId?: string): Proposal {
    const parsed = changes.map((x) => ({ ...x }));
    for (const ch of parsed) {
      if (ch.op === 'update_item') find(p.items, ch.id, 'item');
      if (ch.op === 'update_task') find(p.tasks, ch.id, 'task');
    }
    const pr: Proposal = { id: newId('prop'), proposedBy: actor, at: now.toISOString(), note: note.slice(0, 1000), changes: parsed, status: 'pending', source, ...(reportId ? { reportId } : {}) };
    p.proposals.push(pr);
    return pr;
  }
  /** Only the user decides. Accepting applies the chosen changes in one step; a change to something edited since is refused, not merged. */
  async decideProposal(c: Ctx, id: string, proposalId: string, accept: boolean, only?: number[]): Promise<Proposal> {
    need(c, 'review');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const pr = find(p.proposals, proposalId, 'proposal');
      if (pr.status !== 'pending') throw new PlannerError('conflict', 'That proposal was already decided.');
      pr.status = accept ? 'accepted' : 'rejected';
      pr.decidedAt = now.toISOString();
      if (!accept) { log('proposal.rejected', `Rejected a proposal from ${pr.proposedBy.name}`, { targetId: pr.id }); return pr; }
      const picked = pr.changes.filter((_, i) => !only || only.includes(i));
      const nowIso = now.toISOString();
      const conflicts: string[] = [];
      for (const ch of picked) {
        if (ch.op === 'update_item') { const it = p.items.find((x) => x.id === ch.id); if (!it || it.rev !== ch.baseRev) conflicts.push(`"${it?.title ?? ch.id}" changed after this was proposed`); }
        if (ch.op === 'update_task') { const t = p.tasks.find((x) => x.id === ch.id); if (!t || t.rev !== ch.baseRev) conflicts.push(`task "${t?.title ?? ch.id}" changed after this was proposed`); }
        if (ch.op === 'set_brief' && ch.baseMetaRev !== undefined && ch.baseMetaRev !== p.metaRev) conflicts.push('the project brief was edited after this was proposed');
      }
      let briefChanged = false;
      if (conflicts.length) throw new PlannerError('conflict', `Not applied: ${conflicts.join('; ')}. Reject the proposal or deselect those changes.`, { conflicts });
      // Milestones first, so tasks proposed in the same step can be placed under them.
      for (const ch of [...picked.filter((x) => x.op === 'add_milestone'), ...picked.filter((x) => x.op !== 'add_milestone')]) {
        if (ch.op === 'add_item') p.items.push(this.blankItem(pr.proposedBy, nowIso, ch.itemType, ch.title, ch.text, ch.reason));
        else if (ch.op === 'set_brief') {
          // Text parts are replaced; lists only gain entries, so nothing the owner wrote is lost.
          for (const k of ['goal', 'description', 'scope'] as const) if (ch.patch[k] !== undefined && ch.patch[k] !== p[k]) { p[k] = ch.patch[k]!; briefChanged = true; }
          for (const k of ['constraints', 'deliverables'] as const) {
            const add = (ch.patch[k] ?? []).filter((x) => !p[k].some((y) => y.trim().toLowerCase() === x.trim().toLowerCase()));
            if (add.length) { p[k] = [...p[k], ...add]; briefChanged = true; }
          }
        } else if (ch.op === 'add_milestone') {
          if (!p.milestones.some((m) => m.title.trim().toLowerCase() === ch.title.trim().toLowerCase())) p.milestones.push({ id: newId('ms'), title: ch.title.trim(), due: ch.due, rev: 1 });
        }
        else if (ch.op === 'update_item') { const it = find(p.items, ch.id, 'item'); Object.assign(it, ch.patch); it.rev++; it.updatedAt = nowIso; }
        else if (ch.op === 'add_task') {
          const ms = ch.milestone ? p.milestones.find((m) => m.title.trim().toLowerCase() === ch.milestone!.trim().toLowerCase()) : undefined;
          const t = this.blankTask(pr.proposedBy, nowIso, { title: ch.title, description: ch.description, priority: ch.priority, milestoneId: ms?.id ?? null, dependsOn: ch.dependsOn.filter((d) => p.tasks.some((x) => x.id === d)), parentId: ch.parentId && p.tasks.some((x) => x.id === ch.parentId) ? ch.parentId : null, checks: ch.completionChecks.map((text) => ({ text })) });
          p.tasks.push(t);
        } else {
          const t = find(p.tasks, ch.id, 'task');
          if (ch.patch.title !== undefined) t.title = ch.patch.title;
          if (ch.patch.description !== undefined) t.description = ch.patch.description;
          if (ch.patch.priority !== undefined) t.priority = ch.patch.priority;
          if (ch.patch.completionChecks) t.completionChecks = ch.patch.completionChecks.map((text) => ({ id: newId('chk'), text, kind: 'review' }));
          t.rev++; t.updatedAt = nowIso;
        }
      }
      if (briefChanged) p.metaRev++;
      log('proposal.accepted', `Accepted ${picked.length} change(s) proposed by ${pr.proposedBy.name}`, { targetId: pr.id, ...(briefChanged ? { planAffecting: true } : {}) });
      return pr;
    });
  }

  // ---------------------------------------------------------------- execution packages
  private refreshPackages(p: PlannerProject) {
    for (const k of p.packages) {
      if (k.state !== 'open') continue;
      const mine = p.tasks.filter((t) => t.packageId === k.id);
      if (!mine.length) k.state = k.tasks.every((t) => ['accepted', 'cancelled'].includes(p.tasks.find((x) => x.id === t.id)?.status ?? '')) ? 'closed' : 'superseded';
      else if (mine.every((t) => t.status === 'accepted' || t.status === 'cancelled')) k.state = 'closed';
    }
  }

  /** The parts of a package that depend on what is being sent. Shared by createPackage (to build it) and prepareSend (to recognise an identical one). */
  private packageParts(p: PlannerProject, tasks: PlanTask[], req: { objective?: string; note?: string }) {
    const pkgTasks: PackageTask[] = tasks.map((t) => ({ id: t.id, title: t.title, description: t.description, priority: t.priority, dependsOn: [...t.dependsOn], completionChecks: t.completionChecks.map((k) => ({ ...k })), expectedOutputs: [...t.expectedOutputs], appRef: t.appRef, assetIds: [...t.assetIds] }));
    const wanted = new Set([...tasks.flatMap((t) => t.assetIds), ...p.assets.filter((a) => a.role === 'reference').map((a) => a.id)]);
    return {
      plan: snapshotOf(p), tasks: pkgTasks,
      assets: p.assets.filter((a) => wanted.has(a.id)).map((a) => ({ id: a.id, role: a.role, title: a.title, source: a.source, path: a.path, url: a.url, note: a.note })),
      objective: req.objective?.trim() || `Complete: ${tasks.map((t) => t.title).join('; ')}`, context: req.note ?? '',
    };
  }
  /** Identifies what an AI would receive, ignoring the package number, id and time, so an identical re-send can reuse the open package. */
  private contentKeyOf(p: PlannerProject, tasks: PlanTask[], req: { objective?: string; note?: string }, delivery?: Delivery): string {
    // Only what the AI would receive counts (not the destination or budget), so the same content for another AI is the same brief.
    return hash({ ...this.packageParts(p, tasks, req), planRevision: p.planRevision, delivery: delivery && { includedIds: delivery.includedIds, omitted: delivery.omitted, upstream: delivery.upstream } });
  }

  private checkSendable(p: PlannerProject, tasks: PlanTask[], now: Date) {
    for (const t of tasks) {
      if (isClaimLive(t.claim, now)) throw new PlannerError('claimed', `"${t.title}" is claimed by ${t.claim?.executor.name}. Release the claim before preparing a new package for it.`);
      if (!['todo', 'revision'].includes(t.status)) throw new PlannerError('blocked', `"${t.title}" is ${t.status}; only tasks that are to do (or sent back for revision) can be handed off.`);
      const missing = t.dependsOn.map((d) => find(p.tasks, d, 'task')).filter((d) => d.status !== 'accepted' && d.status !== 'cancelled' && !tasks.some((x) => x.id === d.id));
      if (missing.length) throw new PlannerError('blocked', `"${t.title}" waits for "${missing[0]?.title}". Include it in the package or finish it first.`);
    }
  }

  private buildPackage(p: PlannerProject, actor: Actor, now: Date, log: LogFn, tasks: PlanTask[], req: { objective?: string; note?: string }, delivery?: Delivery): ExecPackage {
    const parts = this.packageParts(p, tasks, req);
    const number = ++p.counters.package;
    const prior = tasks.map((t) => t.packageId).filter((x): x is string => !!x);
    const pkg: ExecPackage = {
      id: newId('pkg'), projectId: p.id, number, planRevision: p.planRevision, createdAt: now.toISOString(), createdBy: actor,
      objective: parts.objective, context: parts.context, plan: parts.plan, tasks: parts.tasks, assets: parts.assets,
      reportInstructions: '', contentHash: '', state: 'open', ...(prior.length ? { supersedes: prior[0] } : {}), ...(delivery ? { delivery } : {}),
    };
    pkg.reportInstructions = reportInstructionsFor(pkg, p.title);
    pkg.contentHash = hash({ ...pkg, id: undefined, createdAt: undefined, contentHash: undefined });
    pkg.contentKey = this.contentKeyOf(p, tasks, req, delivery); // set after the hash, so contentHash is exactly what it was before this field existed
    p.packages.push(pkg);
    for (const t of tasks) { t.packageId = pkg.id; t.claim = null; t.rev++; t.updatedAt = pkg.createdAt; }
    this.refreshPackages(p);
    log('package.created', `Prepared execution package ${number} (${tasks.length} task(s), plan revision ${p.planRevision}); nothing was started`, { targetId: pkg.id });
    return pkg;
  }

  async createPackage(c: Ctx, id: string, req: { taskIds: string[]; objective?: string; note?: string }): Promise<ExecPackage> {
    need(c, 'package');
    if (!req.taskIds.length) throw new PlannerError('invalid', 'Select at least one task.');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const tasks = [...new Set(req.taskIds)].map((tid) => find(p.tasks, tid, 'task'));
      this.checkSendable(p, tasks, now);
      return this.buildPackage(p, c.actor, now, log, tasks, req);
    });
  }

  /**
   * "Send to AI": the same package as createPackage, except that an identical open package (same tasks, same accepted plan, same
   * content) is returned as it is instead of making package N+1 that supersedes it. Runs in one locked step, so two callers sending the
   * same tasks at once end up with one package.
   */
  async prepareSend(c: Ctx, id: string, req: { taskIds: string[]; objective?: string; note?: string; destination?: DestinationId; forceInclude?: string[] }): Promise<{ package: ExecPackage; reused: boolean; replaced: number[] }> {
    need(c, 'package');
    if (!req.taskIds.length) throw new PlannerError('invalid', 'Select at least one task.');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const wanted = [...new Set(req.taskIds)].map((tid) => find(p.tasks, tid, 'task'));
      const tasks = p.tasks.filter((t) => wanted.includes(t)); // project order, so the same selection always gives the same package
      // With a destination the brief carries only what fits it (everything for tools; budgeted for chats) and says what was left out.
      const delivery: Delivery | undefined = req.destination ? (({ rules: _r, size: _s, ...d }) => d)(buildContext(p, { purpose: 'execute', taskIds: tasks.map((t) => t.id), destination: req.destination, forceInclude: req.forceInclude })) : undefined;
      const key = this.contentKeyOf(p, tasks, req, delivery);
      const same = p.packages.find((k) => k.state === 'open' && k.contentKey === key && k.tasks.length === tasks.length && tasks.every((t) => t.packageId === k.id && k.tasks.some((x) => x.id === t.id)));
      if (same) return { package: same, reused: true, replaced: [] };
      this.checkSendable(p, tasks, now);
      const open = new Set(p.packages.filter((k) => k.state === 'open').map((k) => k.id));
      const pkg = this.buildPackage(p, c.actor, now, log, tasks, req, delivery);
      const replaced = p.packages.filter((k) => open.has(k.id) && k.state === 'superseded').map((k) => k.number);
      return { package: pkg, reused: false, replaced };
    });
  }
  async cancelPackage(c: Ctx, id: string, pkgId: string): Promise<void> {
    need(c, 'edit');
    await this.store.mutate(id, c.actor, (p, log, now) => {
      const k = find(p.packages, pkgId, 'package');
      if (k.state !== 'open') throw new PlannerError('blocked', 'That package is not open.');
      const mine = p.tasks.filter((t) => t.packageId === k.id);
      if (mine.some((t) => t.status === 'reported')) throw new PlannerError('blocked', 'A report from this package is waiting for your review.');
      for (const t of mine) { if (t.status === 'accepted') continue; t.packageId = null; t.claim = null; if (t.status !== 'cancelled') t.status = 'todo'; t.rev++; t.updatedAt = now.toISOString(); }
      k.state = 'cancelled';
      log('package.cancelled', `Cancelled package ${k.number}`, { targetId: k.id });
    });
  }

  async getPackage(c: Ctx, id: string, pkgId: string): Promise<{ package: ExecPackage; markdown: string; drift: PlanDrift; tasks: Array<{ id: string; status: TaskStatus; claimedBy: string | null; blockedBy: string[] }> }> {
    need(c, 'read');
    const p = await this.store.read(id);
    const k = find(p.packages, pkgId, 'package');
    return { package: k, markdown: packageToMarkdown(k, p.title), drift: planDrift(k.plan, snapshotOf(p)), tasks: k.tasks.map((t) => { const cur = p.tasks.find((x) => x.id === t.id); return { id: t.id, status: cur?.status ?? 'cancelled', claimedBy: cur && isClaimLive(cur.claim, this.now()) ? cur.claim?.executor.name ?? null : null, blockedBy: cur ? unmetDependencies(p, cur).map((x) => x.id) : [] }; }) };
  }

  // ---------------------------------------------------------------- claims
  async claimTask(c: Ctx, id: string, pkgId: string, taskId: string, opts: { note?: string; leaseMinutes?: number } = {}): Promise<{ claimToken: string; leaseUntil: string; drift: PlanDrift; alreadyYours: boolean }> {
    need(c, 'execute');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const k = find(p.packages, pkgId, 'package');
      const t = find(p.tasks, taskId, 'task');
      if (k.state !== 'open') throw new PlannerError('stale', `Package ${k.number} is ${k.state}. Ask for the current package.`);
      if (t.packageId !== k.id || !k.tasks.some((x) => x.id === t.id)) throw new PlannerError('stale', 'This task is no longer part of that package. Ask for the current package.');
      if (t.claim && isClaimLive(t.claim, now)) {
        if (t.claim.executor.name === c.actor.name && t.claim.executor.kind === c.actor.kind) return { claimToken: t.claim.token, leaseUntil: t.claim.leaseUntil, drift: planDrift(k.plan, snapshotOf(p)), alreadyYours: true };
        throw new PlannerError('claimed', `${t.claim.executor.name} already claimed this task (until ${t.claim.leaseUntil}).`);
      }
      if (!['todo', 'revision', 'in_progress', 'blocked'].includes(t.status)) throw new PlannerError('blocked', `The task is ${t.status}; it cannot be claimed.`);
      const waits = unmetDependencies(p, t).filter((d) => !(d.status === 'reported' && d.packageId === k.id));
      if (waits.length) throw new PlannerError('blocked', `Waiting for "${waits[0]?.title}" to be accepted first.`);
      const token = randomBytes(12).toString('hex');
      const until = new Date(now.getTime() + (opts.leaseMinutes ?? LEASE_MINUTES) * 60_000).toISOString();
      const took = t.claim ? ` (took over an expired claim by ${t.claim.executor.name})` : '';
      t.claim = { token, packageId: k.id, executor: c.actor, claimedAt: now.toISOString(), leaseUntil: until, note: opts.note ?? '' };
      t.status = 'in_progress'; t.rev++; t.updatedAt = now.toISOString();
      log('task.claimed', `${c.actor.name} claimed "${t.title}"${took}`, { targetId: t.id });
      return { claimToken: token, leaseUntil: until, drift: planDrift(k.plan, snapshotOf(p)), alreadyYours: false };
    });
  }
  async releaseClaim(c: Ctx, id: string, taskId: string, token?: string): Promise<void> {
    if (!c.scopes.has('edit')) need(c, 'execute');
    await this.store.mutate(id, c.actor, (p, log, now) => {
      const t = find(p.tasks, taskId, 'task');
      if (!t.claim) return;
      if (!c.scopes.has('edit') && t.claim.token !== token) throw new PlannerError('forbidden', 'That claim belongs to someone else.');
      log('task.released', `${c.actor.name} released "${t.title}"`, { targetId: t.id });
      t.claim = null; if (t.status === 'in_progress') t.status = 'todo'; t.rev++; t.updatedAt = now.toISOString();
    });
  }
  async reportProgress(c: Ctx, id: string, pkgId: string, taskId: string, token: string, note: string, status?: 'in_progress' | 'blocked'): Promise<{ leaseUntil: string }> {
    need(c, 'execute');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const t = find(p.tasks, taskId, 'task');
      if (!t.claim || t.claim.token !== token || t.claim.packageId !== pkgId) throw new PlannerError('forbidden', 'You do not hold the claim on this task.');
      t.progressNote = note.slice(0, 1000);
      if (status) t.status = status;
      t.claim.leaseUntil = new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString();
      t.rev++; t.updatedAt = now.toISOString();
      log('task.progress', `${c.actor.name}: ${status === 'blocked' ? 'blocked on' : 'progress on'} "${t.title}" - ${note.slice(0, 100)}`, { targetId: t.id });
      return { leaseUntil: t.claim.leaseUntil };
    });
  }

  // ---------------------------------------------------------------- reports
  private applyReport(p: PlannerProject, actor: Actor, now: Date, input: { packageId: string; taskId: string; draft: ReportDraft; source: PlanReport['source']; uncertain?: string[]; rawText?: string }, log: LogFn): { report: PlanReport; duplicate: boolean } {
    const k = find(p.packages, input.packageId, 'package');
    const t = find(p.tasks, input.taskId, 'task');
    if (!k.tasks.some((x) => x.id === t.id)) throw new PlannerError('invalid', 'That task is not part of that package.');
    const draft = reportDraftSchema.parse(input.draft);
    const contentHash = hash({ draft, packageId: k.id, taskId: t.id });
    const dup = p.reports.find((r) => r.contentHash === contentHash && r.packageId === k.id && r.taskId === t.id);
    if (dup) return { report: dup, duplicate: true };
    if (t.status === 'reported') throw new PlannerError('conflict', 'A report for this task is already waiting for the user\'s review.');
    const report: PlanReport = {
      ...draft, id: newId('rep'), packageId: k.id, packageNumber: k.number, taskId: t.id, planRevision: k.planRevision, submittedAt: now.toISOString(), executor: actor, source: input.source,
      status: 'submitted', contentHash, uncertain: input.uncertain ?? [], hasRawText: !!input.rawText, driftAtSubmit: planDrift(k.plan, snapshotOf(p)),
    };
    p.reports.push(report);
    const changes: ProposalChange[] = [...draft.proposedChanges];
    for (const q of draft.unresolvedQuestions) if (!p.items.some((i) => i.type === 'question' && i.title === q.slice(0, 200))) changes.push({ op: 'add_item', itemType: 'question', title: q.slice(0, 200), text: `Raised while working on "${t.title}".`, reason: '' });
    if (changes.length) this.addProposal(p, actor, now, `From the report on "${t.title}"`, changes, 'report', report.id);
    t.claim = input.source === 'connection' && (draft.outcome === 'partial' || draft.outcome === 'blocked') ? t.claim : null;
    t.status = draft.outcome === 'complete' ? 'reported' : draft.outcome === 'partial' ? 'in_progress' : draft.outcome === 'blocked' ? 'blocked' : 'todo';
    t.progressNote = draft.outcome === 'complete' ? '' : draft.workPerformed.slice(0, 300);
    t.rev++; t.updatedAt = now.toISOString();
    log('report.submitted', `${actor.name} reported "${t.title}" as ${draft.outcome}${draft.outcome === 'complete' ? ' (awaiting your review)' : ''}${report.driftAtSubmit.outdated ? ' - the plan changed since the package' : ''}`, { targetId: report.id });
    return { report, duplicate: false };
  }

  async submitReport(c: Ctx, id: string, req: { packageId: string; taskId: string; claimToken: string; report: ReportDraft }): Promise<{ report: PlanReport; duplicate: boolean }> {
    need(c, 'execute');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const t = find(p.tasks, req.taskId, 'task');
      const k = find(p.packages, req.packageId, 'package');
      if (t.packageId !== k.id) throw new PlannerError('stale', 'This task now belongs to a newer package. Do not submit work for the old one; ask for the current package.');
      const prior = p.reports.find((r) => r.taskId === t.id && r.packageId === k.id && r.contentHash === hash({ draft: reportDraftSchema.parse(req.report), packageId: k.id, taskId: t.id }));
      if (prior) return { report: prior, duplicate: true };
      if (!t.claim || t.claim.token !== req.claimToken || t.claim.packageId !== k.id) throw new PlannerError('forbidden', 'Claim the task first (and use the claim token you were given).');
      return this.applyReport(p, c.actor, now, { packageId: k.id, taskId: t.id, draft: req.report, source: 'connection' }, log);
    });
  }

  /** The user applies a pasted report after seeing the preview. The original text is kept next to it. */
  async importReport(c: Ctx, id: string, req: { packageId: string; taskId: string; executor: Actor; report: ReportDraft; uncertain?: string[]; rawText: string }): Promise<{ report: PlanReport; duplicate: boolean }> {
    need(c, 'review');
    const res = await this.store.mutate(id, c.actor, (p, log, now) => {
      const t = find(p.tasks, req.taskId, 'task');
      if (t.packageId !== req.packageId) throw new PlannerError('stale', 'That task is not in that package any more (a newer package replaced it, or it was cancelled).');
      if (t.status === 'accepted' || t.status === 'cancelled') throw new PlannerError('blocked', `The task is already ${t.status}.`);
      return this.applyReport(p, req.executor, now, { packageId: req.packageId, taskId: req.taskId, draft: req.report, source: 'pasted', uncertain: req.uncertain, rawText: req.rawText }, log);
    });
    if (!res.duplicate) await this.store.saveRaw(id, res.report.id, req.rawText);
    return res;
  }

  /**
   * The plan approved on Home ("Create with Claude") becomes a Planner project whose steps and questions are only SUGGESTIONS: one
   * pending proposal (source "home"). Nothing joins the plan until the owner accepts it; there is no second plan.
   */
  async createFromHomePlan(c: Ctx, input: { title: string; goal: string; kind?: string; steps: string[]; questions: string[] }): Promise<{ project: PlannerProject; proposal: Proposal }> {
    need(c, 'edit'); need(c, 'review');
    const kinds: Record<string, string> = { image: 'art', design: 'art', video: 'media', audio: 'media' };
    const created = await this.createProject(c, { title: input.title.slice(0, 120) || 'Untitled project', goal: input.goal.slice(0, 2000) });
    if (input.kind && kinds[input.kind]) await this.updateProject(c, created.id, { kinds: [kinds[input.kind] as string] });
    const clip = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 200);
    const changes: ProposalChange[] = [
      ...input.steps.slice(0, 8).filter((t) => clip(t)).map((t) => changeSchema.parse({ op: 'add_task', title: clip(t) })),
      ...input.questions.slice(0, 3).filter((t) => clip(t)).map((t) => changeSchema.parse({ op: 'add_item', itemType: 'question', title: clip(t), text: 'Asked while planning the project.' })),
    ];
    if (!changes.length) throw new PlannerError('invalid', 'The plan has no steps to suggest.');
    const proposal = await this.store.mutate(created.id, c.actor, (p, log, now) => {
      const made = this.addProposal(p, { kind: 'createcraft', name: 'CreateCraft Claude' }, now, 'Steps and questions from the plan you approved on Home', changes, 'home');
      log('proposal.created', `${changes.length} suggestion(s) from the plan approved on Home; waiting for your decision`, { targetId: made.id });
      return made;
    });
    return { project: await this.store.read(created.id), proposal };
  }

  /**
   * The owner pasted an AI's plan suggestions. They are stored as a PENDING proposal (source "pasted"); nothing joins the plan until
   * decideProposal. The proposer is the AI named in the text (a claim, shown as such); the history actor is whoever entered it.
   */
  async importSuggestions(c: Ctx, id: string, req: { proposer?: Actor; note?: string; changes: ProposalChange[]; rawText: string }): Promise<Proposal> {
    need(c, 'review');
    if (!req.changes.length) throw new PlannerError('invalid', 'There is nothing to add.');
    // The renderer is trusted, but the changes are checked here like every other path (the MCP boundary does the same).
    const checked = changeSchema.array().max(80).safeParse(req.changes);
    if (!checked.success) throw new PlannerError('invalid', `Those suggestions are not valid: ${checked.error.issues[0]?.message ?? 'unreadable'}.`);
    const proposer: Actor = req.proposer ?? { kind: 'other', name: 'Pasted suggestion' };
    const pr = await this.store.mutate(id, c.actor, (p, log, now) => {
      const made = this.addProposal(p, proposer, now, req.note || 'Pasted from an AI answer', checked.data, 'pasted');
      log('proposal.created', `${c.actor.name} pasted ${req.changes.length} suggestion(s) from ${proposer.name}; waiting for your decision`, { targetId: made.id });
      return made;
    });
    await this.store.saveRaw(id, pr.id, req.rawText);
    return pr;
  }

  async rawReport(c: Ctx, id: string, reportId: string): Promise<string | null> { need(c, 'read'); return this.store.readRaw(id, reportId); }

  async reviewReport(c: Ctx, id: string, reportId: string, decision: 'accept' | 'revise' | 'reject', note = '', opts: { acknowledgeOutdated?: boolean } = {}): Promise<{ report: PlanReport; driftNow: PlanDrift; uncovered: number }> {
    need(c, 'review');
    return this.store.mutate(id, c.actor, (p, log, now) => {
      const r = find(p.reports, reportId, 'report');
      const t = find(p.tasks, r.taskId, 'task');
      const k = find(p.packages, r.packageId, 'package');
      if (r.status !== 'submitted') throw new PlannerError('conflict', 'That report was already reviewed.');
      const driftNow = planDrift(k.plan, snapshotOf(p));
      const uncovered = uncoveredChecks(k.tasks.find((x) => x.id === t.id) ?? t, r).length;
      if (decision === 'accept') {
        if (r.outcome !== 'complete') throw new PlannerError('blocked', `This report says the work is ${r.outcome}, so it cannot be accepted as done. Ask for a revision or reject it.`);
        if (driftNow.outdated && !opts.acknowledgeOutdated) throw new PlannerError('stale', 'The plan changed after this work was handed off. Review what changed, then accept knowingly.', { drift: driftNow });
        r.status = 'accepted'; t.status = 'accepted'; t.claim = null;
      } else if (decision === 'revise') {
        r.status = 'revision_requested'; t.status = 'revision'; t.claim = null; t.progressNote = note.slice(0, 500);
      } else {
        r.status = 'rejected';
        if (t.status === 'reported') { t.status = 'todo'; t.claim = null; }
      }
      r.review = { at: now.toISOString(), note: note.slice(0, 2000) };
      t.rev++; t.updatedAt = now.toISOString();
      this.refreshPackages(p);
      log(`report.${r.status}`, `${decision === 'accept' ? 'Accepted' : decision === 'revise' ? 'Asked for a revision of' : 'Rejected'} the report on "${t.title}"${note ? `: ${note.slice(0, 80)}` : ''}`, { targetId: r.id });
      return { report: r, driftNow, uncovered };
    });
  }

  // ---------------------------------------------------------------- export and import
  async exportProject(c: Ctx, id: string, mode: 'reference' | 'bundle'): Promise<Buffer> {
    need(c, 'read');
    const p: PlannerProject = JSON.parse(JSON.stringify(await this.store.read(id)));
    const files: Record<string, Buffer | string> = {};
    const assets: Array<{ id: string; how: 'referenced' | 'bundled'; file?: string; why?: string }> = [];
    for (const a of p.assets) {
      if (mode === 'bundle' && a.source === 'file' && a.path) {
        try {
          const st = await fs.stat(a.path);
          if (st.isFile() && st.size <= 50 * 1024 * 1024) {
            const entry = `assets/${a.id}/${path.basename(a.path).replace(/[^\w.\- ]/g, '_')}`;
            files[entry] = await fs.readFile(a.path);
            assets.push({ id: a.id, how: 'bundled', file: entry });
            continue;
          }
          assets.push({ id: a.id, how: 'referenced', why: 'The file is larger than 50 MB, so only its location is exported.' });
        } catch { assets.push({ id: a.id, how: 'referenced', why: 'The file was not found when exporting.' }); }
        continue;
      }
      assets.push({ id: a.id, how: 'referenced', ...(a.source === 'createcraft' ? { why: 'Lives in a CreateCraft art project; relink after import.' } : {}) });
    }
    for (const t of p.tasks) { if (t.claim) { t.claim = null; if (t.status === 'in_progress') t.status = 'todo'; } }
    files['planner.json'] = JSON.stringify({ format: PLANNER_FORMAT, version: 1, exportedAt: this.now().toISOString(), mode, project: p, activity: await this.store.history(id, 0, 5000), assets }, null, 2);
    files['README.txt'] = 'CreateCraft Project Planner export. planner.json holds the plan; assets/ holds bundled files. Referenced files keep the path they had on the exporting computer. Claims are removed. No credentials or settings are included.';
    return writeZip(files);
  }

  async importProject(c: Ctx, zip: Buffer): Promise<PlannerProject> {
    need(c, 'edit');
    let entries: Map<string, Buffer>;
    try { entries = readZip(zip, { maxFiles: 5000, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024 }); } catch (e) { throw new PlannerError('invalid', `That is not a planner export (${(e as Error).message}).`); }
    const raw = entries.get('planner.json');
    if (!raw) throw new PlannerError('invalid', 'That is not a planner export (planner.json is missing).');
    let doc: { format?: string; version?: number; project?: PlannerProject; assets?: Array<{ id: string; how: string; file?: string }> };
    try { doc = JSON.parse(raw.toString('utf8')); } catch { throw new PlannerError('invalid', 'The export is damaged.'); }
    const src = doc.project;
    if (doc.format !== PLANNER_FORMAT || doc.version !== 1 || !src || typeof src.title !== 'string' || !Array.isArray(src.tasks) || !Array.isArray(src.items) || !Array.isArray(src.assets) || !Array.isArray(src.packages) || !Array.isArray(src.reports)) throw new PlannerError('invalid', 'That file is not a version 1 planner export.');
    const project: PlannerProject = { ...src, id: `plan_${randomBytes(6).toString('hex')}`, title: `${src.title} (imported)`, proposals: src.proposals ?? [], milestones: src.milestones ?? [], planVersions: [], counters: { package: src.counters?.package ?? 0, activity: 0 } };
    const dir = this.store.dir(project.id);
    for (const a of doc.assets ?? []) {
      if (a.how !== 'bundled' || !a.file) continue;
      const data = entries.get(a.file);
      const pa = project.assets.find((x) => x.id === a.id);
      if (!data || !pa) continue;
      const dest = path.join(dir, 'assets', pa.id, path.basename(a.file));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, data);
      pa.path = dest;
    }
    for (const t of project.tasks) t.claim = null;
    await this.store.create(project, c.actor, `Imported "${src.title}" (${(doc.assets ?? []).filter((a) => a.how === 'bundled').length} bundled file(s), ${project.assets.length - (doc.assets ?? []).filter((a) => a.how === 'bundled').length} referenced)`);
    return this.store.read(project.id);
  }

  /** Which linked files are still where the plan says (referenced files can move). */
  async assetHealth(c: Ctx, id: string): Promise<Record<string, 'ok' | 'missing' | 'n/a'>> {
    need(c, 'read');
    const p = await this.store.read(id);
    const out: Record<string, 'ok' | 'missing' | 'n/a'> = {};
    for (const a of p.assets) out[a.id] = a.source === 'file' ? ((await fs.stat(a.path).then(() => true).catch(() => false)) ? 'ok' : 'missing') : 'n/a';
    return out;
  }
}


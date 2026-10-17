// Phase 0 baseline for the planner simplification (docs/planner-simplification-plan.md). It does not test new behaviour:
//  1. golden fixtures made by the CURRENT build (GEN_PLANNER_FIXTURES=1 rewrites them) must keep loading and behaving the same;
//  2. probes that pin the findings in section 1.5 of the plan, so later phases change them on purpose, not by accident.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlannerProject, ReportDraft } from '@shared/planner';
import { connectionCtx, PlannerService, userCtx } from './service';
import { PlannerStore } from './store';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const user = userCtx();
const exec = connectionCtx({ kind: 'claude-code', name: 'Claude Code' }, ['read', 'execute']);
const draft = (over: Partial<ReportDraft> = {}): ReportDraft => ({ outcome: 'complete', workPerformed: 'Done.', outputs: [], changedFiles: [], verification: [], blockers: [], limitations: [], unresolvedQuestions: [], proposedChanges: [], ...over });

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-plan-base-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const mk = (name: string, now?: () => Date) => { const store = new PlannerStore(path.join(tmp, name), now); return { store, svc: new PlannerService(store, now) }; };

/** Builds the scenarios with the current service. Each returns the finished project. */
const SCENARIOS: Record<string, () => Promise<PlannerProject>> = {
  fresh: async () => { const { svc } = mk('fresh'); return svc.createProject(user, { title: 'Fresh', goal: 'A goal', templates: ['document'] }); },
  'mid-claim': async () => {
    const { svc } = mk('mid');
    const p = await svc.createProject(user, { title: 'Mid claim', templates: ['art'] });
    const k = await svc.createPackage(user, p.id, { taskIds: [p.tasks[0]!.id] });
    await svc.claimTask(exec, p.id, k.id, p.tasks[0]!.id);
    return svc.getProject(user, p.id);
  },
  'outdated-report': async () => {
    const { svc } = mk('outdated');
    const p = await svc.createProject(user, { title: 'Outdated', templates: ['research'] });
    const t = p.tasks[0]!;
    const k = await svc.createPackage(user, p.id, { taskIds: [t.id] });
    const c = await svc.claimTask(exec, p.id, k.id, t.id);
    await svc.addItem(user, p.id, { type: 'requirement', title: 'New rule after handoff' });
    await svc.submitReport(exec, p.id, { packageId: k.id, taskId: t.id, claimToken: c.claimToken, report: draft({ unresolvedQuestions: ['Which sources?'] }) });
    return svc.getProject(user, p.id);
  },
  superseded: async () => {
    const { svc } = mk('superseded');
    const p = await svc.createProject(user, { title: 'Superseded', templates: ['media'] });
    await svc.createPackage(user, p.id, { taskIds: [p.tasks[0]!.id] });
    await svc.createPackage(user, p.id, { taskIds: [p.tasks[0]!.id] });
    return svc.getProject(user, p.id);
  },
};

describe('phase 0 golden fixtures (made by the current build)', () => {
  if (process.env.GEN_PLANNER_FIXTURES) {
    it('regenerates the fixtures', async () => {
      await fs.mkdir(FIX, { recursive: true });
      for (const [name, build] of Object.entries(SCENARIOS)) await fs.writeFile(path.join(FIX, `${name}.project.json`), JSON.stringify(await build(), null, 2), 'utf8');
    });
    return;
  }
  for (const name of Object.keys(SCENARIOS)) {
    it(`${name}: loads, summarises and stays internally consistent`, async () => {
      const p = JSON.parse(await fs.readFile(path.join(FIX, `${name}.project.json`), 'utf8')) as PlannerProject;
      const store = new PlannerStore(path.join(tmp, `load-${name}`));
      await fs.mkdir(store.dir(p.id), { recursive: true });
      await fs.writeFile(path.join(store.dir(p.id), 'project.json'), JSON.stringify(p), 'utf8');
      const svc = new PlannerService(store);
      const got = await svc.getProject(user, p.id);
      expect(got.revision).toBe(p.revision);
      expect((await svc.listProjects(user))[0]?.id).toBe(p.id);
      expect((await svc.context(user, p.id)).project.planRevision).toBe(p.planRevision);
      // the invariant the new views rely on: a task is in at most one OPEN package
      for (const t of got.tasks) if (t.packageId) expect(got.packages.find((k) => k.id === t.packageId)?.state).toBe('open');
      // an old project still accepts a normal write (older data stays writable)
      await svc.addItem(user, p.id, { type: 'idea', title: 'still writable' });
    });
  }
});

describe('phase 0 probes for the findings in plan section 1.5', () => {
  it('1.5.1 no code path creates a proposal with source "pasted"', async () => {
    const src = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'renderer', 'src', 'planner', 'PlannerWork.tsx'), 'utf8');
    expect(src).not.toMatch(/source:\s*'pasted'/);
    const { svc } = mk('f1');
    const p = await svc.createProject(user, { title: 'x' });
    // importReport-derived proposals are 'report'; a connection without execute cannot even use the report source
    await expect(svc.propose(connectionCtx({ kind: 'chatgpt', name: 'ChatGPT' }, ['read', 'propose']), p.id, 'n', [{ op: 'add_item', itemType: 'idea', title: 'a', text: '', reason: '' }], 'pasted')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('1.5.2 a task left in_progress by an expired claim cannot be packaged again', async () => {
    let t = new Date(Date.now());
    const { svc } = mk('f2', () => t);
    const p = await svc.createProject(user, { title: 'Lease' });
    const task = await svc.addTask(user, p.id, { title: 'T' });
    const k = await svc.createPackage(user, p.id, { taskIds: [task.id] });
    await svc.claimTask(exec, p.id, k.id, task.id);
    t = new Date(Date.now() + 24 * 3600_000); // 24 h later: the 8 h lease has expired
    const now = await svc.getProject(user, p.id);
    expect(now.tasks[0]?.status).toBe('in_progress');
    await expect(svc.createPackage(user, p.id, { taskIds: [task.id] })).rejects.toMatchObject({ code: 'blocked' });
    // the workaround the UI does not show: the service lets the owner set it back to todo
    await svc.setTaskStatus(user, p.id, task.id, 'todo');
    await expect(svc.createPackage(user, p.id, { taskIds: [task.id] })).resolves.toBeTruthy();
  });

  it('1.5.3 identical re-preparation makes a new superseding package', async () => {
    const { svc } = mk('f3');
    const p = await svc.createProject(user, { title: 'Churn' });
    const task = await svc.addTask(user, p.id, { title: 'T' });
    const a = await svc.createPackage(user, p.id, { taskIds: [task.id] });
    const b = await svc.createPackage(user, p.id, { taskIds: [task.id] });
    expect(b.id).not.toBe(a.id);
    // the stored hash includes the package number and supersedes, so it differs; Phase 3 needs its own content key (without those)
    expect(b.contentHash).not.toBe(a.contentHash);
    expect({ ...b.plan, }).toEqual(a.plan);
    expect(b.tasks).toEqual(a.tasks);
    expect((await svc.getProject(user, p.id)).packages.find((k) => k.id === a.id)?.state).toBe('superseded');
  });

  it('1.5.5 every package carries all accepted rules, even ones unrelated to the task', async () => {
    const { svc } = mk('f5');
    const p = await svc.createProject(user, { title: 'All rules' });
    await svc.addItem(user, p.id, { type: 'requirement', title: 'Colour palette is teal' });
    await svc.addItem(user, p.id, { type: 'requirement', title: 'Invoices are PDF' });
    const task = await svc.addTask(user, p.id, { title: 'Write the README' });
    const k = await svc.createPackage(user, p.id, { taskIds: [task.id] });
    expect(k.plan.requirements.map((r) => r.title).sort()).toEqual(['Colour palette is teal', 'Invoices are PDF']);
  });

  it('owner-only invariant: a connection holding every scope still cannot edit, decide or review', async () => {
    const { svc } = mk('inv');
    const p = await svc.createProject(user, { title: 'Inv' });
    const all = connectionCtx({ kind: 'other', name: 'X' }, ['read', 'propose', 'package', 'execute']);
    await expect(svc.addItem(all, p.id, { type: 'requirement', title: 'sneaky' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(svc.decideProposal(all, p.id, 'prop_x', true)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(svc.reviewReport(all, p.id, 'rep_x', 'accept')).rejects.toMatchObject({ code: 'forbidden' });
    expect(() => connectionCtx({ kind: 'other', name: 'X' }, ['edit'])).toThrow();
  });
});

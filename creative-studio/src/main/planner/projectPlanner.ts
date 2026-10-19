// The Planner of the project that is open: one plan per CreateCraft project, kept inside the project folder (see routedStore.ts). Everything here is
// about tying a plan to its project and starting it from what the project already holds. Nothing here writes to the project's own files.

import type { PlannerProject } from '@shared/planner';
import type { ProjectFindingsDto, ProjectPlannerState } from '@shared/plannerApi';
import type { ProjectStore } from '../projectStore';
import { analyzeProject, type ProjectFindings } from './projectContext';
import type { RoutedPlannerStore } from './routedStore';
import { PlannerService, userCtx } from './service';

/** The CreateCraft project that is open. */
export interface OpenProject { id: string; name: string; root: string; store: ProjectStore }

export class ProjectPlanner {
  private readonly u = userCtx();
  constructor(private readonly svc: PlannerService, readonly store: RoutedPlannerStore, private readonly open: () => Promise<OpenProject | null>) {}

  /** Points the store at the open project. Called before every planner call. */
  async sync(): Promise<OpenProject | null> {
    const cur = await this.open();
    this.store.setProject(cur?.root ?? null, cur?.id ?? null);
    return cur;
  }
  private async need(): Promise<OpenProject> {
    const cur = await this.sync();
    if (!cur) throw new Error('Open a project first.');
    return cur;
  }

  /** This project's plan (null until it has one) and the older plans that could be brought in. */
  async forProject(): Promise<ProjectPlannerState> {
    const cur = await this.sync();
    if (!cur) return { project: null, plan: null, older: [] };
    const mine = await this.store.projectPlan();
    let plan = mine ? await this.svc.getProject(this.u, mine.id) : null;
    // A plan copied together with its project (Duplicate) belongs to the copy now.
    if (plan && plan.ownerProjectId !== cur.id) { await this.svc.adoptPlan(this.u, plan.id, cur.id); plan = await this.svc.getProject(this.u, plan.id); }
    const older = (await this.svc.listProjects(this.u)).filter((x) => !x.inThisProject);
    return { project: { id: cur.id, name: cur.name }, plan, older };
  }

  async startPlan(input: { title?: string; goal?: string } = {}): Promise<PlannerProject> {
    const cur = await this.need();
    if (await this.store.projectPlan()) throw new Error('This project already has a plan.');
    return this.svc.createProject(this.u, { title: (input.title?.trim() || cur.name).slice(0, 120), goal: (input.goal ?? '').slice(0, 2000) } as never, { ownerProjectId: cur.id });
  }

  private async scan(): Promise<{ cur: OpenProject; findings: ProjectFindings }> {
    const cur = await this.need();
    return { cur, findings: await analyzeProject(cur.store) };
  }

  async analyze(): Promise<ProjectFindingsDto> {
    const { findings } = await this.scan();
    return { projectName: findings.projectName, lines: findings.lines, changes: findings.changes, stats: findings.stats };
  }

  /** Adds the ticked findings. The scan is repeated here: what the page names is only an index into it. */
  async applyFindings(planId: string, only: number[]): Promise<void> {
    const { cur, findings } = await this.scan();
    const plan = await this.svc.getProject(this.u, planId);
    if (plan.ownerProjectId !== cur.id) throw new Error('That plan belongs to another project.');
    const picked = findings.changes.filter((_, i) => Array.isArray(only) && only.includes(i)).map((c) => (c.op === 'set_brief' ? { ...c, baseMetaRev: plan.metaRev } : c));
    if (!picked.length) throw new Error('Tick at least one thing to add.');
    const pr = await this.svc.importSuggestions(this.u, planId, { proposer: { kind: 'createcraft', name: 'Project scan' }, note: 'What was already in the project when the plan was started', changes: picked, rawText: findings.lines.join('\n') });
    await this.svc.decideProposal(this.u, planId, pr.id, true);
  }

  async attachOlder(planId: string): Promise<PlannerProject> {
    await this.need();
    await this.store.copyIntoProject(planId);
    return this.svc.getProject(this.u, planId);
  }

  /** Lines about the project for the planning AI, when `plan` is the open project's plan. */
  async chatContext(plan: PlannerProject): Promise<string[] | undefined> {
    const cur = await this.sync();
    if (!cur || plan.ownerProjectId !== cur.id) return undefined;
    return (await analyzeProject(cur.store).catch(() => null))?.aiContext;
  }
}

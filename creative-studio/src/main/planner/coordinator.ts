// The thin planning coordinator (docs/planner-2.0/stage-1-blueprint.md, section 8). It reads the plan and prepares PROPOSALS; it cannot accept
// anything, because the permissions it is given do not include review or edit. It uses only public PlannerService methods and adds no rules.
// No AI is called here: whatever produces the changes (the planning chat, an agent, the owner) hands them in.
import { type Actor, type PlanTask, type ProposalChange, changeSchema } from '@shared/planner';
import { NULL_CAPABILITIES, NULL_EXECUTION, type CapabilityPort, type ExecutionPort, type TaskReadiness } from '@shared/plannerCoordination';
import { buildProjectView, type ProjectView } from '@shared/projectView';
import type { ProjectPlanner } from './projectPlanner';
import { connectionCtx, type Ctx, type PlannerService } from './service';
import { PlannerError } from './store';

export const COORDINATOR_ACTOR: Actor = { kind: 'createcraft', name: 'Planning coordinator' };

export interface ProposalDraft { note: string; changes: ProposalChange[] }
export interface NextStep { kind: 'review-report' | 'review-proposal' | 'retake-stalled' | 'continue-current' | 'add-first-chunk'; taskId?: string; proposalId?: string; text: string }

export class ProjectCoordinator {
  /** read + propose + package only. `edit` and `review` are the owner's and cannot be held by anything but the UI. */
  readonly ctx: Ctx = connectionCtx(COORDINATOR_ACTOR, ['read', 'propose', 'package']);
  readonly capabilities: CapabilityPort;
  readonly execution: ExecutionPort;

  constructor(private readonly d: { service: PlannerService; planner: ProjectPlanner; capabilities?: CapabilityPort; execution?: ExecutionPort; now?: () => Date }) {
    this.capabilities = d.capabilities ?? NULL_CAPABILITIES;
    this.execution = d.execution ?? NULL_EXECUTION;
  }

  /** The view of a plan. Without an id: the plan of the project that is open. */
  async view(planId?: string, focusTaskId?: string | null): Promise<ProjectView> {
    await this.d.planner.sync();
    let id = planId;
    if (!id) {
      const mine = await this.d.planner.store.projectPlan();
      if (!mine) throw new PlannerError('not_found', 'This project has no plan yet.');
      id = mine.id;
    }
    const plan = await this.d.service.getProject(this.ctx, id);
    return buildProjectView(plan, { now: this.d.now?.(), focusTaskId });
  }

  /** Stores changes as ONE pending proposal. Nothing joins the plan until the owner accepts it. */
  async proposeChanges(planId: string, draft: ProposalDraft): Promise<{ proposalId: string }> {
    await this.d.planner.sync();
    const parsed = changeSchema.array().min(1).max(80).safeParse(draft.changes);
    if (!parsed.success) throw new PlannerError('invalid', `Those changes are not valid: ${parsed.error.issues[0]?.message ?? 'unreadable'}.`);
    const pr = await this.d.service.propose(this.ctx, planId, draft.note.slice(0, 1000), parsed.data, 'coordinator');
    return { proposalId: pr.id };
  }

  /** What the owner could do next, worked out from the plan alone (no AI). Most urgent first. */
  async nextSteps(planId: string): Promise<NextStep[]> {
    const v = await this.view(planId);
    const steps: NextStep[] = [];
    for (const r of v.awaitingReview) steps.push({ kind: 'review-report', taskId: r.taskId, text: `Review the result for "${v.nodes.find((n) => n.id === r.taskId)?.title ?? 'a chunk'}".` });
    for (const pr of v.pendingProposals) steps.push({ kind: 'review-proposal', proposalId: pr.id, text: `${pr.by} suggested ${pr.changes} change${pr.changes === 1 ? '' : 's'}: look at them.` });
    for (const n of v.nodes) if (n.flags.stalled) steps.push({ kind: 'retake-stalled', taskId: n.id, text: `"${n.title}" stopped without a result: take it back or send it again.` });
    if (v.current) steps.push({ kind: 'continue-current', taskId: v.current.taskId, text: `Continue with "${v.current.title}".` });
    else if (!v.nodes.some((n) => n.kind === 'chunk' || n.kind === 'task')) steps.push({ kind: 'add-first-chunk', text: 'Describe the idea, then break it into chunks.' });
    return steps;
  }

  async readiness(planId: string, taskId: string): Promise<TaskReadiness> {
    await this.d.planner.sync();
    const plan = await this.d.service.getProject(this.ctx, planId);
    const t: PlanTask | undefined = plan.tasks.find((x) => x.id === taskId);
    if (!t) throw new PlannerError('not_found', `No task with id ${taskId}.`);
    return this.capabilities.readiness(t);
  }
}

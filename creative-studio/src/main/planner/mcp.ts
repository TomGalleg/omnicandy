// The planner's MCP interface: a small, provider-neutral JSON-RPC 2.0 server (MCP 2025-06-18 and earlier revisions) exposing the
// planner service to whichever client the user connects. It adds nothing to the rules: every call goes through PlannerService with
// the scopes the connection was started with. Scopes are separate: `read`, `propose` (suggest changes, never apply them),
// `package` (prepare a handoff), `execute` (claim, report progress, submit reports). Editing the plan and accepting proposals or
// reports are the user's alone and cannot be granted to a connection. Nothing here launches an AI session.

import { z } from 'zod';
import { type Actor, type ActorKind, changeSchema, reportDraftSchema, type Scope } from '@shared/planner';
import { connectionCtx, type Ctx, type PlannerService } from './service';
import { PlannerError } from './store';

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const SERVER = { name: 'createcraft-planner', title: 'CreateCraft Project Planner', version: '1.0.0' };

interface ToolDef { name: string; scope: Scope; description: string; schema: z.ZodObject; run: (svc: PlannerService, c: Ctx, a: never) => Promise<unknown>; readOnly?: boolean }

const pid = z.string().min(1).describe('Project id (plan_...)');
const def = <S extends z.ZodObject>(t: { name: string; scope: Scope; description: string; schema: S; readOnly?: boolean; run: (svc: PlannerService, c: Ctx, a: z.infer<S>) => Promise<unknown> }): ToolDef => t as unknown as ToolDef;

export const TOOLS: ToolDef[] = [
  def({ name: 'list_projects', scope: 'read', readOnly: true, description: 'List the planner projects with their revision, progress and what is waiting for the user.', schema: z.object({}), run: (s, c) => s.listProjects(c) }),
  def({
    name: 'get_project_context', scope: 'read', readOnly: true,
    description: 'The current accepted plan (goal, scope, constraints, requirements, decisions), plus what is NOT accepted yet (ideas, open questions, pending proposals), tasks with status and blockers, assets, and the revision numbers. Ideas, questions and proposals are not requirements.',
    schema: z.object({ projectId: pid }), run: (s, c, a) => s.context(c, a.projectId),
  }),
  def({
    name: 'get_changes_since', scope: 'read', readOnly: true, description: 'Activity (who changed what) after a known project revision, plus the current revision and plan revision. Use it to catch up without rereading everything.',
    schema: z.object({ projectId: pid, revision: z.number().int().min(0).describe('The revision you last saw') }), run: (s, c, a) => s.changesSince(c, a.projectId, a.revision),
  }),
  def({
    name: 'list_packages', scope: 'read', readOnly: true, description: 'Execution packages of a project with their tasks and state. Only an open package can be claimed.',
    schema: z.object({ projectId: pid, onlyOpen: z.boolean().default(true) }),
    run: async (s, c, a) => (await s.getProject(c, a.projectId)).packages.filter((k) => !a.onlyOpen || k.state === 'open').map((k) => ({ id: k.id, number: k.number, state: k.state, planRevision: k.planRevision, objective: k.objective, tasks: k.tasks.map((t) => ({ id: t.id, title: t.title })), supersedes: k.supersedes ?? null })),
  }),
  def({
    name: 'get_package', scope: 'read', readOnly: true,
    description: 'Retrieve one execution package: objective, accepted requirements and decisions, scope, constraints, assets, tasks with completion checks, and how to report. Also says whether the plan has changed since the package was made (drift) and who holds each task. Retrieving a package does not start or claim anything.',
    schema: z.object({ projectId: pid, packageId: z.string().min(1) }), run: (s, c, a) => s.getPackage(c, a.projectId, a.packageId),
  }),
  def({
    name: 'propose_changes', scope: 'propose',
    description: 'Suggest changes to the plan (new ideas, questions, requirements, decisions or tasks; edits to existing ones). Nothing is applied: the user reviews every proposal. update_* changes need baseRev (the item or task rev you read).',
    schema: z.object({ projectId: pid, note: z.string().max(1000).describe('One or two sentences on why'), changes: z.array(changeSchema).min(1).max(30) }),
    run: (s, c, a) => s.propose(c, a.projectId, a.note, a.changes),
  }),
  def({
    name: 'create_execution_package', scope: 'package',
    description: 'Prepare a versioned execution package from selected tasks (it freezes the accepted plan as it is now). This only prepares the handoff; it does not start any AI session. Tasks must be to-do, unclaimed, and have their dependencies met or included.',
    schema: z.object({ projectId: pid, taskIds: z.array(z.string()).min(1).max(50), objective: z.string().max(1000).optional(), note: z.string().max(2000).optional() }),
    run: async (s, c, a) => { const k = await s.createPackage(c, a.projectId, a); return { packageId: k.id, number: k.number, planRevision: k.planRevision, state: k.state }; },
  }),
  def({
    name: 'claim_task', scope: 'execute',
    description: 'Claim one task of an open package before working on it, so nobody does the same work twice. Returns a claimToken you must keep for progress and report calls. The claim lasts 8 hours and renews with report_progress.',
    schema: z.object({ projectId: pid, packageId: z.string(), taskId: z.string(), note: z.string().max(500).optional() }), run: (s, c, a) => s.claimTask(c, a.projectId, a.packageId, a.taskId, { note: a.note }),
  }),
  def({
    name: 'report_progress', scope: 'execute', description: 'Tell the user how the claimed task is going, or that you are blocked. Renews the claim.',
    schema: z.object({ projectId: pid, packageId: z.string(), taskId: z.string(), claimToken: z.string(), note: z.string().max(1000), status: z.enum(['in_progress', 'blocked']).optional() }),
    run: (s, c, a) => s.reportProgress(c, a.projectId, a.packageId, a.taskId, a.claimToken, a.note, a.status),
  }),
  def({
    name: 'submit_report', scope: 'execute',
    description: 'Submit the structured report for a claimed task: what you did, outputs and changed files, the verification you ACTUALLY ran (result pass/fail/not_run per completion check id), blockers, limitations, open questions and proposed plan changes. A report claims completion; the user decides whether to accept it. Submitting the same report twice is harmless.',
    schema: z.object({ projectId: pid, packageId: z.string(), taskId: z.string(), claimToken: z.string(), report: reportDraftSchema }),
    run: async (s, c, a) => { const r = await s.submitReport(c, a.projectId, a); return { reportId: r.report.id, duplicate: r.duplicate, status: r.report.status, planOutdated: r.report.driftAtSubmit.outdated, whatChangedInPlan: r.report.driftAtSubmit.changes, note: 'The task is awaiting the user\'s review; it is not accepted.' }; },
  }),
  def({ name: 'release_claim', scope: 'execute', description: 'Give a claimed task back without reporting (you cannot finish it).', schema: z.object({ projectId: pid, taskId: z.string(), claimToken: z.string() }), run: async (s, c, a) => { await s.releaseClaim(c, a.projectId, a.taskId, a.claimToken); return { released: true }; } }),
];

export function toolsFor(c: Ctx): ToolDef[] { return TOOLS.filter((t) => c.scopes.has(t.scope)); }

export const actorKindFor = (clientName: string): ActorKind => {
  const n = clientName.toLowerCase();
  if (n.includes('claude-code') || n.includes('claude code')) return 'claude-code';
  if (n.includes('cowork')) return 'cowork';
  if (n.includes('claude')) return 'claude-code';
  if (n.includes('chatgpt') || n.includes('openai')) return 'chatgpt';
  if (n.includes('gemini')) return 'gemini';
  return 'other';
};

interface Rpc { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }
export interface RpcResponse { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }

const errText = (e: unknown) => (e instanceof PlannerError ? { error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } : e instanceof z.ZodError ? { error: 'invalid', message: e.issues.slice(0, 6).map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') } : { error: 'failed', message: e instanceof Error ? e.message : String(e) });

export class McpSession {
  private actor: Actor;
  private ctx: Ctx;
  constructor(private readonly svc: PlannerService, private readonly scopes: readonly string[], private readonly fixedActor?: Actor) {
    this.actor = fixedActor ?? { kind: 'other', name: 'MCP client' };
    this.ctx = connectionCtx(this.actor, scopes);
  }
  get permissions(): string[] { return [...this.ctx.scopes]; }

  async handle(msg: Rpc): Promise<RpcResponse | null> {
    const id = msg.id ?? null;
    const ok = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
    const bad = (code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (msg.method === undefined) return msg.id === undefined ? null : bad(-32600, 'Invalid request.');
    if (msg.id === undefined) return null; // notifications (initialized, cancelled...) need no answer
    switch (msg.method) {
      case 'initialize': {
        const want = String(msg.params?.protocolVersion ?? '');
        const ci = msg.params?.clientInfo as { name?: unknown } | undefined;
        if (!this.fixedActor && typeof ci?.name === 'string' && ci.name) {
          this.actor = { kind: actorKindFor(ci.name), name: ci.name.slice(0, 60) };
          this.ctx = connectionCtx(this.actor, this.scopes);
        }
        return ok({
          protocolVersion: (SUPPORTED_PROTOCOLS as readonly string[]).includes(want) ? want : SUPPORTED_PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER,
          instructions: 'CreateCraft Project Planner. Read the plan with get_project_context. Ideas, questions and proposals are not decisions. Work from execution packages: get_package, claim_task, then submit_report with verification you actually ran. The user accepts or rejects results.',
        });
      }
      case 'ping': return ok({});
      case 'tools/list':
        return ok({ tools: toolsFor(this.ctx).map((t) => ({ name: t.name, title: t.name.replace(/_/g, ' '), description: t.description, inputSchema: z.toJSONSchema(t.schema, { io: 'input' }), annotations: { readOnlyHint: !!t.readOnly, openWorldHint: false } })) });
      case 'tools/call': {
        const name = String(msg.params?.name ?? '');
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return bad(-32602, `Unknown tool ${name}.`);
        if (!this.ctx.scopes.has(tool.scope)) return ok({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'forbidden', message: `This connection was not given the "${tool.scope}" permission. The user can change it in the planner connection settings.` }) }] });
        try {
          const args = tool.schema.parse(msg.params?.arguments ?? {});
          const out = await tool.run(this.svc, this.ctx, args as never);
          return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
        } catch (e) { return ok({ isError: true, content: [{ type: 'text', text: JSON.stringify(errText(e)) }] }); }
      }
      default: return bad(-32601, `Method not found: ${msg.method}`);
    }
  }
}

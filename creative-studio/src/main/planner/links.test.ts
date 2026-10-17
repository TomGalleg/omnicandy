// Phase 5: Home plan -> Planner suggestions, planner_propose for CreateCraft's Claude, and the workflow run line.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeWorkflowRun } from '@shared/plannerView';
import { McpSession } from './mcp';
import { connectionCtx, PlannerService, userCtx } from './service';
import { PlannerStore } from './store';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-plan-links-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const user = userCtx();
const mk = (n: string) => new PlannerService(new PlannerStore(path.join(tmp, n)));
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFile(path.join(here, rel), 'utf8');

describe('the plan approved on Home', () => {
  it('becomes a Planner project whose steps are pending suggestions, never accepted', async () => {
    const svc = mk('home');
    const { project, proposal } = await svc.createFromHomePlan(user, { title: 'Desert poster', goal: 'A print-ready poster', kind: 'design', steps: ['Pick the photo', 'Add the title', 'Export for print'], questions: ['Which paper size?'] });
    expect(project.tasks).toHaveLength(0);
    expect(project.items).toHaveLength(0);
    expect(project.kinds).toEqual(['art']);
    expect(proposal).toMatchObject({ status: 'pending', source: 'home' });
    expect(proposal.proposedBy).toEqual({ kind: 'createcraft', name: 'CreateCraft Claude' });
    expect(proposal.changes.map((c) => c.op)).toEqual(['add_task', 'add_task', 'add_task', 'add_item']);
    const planBefore = project.planRevision;
    await svc.decideProposal(user, project.id, proposal.id, true, [0, 1, 3]); // the owner leaves one step out
    const after = await svc.getProject(user, project.id);
    expect(after.tasks.map((t) => t.title)).toEqual(['Pick the photo', 'Add the title']);
    expect(after.items.map((i) => i.type)).toEqual(['question']);
    expect(after.planRevision).toBe(planBefore); // tasks and questions do not change the accepted plan
  });

  it('caps and cleans what it accepts, and needs the owner', async () => {
    const svc = mk('home2');
    const r = await svc.createFromHomePlan(user, { title: 'T', goal: '', steps: Array.from({ length: 20 }, (_, i) => `step ${i}`).concat(['   ']), questions: ['a', 'b', 'c', 'd'] });
    expect(r.proposal.changes).toHaveLength(8 + 3);
    await expect(svc.createFromHomePlan(user, { title: 'T', goal: '', steps: [], questions: [] })).rejects.toMatchObject({ code: 'invalid' });
    const conn = connectionCtx({ kind: 'other', name: 'X' }, ['read', 'propose', 'package', 'execute']);
    await expect(svc.createFromHomePlan(conn, { title: 'T', goal: '', steps: ['x'], questions: [] })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe("CreateCraft's Claude can suggest, never decide", () => {
  it('propose_changes through the panel session creates a pending, attributed proposal; nothing else changes', async () => {
    const svc = mk('panel');
    const p = await svc.createProject(user, { title: 'Panel' });
    const s = new McpSession(svc, ['read', 'propose', 'execute'], { kind: 'createcraft', name: 'CreateCraft Claude' });
    const call = async (name: string, args: unknown) => JSON.parse(((await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text);
    const out = await call('propose_changes', { projectId: p.id, note: 'More tasks', changes: [{ op: 'add_task', title: 'Draft the outline' }, { op: 'add_item', itemType: 'requirement', title: 'Keep it short' }] });
    expect(out).toMatchObject({ status: 'pending', proposedBy: { name: 'CreateCraft Claude' } });
    const after = await svc.getProject(user, p.id);
    expect(after.tasks).toHaveLength(0);
    expect(after.items).toHaveLength(0);
    expect(after.planRevision).toBe(p.planRevision);
    // it cannot make packages, and no tool decides or edits
    expect(await call('create_execution_package', { projectId: p.id, taskIds: ['x'] })).toMatchObject({ error: 'forbidden' });
    const names = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names).not.toEqual(expect.arrayContaining(['accept_proposal']));
    expect(names.some((n) => /accept|review|decide|edit_|update_plan|delete/.test(n))).toBe(false);
  });

  it('the Claude panel code only calls the allowed planner tools, and its session holds read, propose and execute only', async () => {
    const partner = await read('../claudePartner.ts');
    const used = [...partner.matchAll(/planner\.call\(([^)]*)\)/g)].flatMap((m) => [...(m[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!));
    expect(new Set(used)).toEqual(new Set(['list_packages', 'list_projects', 'get_package', 'claim_task', 'submit_report', 'propose_changes']));
    expect(partner).toContain("'planner_propose'");
    const ipc = await read('../ipc.ts');
    expect(ipc).toContain("new McpSession(planner.service, ['read', 'propose', 'execute']");
  });
});

describe('describeWorkflowRun', () => {
  const base = { ok: null, cancelled: false, steps: [{ id: 'a', type: 'import', label: 'A', status: 'completed' }, { id: 'b', type: 'export', label: 'B', status: 'idle' }], waitingFor: null, problems: [] as string[] };
  it('says it in plain words and never claims the task is done', () => {
    expect(describeWorkflowRun({ ...base, state: 'idle' } as never)).toBe('Not run yet.');
    expect(describeWorkflowRun({ ...base, state: 'running' } as never)).toBe('Running: 1 of 2 steps done.');
    expect(describeWorkflowRun({ ...base, state: 'waiting-for-you', waitingFor: 'Approve the results' } as never)).toMatch(/Waiting for you in the Workflow tab: Approve/);
    expect(describeWorkflowRun({ ...base, state: 'finished', ok: true } as never)).toMatch(/mark the task done yourself/);
    expect(describeWorkflowRun({ ...base, state: 'finished', ok: false, problems: ['x'] } as never)).toMatch(/problems \(1\)/);
  });
});

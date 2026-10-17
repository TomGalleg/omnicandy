// The protocol layer without a process: the same session CreateCraft's own Claude uses for the planner_* tools.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpSession, SUPPORTED_PROTOCOLS } from './mcp';
import { PlannerService, userCtx } from './service';
import { PlannerStore } from './store';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-planner-sess-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const call = async (s: McpSession, name: string, args: unknown) => {
  const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args as Record<string, unknown> } });
  const res = r?.result as { isError?: boolean; content: Array<{ text: string }> };
  return { error: !!res.isError, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
};

describe('planner MCP session', () => {
  it('negotiates the protocol version and ignores notifications', async () => {
    const s = new McpSession(new PlannerService(new PlannerStore(tmp)), ['read']);
    const init = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'Claude Code' } } });
    expect((init?.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');
    const newer = await s.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
    expect((newer?.result as { protocolVersion: string }).protocolVersion).toBe(SUPPORTED_PROTOCOLS[0]);
    expect(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect((await s.handle({ jsonrpc: '2.0', id: 3, method: 'nope' }))?.error?.code).toBe(-32601);
  });

  it('CreateCraft Claude can claim and report, is named in the history, and cannot edit the plan', async () => {
    const svc = new PlannerService(new PlannerStore(tmp));
    const user = userCtx();
    const p = await svc.createProject(user, { title: 'In-app' });
    const t = await svc.addTask(user, p.id, { title: 'Draw', checks: [{ text: 'looks right' }] });
    const pkg = await svc.createPackage(user, p.id, { taskIds: [t.id] });
    const s = new McpSession(svc, ['read', 'execute'], { kind: 'createcraft', name: 'CreateCraft Claude' });
    const claim = await call(s, 'claim_task', { projectId: p.id, packageId: pkg.id, taskId: t.id });
    expect(claim.error).toBe(false);
    const bad = await call(s, 'submit_report', { projectId: p.id, packageId: pkg.id, taskId: t.id, claimToken: claim.body.claimToken, report: { outcome: 'complete' } });
    expect(bad.error).toBe(true);
    expect(String(bad.body.message)).toMatch(/workPerformed/);
    const ok = await call(s, 'submit_report', { projectId: p.id, packageId: pkg.id, taskId: t.id, claimToken: claim.body.claimToken, report: { outcome: 'complete', workPerformed: 'Drew it.', verification: [{ check: 'looks right', checkId: pkg.tasks[0]!.completionChecks[0]!.id, result: 'not_run' }] } });
    expect(ok.error).toBe(false);
    expect((await svc.getProject(user, p.id)).tasks[0]!.status).toBe('reported');
    expect((await svc.activity(user, p.id)).some((a) => a.actor.kind === 'createcraft' && a.kind === 'report.submitted')).toBe(true);
    const nope = await call(s, 'propose_changes', { projectId: p.id, note: 'x', changes: [{ op: 'add_item', itemType: 'idea', title: 'x' }] });
    expect(nope.error).toBe(true);
    expect(String(nope.body.message)).toMatch(/permission/);
    expect(() => new McpSession(svc, ['read', 'edit'])).toThrow(/cannot hold/);
  });
});

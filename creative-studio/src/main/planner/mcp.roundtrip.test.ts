// Real MCP round trips against the bundled server process (out/planner-mcp.cjs): over stdio with the same client OmniCandy uses
// for ArtCraft, and over local HTTP with a bearer token. The "user" side is the app's own service on the same folder.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpClient } from '../mcpClient';
import { PlannerService, userCtx } from './service';
import { PlannerStore } from './store';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const bundle = path.join(root, 'out', 'planner-mcp.cjs');
let tmp: string;
let svc: PlannerService;
const user = userCtx();
const json = (v: unknown) => v as Record<string, unknown>;

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-planner-mcp.mjs')], { cwd: root });
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-planner-mcp-'));
  svc = new PlannerService(new PlannerStore(tmp));
}, 60_000);
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const start = (scopes: string, actor: string, kind = 'claude-code') => McpClient.start(process.execPath, [bundle, '--dir', tmp, '--scopes', scopes, '--actor', actor, '--kind', kind], 'planner-test');

describe('planner MCP server (real process)', () => {
  it('lists only the tools a connection may use, and refuses scopes it may not hold', async () => {
    const reader = await start('read', 'Reader');
    const tools = ((await reader.request('tools/list', {})) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(tools).toEqual(['list_projects', 'get_project_context', 'get_changes_since', 'list_packages', 'get_package']);
    reader.close();
    const brain = await start('read,propose', 'Brain', 'chatgpt');
    const bt = ((await brain.request('tools/list', {})) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(bt).toContain('propose_changes');
    expect(bt).not.toContain('claim_task');
    brain.close();
    // editing / reviewing can never be granted to a connection
    const out = await new Promise<{ code: number | null; err: string }>((res) => {
      const p = spawn(process.execPath, [bundle, '--dir', tmp, '--scopes', 'read,review']);
      let err = '';
      p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      p.on('exit', (code) => res({ code, err }));
    });
    expect(out.code).toBe(1);
    expect(out.err).toMatch(/cannot hold the scope\(s\): review/);
  });

  it('brainstorm -> accept -> package -> execute -> report -> accept, across real processes', async () => {
    const p = await svc.createProject(user, { title: 'MCP trip', goal: 'Poster and notes', templates: ['blank'] });
    const brain = await start('read,propose', 'Brainstorm AI', 'chatgpt');
    const exec = await start('read,execute', 'Claude Code');

    const list = (await brain.callTool('list_projects', {})) as Array<{ id: string }>;
    expect(list.some((x) => x.id === p.id)).toBe(true);
    const ctx0 = json(await brain.callTool('get_project_context', { projectId: p.id }));
    const rev0 = (ctx0.project as { revision: number }).revision;

    // the AI can only suggest
    const prop = json(await brain.callTool('propose_changes', {
      projectId: p.id, note: 'Start with research',
      changes: [
        { op: 'add_item', itemType: 'requirement', title: 'Poster is 24x36 inches', text: '', reason: 'print size' },
        { op: 'add_task', title: 'Make the poster', description: 'Use the garden photo', priority: 'high', completionChecks: ['Dimensions are 7200x10800'] },
      ],
    }));
    expect(prop.status).toBe('pending');
    expect((await svc.getProject(user, p.id)).items).toHaveLength(0);
    await expect(exec.callTool('propose_changes', { projectId: p.id, note: 'x', changes: [] })).rejects.toThrow(/permission/);

    // the user accepts, prepares the package (nothing starts), the executor retrieves it
    await svc.decideProposal(user, p.id, String(prop.id), true);
    const task = (await svc.getProject(user, p.id)).tasks[0]!;
    const pkg = await svc.createPackage(user, p.id, { taskIds: [task.id] });
    const got = json(await exec.callTool('get_package', { projectId: p.id, packageId: pkg.id }));
    expect(String(got.markdown)).toContain('Poster is 24x36 inches');
    expect(json(got.drift).outdated).toBe(false);
    expect(await exec.callTool('list_packages', { projectId: p.id })).toHaveLength(1);

    const claim = json(await exec.callTool('claim_task', { projectId: p.id, packageId: pkg.id, taskId: task.id }));
    const second = await start('read,execute', 'Cowork', 'cowork');
    await expect(second.callTool('claim_task', { projectId: p.id, packageId: pkg.id, taskId: task.id })).rejects.toThrow(/already claimed/);
    second.close();
    const chk = pkg.tasks[0]!.completionChecks[0]!;
    const report = { outcome: 'complete', workPerformed: 'Built the poster.', outputs: [{ description: 'poster', path: 'C:/x/poster.png' }], verification: [{ checkId: chk.id, check: chk.text, result: 'pass', details: 'identify says 7200x10800' }] };
    const sub = json(await exec.callTool('submit_report', { projectId: p.id, packageId: pkg.id, taskId: task.id, claimToken: claim.claimToken, report }));
    expect(sub.duplicate).toBe(false);
    expect(String(sub.note)).toMatch(/not accepted/);
    expect(json(await exec.callTool('submit_report', { projectId: p.id, packageId: pkg.id, taskId: task.id, claimToken: claim.claimToken, report })).duplicate).toBe(true);
    expect((await svc.getProject(user, p.id)).tasks[0]!.status).toBe('reported');

    const since = json(await brain.callTool('get_changes_since', { projectId: p.id, revision: rev0 }));
    expect((since.changes as Array<{ kind: string; actor: { name: string } }>).some((c) => c.kind === 'report.submitted' && c.actor.name === 'Claude Code')).toBe(true);

    await svc.reviewReport(user, p.id, (await svc.getProject(user, p.id)).reports[0]!.id, 'accept');
    expect((await svc.getProject(user, p.id)).tasks[0]!.status).toBe('accepted');
    brain.close();
    exec.close();
  }, 60_000);

  it('serves local HTTP only with the bearer token', async () => {
    const tokenFile = path.join(tmp, 'token.txt');
    await fs.writeFile(tokenFile, 'a'.repeat(40));
    const proc = spawn(process.execPath, [bundle, '--dir', tmp, '--http', '--port', '0', '--token-file', tokenFile, '--scopes', 'read', '--actor', 'HTTP client']);
    const port = await new Promise<number>((res, rej) => {
      let err = '';
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); const m = /127\.0\.0\.1:(\d+)\/mcp/.exec(err); if (m) res(Number(m[1])); });
      proc.on('exit', () => rej(new Error(err)));
    });
    const call = (headers: Record<string, string>, body: unknown) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      expect((await call({}, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
      expect((await call({ authorization: 'Bearer wrong' }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
      expect((await call({ authorization: `Bearer ${'a'.repeat(40)}`, origin: 'https://evil.example' }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(403);
      const ok = await call({ authorization: `Bearer ${'a'.repeat(40)}` }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { result: { tools: unknown[] } }).result.tools.length).toBe(5);
    } finally { proc.kill(); }
  });
});

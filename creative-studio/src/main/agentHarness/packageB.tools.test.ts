import { describe, expect, it } from 'vitest';
import { runAgent } from './loop';
import { addExternalTools, isTrustedExternalReadback } from './externalTools';
import { addExportTools } from './exportTools';
import { ScriptedProvider } from './providers/scripted';
import { ToolRegistry } from './registry';
import type { ProviderReply } from './types';
import type { LiveTaskController } from '../liveTask';
import type { ProjectStore } from '../projectStore';
import type { DeliverQueue } from '../deliver';
import type { CommandResult, CommandSpec, ExternalAppInfo, JobInfo } from '@shared/integrations';

const call = (id: string, name: string, args: unknown): ProviderReply => ({ text: null, toolCalls: [{ id, name, args }] });
const final: ProviderReply = { text: 'done', toolCalls: [] };
const controller = (phase = 'idle', lockOwner: string | null = null) => ({
  snapshot: () => ({ collab: { phase, lockOwner, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }),
  claudeDone: () => undefined,
}) as unknown as LiveTaskController;

const render: CommandSpec = { id: 'render', label: 'Render', description: 'Render a scene', params: {}, permissions: ['write-files'], longRunning: true };
const move: CommandSpec = { id: 'move', label: 'Move', description: 'Move an object', params: {}, permissions: ['modify-project'] };
const inspect: CommandSpec = { id: 'scene.inspect', label: 'Inspect', description: 'Read object state', params: {}, permissions: ['read-project'], idempotent: true };
const app = (adapterId: string, commands: CommandSpec[]) => ({ key: 'app-1', name: 'Example', status: 'connected', adapterId, adapterName: 'Example', commands }) as unknown as ExternalAppInfo;
const result = (over: Partial<CommandResult> = {}): CommandResult => ({ ok: true, verified: false, message: 'ok', evidence: [], outputs: [], durationMs: 1, ...over });

/** In-memory stand-in for IntegrationManager's job API (execute/job/jobs/cancelJob/isBuiltin). */
function backend(commands: CommandSpec[], opts: { builtin?: boolean; data?: Record<string, unknown>; failWith?: string } = {}) {
  const jobs = new Map<string, JobInfo>();
  const executed: Array<{ command: string; background?: boolean }> = [];
  let next = 1;
  const b = {
    list: async () => [app('blender', commands)],
    isBuiltin: () => opts.builtin === true,
    jobs: () => [...jobs.values()],
    job: (id: string) => jobs.get(id) ?? null,
    cancelJob: (id: string) => { const j = jobs.get(id); if (!j || j.status !== 'running') return false; j.status = 'cancelled'; return true; },
    execute: async (_key: string, command: string, _params: unknown, o: { background?: boolean } = {}) => {
      executed.push({ command, background: o.background });
      if (opts.failWith) throw new Error(opts.failWith);
      if (o.background) {
        const id = `job-${next++}`;
        jobs.set(id, { id, appKey: 'app-1', appName: 'Example', commandId: command, status: 'running', stage: 'Starting', fraction: null, startedAt: 'now', finishedAt: null, result: null });
        return result({ message: `Started job ${id}`, data: { jobId: id, status: 'running' } });
      }
      return result({ verified: true, data: opts.data });
    },
  };
  return { b: b as unknown as Parameters<typeof addExternalTools>[1], jobs, executed };
}
const run = (be: ReturnType<typeof backend>, script: ProviderReply[], extra: Partial<Parameters<typeof runAgent>[0]> = {}) => {
  const started: string[] = [];
  const registry = addExternalTools(new ToolRegistry(), be.b, { onJobStarted: ({ jobId }) => { started.push(jobId); } });
  return runAgent({ goal: 'work', ctl: controller(), registry, provider: new ScriptedProvider(script), ...extra }).then((outcome) => ({ outcome, started }));
};
const text = (outcome: { messages: Array<{ role: string; content?: string | null }> }, id?: number) =>
  outcome.messages.filter((m) => m.role === 'tool').map((m) => m.content ?? '')[id ?? 0] ?? '';

describe('external long-running jobs', () => {
  it('starts a long-running command as a background job, reports it and follows its status', async () => {
    const be = backend([render]);
    const { outcome, started } = await run(be, [
      call('1', 'external_command', { app_key: 'app-1', command: 'render' }),
      call('2', 'external_job', {}),
      call('3', 'external_job', { job_id: 'job-1' }),
      final, final,
    ]);
    expect(be.executed).toEqual([{ command: 'render', background: true }]);
    expect(started).toEqual(['job-1']);
    expect(text(outcome, 1)).toContain('"status":"running"');
    expect(text(outcome, 2)).toContain('job-1');
    expect(outcome.status).toBe('limit'); // a started job is a change nobody has verified yet
  });
  it('cancels a job, and says so when the job is gone after a restart', async () => {
    const be = backend([render]);
    const { outcome } = await run(be, [
      call('1', 'external_command', { app_key: 'app-1', command: 'render' }),
      call('2', 'external_job', { job_id: 'job-1', cancel: true }),
      call('3', 'external_job', { job_id: 'job-99' }),
      final, final,
    ]);
    expect(be.jobs.get('job-1')?.status).toBe('cancelled');
    expect(text(outcome, 1)).toContain('"status":"cancelled"');
    expect(text(outcome, 2)).toContain('do not survive an application restart');
  });
  it('never launches the same long-running command twice while a job is running (also after an interruption)', async () => {
    const be = backend([render]);
    const { outcome } = await run(be, [
      call('1', 'external_command', { app_key: 'app-1', command: 'render' }),
      call('2', 'external_command', { app_key: 'app-1', command: 'render' }),
      final, final,
    ]);
    expect(be.executed).toHaveLength(1);
    expect(text(outcome, 1)).toContain('already running');
    // A fresh run (for example Continue Task after a restart of the agent) sees the same running job.
    const again = await run(be, [call('1', 'external_command', { app_key: 'app-1', command: 'render' }), final, final]);
    expect(be.executed).toHaveLength(1);
    expect(text(again.outcome)).toContain('already running');
  });
  it('treats a launch that failed after dispatch as uncertain and blocks a second launch', async () => {
    const be = backend([render], { failWith: 'Bridge timeout after execution' });
    const { outcome } = await run(be, [
      call('1', 'external_command', { app_key: 'app-1', command: 'render' }),
      call('2', 'external_command', { app_key: 'app-1', command: 'render' }),
      final,
    ]);
    expect(be.executed).toHaveLength(1);
    expect(outcome.uncertainEdit).toContain('external_command');
    expect(text(outcome, 1)).toContain('Further edits remain blocked');
  });
  it('does not launch anything when the user has taken control, and the job tool stays advertised for cancel', async () => {
    const be = backend([render]);
    const registry = addExternalTools(new ToolRegistry(), be.b);
    await expect(runAgent({ goal: 'work', ctl: controller('manual', 'user'), registry, provider: new ScriptedProvider([final]) })).rejects.toThrow(/User control/);
    expect(be.executed).toHaveLength(0);
    expect(registry.snapshot().map((t) => t.name)).toContain('external_job');
    // Control taken mid-task: calls after the takeover are not executed.
    let phase = 'idle';
    const ctl = { snapshot: () => ({ collab: { phase, lockOwner: null, activeOperation: null } }), claudeDone: () => undefined } as unknown as LiveTaskController;
    const reg2 = addExternalTools(new ToolRegistry(), be.b);
    const provider = new ScriptedProvider([call('1', 'external_apps', {}), call('2', 'external_command', { app_key: 'app-1', command: 'render' })]);
    const orig = provider.complete.bind(provider);
    provider.complete = async (i) => { const r = await orig(i); if (r.toolCalls[0]?.id === '2') phase = 'manual'; return r; };
    const out = await runAgent({ goal: 'work', ctl, registry: reg2, provider });
    expect(out.status).toBe('paused');
    expect(be.executed).toHaveLength(0);
  });
  it('does not advertise external_job when the backend cannot track jobs', () => {
    const registry = addExternalTools(new ToolRegistry(), { list: async () => [], execute: async () => result() } as never);
    expect(registry.snapshot().map((t) => t.name)).not.toContain('external_job');
  });
});

describe('trusted versus untrusted external verification', () => {
  const edit = call('1', 'external_command', { app_key: 'app-1', command: 'move' });
  const read = (id: string) => call(id, 'external_command', { app_key: 'app-1', command: 'scene.inspect' });
  const verify = (id: string, receipt: string, path = 'data.x') => call(id, 'evidence_verify', { receipt_id: receipt, path, expected: 5 });

  it('recognises only host-trusted read-only commands as read-back', () => {
    const builtin = () => true;
    expect(isTrustedExternalReadback(builtin, 'blender', inspect)).toBe(true);
    expect(isTrustedExternalReadback(() => false, 'blender', inspect)).toBe(false);
    expect(isTrustedExternalReadback(undefined, 'blender', inspect)).toBe(false);
    expect(isTrustedExternalReadback(builtin, 'blender', { ...inspect, idempotent: false })).toBe(false);
    expect(isTrustedExternalReadback(builtin, 'blender', { ...inspect, permissions: ['read-project', 'write-files'] })).toBe(false);
    expect(isTrustedExternalReadback(builtin, 'blender', { ...inspect, id: 'scene.render_still' })).toBe(false); // not on the host allow-list
    expect(isTrustedExternalReadback(builtin, 'other-adapter', inspect)).toBe(false);
    expect(isTrustedExternalReadback(builtin, 'blender', move)).toBe(false);
  });
  it('completes after an edit followed by a trusted read-back that matches', async () => {
    const be = backend([move, inspect], { builtin: true, data: { x: 5 } });
    const { outcome } = await run(be, [edit, read('2'), verify('3', 'r2'), final]);
    expect(outcome.status).toBe('completed');
    expect(be.executed.map((e) => e.command)).toEqual(['move', 'scene.inspect']);
  });
  it('does not treat the inspection as an edit: it can run while an edit is uncertain', async () => {
    const be = backend([move, inspect], { builtin: true, data: { x: 5 } });
    const { outcome } = await run(be, [edit, read('2'), final, final]);
    expect(be.executed.map((e) => e.command)).toEqual(['move', 'scene.inspect']);
    expect(outcome.status).toBe('limit'); // read but not compared
  });
  it('does not accept a read-back from an untrusted integration, even if the command says verified', async () => {
    const be = backend([move, inspect], { builtin: false, data: { x: 5 } });
    const { outcome } = await run(be, [edit, read('2'), verify('3', 'r2'), final, final]);
    expect(outcome.status).toBe('limit');
    expect(text(outcome, 2)).toContain('no eligible structured read-back');
  });
  it('does not accept the command\'s own verified claim as the compared state', async () => {
    const be = backend([move, inspect], { builtin: true, data: { x: 5 } });
    const { outcome } = await run(be, [edit, read('2'), call('3', 'evidence_verify', { receipt_id: 'r2', path: 'verified', expected: true }), final, final]);
    expect(outcome.status).toBe('limit');
    expect(text(outcome, 2)).toContain('data.*');
  });
  it('rejects a mismatching read-back and a read-back taken before the edit', async () => {
    const mismatch = await run(backend([move, inspect], { builtin: true, data: { x: 6 } }), [edit, read('2'), verify('3', 'r2'), final, final]);
    expect(mismatch.outcome.status).toBe('limit');
    const stale = await run(backend([move, inspect], { builtin: true, data: { x: 5 } }), [read('1'), call('2', 'external_command', { app_key: 'app-1', command: 'move' }), verify('3', 'r1'), final, final]);
    expect(stale.outcome.status).toBe('limit');
  });
  it('keeps an integration without read-back incomplete and resumable', async () => {
    const be = backend([move], { builtin: true });
    const { outcome } = await run(be, [edit, final, final]);
    expect(outcome.status).toBe('limit');
    expect(outcome.text).toContain('Continue Task');
  });
});

describe('export tools', () => {
  const asset = { id: 'a1', name: 'logo.png', sourceFormat: 'png' };
  const store = { loadManifest: async () => ({ assets: [asset] }) } as unknown as ProjectStore;
  const fakeQueue = () => {
    const calls: unknown[][] = [];
    const queue = {
      enqueue: async (...args: unknown[]) => { calls.push(args); return [{ id: 'j1', presetLabel: 'JPEG for the web' }]; },
      wait: async () => [{ id: 'j1', status: 'done', presetLabel: 'JPEG for the web', output: 'logo-web.jpg', note: undefined }],
      addToLibrary: async () => ({ name: 'logo-from-png.jpg' }),
    } as unknown as DeliverQueue;
    return { queue, calls };
  };
  const build = (ctl = controller(), q = fakeQueue()) => ({ q, registry: addExportTools(new ToolRegistry(), { ctl, store, deliver: async () => q.queue }) });

  it('discovers the same formats Claude sees, without exposing paths', async () => {
    const { registry } = build();
    const { outcome } = await run(backend([]), [call('1', 'list_export_formats', { name: 'logo.png' }), final], { registry });
    const out = text(outcome);
    expect(out).toContain('image-web');
    expect(out).not.toMatch(/[A-Za-z]:\\\\/);
  });
  it('exports through the Deliver queue and reports the exports/ location', async () => {
    const { registry, q } = build();
    const { outcome } = await run(backend([]), [call('1', 'export_file', { name: 'logo.png', preset_ids: ['image-web'], add_to_library: true }), final], { registry });
    expect(text(outcome)).toContain('exports/logo-web.jpg');
    expect(text(outcome)).toContain('in the library as logo-from-png.jpg');
    expect(q.calls[0]).toEqual(['a1', ['image-web'], 'claude']);
  });
  it('rejects unknown files, unexpected arguments and an agent-chosen output path', async () => {
    const { registry, q } = build();
    const { outcome } = await run(backend([]), [
      call('1', 'export_file', { name: 'missing.png', preset_ids: ['image-web'] }),
      call('2', 'export_file', { name: 'logo.png', preset_ids: ['image-web'], output_path: 'C:\\Windows\\x.jpg' }),
      final, final,
    ], { registry });
    expect(text(outcome, 0)).toContain('No file named');
    expect(text(outcome, 1)).toContain('Invalid tool arguments');
    expect(q.calls).toHaveLength(0);
  });
  it('does not export while the user has control', async () => {
    const { registry, q } = build(controller('manual', 'user'));
    const direct = registry.snapshot().find((t) => t.name === 'export_file')!;
    const r = await registry.call(registry.snapshot(), direct.name, { name: 'logo.png', preset_ids: ['image-web'] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('stop and wait');
    expect(q.calls).toHaveLength(0);
  });
});

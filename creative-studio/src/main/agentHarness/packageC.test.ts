import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runAgent, hasUnverifiedChanges } from './loop';
import { addExternalTools } from './externalTools';
import { ScriptedProvider } from './providers/scripted';
import { ToolRegistry, tool } from './registry';
import { AgentJobLedger } from './jobLedger';
import { expectedEditIntent, EditIntentJournal } from './editIntentJournal';
import { TaskCheckpointStore, type CheckpointCrypto } from './taskCheckpoint';
import { compactAgentHistory } from './contextBudget';
import { SHARED_CLAUDE_TOOL_FAMILIES, SHARED_CLAUDE_TOOL_NAMES } from './sharedClaudeTools';
import { ClaudePartner, type ClaudePartnerDeps } from '../claudePartner';
import { BLENDER_MANIFEST } from '../integrations/adapters/blender';
import { RESOLVE_MANIFEST } from '../integrations/adapters/resolve';
import { isTrustedReadbackCommand, TRUSTED_READBACK_COMMANDS } from '../integrations/readback';
import type { LiveTaskController } from '../liveTask';
import type { Message, ProviderReply } from './types';
import type { CommandResult, ExternalAppInfo, JobInfo } from '@shared/integrations';

const call = (id: string, name: string, args: unknown): ProviderReply => ({ text: null, toolCalls: [{ id, name, args }] });
const final: ProviderReply = { text: 'done', toolCalls: [] };
const ctlWith = (phase: () => string) => ({
  snapshot: () => ({ collab: { phase: phase(), lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }),
  claudeDone: () => undefined,
}) as unknown as LiveTaskController;
const idle = () => ctlWith(() => 'idle');

// ---------------------------------------------------------------- real built-in adapter classification
describe('trusted read-back classification against the real built-in adapters', () => {
  const classify = (adapterId: string, commands: typeof BLENDER_MANIFEST.commands) =>
    commands.filter((c) => isTrustedReadbackCommand(() => true, adapterId, c)).map((c) => c.id).sort();
  it('trusts exactly the documented read-only inspections of Blender and Resolve', () => {
    expect(classify('blender', BLENDER_MANIFEST.commands)).toEqual(['scene.inspect']);
    expect(classify('davinci.resolve', RESOLVE_MANIFEST.commands)).toEqual(['app.info', 'project.inspect', 'project.list']);
  });
  it('never trusts an edit, render, create or delete command', () => {
    for (const id of ['object.transform', 'material.set', 'object.delete', 'object.add', 'scene.set', 'scene.create_basic', 'scene.render_still', 'scene.render_animation', 'animation.keyframe'])
      expect(BLENDER_MANIFEST.commands.some((c) => c.id === id && isTrustedReadbackCommand(() => true, 'blender', c))).toBe(false);
    for (const id of ['project.create_scratch', 'project.delete_scratch', 'timeline.export'])
      expect(RESOLVE_MANIFEST.commands.some((c) => c.id === id && isTrustedReadbackCommand(() => true, 'davinci.resolve', c))).toBe(false);
  });
  it('trusts nothing from an adapter that is not built in, and every allow-listed command really exists', () => {
    for (const c of BLENDER_MANIFEST.commands) expect(isTrustedReadbackCommand(() => false, 'blender', c)).toBe(false);
    for (const c of RESOLVE_MANIFEST.commands) expect(isTrustedReadbackCommand(() => false, 'davinci.resolve', c)).toBe(false);
    expect(BLENDER_MANIFEST.commands.map((c) => c.id)).toEqual(expect.arrayContaining([...TRUSTED_READBACK_COMMANDS.blender!]));
    expect(RESOLVE_MANIFEST.commands.map((c) => c.id)).toEqual(expect.arrayContaining([...TRUSTED_READBACK_COMMANDS['davinci.resolve']!]));
  });
  it('loses trust if a listed command ever starts declaring a write permission', () => {
    const inspect = BLENDER_MANIFEST.commands.find((c) => c.id === 'scene.inspect')!;
    expect(isTrustedReadbackCommand(() => true, 'blender', { ...inspect, permissions: [...inspect.permissions, 'write-files'] })).toBe(false);
    expect(isTrustedReadbackCommand(() => true, 'blender', { ...inspect, idempotent: false })).toBe(false);
  });
});

// ---------------------------------------------------------------- fake Blender through the real command specs
interface Obj { name: string; location: number[]; rotation_deg: number[]; scale: number[]; materials?: Array<{ name: string; color: number[] }> }
function blender(opts: { objects?: Obj[]; applyEdit?: boolean; failEditAfterApplying?: boolean; extraObjects?: number } = {}) {
  const world: Obj[] = opts.objects ?? [{ name: 'Cube', location: [0, 0, 0], rotation_deg: [0, 0, 0], scale: [1, 1, 1], materials: [{ name: 'M', color: [0.5, 0.5, 0.5, 1] }] }];
  for (let i = 0; i < (opts.extraObjects ?? 0); i++) world.push({ name: `Extra${i}`, location: [i, i, i], rotation_deg: [0, 0, 0], scale: [1, 1, 1] });
  const jobs = new Map<string, JobInfo>();
  const executed: string[] = [];
  const app = { key: 'blender-1', name: 'Blender', status: 'connected', adapterId: 'blender', adapterName: 'Blender', commands: BLENDER_MANIFEST.commands.map((c) => c.id === 'scene.render_animation' ? { ...c, longRunning: true } : c) } as unknown as ExternalAppInfo;
  const ok = (data?: Record<string, unknown>): CommandResult => ({ ok: true, verified: true, message: 'ok', evidence: ['adapter says verified'], outputs: [], durationMs: 1, data });
  const backend = {
    list: async () => [app],
    isBuiltin: (id: string) => id === 'blender',
    jobs: () => [...jobs.values()],
    job: (id: string) => jobs.get(id) ?? null,
    cancelJob: (id: string) => { const j = jobs.get(id); if (!j || j.status !== 'running') return false; j.status = 'cancelled'; return true; },
    execute: async (_k: string, command: string, params: Record<string, unknown>, o: { background?: boolean } = {}) => {
      executed.push(command);
      if (command === 'object.transform') {
        if (opts.applyEdit !== false) {
          const o = world.find((x) => x.name === params.name)!;
          if (typeof params.x === 'number') o.location[0] = params.x;
          if (typeof params.rz === 'number') o.rotation_deg[2] = params.rz;
        }
        if (opts.failEditAfterApplying) throw new Error('Bridge timeout after execution');
        return ok({ objects: { MESH: ['Cube'] } }); // the edit's own response says nothing about the real state
      }
      if (command === 'scene.inspect') return ok({ count: world.length, details: world.map((o) => ({ type: 'MESH', size: [2, 2, 2], ...o })), scene: { engine: 'X' } });
      if (command === 'scene.render_animation' && o.background) {
        const id = `job-${jobs.size + 1}`;
        jobs.set(id, { id, appKey: 'blender-1', appName: 'Blender', commandId: command, status: 'running', stage: 'Starting', fraction: null, startedAt: 'now', finishedAt: null, result: null });
        return { ...ok({ jobId: id, status: 'running' }), message: `Started ${id}` };
      }
      return ok();
    },
  };
  return { backend: backend as unknown as Parameters<typeof addExternalTools>[1], world, jobs, executed };
}
const move = (id: string, over: Record<string, unknown> = {}) => call(id, 'external_command', { app_key: 'blender-1', command: 'object.transform', params: { file_name: 'a.blend', name: 'Cube', x: 3, ...over } });
const inspectCall = (id: string) => call(id, 'external_command', { app_key: 'blender-1', command: 'scene.inspect', params: { file_name: 'a.blend' } });
const verifyX = (id: string, receipt: string, expected = 3, index = 0) => call(id, 'evidence_verify', { receipt_id: receipt, path: `data.details.${index}.location.0`, expected });
const toolText = (messages: Message[], n: number) => messages.filter((m) => m.role === 'tool').map((m) => m.content)[n] ?? '';
const run = (b: ReturnType<typeof blender>, script: ProviderReply[], extra: Partial<Parameters<typeof runAgent>[0]> = {}) =>
  runAgent({ goal: 'move the cube', ctl: idle(), registry: addExternalTools(new ToolRegistry(), b.backend), provider: new ScriptedProvider(script), ...extra });

describe('external verification with fresh application state', () => {
  it('completes when a fresh, independent inspection matches the edit', async () => {
    const b = blender();
    const r = await run(b, [move('1'), inspectCall('2'), verifyX('3', 'r2'), final]);
    expect(r.status).toBe('completed');
    expect(b.executed).toEqual(['object.transform', 'scene.inspect']);
  });
  it('stays incomplete and resumable when the application did not really change, whatever the edit response said', async () => {
    const b = blender({ applyEdit: false });
    const r = await run(b, [move('1'), inspectCall('2'), verifyX('3', 'r2'), final, final]);
    expect(r.status).toBe('limit');
    expect(toolText(r.messages, 2)).toContain('"passed":false');
  });
  it('does not accept the edit response or a pre-edit inspection as verification', async () => {
    const b = blender();
    const stale = await run(b, [inspectCall('1'), move('2'), verifyX('3', 'r1', 0), final, final]);
    expect(stale.status).toBe('limit');
    const fromEdit = await run(blender(), [move('1'), call('2', 'evidence_verify', { receipt_id: 'r1', path: 'data.objects.MESH.0', expected: 'Cube' }), final, final]);
    expect(fromEdit.status).toBe('limit');
  });
  it('compares a large read-back in full while the model sees an outline', async () => {
    const b = blender({ extraObjects: 3000 });
    const r = await run(b, [move('1'), inspectCall('2'), verifyX('3', 'r2', 3, 0), call('4', 'evidence_verify', { receipt_id: 'r2', path: 'data.details.2999.location.0', expected: 2998 }), final]);
    const shown = toolText(r.messages, 1);
    expect(shown).toContain('retained in full for evidence_verify');
    expect(shown).toContain('"items":3001');
    expect(shown.length).toBeLessThan(7000);
    expect(toolText(r.messages, 2)).toContain('"passed":true');
    expect(toolText(r.messages, 3)).toContain('"passed":true');
    expect(r.status).toBe('completed');
  });
  it('refuses to use a state that is too large to compare instead of silently truncating it', async () => {
    const b = blender({ extraObjects: 20000 });
    const r = await run(b, [move('1'), inspectCall('2'), verifyX('3', 'r2'), final, final]);
    expect(toolText(r.messages, 1)).toContain('too large to compare');
    expect(r.status).toBe('limit');
  });
});

// ---------------------------------------------------------------- edit-intent variants
describe('edit intents beyond PhotoCraft rectangles', () => {
  const ext = (command: string, params: Record<string, unknown>) => expectedEditIntent('external_command', { app_key: 'k', command, params });
  it('extracts Blender transform and colour intents, and nothing it cannot compare', () => {
    expect(ext('object.transform', { file_name: 'a.blend', name: 'Cube', x: 3, rz: 45 })).toEqual({ kind: 'blender.object.transform', file: 'a.blend', object: 'Cube', values: { x: 3, rz: 45 } });
    expect(ext('material.set', { file_name: 'a.blend', name: 'Cube', color: '#ff0000' })).toEqual({ kind: 'blender.object.color', file: 'a.blend', object: 'Cube', color: '#ff0000' });
    expect(ext('object.transform', { file_name: 'a.blend', name: 'Cube', x: 1, new_name: 'B' })).toBeUndefined();
    expect(ext('object.transform', { file_name: 'a.blend', name: 'Cube', look_at: 'Cam' })).toBeUndefined();
    expect(ext('object.transform', { file_name: 'a.blend', name: 'Cube' })).toBeUndefined();
    expect(ext('material.set', { file_name: 'a.blend', name: 'Cube', color: '#ff0000', metallic: 1 })).toBeUndefined();
    expect(ext('object.delete', { file_name: 'a.blend', name: 'Cube' })).toBeUndefined();
    expect(ext('object.transform', { file_name: 'a.blend', name: 'Cube', x: '3' })).toBeUndefined();
    expect(expectedEditIntent('app_command', { command: 'shape.edit', params: { layer: 3, rect: [1, 2, 3, 4] } })).toMatchObject({ kind: 'photocraft.shape.edit.rect' });
  });
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }))); });
  const crypto: CheckpointCrypto = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString('utf8') };
  it('records the intent durably before dispatch and releases the lock only after a matching trusted read-back', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicandy-pkgc-'));
    roots.push(root);
    const journal = new EditIntentJournal(root, crypto);
    const b = blender({ failEditAfterApplying: true });
    const first = await run(b, [move('1'), final], {
      onEditBegin: async (t, c, a) => { await journal.begin('move', t, c, a); },
      onEditSettled: async (safe) => { if (safe) await journal.clear(); },
    });
    expect(first.uncertainEdit).toContain('external_command');
    const intent = await journal.load();
    expect(intent?.expected).toEqual({ kind: 'blender.object.transform', file: 'a.blend', object: 'Cube', values: { x: 3 } });

    const noDuplicate = blender({ failEditAfterApplying: true });
    noDuplicate.world[0]!.location[0] = 3; // the edit did apply even though the response was lost
    const resumed = await run(noDuplicate, [move('2'), inspectCall('3'), verifyX('4', 'r1'), final], {
      resumeMessages: first.messages, resumeUncertainEdit: first.uncertainEdit, resumeExpectedEdit: intent!.expected,
      registry: (() => { const r = addExternalTools(new ToolRegistry(), noDuplicate.backend); r.add(tool('get_status', 'status', z.object({}).strict(), async () => 'current')); return r; })(),
      onRecoveryResolved: async () => { await journal.clear(); },
    });
    expect(noDuplicate.executed).toEqual(['scene.inspect']); // the blocked replay never reached Blender
    expect(toolText(resumed.messages, resumed.messages.filter((m) => m.role === 'tool').length - 3)).toContain('Further edits remain blocked');
    expect(resumed.uncertainEdit).toBeUndefined();
    expect(await journal.load()).toBeNull();
    expect(resumed.status).toBe('completed'); // the lock was released by evidence and nothing else changed
  });
  it('keeps the lock when the fresh read-back does not match the recorded intent', async () => {
    const mismatch = blender({ applyEdit: false });
    const status = () => { const r = addExternalTools(new ToolRegistry(), mismatch.backend); r.add(tool('get_status', 'status', z.object({}).strict(), async () => 'current')); return r; };
    const r = await runAgent({ goal: 'move', ctl: idle(), registry: status(), provider: new ScriptedProvider([inspectCall('1'), verifyX('2', 'r1'), final]),
      resumeMessages: [{ role: 'user', content: 'move' }], resumeUncertainEdit: 'external_command (object.transform)',
      resumeExpectedEdit: { kind: 'blender.object.transform', file: 'a.blend', object: 'Cube', values: { x: 3 } } });
    expect(r.uncertainEdit).toBe('external_command (object.transform)');
    expect(r.status).toBe('limit');
  });
  it('matches a colour intent against the fresh materials of exactly one object', async () => {
    const b = blender({ objects: [{ name: 'Cube', location: [0, 0, 0], rotation_deg: [0, 0, 0], scale: [1, 1, 1], materials: [{ name: 'M', color: [1, 0, 0, 1] }] }] });
    const r = await runAgent({ goal: 'paint', ctl: idle(), provider: new ScriptedProvider([inspectCall('1'), call('2', 'evidence_verify', { receipt_id: 'r1', path: 'data.details.0.materials.0.color.0', expected: 1 }), final]),
      registry: (() => { const x = addExternalTools(new ToolRegistry(), b.backend); x.add(tool('get_status', 's', z.object({}).strict(), async () => 'current')); return x; })(),
      resumeMessages: [{ role: 'user', content: 'paint' }], resumeUncertainEdit: 'external_command (material.set)',
      resumeExpectedEdit: { kind: 'blender.object.color', file: 'a.blend', object: 'Cube', color: '#ff0000' } });
    expect(r.uncertainEdit).toBeUndefined();
  });
  it('round-trips the job ledger through the encrypted checkpoint and rejects a corrupt one', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicandy-pkgc-'));
    roots.push(root);
    const store = new TaskCheckpointStore(root, crypto);
    await store.save({ goal: 'g', model: 'm', status: 'limit', messages: [{ role: 'user', content: 'g' }], jobs: [{ id: 'job-1', appKey: 'blender-1', commandId: 'scene.render_animation' }] });
    expect((await store.load())?.jobs).toEqual([{ id: 'job-1', appKey: 'blender-1', commandId: 'scene.render_animation' }]);
    await store.save({ goal: 'g', model: 'm', status: 'limit', messages: [{ role: 'user', content: 'g' }] });
    expect((await store.load())?.jobs).toBeUndefined(); // checkpoints without jobs (older ones) still load
  });
});

// ---------------------------------------------------------------- jobs: takeover and interruption
describe('agent-owned jobs', () => {
  const render = (id: string) => call(id, 'external_command', { app_key: 'blender-1', command: 'scene.render_animation', params: { file_name: 'a.blend' } });
  const withLedger = (b: ReturnType<typeof blender>, persisted: unknown[] = []) => {
    const ledger = new AgentJobLedger(b.backend as never, async (jobs) => { persisted.push(jobs); });
    const registry = addExternalTools(new ToolRegistry(), b.backend, {
      onJobStarted: (j) => ledger.started({ id: j.jobId, appKey: j.appKey, commandId: j.commandId }),
      jobGuard: (k, c) => ledger.guard(k, c),
    });
    return { ledger, registry, persisted };
  };
  it('cancels the running job when the user takes control', async () => {
    const b = blender();
    const { ledger, registry, persisted } = withLedger(b);
    let phase = 'idle';
    const provider = new ScriptedProvider([render('1'), call('2', 'external_job', {}), final]);
    const orig = provider.complete.bind(provider);
    provider.complete = async (i) => { const r = await orig(i); if (r.toolCalls[0]?.id === '2') phase = 'manual'; return r; };
    const interrupted: string[] = [];
    const r = await runAgent({ goal: 'render', ctl: ctlWith(() => phase), registry, provider, onInterrupted: (s) => { interrupted.push(s); ledger.cancelRunning(); } });
    expect(r.status).toBe('paused');
    expect(interrupted).toEqual(['paused']);
    expect(b.jobs.get('job-1')?.status).toBe('cancelled');
    expect(persisted.length).toBe(1); // the launch was made durable before the model saw the result
  });
  it('cancels on stop and keeps a finished job from blocking the next launch', async () => {
    const b = blender();
    const { ledger, registry } = withLedger(b);
    const ac = new AbortController();
    const provider = new ScriptedProvider([render('1'), final]);
    const orig = provider.complete.bind(provider);
    let n = 0;
    provider.complete = async (i) => { if (++n === 2) ac.abort(); return orig(i); };
    const r = await runAgent({ goal: 'render', ctl: idle(), registry, provider, signal: ac.signal, onInterrupted: () => { ledger.cancelRunning(); } });
    expect(r.status).toBe('cancelled');
    expect(b.jobs.get('job-1')?.status).toBe('cancelled');
    expect(ledger.guard('blender-1', 'scene.render_animation')).toBeUndefined(); // observed as cancelled: a deliberate new launch is allowed
  });
  it('never relaunches a job that is missing after a restart, and says what to do instead', async () => {
    const b = blender();
    const { ledger, registry } = withLedger(b);
    ledger.restore([{ id: 'job-77', appKey: 'blender-1', commandId: 'scene.render_animation' }]); // restored from the checkpoint; the manager has lost it
    const r = await runAgent({ goal: 'render', ctl: idle(), registry, provider: new ScriptedProvider([render('1'), call('2', 'external_job', { job_id: 'job-77' }), render('3'), final]) });
    expect(b.executed).toEqual([]);
    expect(toolText(r.messages, 0)).toContain('status is unknown');
    expect(toolText(r.messages, 1)).toContain('do not survive an application restart');
    expect(toolText(r.messages, 2)).toContain('status is unknown'); // asking about it does not unlock it
    ledger.resetForNewTask(); // only an explicit new task forgets an unknowable job
    expect(ledger.guard('blender-1', 'scene.render_animation')).toBeUndefined();
  });
  it('keeps a verifiably running job blocked even for a new task', () => {
    const b = blender();
    const { ledger } = withLedger(b);
    b.jobs.set('job-1', { id: 'job-1', appKey: 'blender-1', appName: 'Blender', commandId: 'scene.render_animation', status: 'running', stage: '', fraction: null, startedAt: '', finishedAt: null, result: null });
    ledger.restore([{ id: 'job-1', appKey: 'blender-1', commandId: 'scene.render_animation' }]);
    ledger.resetForNewTask();
    expect(ledger.guard('blender-1', 'scene.render_animation')).toContain('still running');
  });
});

// ---------------------------------------------------------------- resume and compaction
describe('resume classification and compaction', () => {
  const msg = (id: string, name: string, args: unknown, content: string): Message[] => [
    { role: 'assistant', content: null, toolCalls: [{ id, name, args }] }, { role: 'tool', toolCallId: id, content },
  ];
  it('does not reopen verified work because its tool responses were compacted', async () => {
    const messages: Message[] = [
      ...msg('1', 'app_command', { command: 'shape.edit' }, 'applied'),
      ...msg('2', 'app_command', { command: 'shape.info' }, `Result: ${'x'.repeat(2000)}`),
      ...msg('3', 'evidence_verify', { receipt_id: 'r2' }, `{"id":"v1","path":"live.rect.0","expected":1,"observed":1,"passed":true,"pad":"${'p'.repeat(600)}"}`),
      ...Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `filler ${i}` }) as Message),
    ];
    expect(await hasUnverifiedChanges(messages)).toBe(false);
    compactAgentHistory(messages);
    expect(messages[5]).toMatchObject({ role: 'tool', content: expect.stringContaining('[evidence_verify passed]') });
    expect(await hasUnverifiedChanges(messages)).toBe(false);
  });
  it('does not turn a compacted failure into a success', async () => {
    const messages: Message[] = [...msg('1', 'app_command', { command: 'shape.edit' }, `Error: ${'e'.repeat(500)}`), ...Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `f${i}` }) as Message)];
    compactAgentHistory(messages);
    expect((messages[1] as { content: string }).content.startsWith('Error:')).toBe(true);
    expect(await hasUnverifiedChanges(messages)).toBe(false);
  });
  it('distinguishes trusted read-only external calls from mutations on resume', async () => {
    const messages: Message[] = [...msg('1', 'external_command', { app_key: 'k', command: 'scene.inspect' }, '{"ok":true}')];
    expect(await hasUnverifiedChanges(messages)).toBe(true); // unknown: conservative
    expect(await hasUnverifiedChanges(messages, async (_n, a) => (a as { command: string }).command === 'scene.inspect')).toBe(false);
    const edit = [...messages, ...msg('2', 'external_command', { app_key: 'k', command: 'object.transform' }, '{"ok":true}')];
    expect(await hasUnverifiedChanges(edit, async (_n, a) => (a as { command: string }).command === 'scene.inspect')).toBe(true);
  });
  it('requires fresh evidence for the latest mutation after a resume, then completes', async () => {
    const b = blender();
    const first = await run(b, [move('1'), final, final]);
    expect(first.status).toBe('limit');
    const withStatus = () => { const r = addExternalTools(new ToolRegistry(), b.backend); r.add(tool('get_status', 's', z.object({}).strict(), async () => 'current')); return r; };
    const stale = await runAgent({ goal: 'move the cube', ctl: idle(), registry: withStatus(), provider: new ScriptedProvider([final, final]), resumeMessages: first.messages });
    expect(stale.status).toBe('limit'); // nothing new was checked
    const done = await runAgent({ goal: 'move the cube', ctl: idle(), registry: withStatus(), provider: new ScriptedProvider([inspectCall('2'), verifyX('3', 'r1'), final]), resumeMessages: first.messages });
    expect(done.status).toBe('completed');
    expect(b.executed.filter((c) => c === 'object.transform')).toHaveLength(1); // no edit was replayed
  });
  it('does not count a trusted inspection as an edit on resume', async () => {
    const b = blender();
    const first = await run(b, [inspectCall('1'), final]);
    expect(first.status).toBe('completed');
    const registry = addExternalTools(new ToolRegistry(), b.backend);
    registry.add(tool('get_status', 's', z.object({}).strict(), async () => 'current'));
    const resumed = await runAgent({ goal: 'look', ctl: idle(), registry, provider: new ScriptedProvider([final]), resumeMessages: first.messages });
    expect(resumed.status).toBe('completed');
  });
});

// ---------------------------------------------------------------- shared Claude tool families
describe('Claude tool families shared with Independent AI', () => {
  const fakeCtl = { snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined };
  const make = (over: Record<string, unknown> = {}) => new ClaudePartner({
    live: async () => fakeCtl, store: async () => ({ loadManifest: async () => ({ assets: [] }) }), emit: () => undefined,
    history: { load: async () => [], save: async () => undefined }, imageModels: async () => [], ...over,
  } as unknown as ClaudePartnerDeps);

  it('offers the timeline, workflow, planner, generation, local media and PhotoCraft tools using Claude\'s own schemas', async () => {
    const defs = await make().agentToolDefs(SHARED_CLAUDE_TOOL_NAMES);
    const names = defs.map((d) => d.name);
    for (const family of Object.values(SHARED_CLAUDE_TOOL_FAMILIES)) for (const n of family) expect(names).toContain(n);
    expect(names).toHaveLength(SHARED_CLAUDE_TOOL_NAMES.length);
    const add = defs.find((d) => d.name === 'timeline_add')!;
    expect(JSON.stringify(add.parameters)).toContain('additionalProperties');
    const registry = new ToolRegistry(defs);
    expect(registry.snapshot().map((t) => t.name)).toEqual(expect.arrayContaining(['timeline_add', 'timeline_move_clip', 'run_workflow', 'plan_workflow', 'planner_claim']));
  });
  it('does not expose shell access, Claude-only builder tools or tools the agent already has natively', () => {
    for (const forbidden of ['integration_builder_start', 'integration_builder_status', 'get_status', 'app_command', 'external_run', 'export_file', 'list_files'])
      expect(SHARED_CLAUDE_TOOL_NAMES).not.toContain(forbidden);
    expect(SHARED_CLAUDE_TOOL_NAMES.some((n) => /shell|bash|exec|script/i.test(n))).toBe(false);
  });
  it('rejects unexpected arguments before any handler runs', async () => {
    let generated = 0;
    const defs = await make({ generate: async () => { generated++; throw new Error('should not run'); } }).agentToolDefs(['generate_image']);
    const r = await defs[0]!.execute({ prompt: 'a cat', model_id: 'm', outputPath: 'C:\\x.png' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Invalid tool arguments');
    expect(generated).toBe(0);
  });
  it('sends paid generation only through the approval-gated generate service, and a declined approval stops the agent', async () => {
    const calls: unknown[] = [];
    const defs = await make({ generate: async (job: unknown) => { calls.push(job); throw new Error('The user cancelled the approval dialog'); } }).agentToolDefs(['generate_image', 'list_image_models']);
    const registry = new ToolRegistry([...defs, tool('get_status', 's', z.object({}).strict(), async () => 'current')]);
    const r = await runAgent({ goal: 'make a cat picture', ctl: idle(), registry, provider: new ScriptedProvider([call('1', 'generate_image', { prompt: 'a cat', model_id: 'gpt-image-1' }), call('2', 'generate_image', { prompt: 'a cat again', model_id: 'gpt-image-1' }), final]) });
    expect(calls).toHaveLength(1); // declined once; the second attempt was never executed
    expect(r.status).toBe('paused');
    expect(toolText(r.messages, 0)).toContain('Nothing was charged');
    expect(r.messages.filter((m) => m.role === 'tool')).toHaveLength(1); // the loop stopped; the second attempt was never made
  });
  it('sends model downloads through the user-approval service and reports a refusal exactly', async () => {
    const asked: string[] = [];
    const defs = await make({ localAi: { status: async () => 's', startVideo: async () => 'x', motion: async () => 'x', requestDownload: async (id: string) => { asked.push(id); return 'The user declined the download.'; } } }).agentToolDefs(['request_model_download']);
    const r = await defs[0]!.execute({ model_id: 'ltx-video' });
    expect(asked).toEqual(['ltx-video']);
    expect(r.text).toContain('declined');
  });
  it('treats timeline edits and PhotoCraft commands as unverified changes that need fresh evidence', async () => {
    const status = { open: { file: 'clip.mp4', details: { clips: 2 } } };
    let clips = 1;
    const registry = new ToolRegistry([
      tool('timeline_add', 'add', z.object({ file_name: z.string(), as: z.string().optional() }).strict(), async () => { clips = 2; return 'added'; }),
      { ...tool('get_status', 'status', z.object({}).strict(), async () => 'x'), execute: async () => ({ text: JSON.stringify({ open: { file: 'clip.mp4', details: { clips } } }), readback: { open: { file: 'clip.mp4', details: { clips } } }, trustedReadback: true }) },
    ]);
    void status;
    const unverified = await runAgent({ goal: 'add a clip', ctl: idle(), registry, provider: new ScriptedProvider([call('1', 'timeline_add', { file_name: 'b.mp4' }), final, final]) });
    expect(unverified.status).toBe('limit');
    const verified = await runAgent({ goal: 'add a clip', ctl: idle(), registry, provider: new ScriptedProvider([
      call('1', 'timeline_add', { file_name: 'b.mp4' }), call('2', 'get_status', {}), call('3', 'evidence_verify', { receipt_id: 'r2', path: 'open.details.clips', expected: 2 }), final]) });
    expect(verified.status).toBe('completed');
  });
});

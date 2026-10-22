// REAL Blender through the real IntegrationManager and the real Independent AI loop (runAgent + external tools).
// Only the MODEL is scripted. OPT-IN: skipped unless CS_LIVE_TESTS=1 (`npm run check` never runs it) and Blender is installed.
// Safety: every file lives in a fresh folder under the OS temp directory (asserted below, and checked again for every
// output the adapter reports); no user project, library or Blender folder is opened or written.
// Run it with: CS_LIVE_TESTS=1 npx vitest run src/main/agentHarness/agentBlender.live.test.ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission } from '@shared/integrations';
import { createIntegrationManager } from '../integrations/index';
import { runAgent } from './loop';
import { addExternalTools } from './externalTools';
import { AgentJobLedger } from './jobLedger';
import { ToolRegistry } from './registry';
import type { Message, ModelProvider, ProviderReply } from './types';
import type { LiveTaskController } from '../liveTask';

const on = process.env.CS_LIVE_TESTS === '1';
const FILE = 'agent-live.blend';
const call = (id: string, name: string, args: unknown): ProviderReply => ({ text: null, toolCalls: [{ id, name, args }] });
const final: ProviderReply = { text: 'done', toolCalls: [] };
class Steps implements ModelProvider {
  readonly id = 'steps'; readonly supportsVision = false; private turn = 0;
  constructor(private readonly fn: (messages: Message[], turn: number) => ProviderReply) {}
  async complete(input: Parameters<ModelProvider['complete']>[0]): Promise<ProviderReply> { return this.fn(input.messages, this.turn++); }
}
const lastTool = (m: Message[]) => [...m].reverse().find((x) => x.role === 'tool')?.content ?? '';
const ctlWith = (phase: () => string) => ({
  snapshot: () => ({ collab: { phase: phase(), lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }),
  claudeDone: () => undefined,
}) as unknown as LiveTaskController;

describe.skipIf(!on)('Independent AI + real Blender (real adapter, scripted model)', { timeout: 300_000 }, () => {
  let tmp: string;
  let granted: Record<string, Permission[]> = {};
  const asked: string[] = [];
  let m: ReturnType<typeof createIntegrationManager>;
  let key = '';
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-agent-blender-'));
    expect(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep), 'the live test must only ever work inside the OS temp folder').toBe(true);
    m = createIntegrationManager({
      workDir: async (id) => path.join(tmp, id),
      permissions: { load: async () => granted, save: async (g) => { granted = g; } },
      approve: async (r) => { asked.push(r.command.id); return 'always'; },
    });
    const b = (await m.scan()).apps.find((a) => a.adapterId === 'blender');
    expect(b, 'Blender is not installed').toBeTruthy();
    key = b!.key;
    await m.connect(key);
    const made = await m.execute(key, 'scene.create_basic', { file_name: FILE, cube_size: 2 });
    expect(made.ok).toBe(true);
    for (const o of made.outputs) expect(path.resolve(o.path).startsWith(path.resolve(tmp) + path.sep), `output outside the temp folder: ${o.path}`).toBe(true);
  });
  afterAll(async () => { await m.shutdown(); await fs.rm(tmp, { recursive: true, force: true }); });

  const registry = (backend: Parameters<typeof addExternalTools>[1] = m, opts: Parameters<typeof addExternalTools>[2] = {}) => addExternalTools(new ToolRegistry(), backend, opts);
  const edits: string[] = [];
  const hooks = { onEditBegin: async (_t: string, c: string) => { edits.push(c); }, onEditSettled: async () => undefined };
  const move = (x: number) => call('edit', 'external_command', { app_key: key, command: 'object.transform', params: { file_name: FILE, name: 'Cube', x } });
  const inspect = () => call('read', 'external_command', { app_key: key, command: 'scene.inspect', params: { file_name: FILE } });
  /** Edit, fresh scene.inspect, then compare Cube's X (found in the real read-back) with `expected`. */
  const flow = (x: number, expected: number) => new Steps((messages, turn) => {
    if (turn === 0) return call('cmds', 'external_commands', { app_key: key, command_id: 'scene.inspect' });
    if (turn === 1) return move(x);
    if (turn === 2) return inspect();
    if (turn === 3) {
      const details = (JSON.parse(lastTool(messages).split('\nExecution receipt')[0]!).data.details as Array<{ name: string }>);
      return call('verify', 'evidence_verify', { receipt_id: 'r2', path: `data.details.${details.findIndex((d) => d.name === 'Cube')}.location.0`, expected, tolerance: 0.001 });
    }
    return final;
  });

  it('classifies the real scene.inspect as trusted read-back and the real edit as not', async () => {
    const apps = await m.list();
    const blender = apps.find((a) => a.key === key)!;
    const reg = registry();
    const snap = reg.snapshot();
    const readOnly = async (command: string) => reg.isReadOnly(snap, 'external_command', { app_key: key, command, params: {} });
    expect(blender.adapterId).toBe('blender');
    expect(await readOnly('scene.inspect')).toBe(true);
    for (const c of ['object.transform', 'object.add', 'material.set', 'scene.render_still', 'scene.create_basic']) expect(await readOnly(c)).toBe(false);
  });

  it('completes when the fresh real scene.inspect matches the edit', async () => {
    edits.length = 0;
    const r = await runAgent({ goal: 'move the cube to x=3', ctl: ctlWith(() => 'idle'), registry: registry(), provider: flow(3, 3), ...hooks });
    const texts = r.messages.filter((x) => x.role === 'tool').map((x) => x.content);
    console.log('MATCH tool results:', JSON.stringify(texts.map((t) => t.slice(0, 160))));
    expect(texts[0]).toContain('"trustedReadback":true');
    expect(r.status).toBe('completed');
    expect(edits).toEqual(['object.transform']); // scene.inspect did not create a false mutation
    const after = await m.execute(key, 'scene.inspect', { file_name: FILE });
    const cube = (after.data as { details: Array<{ name: string; location: number[] }> }).details.find((d) => d.name === 'Cube')!;
    expect(cube.location[0]).toBeCloseTo(3, 3);
  });

  it('does not complete when the real read-back disagrees with the claimed result', async () => {
    edits.length = 0;
    const r = await runAgent({ goal: 'move the cube to x=5', ctl: ctlWith(() => 'idle'), registry: registry(), provider: flow(5, 4) /* claims 4 although 5 was set */, ...hooks });
    const verifyText = r.messages.filter((x) => x.role === 'tool').map((x) => x.content)[3] ?? '';
    console.log('MISMATCH verify result:', verifyText.slice(0, 300));
    expect(verifyText).toContain('"passed":false');
    expect(r.status).toBe('limit');
  });

  it('read-only inspection alone creates no mutation, no journal entry and completes', async () => {
    edits.length = 0;
    const r = await runAgent({ goal: 'what is in the scene?', ctl: ctlWith(() => 'idle'), registry: registry(), provider: new Steps((_m, t) => (t === 0 ? inspect() : final)), ...hooks });
    expect(r.status).toBe('completed');
    expect(edits).toEqual([]);
  });

  it('blocks a blind retry of an edit whose result is unknown, against the real adapter', async () => {
    edits.length = 0;
    const flaky = new Proxy(m, { get: (t, p, rcv) => p === 'execute'
      ? async (...a: Parameters<typeof m.execute>) => { const res = await t.execute(...a); if (a[1] === 'object.transform') throw new Error('Bridge timeout after execution'); return res; }
      : Reflect.get(t, p, rcv) }) as typeof m;
    const r = await runAgent({ goal: 'move the cube', ctl: ctlWith(() => 'idle'), registry: registry(flaky), provider: new Steps((_m, t) => (t === 0 ? move(7) : t === 1 ? move(7) : final)), ...hooks });
    expect(edits).toEqual(['object.transform']); // the second identical edit never reached the adapter
    expect(r.uncertainEdit).toContain('external_command');
    expect(r.status).toBe('limit');
  });

  it('cancels an agent-owned real Blender job when the user takes control', async () => {
    // The built-in adapter has no long-running command, so one render command is marked longRunning in the LIST only;
    // execute, job tracking, progress and cancellation are the real IntegrationManager's.
    const listed = new Proxy(m, { get: (t, p, rcv) => p === 'list'
      ? async () => (await t.list()).map((a) => a.adapterId !== 'blender' ? a : { ...a, commands: a.commands.map((c) => c.id === 'scene.render_animation' ? { ...c, longRunning: true } : c) })
      : Reflect.get(t, p, rcv) }) as typeof m;
    const ledger = new AgentJobLedger(m, async () => undefined);
    let phase = 'idle';
    const render = call('render', 'external_command', { app_key: key, command: 'scene.render_animation', params: { file_name: FILE, width: 1280, height: 720, frame_end: 250, engine: 'eevee' } });
    const provider = new Steps((_m, t) => { if (t === 1) phase = 'manual'; return t === 0 ? render : call('wait', 'external_job', {}); });
    const r = await runAgent({ goal: 'render it', ctl: ctlWith(() => phase), provider, ...hooks,
      registry: registry(listed, { onJobStarted: (j) => ledger.started({ id: j.jobId, appKey: j.appKey, commandId: j.commandId }), jobGuard: (k, c) => ledger.guard(k, c) }),
      onInterrupted: () => { ledger.cancelRunning(); } });
    expect(r.status).toBe('paused');
    const jobs = m.jobs();
    console.log('JOBS after takeover:', JSON.stringify(jobs.map((j) => ({ id: j.id, cmd: j.commandId, status: j.status }))));
    expect(jobs).toHaveLength(1);
    for (let i = 0; i < 40 && m.jobs()[0]!.status === 'running'; i++) await new Promise((res) => setTimeout(res, 500));
    expect(['cancelled', 'failed']).toContain(m.jobs()[0]!.status);
    expect(m.jobs()[0]!.status).toBe('cancelled');
    expect(ledger.guard(key, 'scene.render_animation')).toBeUndefined(); // seen terminal: a deliberate relaunch is allowed again
  });
});

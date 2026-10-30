import { mkdtemp, stat, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, tool } from '../agentHarness/registry';
import { chooseEngine, toolboxFor } from '../../shared/directorToolbox';
import { CAPABILITIES, effectiveLevel } from '../../shared/teamAccess';
import { approvalBox, nativeApprover } from './approval';
import { briefing, directorWorkerId, runDirector, type DirectorOutcome, type Engine, type MadeFile } from './directorRun';
import type { ActivityEntry } from './guard';
import { PolicyStore, POLICY_FILE } from './policyStore';

const task = { id: 't1', title: 'Draw a baby dragon reading a book under a glowing mushroom' };

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dir-'));
  const lib: string[] = [];
  const library = async (): Promise<MadeFile[]> => Promise.all(lib.map(async (n) => { try { return { name: n, exists: true, bytes: (await stat(path.join(dir, n))).size }; } catch { return { name: n, exists: false, bytes: 0 }; } }));
  const log: ActivityEntry[] = [];
  const store = new PolicyStore(dir);
  // tools standing in for the real ones: generate_image really writes a file
  const makeEngine = (script: (call: (name: string, args?: unknown) => Promise<{ text: string; isError?: boolean }>) => Promise<string>): Engine => ({
    run: async ({ guard }) => {
      const reg = new ToolRegistry([
        tool('generate_image', 'x', z.object({ prompt: z.string() }), async ({ prompt }) => { await writeFile(path.join(dir, 'dragon.png'), Buffer.from('PNG-not-empty-' + prompt)); lib.push('dragon.png'); return 'made dragon.png'; }),
        tool('get_status', 'x', z.object({}), async () => 'status'),
        tool('external_run', 'x', z.object({ app: z.string(), command: z.string() }), async () => 'ran'),
      ]);
      reg.setGuard(guard);
      return { text: await script((n, a) => reg.call(reg.snapshot(), n, a ?? {})) };
    },
  });
  return { dir, lib, library, log, store, makeEngine, deps: (engine: Engine, extra = {}) => ({ store, engine, library, log: (e: ActivityEntry) => { log.push(e); }, ...extra }) };
}

describe('a director doing a task', () => {
  it('makes the picture after the owner says yes, and the file really exists', async () => {
    const s = await setup(); const asked: string[] = [];
    const out = await runDirector(s.deps(s.makeEngine(async (call) => { const r = await call('generate_image', { prompt: 'dragon' }); return r.text; }), { approve: async ({ request }: { request: { label: string } }) => { asked.push(request.label); return 'once'; } }), 'creative-director', task);
    expect(asked).toEqual(['Make a picture with AI']);
    expect(out.status).toBe('made');
    expect(out.files).toEqual([{ name: 'dragon.png', exists: true, bytes: expect.any(Number) }]);
    expect(s.log.map((e) => `${e.tool}:${e.outcome}:${e.approvedBy ?? ''}`)).toEqual(['generate_image:done:owner']);
  });

  it('sends the Creative Director\'s AI work through the AI Director: named in the question, and stopped when they are switched off', async () => {
    const s = await setup(); const asked: string[] = [];
    const engine = s.makeEngine(async (call) => (await call('generate_image', { prompt: 'dragon' })).text);
    await runDirector(s.deps(engine, { approve: async ({ via }: { via?: { name: string } }) => { asked.push(via?.name ?? 'direct'); return 'once'; } }), 'creative-director', task);
    expect(asked).toEqual(['AI Director']); expect(s.log[0]).toMatchObject({ via: 'AI Director', approvedBy: 'owner' });
    await s.store.setRevoked(directorWorkerId('ai-director'), true);
    const s2 = s.lib.length; const out = await runDirector(s.deps(s.makeEngine(async (call) => (await call('generate_image', { prompt: 'again' })).text), { approve: async () => 'once' }), 'creative-director', task);
    expect(s.lib.length).toBe(s2); expect(out.status).toBe('stopped');
    expect(s.log.at(-1)).toMatchObject({ outcome: 'refused' }); expect(s.log.at(-1)?.why).toContain('AI Director is switched off');
  });

  it('does not say it worked when the owner said no', async () => {
    const s = await setup();
    const out = await runDirector(s.deps(s.makeEngine(async (call) => { await call('generate_image', { prompt: 'dragon' }); return 'All done! I made a lovely dragon.'; }), { approve: async () => 'deny' }), 'creative-director', task);
    expect(out.status).toBe('nothing-made'); expect(out.said).toContain('All done'); expect(out.summary).toContain('Nothing was added');
  });

  it('does not believe a claim of success with no file behind it', async () => {
    const s = await setup(); s.lib.push('ghost.png');
    const out = await runDirector(s.deps(s.makeEngine(async () => 'Made ghost.png'), {}), 'creative-director', task);
    expect(out.status).toBe('nothing-made');
  });

  it('cannot use what is not in the toolbox, however the owner set things', async () => {
    const s = await setup();
    await s.store.save({ ...(await s.store.get(directorWorkerId('creative-director'))), preset: 'independent' });
    const out = await runDirector(s.deps(s.makeEngine(async (call) => (await call('external_run', { app: 'blender', command: 'x' })).text), {}), 'creative-director', task);
    expect(s.log[0]).toMatchObject({ tool: 'external_run', outcome: 'refused' });
    expect(out.status).toBe('nothing-made');
  });

  it('is not started when the owner has switched the director off, and stops mid-run when they do', async () => {
    const s = await setup(); const id = directorWorkerId('creative-director');
    await s.store.setRevoked(id, true);
    expect((await runDirector(s.deps(s.makeEngine(async () => 'x'), {}), 'creative-director', task)).status).toBe('stopped');
    await s.store.setRevoked(id, false);
    const results: string[] = [];
    const out = await runDirector(s.deps(s.makeEngine(async (call) => { results.push((await call('get_status')).text); await s.store.setRevoked(id, true); results.push((await call('get_status')).text); return 'x'; }), {}), 'creative-director', task);
    expect(results[0]).toBe('status'); expect(results[1]).toMatch(/switched this worker|switched off/);
    expect(out.status).toBe('stopped');
  });

  it('hands the outcome to the plan, and a failed hand-over does not lose it', async () => {
    const s = await setup(); const got: DirectorOutcome[] = [];
    await runDirector(s.deps(s.makeEngine(async () => 'x'), { handOver: async (_t: unknown, o: DirectorOutcome) => { got.push(o); throw new Error('plan locked'); } }), 'creative-director', task);
    expect(got).toHaveLength(1);
  });

  it('reports a crash honestly', async () => {
    const s = await setup();
    const out = await runDirector(s.deps({ run: async () => { throw new Error('network down'); } }), 'creative-director', task);
    expect(out).toMatchObject({ status: 'failed' }); expect(out.summary).toContain('network down');
  });

  it('briefs the AI with its job and the honesty rule', () => {
    const b = briefing('creative-director', task);
    expect(b).toContain('Creative Director'); expect(b).toContain('baby dragon'); expect(b).toContain('Say only what you really did');
  });
});

describe('settings saved in the project', () => {
  it('start safe, survive a restart, and ignore a damaged file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pol-')); const a = new PolicyStore(dir);
    expect((await a.get('w')).preset).toBe('balanced');
    await a.save({ ...(await a.get('w')), preset: 'supervised', spendCapCents: 500 });
    expect(await new PolicyStore(dir).get('w')).toMatchObject({ preset: 'supervised', spendCapCents: 500 });
    await writeFile(path.join(dir, POLICY_FILE), '{ nope');
    expect((await a.get('w')).preset).toBe('balanced');
  });
  it('can never grant more than the toolbox, even if the file says so', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pol-')); const a = new PolicyStore(dir);
    await a.save({ ...(await a.get('w')), levels: { 'outside-apps': 'allow' } });
    const p = await a.get('w', toolboxFor('creative-director').ceiling);
    expect(effectiveLevel(p, 'outside-apps')).toBe('none');
  });
  it('counts spending toward the cap and keeps the switch-off', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pol-')); const a = new PolicyStore(dir);
    await a.addSpend('w', 12.4); await a.addSpend('w', 8);
    expect((await a.get('w')).spentCents).toBe(20);
    expect((await a.setRevoked('w', true)).revoked).toBe(true);
    expect((await a.get('w')).revoked).toBe(true);
    expect((await a.setRevoked('w', false)).revoked).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(dir, POLICY_FILE), 'utf8')).version).toBe(1);
  });
});

describe('the approval question', () => {
  const info = { worker: { id: 'w', name: 'Creative Director', kind: 'director' as const }, request: { capability: 'generate-media' as const, kind: 'spend' as const, label: 'Make a picture with AI', target: 'image', costCents: 4 }, why: 'No spending cap is set, so every paid action asks.', offer: ['once' as const] };
  it('names the worker, the action, the target and why, with No as the safe default', () => {
    const { options } = approvalBox(info);
    expect(options.message).toBe('Creative Director wants to: Make a picture with AI');
    expect(options.detail).toContain('On: image'); expect(options.detail).toContain('No spending cap'); expect(options.detail).toContain('$0.04');
    expect(options.buttons[options.defaultId]).toBe('No'); expect(options.cancelId).toBe(0);
  });
  it('offers "for this task" only when allowed, and maps buttons to answers', async () => {
    expect(approvalBox(info).options.buttons).toHaveLength(2);
    const two = approvalBox({ ...info, offer: ['once', 'task'] });
    expect(two.options.buttons).toHaveLength(3);
    expect(await nativeApprover(async () => ({ response: 2 }))({ ...info, offer: ['once', 'task'] })).toBe('task');
    expect(await nativeApprover(async () => ({ response: 1 }))(info)).toBe('once');
    expect(await nativeApprover(async () => ({ response: 0 }))(info)).toBe('deny');
    expect(await nativeApprover(async () => { throw new Error('closed'); })(info)).toBe('deny');
    expect(await nativeApprover(async () => ({ response: 7 }))(info)).toBe('deny');
  });
});

describe('which AI runs the work', () => {
  const base = { claudeReady: true, harnessProviders: ['openai'] as ('openai' | 'gemini' | 'local')[] };
  it('uses Claude unless told otherwise', () => { expect(chooseEngine({ ...base, chosen: 'claude' }).choice).toEqual({ engine: 'claude' }); });
  it('switches to the provider the owner chose', () => {
    expect(chooseEngine({ ...base, chosen: 'openai' }).choice).toEqual({ engine: 'harness', provider: 'openai' });
    expect(chooseEngine({ ...base, chosen: 'gemini' }).choice).toBeNull();
  });
  it('uses the harness for a program that works better there, otherwise Claude', () => {
    expect(chooseEngine({ ...base, chosen: 'claude', program: 'blender', harnessPrograms: ['blender'] }).choice).toEqual({ engine: 'harness', provider: 'openai' });
    expect(chooseEngine({ ...base, chosen: 'claude', program: 'photocraft', harnessPrograms: ['blender'] }).choice).toEqual({ engine: 'claude' });
    expect(chooseEngine({ ...base, harnessProviders: [], chosen: 'claude', program: 'blender', harnessPrograms: ['blender'] }).choice).toEqual({ engine: 'claude' });
  });
  it('says so when nothing can run', () => { expect(chooseEngine({ ...base, claudeReady: false, chosen: 'claude' })).toMatchObject({ choice: null }); });
  it('keeps every toolbox inside the capabilities that exist', () => { for (const c of Object.keys(toolboxFor('creative-director').ceiling)) expect(CAPABILITIES).toContain(c); });
});

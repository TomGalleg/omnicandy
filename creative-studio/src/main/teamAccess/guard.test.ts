import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, tool } from '../agentHarness/registry';
import { bindTask, defaultPolicy, delegate, type AccessPolicy } from '../../shared/teamAccess';
import { CLASSIFIED_TOOLS, classifyToolCall } from '../../shared/teamToolAccess';
import { ACTIVITY_FILE, activityLogger, readActivity } from './activityLog';
import { AccessGuard, type ActivityEntry, type GuardDeps } from './guard';

const worker = { id: 'creative', name: 'Creative Director', kind: 'director' as const };
const make = (policy: { p: AccessPolicy }, extra: Partial<GuardDeps> = {}) => {
  const log: ActivityEntry[] = [];
  const guard = new AccessGuard({ worker, chain: () => [policy.p], taskId: () => 't1', log: (e) => { log.push(e); }, ...extra });
  return { guard, log };
};
const bal = (): { p: AccessPolicy } => ({ p: bindTask(defaultPolicy('creative'), 't1') });

describe('every tool is classified, so none slips past the guard', () => {
  it('knows each tool the Claude panel has', async () => {
    const src = await readFile(path.join(__dirname, '..', 'claudePartner.ts'), 'utf8');
    const names = [...src.matchAll(/^\s{8}tool\('([a-z_]+)'/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(40);
    for (const n of names) expect(CLASSIFIED_TOOLS, n).toContain(n);
  });
  it('treats approval-tier commands as risky and refuses unknown tools', () => {
    expect(classifyToolCall('photocraft_command', { command: 'file.save' })?.kind).not.toBe('change');
    expect(classifyToolCall('unknown_tool', {})).toBeNull();
  });
});

describe('the guard at the point of execution', () => {
  it('lets Balanced do ordinary work and keeps a record', async () => {
    const { guard, log } = make(bal());
    const g = await guard.before('apply_edit', { edit_id: 'x' });
    expect(g.ok).toBe(true); if (g.ok) g.done(false);
    expect(log[0]).toMatchObject({ tool: 'apply_edit', verdict: 'allow', outcome: 'done', approvedBy: 'rule', taskId: 't1' });
  });
  it('refuses an unknown tool and a tool switched off', async () => {
    const s = bal(); s.p = { ...s.p, levels: { 'native-apps': 'none' } };
    const { guard, log } = make(s);
    expect((await guard.before('made_up', {})).ok).toBe(false);
    expect((await guard.before('apply_edit', {})).ok).toBe(false);
    expect(log.map((e) => e.outcome)).toEqual(['refused', 'refused']);
  });
  it('asks the owner for risky things, names the action, and honours no', async () => {
    const asked: string[] = [];
    const { guard, log } = make(bal(), { approve: async ({ request }) => { asked.push(request.label); return 'deny'; } });
    expect((await guard.before('generate_image', { prompt: 'dragon' })).ok).toBe(false);
    expect(asked).toEqual(['Make a picture with AI']);
    expect(log[0]).toMatchObject({ verdict: 'ask', outcome: 'refused' });
  });
  it('refuses what needs approval when there is no way to ask', async () => {
    expect((await make(bal()).guard.before('request_model_download', {})).ok).toBe(false);
  });
  it('uses up a one-time approval', async () => {
    let asks = 0;
    const { guard } = make(bal(), { approve: async () => { asks++; return 'once'; } });
    expect((await guard.before('generate_image', {})).ok).toBe(true);
    expect((await guard.before('generate_image', {})).ok).toBe(true);
    expect(asks).toBe(2);
  });
  it('remembers an approval for the task, but never for installs', async () => {
    let asks = 0;
    const s = bal(); s.p = { ...s.p, preset: 'supervised' };
    const { guard } = make(s, { approve: async ({ offer }) => { asks++; return offer.includes('task') ? 'task' : 'once'; } });
    await guard.before('apply_edit', {}); await guard.before('apply_edit', {});
    expect(asks).toBe(1);
    await guard.before('request_model_download', {}); await guard.before('request_model_download', {});
    expect(asks).toBe(3);
  });
  it('stops at the next action when the owner switches access off, and tells the run', async () => {
    const s = bal(); let stopped = 0;
    const { guard } = make(s, { onRevoked: () => { stopped++; } });
    expect((await guard.before('get_status', {})).ok).toBe(true);
    s.p = { ...s.p, revoked: true };
    expect((await guard.before('get_status', {})).ok).toBe(false);
    expect(stopped).toBe(1);
  });
  it('is not fooled by access being switched off while the owner was being asked', async () => {
    const s = bal(); s.p = { ...s.p, preset: 'supervised' };
    const { guard } = make(s, { approve: async () => { s.p = { ...s.p, revoked: true }; return 'once'; } });
    expect((await guard.before('apply_edit', {})).ok).toBe(false);
  });
  it('holds an expert to their director, including nested calls', async () => {
    const director = { p: { ...bal().p, preset: 'independent' as const } };
    const expert = delegate(director.p, 'expert', { levels: { 'native-apps': 'allow', 'read-project': 'allow' }, taskId: 't1' }, new Date());
    const g = new AccessGuard({ worker: { id: 'expert', name: 'Expert', kind: 'expert', parentId: 'creative' }, chain: () => [expert, director.p], taskId: () => 't1' });
    expect((await g.before('apply_edit', {})).ok).toBe(true);
    expect((await g.before('external_run', { app: 'blender', command: 'x' })).ok).toBe(false);
    director.p = { ...director.p, revoked: true };
    expect((await g.before('apply_edit', {})).ok).toBe(false);
  });
  it('refuses a tool outside the worker toolbox even when their level would allow it', async () => {
    const guard = new AccessGuard({ worker, chain: () => [bal().p], taskId: () => 't1', tools: ['get_status'] });
    expect((await guard.before('get_status', {})).ok).toBe(true);
    expect((await guard.before('apply_edit', {})).ok).toBe(false);
  });
  it('decides AI work by the AI Director\'s access, names the route, and stops when they are switched off', async () => {
    const own = bal(); const ai: { p: AccessPolicy } = { p: { ...bal().p, workerId: 'director:ai-director', preset: 'independent', spendCapCents: 500 } };
    const asked: Array<string | undefined> = [];
    const aiWorker = { id: 'director:ai-director', name: 'AI Director', kind: 'director' as const };
    const { guard, log } = make(own, { via: { worker: aiWorker, chain: () => [ai.p] }, approve: async ({ via }) => { asked.push(via?.name); return 'once'; } });
    // inside the AI Director's cap, an Independent AI Director allows it on its own, even though the requester would ask
    expect((await guard.before('generate_image', {})).ok).toBe(true);
    expect(asked).toEqual([]);
    ai.p = { ...ai.p, preset: 'supervised' };
    const g2 = await guard.before('generate_image', {}); expect(g2.ok).toBe(true); if (g2.ok) g2.done(false);
    expect(asked).toEqual(['AI Director']);
    expect(log.at(-1)).toMatchObject({ via: 'AI Director' });
    ai.p = { ...ai.p, revoked: true };
    const r = await guard.before('generate_image', {});
    expect(r.ok).toBe(false); expect(r.ok === false && r.text).toContain('AI Director is switched off');
    // other work is still decided by the requester's own access
    expect((await guard.before('apply_edit', {})).ok).toBe(true);
    // and a switched-off requester cannot use the AI Director either
    own.p = { ...own.p, revoked: true };
    ai.p = { ...ai.p, revoked: false, preset: 'independent' };
    expect((await guard.before('generate_image', {})).ok).toBe(false);
  });
  it('never lets a log problem decide an action', async () => {
    const guard = new AccessGuard({ worker, chain: () => [bal().p], taskId: () => 't1', log: () => { throw new Error('disk full'); } });
    const g = await guard.before('get_status', {}); expect(g.ok).toBe(true); if (g.ok) g.done(false);
  });
});

describe('the agent harness registry', () => {
  it('is unchanged with no guard', async () => {
    const r = new ToolRegistry([tool('apply_edit', 'x', z.object({}), async () => 'done')]);
    expect((await r.call(r.snapshot(), 'apply_edit', {})).isError).toBeUndefined();
  });
  it('refuses at the boundary before the tool runs', async () => {
    const ran: string[] = [];
    const s = bal(); s.p = { ...s.p, levels: { 'native-apps': 'read' } };
    const r = new ToolRegistry([tool('get_status', 'x', z.object({}), async () => { ran.push('get_status'); return 'ok'; }), tool('apply_edit', 'x', z.object({}), async () => { ran.push('apply_edit'); return 'done'; })]);
    r.setGuard(make(s).guard);
    expect((await r.call(r.snapshot(), 'apply_edit', {})).isError).toBe(true);
    expect((await r.call(r.snapshot(), 'get_status', {})).isError).toBeUndefined();
    expect(ran).toEqual(['get_status']);
  });
  it('logs what happened, including a failure', async () => {
    const { guard, log } = make(bal());
    const r = new ToolRegistry([tool('apply_edit', 'x', z.object({}), async () => { throw new Error('boom'); })]); r.setGuard(guard);
    await r.call(r.snapshot(), 'apply_edit', {});
    expect(log[0]).toMatchObject({ outcome: 'failed', note: 'boom' });
  });
});

describe('the activity log file', () => {
  it('appends one line per action and reads them back, skipping damage', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'act-')); const w = activityLogger(dir);
    const e = (t: string): ActivityEntry => ({ at: 'now', workerId: 'w', worker: 'W', tool: t, label: t, verdict: 'allow', why: 'ok', outcome: 'done' });
    await w(e('a')); await w(e('b'));
    await appendFile(path.join(dir, ACTIVITY_FILE), 'not json\n');
    expect((await readActivity(dir)).map((x) => x.tool)).toEqual(['a', 'b']);
    expect(await readActivity(path.join(dir, 'none'))).toEqual([]);
  });
});

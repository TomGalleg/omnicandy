import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyQueue, type BuildQueue } from '../../shared/buildQueue';
import type { DirectorOutcome } from '../../shared/directorToolbox';
import type { PlanTask } from '../../shared/planner';
import { BuildRunner, loadQueue, QUEUE_FILE, saveQueue } from './buildRunner';

let n = 0;
const task = (title: string, director: string | null, o: Partial<PlanTask> = {}): PlanTask => ({
  id: `t${++n}`, title, description: '', status: 'todo', priority: 'normal', parentId: null, dependsOn: [], completionChecks: [], expectedOutputs: [], assetIds: [], milestoneId: null, appRef: null,
  assignee: director, packageId: null, claim: null, progressNote: '', rev: 1, createdAt: '', updatedAt: '', createdBy: { kind: 'user', name: 'You' }, ...o,
});
const made = (): DirectorOutcome => ({ status: 'made', summary: 'made it', files: [{ name: 'a.png', exists: true, bytes: 5 }], said: '' });

function rig(tasks: PlanTask[], run: (t: PlanTask, d: string, signal: AbortSignal) => Promise<DirectorOutcome>) {
  const events: BuildQueue[] = []; let saved: BuildQueue | null = null;
  const runner = new BuildRunner({
    tasks: async () => tasks, works: (d) => d !== 'quality-director' && d !== 'general-manager',
    // a finished task becomes "reported" in the plan, as the real hand-over does
    runTask: async (t, d, s) => { const o = await run(t, d, s); if (o.status === 'made') tasks.splice(tasks.findIndex((x) => x.id === t.id), 1, { ...t, status: 'reported' }); return o; },
    load: async () => saved ?? emptyQueue(), save: async (q) => { saved = q; }, emit: (q) => events.push(q),
  });
  return { runner, events, saved: () => saved };
}

describe('the build, one task at a time', () => {
  it('does the tasks in the order given, one after the other, then says it is done', async () => {
    const a = task('Brief', 'creative-director'); const b = task('Art', 'creative-director'); const c = task('Prompt', 'ai-director');
    const seen: string[] = []; let active = 0; let most = 0;
    const { runner } = rig([a, b, c], async (t) => { active++; most = Math.max(most, active); seen.push(t.title); await new Promise((r) => setTimeout(r, 5)); active--; return made(); });
    await runner.start([c.id, a.id, b.id], 'Prompt first.'); await runner.settled();
    expect(seen).toEqual(['Prompt', 'Brief', 'Art']); expect(most).toBe(1);
    expect(await runner.state()).toMatchObject({ status: 'done', finished: [c.id, a.id, b.id] });
  });

  it('waits for a task\'s need: the order is followed, but never ahead of what it needs', async () => {
    const brief = task('Brief', 'creative-director'); const art = task('Art', 'creative-director', { dependsOn: [brief.id] });
    const seen: string[] = []; const { runner } = rig([brief, art], async (t) => { seen.push(t.title); return made(); });
    await runner.start([art.id, brief.id], 'x'); await runner.settled();
    // the Art task came first in the order, but it needs the brief: the first it can do is the brief, then the art
    expect(seen).toEqual(['Brief', 'Art']);
  });

  it('stops and flags the owner when a task could not be made', async () => {
    const a = task('Brief', 'creative-director'); const b = task('Art', 'creative-director'); const seen: string[] = [];
    const { runner } = rig([a, b], async (t) => { seen.push(t.title); return { status: 'nothing-made', summary: 'Creative Director did not make anything.', files: [], said: '' }; });
    await runner.start([a.id, b.id], 'x'); await runner.settled();
    expect(seen).toEqual(['Brief']);
    expect(await runner.state()).toMatchObject({ status: 'waiting', waiting: { taskId: a.id, director: 'creative-director', message: 'Creative Director did not make anything.' } });
  });

  it('flags the owner for a task that needs a conversation, after doing the ones before it', async () => {
    const a = task('Art', 'creative-director'); const q = task('Quality pass', 'quality-director'); const seen: string[] = [];
    const { runner } = rig([a, q], async (t) => { seen.push(t.title); return made(); });
    await runner.start([a.id, q.id], 'x'); await runner.settled();
    expect(seen).toEqual(['Art']);
    expect(await runner.state()).toMatchObject({ status: 'waiting', waiting: { director: 'quality-director' } });
  });

  it('carries on from where it stopped after a flag', async () => {
    const a = task('Art', 'creative-director'); const b = task('Check', 'quality-director'); const c = task('More art', 'creative-director'); const seen: string[] = [];
    const tasks = [a, b, c];
    const { runner } = rig(tasks, async (t) => { seen.push(t.title); return made(); });
    await runner.start([a.id, b.id, c.id], 'x'); await runner.settled();
    expect((await runner.state()).status).toBe('waiting');
    tasks.splice(1, 1, { ...b, status: 'accepted' }); // the owner dealt with it in the quality office
    await runner.resume(); await runner.settled();
    expect(seen).toEqual(['Art', 'More art']); expect((await runner.state()).status).toBe('done');
  });

  it('pauses after the current task, and stop cancels the one being worked on', async () => {
    const a = task('A', 'creative-director'); const b = task('B', 'creative-director'); const seen: string[] = [];
    const first = rig([a, b], async (t) => { seen.push(t.title); await new Promise((r) => setTimeout(r, 20)); return made(); });
    await first.runner.start([a.id, b.id], 'x'); await first.runner.pause(); await first.runner.settled();
    expect(seen).toEqual(['A']); expect((await first.runner.state()).status).toBe('paused');
    const c = task('C', 'creative-director'); let sawAbort = false;
    const second = rig([c], async (_t, _d, signal) => { await new Promise<void>((res) => signal.addEventListener('abort', () => { sawAbort = true; res(); })); return { status: 'stopped', summary: 'stopped', files: [], said: '' }; });
    await second.runner.start([c.id], 'x'); await new Promise((r) => setTimeout(r, 5)); await second.runner.stop(); await second.runner.settled();
    expect(sawAbort).toBe(true); expect((await second.runner.state()).status).toBe('paused');
  });

  it('treats a crash as "could not be made", never as done', async () => {
    const a = task('A', 'creative-director');
    const { runner } = rig([a], async () => { throw new Error('network down'); });
    await runner.start([a.id], 'x'); await runner.settled();
    expect(await runner.state()).toMatchObject({ status: 'waiting', waiting: { message: 'network down' } });
  });

  it('cannot loop forever on a task that reported but is still open', async () => {
    const a = task('A', 'creative-director'); let runs = 0;
    const events: BuildQueue[] = []; let saved: BuildQueue | null = null;
    const runner = new BuildRunner({ tasks: async () => [a], works: () => true, runTask: async () => { runs++; return made(); }, load: async () => saved ?? emptyQueue(), save: async (q) => { saved = q; }, emit: (q) => events.push(q) });
    await runner.start([a.id], 'x'); await runner.settled();
    expect(runs).toBe(1); expect(await runner.state()).toMatchObject({ status: 'waiting', waiting: { taskId: a.id } });
  });

  it('refuses a second build while one runs, and an empty one', async () => {
    const a = task('A', 'creative-director');
    const { runner } = rig([a], async () => { await new Promise((r) => setTimeout(r, 30)); return made(); });
    await runner.start([a.id], 'x');
    await expect(runner.start([a.id], 'x')).rejects.toThrow(/already running/);
    await runner.settled();
    await expect(runner.start([], 'x')).rejects.toThrow(/no open tasks/);
  });
});

describe('the saved queue', () => {
  it('survives a restart, comes back paused if it was running, and ignores a damaged file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bq-'));
    expect(await loadQueue(dir)).toEqual(emptyQueue());
    await saveQueue(dir, { ...emptyQueue(), status: 'running', order: ['t1'], current: 't1' });
    expect(await loadQueue(dir)).toMatchObject({ status: 'paused', order: ['t1'] });
    await saveQueue(dir, { ...emptyQueue(), status: 'waiting', order: ['t1'], waiting: { taskId: 't1', director: 'creative-director', message: 'm' } });
    expect((await loadQueue(dir)).status).toBe('waiting');
    await writeFile(path.join(dir, QUEUE_FILE), '{ nope'); expect(await loadQueue(dir)).toEqual(emptyQueue());
  });
});

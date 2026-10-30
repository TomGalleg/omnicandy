// Works through the build queue, one task at a time, in the order the Production Director set. Each task is done by its director through the same guarded run as
// everywhere else (see directorRun.ts); when one finishes the next starts, with no need for the owner. It stops and flags the owner when a task could not be made, when
// the next one is a job that needs a conversation, or when the owner pauses it. Nothing here decides what is allowed: the guard still checks every action.
import fs from 'node:fs/promises';
import path from 'node:path';
import { emptyQueue, nextStep, type BuildQueue } from '../../shared/buildQueue';
import type { DirectorOutcome } from '../../shared/directorToolbox';
import type { PlanTask } from '../../shared/planner';
import type { DirectorKey } from '../../shared/town';
import { writeJsonAtomic } from '../projectStore';

export const QUEUE_FILE = 'build-queue.json';

export async function loadQueue(dir: string): Promise<BuildQueue> {
  try {
    const q = JSON.parse(await fs.readFile(path.join(dir, QUEUE_FILE), 'utf8')) as Partial<BuildQueue>;
    if (q.version !== 1 || !Array.isArray(q.order) || !Array.isArray(q.finished)) return emptyQueue();
    const loaded = q as BuildQueue;
    // Nothing runs while OmniCandy is closed: a build that was running comes back paused, ready to carry on.
    return loaded.status === 'running' ? { ...loaded, status: 'paused', current: undefined, why: 'OmniCandy was closed, so the build was paused.' } : loaded;
  } catch { return emptyQueue(); }
}
export const saveQueue = (dir: string, q: BuildQueue) => writeJsonAtomic(path.join(dir, QUEUE_FILE), q);

export interface RunnerDeps {
  tasks: () => Promise<PlanTask[]>;
  /** Whether this director makes files on their own (so can do a task without the owner). */
  works: (d: DirectorKey) => boolean;
  runTask: (task: PlanTask, director: DirectorKey, signal: AbortSignal) => Promise<DirectorOutcome>;
  load: () => Promise<BuildQueue>;
  save: (q: BuildQueue) => Promise<void>;
  emit: (q: BuildQueue) => void;
  now?: () => Date;
}

export class BuildRunner {
  private q: BuildQueue | null = null;
  private running: Promise<void> | null = null;
  private pauseRequested = false;
  private abort: AbortController | null = null;
  constructor(private readonly d: RunnerDeps) {}

  async state(): Promise<BuildQueue> { return (this.q ??= await this.d.load()); }
  /** Resolves when the current run of the queue has stopped (for tests and for stop-then-restart). */
  settled(): Promise<void> { return this.running ?? Promise.resolve(); }

  private async set(patch: Partial<BuildQueue>) {
    const next = { ...(await this.state()), ...patch } as BuildQueue;
    for (const k of Object.keys(patch) as Array<keyof BuildQueue>) if (patch[k] === undefined) delete (next as unknown as Record<string, unknown>)[k];
    this.q = next;
    try { await this.d.save(next); } catch { /* the build goes on; only the saved copy is behind */ }
    this.d.emit(next);
  }

  /** Starts a new build with this order. Refused while one is running. */
  async start(order: string[], why: string): Promise<BuildQueue> {
    const cur = await this.state();
    if (cur.status === 'running') throw new Error('A build is already running. Pause it first.');
    if (order.length === 0) throw new Error('There are no open tasks to build.');
    await this.set({ status: 'running', order, finished: [], waiting: undefined, current: undefined, why, startedAt: (this.d.now?.() ?? new Date()).toISOString() });
    this.launch();
    return this.q!;
  }

  /** Carry on after a pause or a flag: the same order, from the first task still open. */
  async resume(): Promise<BuildQueue> {
    const cur = await this.state();
    if (cur.status === 'running') return cur;
    if (cur.order.length === 0) throw new Error('There is nothing to carry on with.');
    await this.set({ status: 'running', waiting: undefined });
    this.launch();
    return this.q!;
  }

  /** Stops after the task being worked on finishes. */
  async pause(): Promise<BuildQueue> { this.pauseRequested = true; return this.state(); }

  /** Stops now: the task being worked on is cancelled. */
  async stop(): Promise<BuildQueue> { this.pauseRequested = true; this.abort?.abort(); return this.state(); }

  private launch() {
    this.pauseRequested = false;
    this.running = this.loop().catch(async (e) => { await this.set({ status: 'waiting', current: undefined, waiting: { taskId: '', director: 'general-manager', message: `The build stopped: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) } }); }).finally(() => { this.running = null; });
  }

  private async loop(): Promise<void> {
    for (;;) {
      const q = await this.state();
      if (this.pauseRequested) { await this.set({ status: 'paused', current: undefined }); return; }
      const step = nextStep(q.order, await this.d.tasks(), this.d.works);
      if (step.kind === 'done') { await this.set({ status: 'done', current: undefined, waiting: undefined }); return; }
      if (step.kind === 'wait') { await this.set({ status: 'waiting', current: undefined, waiting: { taskId: step.task.id, director: step.director, message: step.message } }); return; }
      if (q.finished.includes(step.task.id)) {
        await this.set({ status: 'waiting', current: undefined, waiting: { taskId: step.task.id, director: step.director, message: `"${step.task.title}" was reported but is still open in the plan. Open it and check what happened.` } }); return;
      }
      await this.set({ status: 'running', current: step.task.id, waiting: undefined });
      const ctrl = new AbortController(); this.abort = ctrl;
      let outcome: DirectorOutcome;
      try { outcome = await this.d.runTask(step.task, step.director, ctrl.signal); } catch (e) { outcome = { status: 'failed', summary: e instanceof Error ? e.message : String(e), files: [], said: '' }; }
      this.abort = null;
      if (outcome.status === 'made') { await this.set({ current: undefined, finished: [...(await this.state()).finished, step.task.id] }); continue; }
      if (ctrl.signal.aborted) { await this.set({ status: 'paused', current: undefined }); return; }
      await this.set({ status: 'waiting', current: undefined, waiting: { taskId: step.task.id, director: step.director, message: outcome.summary } });
      return;
    }
  }
}

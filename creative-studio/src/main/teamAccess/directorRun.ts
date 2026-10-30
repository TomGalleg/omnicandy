// One director doing one task: the same steps whichever AI engine runs it. Set up the worker's access (the owner's settings, never above the toolbox), brief the
// AI in plain words, let it work through the guarded tools, then CHECK what it says it made: a result is "made" only when the files really exist. The AI's own
// words never count as proof. The outcome goes back to the plan as a report that needs review; only the owner accepts it.
import { bindTask } from '../../shared/teamAccess';
import { toolboxFor, type DirectorOutcome, type MadeFile } from '../../shared/directorToolbox';
import { DIRECTORS, type DirectorKey } from '../../shared/town';
import { AccessGuard, type ActivityEntry, type GuardDeps } from './guard';
import type { PolicyStore } from './policyStore';

export interface DirectorTask { id: string; title: string; detail?: string }
export type { DirectorOutcome, MadeFile };
export interface Engine { run(input: { prompt: string; guard: AccessGuard; stop: AbortSignal }): Promise<{ text: string }> }
export interface DirectorRunDeps {
  store: PolicyStore;
  engine: Engine;
  approve?: GuardDeps['approve'];
  log?: (e: ActivityEntry) => void | Promise<void>;
  /** Names of the files in the project library right now, and whether each exists (read from the project itself, not from the AI). */
  library: () => Promise<MadeFile[]>;
  /** Before anything starts: takes the task in the plan, so nobody else does it. If this throws, nothing runs. */
  begin?: (task: DirectorTask) => Promise<void>;
  /** Puts the outcome in the plan as a report that needs review. */
  handOver?: (task: DirectorTask, o: DirectorOutcome) => Promise<void>;
  now?: () => Date;
}

export const directorWorkerId = (key: DirectorKey) => `director:${key}`;

/** What the AI is told: its job, the task, and the rules it works under. Plain words; the rules are enforced by the guard whatever this says. */
export function briefing(key: DirectorKey, task: DirectorTask): string {
  const d = DIRECTORS.find((x) => x.key === key)!;
  const tb = toolboxFor(key);
  return [
    `You are the ${d.title} in the owner's OmniTown. ${d.job}`,
    `Your tools: ${tb.does}`,
    `Your task: ${task.title}${task.detail ? `\n${task.detail}` : ''}`,
    'To make pictures, first call list_image_models to see which AI makers can run right now, choose from that list, and tell the owner which one you chose and why.',
    'Work only on this task. Some actions ask the owner first; if they say no, accept it and say so. If a tool is refused, do not look for a way round it.',
    'Say only what you really did. Do not say something is made unless a tool confirmed it. The owner decides whether it is accepted.',
  ].join('\n\n');
}

export async function runDirector(deps: DirectorRunDeps, key: DirectorKey, task: DirectorTask, stop: AbortSignal = new AbortController().signal): Promise<DirectorOutcome> {
  const workerId = directorWorkerId(key);
  const d = DIRECTORS.find((x) => x.key === key)!;
  const box = toolboxFor(key);
  const ceiling = box.ceiling;
  // Read the saved policy fresh on every call, so switching the worker off stops the very next action.
  const chain = async () => bindTask(await deps.store.get(workerId, ceiling, box.preset), task.id);
  const first = await chain();
  if (first.revoked) return { status: 'stopped', summary: `${d.title}'s access is switched off, so nothing was started.`, files: [], said: '' };

  await deps.begin?.(task);
  const before = new Set((await deps.library()).map((f) => f.name));
  const abort = new AbortController();
  const onStop = () => abort.abort(); stop.addEventListener('abort', onStop);
  const guard = new AccessGuard({
    worker: { id: workerId, name: d.title, kind: 'director', director: key },
    chain: async () => [await chain()],
    taskId: () => task.id,
    tools: box.tools,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.approve ? { approve: deps.approve } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    onRevoked: () => abort.abort(),
  });

  let said = ''; let failed: string | null = null;
  try { said = (await deps.engine.run({ prompt: briefing(key, task), guard, stop: abort.signal })).text; }
  catch (e) { failed = e instanceof Error ? e.message : String(e); }
  finally { stop.removeEventListener('abort', onStop); }

  const files = (await deps.library()).filter((f) => !before.has(f.name));
  const real = files.filter((f) => f.exists && f.bytes > 0);
  let outcome: DirectorOutcome;
  if (abort.signal.aborted && real.length === 0) outcome = { status: 'stopped', summary: `${d.title} was stopped before making anything.`, files, said };
  else if (failed && real.length === 0) outcome = { status: 'failed', summary: `${d.title} could not finish: ${failed.slice(0, 200)}`, files, said };
  else if (real.length === 0) outcome = { status: 'nothing-made', summary: `${d.title} did not make anything that could be found in the project. Nothing was added.`, files, said };
  else outcome = { status: 'made', summary: `${d.title} made ${real.length === 1 ? `"${real[0]!.name}"` : `${real.length} files`}, and ${real.length === 1 ? 'it is' : 'they are'} in the project. Please review ${real.length === 1 ? 'it' : 'them'}.`, files, said };

  if (deps.handOver) { try { await deps.handOver(task, outcome); } catch { /* the outcome is still returned; the owner sees it */ } }
  return outcome;
}

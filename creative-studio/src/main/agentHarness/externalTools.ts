import { compactParameterHints } from '../commandDiscovery';
import { preflightExternalParams, classifyCommandError } from './commandPreflight';
import { z } from 'zod';
import { inspectExternalCommand } from '@shared/commandCapabilityInspection';
import type { CommandSpec, JobInfo } from '@shared/integrations';
import type { IntegrationManager } from '../integrations/manager';
import { isTrustedReadbackCommand, isViewOnlyCommand } from '../integrations/readback';
import fs from 'node:fs/promises';
import { tool, ToolRegistry } from './registry';

/** The only external execution backend is IntegrationManager: never bypass its approval and policy checks. */
type ExternalBackend = Pick<IntegrationManager, 'list' | 'execute'> & Partial<Pick<IntegrationManager, 'job' | 'jobs' | 'cancelJob' | 'isBuiltin'>>;
export interface ExternalToolOptions {
  /** Reports a job launched by the agent so the host can cancel it and remember it across restarts. Awaited before the result is returned. */
  onJobStarted?: (job: { jobId: string; appKey: string; commandId: string }) => void | Promise<void>;
  /** Returns a reason when this command must not be launched again (a job of this agent that was never seen to finish). */
  jobGuard?: (appKey: string, commandId: string) => string | undefined;
  /** Formats a job for the model (the host may also bring finished outputs into the library). Defaults to a plain summary. */
  describeJob?: (jobId: string, cancel: boolean) => Promise<string>;
  /** The model can see images: only then may a preview command (a picture of the application) run. */
  supportsVision?: boolean;
  /** Claude-style discovery: external_apps lists the applications and, with an app_key, that application's commands and settings; no separate command search. */
  claudeStyle?: boolean;
}
/** Cost and privacy limits for pictures of an application: per task, between pictures, and the size sent to the model. */
export const MAX_PREVIEWS_PER_TASK = 6;
export const MIN_PREVIEW_INTERVAL_MS = 2000;
export const MAX_PREVIEW_BYTES = 2_000_000;
export const MAX_PREVIEW_SIDE = 1024;
const empty = z.object({}).strict();
const identifier = z.string().min(1).max(1024);
const argsSchema = z.record(z.string().min(1).max(128), z.unknown());
const usable = (status: string) => status === 'connected' || status === 'limited';
/** A closed application is still offered when it has commands that work closed (making its project, starting it). */
const closedButUsable = (app: { status: string; commands?: Array<{ offline?: boolean }> }) => (app.status === 'api-unavailable' || app.status === 'not-running') && !!app.commands?.some((c) => c.offline === true);
const normKey = (s: string) => s.trim().toLowerCase().replace(/[\\/]+/g, '\\');
type AppRef = { key: string; name: string; adapterId?: string | null; status: string; statusDetail?: string };
/**
 * Finds the application a model meant. A key is a long Windows path that models routinely mangle (case, slashes, JSON
 * escaping), so besides the exact key a unique match on the normalized key, the adapter id or the name is accepted.
 * A failure says what is really wrong: an unknown reference lists the connected applications; only an application that
 * really is not connected is reported as disconnected (and asks the agent to stop, since nothing can run until the user acts).
 */
export function resolveApplication<T extends AppRef>(all: readonly T[], ref: string): { app: T } | { error: string } {
  const live = all.filter((a) => (usable(a.status) || closedButUsable(a as { status: string; commands?: Array<{ offline?: boolean }> })) && !!a.adapterId);
  const want = normKey(ref);
  const pick = (pool: readonly T[]) => {
    const exact = pool.filter((a) => a.key === ref);
    if (exact.length === 1) return exact;
    for (const test of [(a: T) => normKey(a.key) === want, (a: T) => (a.adapterId ?? '').toLowerCase() === want, (a: T) => a.name.toLowerCase() === want]) {
      const hit = pool.filter(test);
      if (hit.length) return hit;
    }
    return [];
  };
  const hit = pick(live);
  if (hit.length === 1) return { app: hit[0]! };
  if (hit.length > 1) return { error: `Invalid parameter app_key: "${ref}" matches several connected applications. Use one key exactly as external_apps lists it: ${hit.map((a) => JSON.stringify(a.key)).join(', ')}.` };
  const down = pick(all);
  if (down.length === 1) return { error: `${down[0]!.name} is not connected (status: ${down[0]!.status}${down[0]!.statusDetail ? `; ${down[0]!.statusDetail}` : ''}). Stop and wait for the user to reconnect it.` };
  return { error: live.length
    ? `Invalid parameter app_key: no connected application matches "${ref}". Connected: ${live.map((a) => `${a.name} (key ${JSON.stringify(a.key)})`).join('; ')}. Use a key exactly as external_apps lists it, or the application name. This is not a lost connection.`
    : 'No external application is connected. Stop and wait for the user to connect one.' };
}
/** Host trust decision lives in integrations/readback.ts: built-in adapters and explicitly listed read-only commands only. */
export const isTrustedExternalReadback = isTrustedReadbackCommand;

/** Compact map of a large result (keys, array lengths) so the model can choose evidence_verify paths without the whole state in context. */
export function outline(value: unknown, depth = 3): unknown {
  if (Array.isArray(value)) return { items: value.length, ...(value.length && depth > 0 ? { first: outline(value[0], depth - 1) } : {}) };
  if (value && typeof value === 'object') return depth <= 0 ? '{…}' : Object.fromEntries(Object.entries(value).slice(0, 40).map(([k, v]) => [k, outline(v, depth - 1)]));
  return typeof value;
}
const MAX_MODEL_TEXT = 6000;
const MAX_READBACK_BYTES = 1_000_000;

const summary = (j: JobInfo) => ({ job_id: j.id, app: j.appName, command: j.commandId, status: j.status, stage: j.stage, progress: j.fraction, started: j.startedAt, finished: j.finishedAt });

export function externalTools(backend: ExternalBackend, options: ExternalToolOptions = {}) {
  const list = async () => (await backend.list()).filter(app => (usable(app.status) || closedButUsable(app)) && !!app.adapterId);
  const resolve = async (ref: string) => resolveApplication(await backend.list(), ref);
  const trusted = (adapterId: string | null | undefined, spec: CommandSpec) => isTrustedExternalReadback(backend.isBuiltin?.bind(backend), adapterId, spec);
  const viewOnly = (adapterId: string | null | undefined, spec: CommandSpec) => isViewOnlyCommand(backend.isBuiltin?.bind(backend), adapterId, spec);
  let previews = 0;
  let lastPreview = 0;
  const tools = [
    tool('external_apps', 'List already-connected external applications and their names. Only connected applications may be controlled.', empty, async () =>
      JSON.stringify((await list()).map(app => ({ key: app.key, name: app.name, status: app.status, adapter: app.adapterName })))),
    tool('external_commands', 'Search command identifiers for a connected external application, or inspect complete parameter and permission details by exact command_id before executing.',
      z.object({ app_key: identifier, filter: z.string().max(100).optional(), command_id: z.string().max(128).optional() }).strict(), async ({ app_key, filter, command_id }) => {
        const found = await resolve(app_key);
        if ('error' in found) throw new Error(found.error);
        const app = found.app;
        if (command_id) {
          const spec = app.commands.find(c => c.id === command_id);
          if (!spec) throw new Error('Command is not advertised by this app. Search external_commands again.');
          return JSON.stringify({ app: app.name, command: spec, capabilityInspection: inspectExternalCommand(spec), trustedReadback: trusted(app.adapterId, spec) });
        }
        const q = (filter ?? '').trim().toLowerCase();
        const matches = app.commands.filter(c => c.id && (!q || `${c.id} ${c.label} ${c.description}`.toLowerCase().includes(q)));
        return JSON.stringify({ app: app.name, total: matches.length,
          commands: matches.slice(0, 40).map(c => ({ id: c.id, label: c.label, description: c.description.slice(0, 100),
            parameterHints: compactParameterHints(c.params), requiresInspection: true })),
          next: matches.length > 40 ? 'Refine filter to see other matching commands.' : undefined });
      }),
    {
      ...tool('external_command', 'Execute an inspected command in a connected external app. Inspect with external_commands command_id first. Long-running commands start a background job: follow it with external_job. The integration manager enforces user approvals and all existing security policies. A command marked trustedReadback in its inspection returns state that evidence_verify can compare.',
        z.object({ app_key: identifier, command: z.string().min(1).max(128), params: argsSchema.optional() }).strict(), async ({ app_key, command, params }) => {
          // Recheck on every call: connected status, adapter and command availability may have changed since advertisement.
          const found = await resolve(app_key);
          if ('error' in found) throw new Error(found.error);
          const app = found.app;
          app_key = app.key; // whatever the model called it, the backend, the job ledger and the guards see the real key
          const spec = app.commands.find(c => c.id === command);
          if (!spec) throw new Error('Command is not advertised by this connected app. Run external_commands again.');
          if (spec.longRunning) {
            // A job that is still running (also one started before an interruption or by an earlier attempt) is never launched twice.
            const running = (backend.jobs?.() ?? []).find(j => j.status === 'running' && j.appKey === app_key && j.commandId === command);
            const guard = options.jobGuard?.(app_key, command);
            if (guard) throw new Error(`${guard} It must be checked with external_job and the application state before any new launch; it will not be launched again blindly.`);
            if (running) throw new Error(`Job ${running.id} for this command is already running; it must be followed with external_job instead of being launched again.`);
          }
          const problem = preflightExternalParams(spec, params ?? {});
          if (problem) throw new Error(`validation: ${problem}`);
          const preview = spec.preview === true && viewOnly(app.adapterId, spec);
          if (preview) {
            // Pictures cost tokens and show the user's work to the model provider: only for models that can see, and rationed.
            if (!options.supportsVision) throw new Error('This model cannot see images, so no picture was taken. Continue with structured inspection (for Blender: scene.inspect_detail).');
            if (previews >= MAX_PREVIEWS_PER_TASK) throw new Error(`Picture limit reached (${MAX_PREVIEWS_PER_TASK} per task). Continue with structured inspection (scene.inspect_detail).`);
            if (Date.now() - lastPreview < MIN_PREVIEW_INTERVAL_MS) throw new Error('Pictures are limited to one every few seconds. Inspect the structured state first, then ask again.');
            previews++;
            lastPreview = Date.now();
          }
          const result = await backend.execute(app_key, command, params ?? {}, { background: spec.longRunning === true });
          const payload = { ok: result.ok, verified: result.verified, message: result.message,
            evidence: result.evidence, outputs: result.outputs, data: result.data, error: result.error };
          if (!result.ok) {
            const detail = result.error?.message && result.error.message !== result.message ? ` ${result.error.message}` : '';
            const category = classifyCommandError(`${result.error?.kind ?? ''} ${result.message} ${detail}`);
            throw new Error(`${category} (${result.error?.kind ?? 'app-error'}): ${result.message}${detail}`);
          }
          if (preview) {
            const image = (result.data?.image ?? {}) as { path?: unknown; width?: unknown; height?: unknown };
            const file = typeof image.path === 'string' ? image.path : '';
            let png: Buffer | undefined;
            try { png = file ? await fs.readFile(file) : undefined; } finally { if (file) await fs.rm(file, { force: true }).catch(() => undefined); } // pictures are temporary
            const w = Number(image.width), h = Number(image.height);
            if (!png || png.length < 8 || png.length > MAX_PREVIEW_BYTES || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || !(w > 0 && h > 0 && Math.max(w, h) <= MAX_PREVIEW_SIDE))
              throw new Error('The application returned no usable picture (missing, not a PNG, or larger than the limits). Use structured inspection.');
            const data = { ...(result.data ?? {}), image: { width: w, height: h, bytes: png.length } };
            return { text: JSON.stringify({ ok: true, message: result.message, data, note: 'A picture of the open application follows. It is NOT proof of saved state: verify with a structured read-back.' }), verified: false, imageDataUrl: `data:image/png;base64,${png.toString('base64')}` };
          }
          const jobId = typeof result.data?.jobId === 'string' ? result.data.jobId : undefined;
          if (spec.longRunning && jobId) await options.onJobStarted?.({ jobId, appKey: app_key, commandId: command });
          const full = JSON.stringify(payload);
          // `verified` is the command's own claim. Only a host-trusted read-only command yields a read-back receipt.
          if (!trusted(app.adapterId, spec)) return { text: full, verified: result.verified === true };
          if (full.length > MAX_READBACK_BYTES)
            return { text: JSON.stringify({ ok: true, message: result.message, note: `The state is too large to compare (${full.length} bytes); it cannot be used as verification evidence. Request a narrower inspection if the command allows it.` }), verified: false };
          // The complete state is kept for evidence_verify (host side); the model sees the whole text when small, otherwise an outline.
          const text = full.length <= MAX_MODEL_TEXT ? full
            : JSON.stringify({ ok: true, message: result.message, note: `Large state (${full.length} bytes) retained in full for evidence_verify; compare fields by path under data.*.`, outline: outline(payload.data) });
          return { text, verified: result.verified === true, trustedReadback: true, readback: payload };
        }),
      readOnly: async (raw: unknown) => {
        const parsed = z.object({ app_key: identifier, command: z.string().min(1).max(128) }).passthrough().safeParse(raw);
        if (!parsed.success) return false;
        const found = await resolve(parsed.data.app_key);
        const app = 'app' in found ? found.app : undefined;
        const spec = app?.commands.find(c => c.id === parsed.data.command);
        return !!app && !!spec && (trusted(app.adapterId, spec) || viewOnly(app.adapterId, spec));
      },
    },
  ];
  // Offered only when the backend can really track jobs, so the model is never told about a tool that cannot work.
  const getJob = backend.job?.bind(backend);
  const getJobs = backend.jobs?.bind(backend);
  if (getJob && getJobs) tools.push(
    tool('external_job', 'Status, progress and result of a background external job, or cancel it. With no job_id it lists the jobs. A job is finished only when status is succeeded, failed or cancelled; report its result exactly. A finished job does not prove the goal: read the resulting state back before claiming success.',
      z.object({ job_id: z.string().min(1).max(100).optional(), cancel: z.boolean().optional() }).strict(), async ({ job_id, cancel }) => {
        if (!job_id) return JSON.stringify(getJobs().slice(0, 20).map(summary));
        if (options.describeJob) return options.describeJob(job_id, cancel === true);
        if (cancel) backend.cancelJob?.(job_id);
        const j = getJob(job_id);
        if (!j) return JSON.stringify({ error: 'No such job (jobs do not survive an application restart). Check the application state before starting it again.', jobs: getJobs().slice(0, 20).map(summary) });
        return JSON.stringify({ ...summary(j), result: j.result });
      })
  );
  if (!options.claudeStyle) return tools;
  // Claude-style: one discovery tool, the same wording Claude's own panel works from.
  const apps = tool('external_apps', 'External third-party software (Blender, Autodesk, Adobe and others) that is connected, and what it can do. With no app_key: the connected applications. With an app_key: that application\'s commands and the settings each takes. Only commands listed here exist. Read this before running anything.',
    z.object({ app_key: identifier.optional() }).strict(), async ({ app_key }) => {
      const all = await backend.list();
      if (!app_key) return JSON.stringify({ applications: all.filter(a => !!a.adapterId).map(a => ({ app_key: a.key, name: a.name, status: a.status, commands: a.commands.length })), next: 'Call external_apps with an app_key to see that application\'s commands and settings.' });
      const found = resolveApplication(all, app_key);
      if ('error' in found) throw new Error(found.error);
      const a = found.app;
      // Plain lines, not JSON: no quoting overhead, so every command fits in one model-visible answer.
      const nl = String.fromCharCode(10);
      // The commands to reach for first come first; a model reads a list from the top.
      const rank = (id: string) => { const i = PREFERRED_COMMANDS.indexOf(id); return i < 0 ? PREFERRED_COMMANDS.length : i; };
      const ordered = [...a.commands].sort((x, y) => rank(x.id) - rank(y.id));
      return `${a.name} (app_key ${JSON.stringify(a.key)}), status ${a.status}. ${a.commands.length} commands; run one with external_command {app_key, command, params}.${nl}${nl}${ordered.map(describeCommand).join(nl + nl)}`;
    });
  const keep = tools.filter(t => t.name !== 'external_apps' && t.name !== 'external_commands')
    .map(t => t.name === 'external_command' ? { ...t, description: 'Runs one command from external_apps in a connected external application. The user is asked to allow it first; if they decline, accept it. The result states what was verified (for example that the saved file was re-opened and checked); report only that, never claim more. Long-running commands start a background job: follow it with external_job.' } : t);
  return [apps, ...keep] as typeof tools;
}

/** A setting as one short line: type, limits, default and what it is for. Structured (json) settings keep their longer description: it holds the example. */
function describeParam(p: CommandSpec['params'][string]): string {
  const range = p.min !== undefined || p.max !== undefined ? ` ${p.min ?? ''}..${p.max ?? ''}` : '';
  const dflt = p.default !== undefined ? ` default ${String(p.default)}` : '';
  return `${p.type}${p.required ? ' (required)' : ''}${range}${dflt}: ${p.description.slice(0, p.type === 'json' ? 1250 : 90)}`;
}
/** Listed first in Claude-style discovery: the typed, recoverable ways to do most things. */
const PREFERRED_COMMANDS = ['scene.create_basic', 'scene.build', 'scene.inspect_detail', 'scene.viewport', 'discover.search', 'script.run'];
export function describeCommand(c: CommandSpec): string {
  const structured = Object.values(c.params).some((p) => p.type === 'json');
  const flags = `${c.destructive ? ' [asks you every time]' : ''}${c.longRunning ? ' [long-running: returns a job]' : ''}`;
  const params = Object.entries(c.params).map(([k, p]) => `  ${k}: ${describeParam(p)}`).join(String.fromCharCode(10));
  return `${c.id}${flags} - ${c.description.slice(0, structured ? 600 : 130)}${params ? String.fromCharCode(10) + params : ''}`;
}

/** Extend an existing native registry without replacing native tools or weakening adapter policy. */
export function addExternalTools(registry: ToolRegistry, backend: ExternalBackend, options: ExternalToolOptions = {}): ToolRegistry {
  for (const entry of externalTools(backend, options)) registry.add(entry);
  return registry;
}

/** One application's commands as plain lines (no JSON quoting), the commands to reach for first at the top: what a model reads when it asks about ONE app. */
export function describeAppForModel(a: { name: string; key: string; status: string; commands: CommandSpec[] }): string {
  const nl = '\n';
  const rank = (id: string) => { const i = PREFERRED_COMMANDS.indexOf(id); return i < 0 ? PREFERRED_COMMANDS.length : i; };
  const ordered = [...a.commands].sort((x, y) => rank(x.id) - rank(y.id));
  return `${a.name} (app_key ${JSON.stringify(a.key)}), status ${a.status}. ${a.commands.length} commands; run one with external_run {app, command, settings}.${nl}${nl}${ordered.map(describeCommand).join(nl + nl)}`;
}
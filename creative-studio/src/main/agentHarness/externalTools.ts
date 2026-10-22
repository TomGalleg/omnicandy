import { compactParameterHints } from '../commandDiscovery';
import { preflightExternalParams, classifyCommandError } from './commandPreflight';
import { z } from 'zod';
import { inspectExternalCommand } from '@shared/commandCapabilityInspection';
import type { CommandSpec, JobInfo } from '@shared/integrations';
import type { IntegrationManager } from '../integrations/manager';
import { isTrustedReadbackCommand } from '../integrations/readback';
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
}
const empty = z.object({}).strict();
const identifier = z.string().min(1).max(1024);
const argsSchema = z.record(z.string().min(1).max(128), z.unknown());
const usable = (status: string) => status === 'connected' || status === 'limited';
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
  const list = async () => (await backend.list()).filter(app => usable(app.status) && !!app.adapterId);
  const trusted = (adapterId: string | null | undefined, spec: CommandSpec) => isTrustedExternalReadback(backend.isBuiltin?.bind(backend), adapterId, spec);
  const tools = [
    tool('external_apps', 'List already-connected external applications and their names. Only connected applications may be controlled.', empty, async () =>
      JSON.stringify((await list()).map(app => ({ key: app.key, name: app.name, status: app.status, adapter: app.adapterName })))),
    tool('external_commands', 'Search command identifiers for a connected external application, or inspect complete parameter and permission details by exact command_id before executing.',
      z.object({ app_key: identifier, filter: z.string().max(100).optional(), command_id: z.string().max(128).optional() }).strict(), async ({ app_key, filter, command_id }) => {
        const app = (await list()).find(a => a.key === app_key);
        if (!app) throw new Error('Application is not connected or is no longer available. Run external_apps again.');
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
          const app = (await list()).find(a => a.key === app_key);
          if (!app) throw new Error('Application disconnected or unavailable. Stop and ask the user to reconnect.');
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
          const result = await backend.execute(app_key, command, params ?? {}, { background: spec.longRunning === true });
          const payload = { ok: result.ok, verified: result.verified, message: result.message,
            evidence: result.evidence, outputs: result.outputs, data: result.data, error: result.error };
          if (!result.ok) {
            const detail = result.error?.message && result.error.message !== result.message ? ` ${result.error.message}` : '';
            const category = classifyCommandError(`${result.error?.kind ?? ''} ${result.message} ${detail}`);
            throw new Error(`${category} (${result.error?.kind ?? 'app-error'}): ${result.message}${detail}`);
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
        const app = (await list()).find(a => a.key === parsed.data.app_key);
        const spec = app?.commands.find(c => c.id === parsed.data.command);
        return !!app && !!spec && trusted(app.adapterId, spec);
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
  return tools;
}

/** Extend an existing native registry without replacing native tools or weakening adapter policy. */
export function addExternalTools(registry: ToolRegistry, backend: ExternalBackend, options: ExternalToolOptions = {}): ToolRegistry {
  for (const entry of externalTools(backend, options)) registry.add(entry);
  return registry;
}

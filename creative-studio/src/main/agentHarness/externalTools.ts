import { compactParameterHints } from '../commandDiscovery';
import { preflightExternalParams, classifyCommandError } from './commandPreflight';
import { z } from 'zod';
import type { IntegrationManager } from '../integrations/manager';
import { tool, ToolRegistry } from './registry';

/** The only external execution backend is IntegrationManager: never bypass its approval and policy checks. */
type ExternalBackend = Pick<IntegrationManager, 'list' | 'execute'>;
const empty = z.object({}).strict();
const identifier = z.string().min(1).max(1024);
const argsSchema = z.record(z.string().min(1).max(128), z.unknown());
const usable = (status: string) => status === 'connected' || status === 'limited';

export function externalTools(backend: ExternalBackend) {
  const list = async () => (await backend.list()).filter(app => usable(app.status) && !!app.adapterId);
  return [
    tool('external_apps', 'List already-connected external applications and their names. Only connected applications may be controlled.', empty, async () =>
      JSON.stringify((await list()).map(app => ({ key: app.key, name: app.name, status: app.status, adapter: app.adapterName })))),
    tool('external_commands', 'Search command identifiers for a connected external application, or inspect complete parameter and permission details by exact command_id before executing.',
      z.object({ app_key: identifier, filter: z.string().max(100).optional(), command_id: z.string().max(128).optional() }).strict(), async ({ app_key, filter, command_id }) => {
        const app = (await list()).find(a => a.key === app_key);
        if (!app) throw new Error('Application is not connected or is no longer available. Run external_apps again.');
        if (command_id) {
          const spec = app.commands.find(c => c.id === command_id);
          if (!spec) throw new Error('Command is not advertised by this app. Search external_commands again.');
          return JSON.stringify({ app: app.name, command: spec });
        }
        const q = (filter ?? '').trim().toLowerCase();
        const matches = app.commands.filter(c => c.id && (!q || `${c.id} ${c.label} ${c.description}`.toLowerCase().includes(q)));
        return JSON.stringify({ app: app.name, total: matches.length,
          commands: matches.slice(0, 40).map(c => ({ id: c.id, label: c.label, description: c.description.slice(0, 100),
            parameterHints: compactParameterHints(c.params), requiresInspection: true })),
          next: matches.length > 40 ? 'Refine filter to see other matching commands.' : undefined });
      }),
    tool('external_command', 'Execute one command from external_commands in a connected external app. The integration manager enforces user approvals and all existing security policies.',
      z.object({ app_key: identifier, command: z.string().min(1).max(128), params: argsSchema.optional() }).strict(), async ({ app_key, command, params }) => {
        // Recheck on every call: connected status, adapter and command availability may have changed since advertisement.
        const app = (await list()).find(a => a.key === app_key);
        if (!app) throw new Error('Application disconnected or unavailable. Stop and ask the user to reconnect.');
        const spec = app.commands.find(c => c.id === command);
        if (!spec) throw new Error('Command is not advertised by this connected app. Run external_commands again.');
        // A long-running operation can outlive the model turn; job tracking is a separate milestone.
        if (spec.longRunning) throw new Error('Long-running external commands are not supported in this prototype.');
        const problem = preflightExternalParams(spec, params ?? {});
        if (problem) throw new Error(`validation: ${problem}`);
        const result = await backend.execute(app_key, command, params ?? {}, { background: false });
        const payload = { ok: result.ok, verified: result.verified, message: result.message,
          evidence: result.evidence, outputs: result.outputs, error: result.error };
        if (!result.ok) {
          const detail = result.error?.message && result.error.message !== result.message ? ` ${result.error.message}` : '';
          const category = classifyCommandError(`${result.error?.kind ?? ''} ${result.message} ${detail}`);
          throw new Error(`${category} (${result.error?.kind ?? 'app-error'}): ${result.message}${detail}`);
        }
        return { text: JSON.stringify(payload), verified: result.verified === true };
      }),
  ];
}

/** Extend an existing native registry without replacing native tools or weakening adapter policy. */
export function addExternalTools(registry: ToolRegistry, backend: ExternalBackend): ToolRegistry {
  for (const entry of externalTools(backend)) registry.add(entry);
  return registry;
}

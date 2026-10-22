import type { CommandSpec } from '@shared/integrations';
import { normalizeJsonParam } from '@shared/jsonParam';

/** Advisory fast-fail validation. IntegrationManager remains the final authority. */
export function preflightExternalParams(cmd: CommandSpec, raw: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(cmd.params, key))
      return `Unknown parameter "${key}" for ${cmd.id}. Allowed: ${Object.keys(cmd.params).join(', ') || '(none)'}. Inspect external_commands with command_id.`;
  }
  for (const [key, spec] of Object.entries(cmd.params)) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') {
      if (spec.required && spec.default === undefined) return `Missing required parameter "${key}" for ${cmd.id}. Inspect external_commands with command_id.`;
      continue;
    }
    if (spec.type === 'number') {
      // Match the existing manager's string-to-number conversion, without changing the submitted value.
      const num = typeof value === 'string' ? Number(value) : value;
      if (typeof num !== 'number' || !Number.isFinite(num)) return `Parameter "${key}" must be a number.`;
      if (spec.min !== undefined && num < spec.min) return `Parameter "${key}" must be at least ${spec.min}.`;
      if (spec.max !== undefined && num > spec.max) return `Parameter "${key}" must be at most ${spec.max}.`;
    } else if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') return `Parameter "${key}" must be true or false.`;
    } else if (spec.type === 'json') {
      const j = normalizeJsonParam(value, key, { maxChars: spec.maxChars, maxDepth: spec.maxDepth });
      if (!j.ok) return j.error;
    } else if (typeof value !== 'string' || value.length > 512) {
      return `Parameter "${key}" must be text (up to 512 characters).`;
    }
  }
  return undefined;
}

/** Diagnostics never indicate that an attempted edit can safely be replayed. */
export function classifyCommandError(message: string): 'permission' | 'validation' | 'unavailable' | 'execution' {
  if (/permission[- ]denied|user declined|user did not allow|not approved|do not retry|stop and wait/i.test(message)) return 'permission';
  if (/invalid tool arguments|unknown parameter|unknown setting|missing required|must be|at least|at most|not advertised|invalid parameter/i.test(message)) return 'validation';
  if (/not connected|disconnected|unavailable|no longer available|not supported/i.test(message)) return 'unavailable';
  return 'execution';
}

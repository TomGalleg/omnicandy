import { normalizeNativeParameters } from './nativeSchemaNormalizer';
import type { CommandSpec } from '@shared/integrations';

/** Read-only command description for models and diagnostics. Never an execution grant. */
export type InspectedSchema = { status: 'complete' | 'partial' | 'unavailable'; raw?: unknown; fields: Record<string, unknown>; reason?: string };

export function inspectNativeSchema(raw: unknown): InspectedSchema {
  const normalized = normalizeNativeParameters(raw);
  if (!normalized) return { status: 'unavailable', raw, fields: {}, reason: 'No supported structured parameters.' };
  const fields = normalized.properties;
  const hasUnknown = (obj: typeof fields): boolean => Object.values(obj).some(rule =>
    rule.type === 'unknown' || (rule.properties !== undefined && hasUnknown(rule.properties)));
  if (!normalized.complete) return { status: 'unavailable', raw, fields, reason: 'Ambiguous or unsupported constraints; preserve original definition.' };
  return { status: hasUnknown(fields) ? 'partial' : 'complete', raw, fields };
}

/** External adapter metadata is already structured; keep its permission system authoritative. */
export function inspectExternalSchema(command: CommandSpec): InspectedSchema {
  return { status: 'complete', fields: command.params };
}

import { normalizeNativeParameters, validateNormalizedNative } from './nativeSchemaNormalizer';

/** A schema check is advisory until an execution controller explicitly enforces it.
 * No branch here authorizes execution, bypasses policy, or grants approval.
 */
export type NativePreflight =
  | { status: 'validated' }
  | { status: 'rejected'; reason: string }
  | { status: 'unavailable'; reason: string };

export function preflightNativeCommand(
  detail: string | undefined,
  command: string,
  params: Record<string, unknown>,
): NativePreflight {
  if (!detail) return { status: 'unavailable', reason: 'Command details are unavailable.' };
  let parsed: unknown;
  try { parsed = JSON.parse(detail); }
  catch { return { status: 'unavailable', reason: 'Command details are not structured JSON.' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unavailable', reason: 'Command details are not an object.' };
  }
  const record = parsed as Record<string, unknown>;
  if (record.id !== command) return { status: 'rejected', reason: 'Command ID mismatch.' };
  const raw = record.params ?? record.parameters ?? record.inputSchema;
  const schema = normalizeNativeParameters(raw);
  if (!schema) return { status: 'unavailable', reason: 'Command parameter schema is incomplete or unsupported.' };
  if (!schema.complete) {
    // Even when types or alternatives cannot be normalized, known parameter
    // names are still useful. Only reject an absent name when it is definitely
    // not declared anywhere in the original schema. Never grant execution here.
    for (const key of Object.keys(params)) {
      if (Object.hasOwn(schema.properties, key)) continue;
      const escape = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const declaration = new RegExp(`(?:[\\{,|]\\s*|^)['"]?${escape}['"]?\\s*(?:[?:},(]|$)`);
      if (typeof raw === 'string' && declaration.test(raw)) continue;
      // Structured schemas have a trustworthy explicit property list unless
      // their root uses unknown alternatives/refs (then fail advisory-only).
      if (typeof raw === 'string' && !raw.trim().startsWith('{')) continue;
      if (typeof raw === 'object' && raw !== null && ('oneOf' in raw || 'anyOf' in raw || '$ref' in raw)) continue;
      return { status: 'rejected', reason: `Unknown parameter "${key}" for ${command}. Inspect exact command ID.` };
    }
    return { status: 'unavailable', reason: 'Command parameter schema is incomplete or unsupported.' };
  }
  // An unknown type for an optional *omitted* field is not grounds to block
  // an otherwise valid command. Unknown supplied values remain unavailable.
  const error = validateNormalizedNative(schema, params, command);
  if (!error) return { status: 'validated' };
  if (/^Cannot validate /.test(error)) return { status: 'unavailable', reason: error };
  return { status: 'rejected', reason: error };
}

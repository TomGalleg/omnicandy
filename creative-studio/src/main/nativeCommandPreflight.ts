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
  if (!schema || !schema.complete) {
    return { status: 'unavailable', reason: 'Command parameter schema is incomplete or unsupported.' };
  }
  // An unknown type for an optional *omitted* field is not grounds to block
  // an otherwise valid command. Unknown supplied values remain unavailable.
  const error = validateNormalizedNative(schema, params, command);
  if (!error) return { status: 'validated' };
  if (/^Cannot validate /.test(error)) return { status: 'unavailable', reason: error };
  return { status: 'rejected', reason: error };
}

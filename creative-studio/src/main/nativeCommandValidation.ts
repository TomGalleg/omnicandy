import { normalizeNativeParameters, validateNormalizedNative } from './nativeSchemaNormalizer';

/** Pure validation of advertised native command schemas. Does not grant execution permissions. */
export function validateNativeCommandDetail(detail: string, command: string, params: Record<string, unknown>): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(detail); } catch { return `Cannot validate ${command}: command schema is not structured JSON. Do not execute.`; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return `Cannot validate ${command}: invalid command schema.`;
  const record = parsed as Record<string, unknown>;
  if (record.id !== command) return `Cannot validate ${command}: command schema ID mismatch.`;
  const schema = record.params ?? record.parameters ?? record.inputSchema;
  const normalized = normalizeNativeParameters(schema);
  if (!normalized) return `Cannot validate ${command}: parameter schema unavailable or malformed.`;
  return validateNormalizedNative(normalized, params, command);
}

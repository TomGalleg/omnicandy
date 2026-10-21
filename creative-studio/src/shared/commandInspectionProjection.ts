/** Read-only enrichment of exact-ID native discovery results; never authorizes execution. */
import { inspectNativeCommand } from './commandCapabilityInspection'

/** Keep list/search output unchanged to avoid inflating model context. */
export function appendNativeCapabilityInspection(output: string, requestedId?: string): string {
  const id = requestedId?.trim()
  if (!id || id.length > 128) return output
  let parsed: unknown
  try { parsed = JSON.parse(output) } catch { return output }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return output
  const command = parsed as Record<string, unknown>
  // Never enrich an arbitrary JSON response or filtered list as if it were an exact match.
  if (command.id !== id && command.name !== id) return output
  const params = command.params ?? command.parameters ?? command.inputSchema ?? command.input_schema
  return JSON.stringify({ ...command, capabilityInspection: inspectNativeCommand(id, params) })
}

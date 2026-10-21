/** Read-only, model-neutral command capability inspection. Never authorizes execution. */
import type { CommandSpec } from './integrations'
import {
  mapExternalCommandCapabilities,
  mapNativeCommandCapabilities,
  summarizeCommandCapabilities,
} from './commandCapabilityMapping'

export interface CommandInspection {
  commandId: string
  source: 'native' | 'external'
  classification: string
  effects: string[]
  permissions: string[]
  effectsComplete: boolean
  requiresControllerChecks: true
  parameterSchema: 'available' | 'unavailable'
  verification: 'supported' | 'unavailable' | 'unknown'
  warning: string
}

/** Pure metadata projection. The caller must use its existing controller to execute. */
export function inspectNativeCommand(commandId: string, parameters?: unknown): CommandInspection {
  if (!commandId.trim()) throw new Error('Command id is required')
  const view = mapNativeCommandCapabilities(commandId)
  const summary = summarizeCommandCapabilities(view)
  return {
    ...summary,
    parameterSchema: parameters === undefined || parameters === null ? 'unavailable' : 'available',
    verification: view.contract.verification,
    warning: 'Native effects have not been authoritatively declared. Existing command policy, approval and parameter checks still apply.',
  }
}

export function inspectExternalCommand(command: CommandSpec): CommandInspection {
  if (!command.id.trim()) throw new Error('Command id is required')
  const view = mapExternalCommandCapabilities(command)
  const summary = summarizeCommandCapabilities(view)
  return {
    ...summary,
    parameterSchema: command.params === undefined || command.params === null ? 'unavailable' : 'available',
    verification: view.contract.verification,
    warning: 'Manifest capabilities describe declared permissions, not an execution grant. IntegrationManager must enforce permissions and approvals.',
  }
}

/** Compact JSON intended for a command-inspection response, not a security decision. */
export function formatCommandInspection(inspection: CommandInspection): string {
  return JSON.stringify(inspection)
}

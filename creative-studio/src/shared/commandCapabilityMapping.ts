/**
 * Read-only capability view for command inspection across native and external apps.
 * Neither mapper grants permission, makes an approval decision, nor executes a command.
 */
import type { CommandSpec } from './integrations'
import { describeExternalCommand, describeNativeCommand } from './commandCapabilities'
import type { CommandCapabilityContract, CommandEffect } from './commandCapabilities'
import { appCommandTier } from './appCommands'

export interface CommandCapabilityView {
  contract: CommandCapabilityContract
  /** Current legacy policy for informational display; never an authorization token. */
  legacyTier?: 'free' | 'approval' | 'never'
  /** Whether the descriptor is sufficient to state effects conclusively. */
  effectsComplete: boolean
}

/**
 * Native names are hints only. The legacy classifier remains the source of truth
 * for policy, including PhotoCraft's separate control path (not handled here).
 * In particular, `free` does NOT mean that this mapper verified a command is safe.
 */
export function mapNativeCommandCapabilities(commandId: string): CommandCapabilityView {
  const contract = describeNativeCommand(commandId)
  const legacyTier = appCommandTier(commandId)
  return { contract, legacyTier, effectsComplete: false }
}

/**
 * External manifests supply declared permission ceilings, not exhaustive effects.
 * Extra requirements introduced here could accidentally diverge from IntegrationManager,
 * so enforcement remains exclusively in that manager.
 */
export function mapExternalCommandCapabilities(command: CommandSpec): CommandCapabilityView {
  return { contract: describeExternalCommand(command), effectsComplete: false }
}

/**
 * A compact, display-only summary suitable for agent command inspection. Unknown
 * effects are explicit; no agent should interpret this value as execution approval.
 */
export function summarizeCommandCapabilities(view: CommandCapabilityView): {
  commandId: string
  source: 'native' | 'external'
  classification: string
  effects: CommandEffect[]
  permissions: string[]
  effectsComplete: boolean
  requiresControllerChecks: true
} {
  return {
    commandId: view.contract.commandId,
    source: view.contract.source,
    classification: view.legacyTier ?? view.contract.confidence,
    effects: [...view.contract.effects],
    permissions: [...view.contract.permissions],
    effectsComplete: view.effectsComplete,
    requiresControllerChecks: true,
  }
}

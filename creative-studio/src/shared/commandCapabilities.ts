/**
 * Model-neutral security metadata for native commands and external adapters.
 * Descriptive only: execution controllers remain the sole policy enforcers.
 * Absence of a declaration is UNKNOWN, never evidence that an operation is safe.
 */
import type { CommandSpec, Permission } from './integrations'

export type CommandEffect =
  | 'document.read'
  | 'document.modify'
  | 'document.destructive'
  | 'filesystem.read'
  | 'filesystem.write'
  | 'code.execute'
  | 'network.access'
  | 'application.launch'
  | 'ui.automate'

export type Confidence = 'declared' | 'inferred' | 'unknown'

export interface CommandCapabilityContract {
  commandId: string
  source: 'native' | 'external'
  /** Unknown means no trustworthy evidence about command effects, not no effects. */
  confidence: Confidence
  effects: CommandEffect[]
  /** Existing manager permission identifiers, not a second permission store. */
  permissions: Permission[]
  destructive: boolean
  idempotent?: boolean
  /** Only reports whether an outcome may be independently checked. */
  verification: 'supported' | 'unavailable' | 'unknown'
  /** Optional diagnostic; never treat it as authorization. */
  note?: string
}

const EFFECT_PERMISSION: Partial<Record<CommandEffect, Permission>> = {
  'document.read': 'read-project',
  'document.modify': 'modify-project',
  'document.destructive': 'modify-project',
  'filesystem.read': 'open-files',
  'filesystem.write': 'write-files',
  'code.execute': 'execute-scripts',
  'network.access': 'network',
  'application.launch': 'launch',
  'ui.automate': 'ui-automation',
}

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set([
  'read-info', 'launch', 'open-files', 'read-project', 'modify-project',
  'write-files', 'execute-scripts', 'ui-automation', 'network',
])

export function permissionsForEffects(effects: readonly CommandEffect[]): Permission[] {
  return [...new Set(effects.map((effect) => EFFECT_PERMISSION[effect]).filter((value): value is Permission => !!value))]
}

/**
 * Translate existing external command metadata without guessing undocumented effects.
 * Permissions are a declared ceiling, not proof of the precise operation performed.
 */
export function describeExternalCommand(command: CommandSpec): CommandCapabilityContract {
  const effects = new Set<CommandEffect>()
  for (const p of command.permissions) {
    switch (p) {
      case 'read-project': effects.add('document.read'); break
      case 'modify-project': effects.add('document.modify'); break
      case 'open-files': effects.add('filesystem.read'); break
      case 'write-files': effects.add('filesystem.write'); break
      case 'execute-scripts': effects.add('code.execute'); break
      case 'network': effects.add('network.access'); break
      case 'launch': effects.add('application.launch'); break
      case 'ui-automation': effects.add('ui.automate'); break
    }
  }
  if (command.destructive) effects.add('document.destructive')
  return {
    commandId: command.id,
    source: 'external',
    confidence: 'declared',
    effects: [...effects],
    permissions: [...command.permissions],
    destructive: command.destructive === true,
    idempotent: command.idempotent,
    verification: 'unknown',
    note: 'Derived from existing adapter manifest; enforcement stays in IntegrationManager.',
  }
}

/** Native commands require authoritative metadata before effects can be trusted. */
export function describeNativeCommand(commandId: string): CommandCapabilityContract {
  return {
    commandId,
    source: 'native',
    confidence: 'unknown',
    effects: [],
    permissions: [],
    destructive: false,
    verification: 'unknown',
    note: 'No authoritative native capability declaration; retain existing command policy.',
  }
}

export interface CapabilityAssessment {
  status: 'declared' | 'missing' | 'invalid'
  missingPermissions: Permission[]
  /** Informational only. Never substitutes for controller approval or permission checks. */
  requiresSpecialHandling: boolean
  reason: string
}

/**
 * Diagnostic precheck for future integration; never returns permission to execute.
 * An empty or missing contract never grants access.
 */
export function assessCapabilities(
  contract: CommandCapabilityContract | undefined,
  granted: readonly Permission[],
): CapabilityAssessment {
  if (!contract || contract.confidence === 'unknown') {
    return { status: 'missing', missingPermissions: [], requiresSpecialHandling: true, reason: 'Capability declaration unavailable' }
  }
  if (
    !contract.commandId || !['native', 'external'].includes(contract.source) ||
    !contract.effects.every((effect) => effect in EFFECT_PERMISSION) ||
    !contract.permissions.every((permission) => KNOWN_PERMISSIONS.has(permission))
  ) {
    return { status: 'invalid', missingPermissions: [], requiresSpecialHandling: true, reason: 'Invalid capability declaration' }
  }
  const required = [...new Set([...contract.permissions, ...permissionsForEffects(contract.effects)])]
  const missingPermissions = required.filter((permission) => !granted.includes(permission))
  const requiresSpecialHandling = contract.destructive || contract.effects.includes('code.execute') || contract.effects.includes('document.destructive') || missingPermissions.length > 0
  return {
    status: 'declared', missingPermissions, requiresSpecialHandling,
    reason: requiresSpecialHandling ? 'Controller approval and permission enforcement required' : 'Metadata available; controller checks still required',
  }
}

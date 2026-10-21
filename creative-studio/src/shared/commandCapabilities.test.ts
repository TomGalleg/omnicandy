import { describe, expect, it } from 'vitest'
import type { CommandSpec } from './integrations'
import { assessCapabilities, describeExternalCommand, describeNativeCommand, permissionsForEffects } from './commandCapabilities'

const command = (overrides: Partial<CommandSpec> = {}): CommandSpec => ({
  id: 'file.export', label: 'Export', description: 'Write an export', params: {},
  permissions: ['write-files'], ...overrides,
})

describe('shared command capability contract (metadata only)', () => {
  it('retains adapter declared permissions and destructive/idempotent flags', () => {
    const contract = describeExternalCommand(command({ destructive: true, idempotent: false }))
    expect(contract.effects).toContain('filesystem.write')
    expect(contract.effects).toContain('document.destructive')
    expect(contract.permissions).toEqual(['write-files'])
    expect(contract.destructive).toBe(true)
    expect(contract.idempotent).toBe(false)
    expect(contract.verification).toBe('unknown')
  })

  it('does not infer safety from native command names', () => {
    const contract = describeNativeCommand('edit.undo')
    expect(contract.confidence).toBe('unknown')
    expect(assessCapabilities(contract, []).status).toBe('missing')
    expect(assessCapabilities(contract, []).requiresSpecialHandling).toBe(true)
  })

  it('maps known effects to existing adapter permissions', () => {
    expect(permissionsForEffects(['filesystem.write', 'code.execute', 'filesystem.write'])).toEqual(['write-files', 'execute-scripts'])
  })

  it('reports missing permissions without authorizing execution', () => {
    const contract = describeExternalCommand(command({ permissions: ['open-files', 'write-files'] }))
    const assessed = assessCapabilities(contract, ['open-files'])
    expect(assessed.status).toBe('declared')
    expect(assessed.missingPermissions).toEqual(['write-files'])
    expect(assessed.requiresSpecialHandling).toBe(true)
  })

  it('flags code execution even when existing permission is granted', () => {
    const contract = describeExternalCommand(command({ permissions: ['execute-scripts'], destructive: false }))
    const assessed = assessCapabilities(contract, ['execute-scripts'])
    expect(assessed.missingPermissions).toEqual([])
    expect(assessed.requiresSpecialHandling).toBe(true)
  })

  it('missing contract never signals safe execution', () => {
    expect(assessCapabilities(undefined, [])).toMatchObject({ status: 'missing', requiresSpecialHandling: true })
  })

  it('rejects invalid capabilities instead of trusting them', () => {
    const contract = describeExternalCommand(command())
    const invalid = { ...contract, effects: ['filesystem.teleport'] as unknown as typeof contract.effects }
    expect(assessCapabilities(invalid, ['write-files']).status).toBe('invalid')
  })
})

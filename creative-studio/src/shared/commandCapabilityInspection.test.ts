import { describe, expect, it } from 'vitest'
import type { CommandSpec } from './integrations'
import {
  formatCommandInspection,
  inspectExternalCommand,
  inspectNativeCommand,
} from './commandCapabilityInspection'

describe('read-only universal command inspection', () => {
  it('reports native approval without claiming effects are complete', () => {
    const info = inspectNativeCommand('saveas', '{path}')
    expect(info.classification).toBe('approval')
    expect(info.effectsComplete).toBe(false)
    expect(info.requiresControllerChecks).toBe(true)
    expect(info.parameterSchema).toBe('available')
  })

  it('preserves blocked native script tier', () => {
    const info = inspectNativeCommand('lisp')
    expect(info.classification).toBe('never')
    expect(info.permissions).toEqual([])
    expect(info.verification).toBe('unknown')
  })

  it('does not claim that a native free tier means safe', () => {
    const info = inspectNativeCommand('edit.undo')
    expect(info.classification).toBe('free')
    expect(info.effectsComplete).toBe(false)
    expect(info.warning).toContain('Existing command policy')
  })

  it('reports external declared permissions and keeps execution manager authoritative', () => {
    const command: CommandSpec = {
      id: 'doc.export', label: 'Export', description: 'Export a file', params: {},
      permissions: ['read-project', 'write-files'], destructive: false,
    }
    const info = inspectExternalCommand(command)
    expect(info.source).toBe('external')
    expect(info.permissions).toEqual(['read-project', 'write-files'])
    expect(info.effects).toContain('filesystem.write')
    expect(info.effectsComplete).toBe(false)
    expect(info.requiresControllerChecks).toBe(true)
    expect(command.permissions).toEqual(['read-project', 'write-files'])
  })

  it('produces compact JSON and rejects empty ids', () => {
    expect(JSON.parse(formatCommandInspection(inspectNativeCommand('edit.undo'))).commandId).toBe('edit.undo')
    expect(() => inspectNativeCommand('  ')).toThrow('Command id is required')
  })
})

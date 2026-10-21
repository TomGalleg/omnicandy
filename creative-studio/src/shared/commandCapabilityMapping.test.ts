import { describe, expect, it } from 'vitest'
import type { CommandSpec } from './integrations'
import {
  mapExternalCommandCapabilities,
  mapNativeCommandCapabilities,
  summarizeCommandCapabilities,
} from './commandCapabilityMapping'

const external: CommandSpec = {
  id: 'doc.export', label: 'Export', description: 'Export a file', params: {},
  permissions: ['read-project', 'write-files'], destructive: false,
}

describe('shared command capability views (non-enforcing)', () => {
  it('preserves native policy without claiming effects are known', () => {
    const save = mapNativeCommandCapabilities('saveas')
    expect(save.legacyTier).toBe('approval')
    expect(save.contract.source).toBe('native')
    expect(save.contract.confidence).toBe('unknown')
    expect(save.effectsComplete).toBe(false)
    expect(summarizeCommandCapabilities(save).requiresControllerChecks).toBe(true)
  })

  it('preserves blocked native script commands', () => {
    const script = mapNativeCommandCapabilities('lisp')
    expect(script.legacyTier).toBe('never')
    expect(script.contract.permissions).toEqual([])
  })

  it('does not promote free commands into authoritative safety declarations', () => {
    const edit = mapNativeCommandCapabilities('edit.undo')
    expect(edit.legacyTier).toBe('free')
    expect(edit.contract.confidence).toBe('unknown')
  })

  it('maps external adapter permission declarations without granting them', () => {
    const view = mapExternalCommandCapabilities(external)
    expect(view.contract.source).toBe('external')
    expect(view.contract.permissions).toEqual(['read-project', 'write-files'])
    expect(view.contract.effects).toContain('filesystem.write')
    expect(view.effectsComplete).toBe(false)
    const summary = summarizeCommandCapabilities(view)
    expect(summary.requiresControllerChecks).toBe(true)
    expect(summary.permissions).toContain('write-files')
  })

  it('does not mutate source adapter manifests or returned summaries', () => {
    const view = mapExternalCommandCapabilities(external)
    const summary = summarizeCommandCapabilities(view)
    summary.permissions.push('execute-scripts')
    expect(external.permissions).toEqual(['read-project', 'write-files'])
    expect(view.contract.permissions).toEqual(['read-project', 'write-files'])
  })
})

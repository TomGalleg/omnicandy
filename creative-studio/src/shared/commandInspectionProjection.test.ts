import { describe, expect, it } from 'vitest'
import { appendNativeCapabilityInspection } from './commandInspectionProjection'

describe('native AI command inspection projection', () => {
  it('enriches exact-ID native inspection with read-only metadata', () => {
    const output = appendNativeCapabilityInspection(JSON.stringify({ id: 'saveas', params: '{path}' }), 'saveas')
    const result = JSON.parse(output)
    expect(result.params).toBe('{path}')
    expect(result.capabilityInspection.classification).toBe('approval')
    expect(result.capabilityInspection.effectsComplete).toBe(false)
    expect(result.capabilityInspection.requiresControllerChecks).toBe(true)
  })
  it('preserves blocked tier and unknown effects', () => {
    const info = JSON.parse(appendNativeCapabilityInspection('{"id":"lisp"}', 'lisp'))
    expect(info.capabilityInspection.classification).toBe('never')
    expect(info.capabilityInspection.parameterSchema).toBe('unavailable')
  })
  it('does not alter catalog searches, nonmatches, or plain-text replies', () => {
    const list = '{"commands":[{"id":"saveas"}]}'
    expect(appendNativeCapabilityInspection(list, 'saveas')).toBe(list)
    expect(appendNativeCapabilityInspection('{"id":"other"}', 'saveas')).toBe('{"id":"other"}')
    expect(appendNativeCapabilityInspection('not JSON', 'saveas')).toBe('not JSON')
    expect(appendNativeCapabilityInspection('{"id":"saveas"}', 'sav')).toBe('{"id":"saveas"}')
    expect(appendNativeCapabilityInspection(list, 'save')).toBe(list)
  })
})

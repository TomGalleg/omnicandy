import { describe, expect, it } from 'vitest';
import type { ExternalAppInfo } from './integrations';
import { compareVersions, groupInstalls, nextStep } from './softwareList';

const app = (o: Partial<ExternalAppInfo>): ExternalAppInfo => ({ key: Math.random().toString(), name: 'X', adapterId: null, version: null, status: 'unsupported', ...o } as ExternalAppInfo);

describe('software list', () => {
  it('compares versions numerically, newest first, unknown last', () => {
    expect(compareVersions('5.8.4', '5.4.4')).toBeLessThan(0);
    expect(compareVersions('1.10', '1.9')).toBeLessThan(0);
    expect(compareVersions(null, '1.0')).toBeGreaterThan(0);
  });
  it('shows an incompatible old install behind the usable one', () => {
    const rows = groupInstalls([
      app({ adapterId: 'unreal', name: 'Unreal Engine', version: '5.4.4', status: 'incompatible' }),
      app({ adapterId: 'unreal', name: 'Unreal Engine', version: '5.8.4', status: 'api-unavailable' }),
      app({ adapterId: 'blender', name: 'Blender', version: '4.0.2', status: 'connected' }),
    ]);
    expect(rows.map((r) => [r.app.name, r.app.version, r.others])).toEqual([['Unreal Engine', '5.8.4', 1], ['Blender', '4.0.2', 0]]);
  });
  it('keeps the copy with a known, newest version when the status ties', () => {
    const rows = groupInstalls([app({ name: 'FreeCAD', version: null }), app({ name: 'FreeCAD', version: '1.1.4' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.app.version).toBe('1.1.4');
    expect(rows[0]!.others).toBe(1);
  });
  it('says what to do next for programs that are found but not reachable', () => {
    expect(nextStep({ adapterId: 'unreal', name: 'Unreal Engine', status: 'api-unavailable' })).toMatch(/Auto Start Server/);
    expect(nextStep({ adapterId: null, name: 'Fusion', status: 'api-unavailable' })).toMatch(/Fusion MCP Server/);
    expect(nextStep({ adapterId: null, name: 'DaVinci Resolve', status: 'not-running' })).toMatch(/Studio/);
    expect(nextStep({ adapterId: 'blender', name: 'Blender', status: 'connected' })).toBeNull();
  });
});

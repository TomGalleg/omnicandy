import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry';
import { addExternalTools } from './externalTools';
import type { IntegrationManager } from '../integrations/manager';
import type { ExternalAppInfo, CommandResult } from '@shared/integrations';

const spec = { id: 'create_cube', label: 'Create cube', description: 'Adds a cube', params: {}, permissions: ['modify-project'] as const };
const app = (status: ExternalAppInfo['status'] = 'connected') => ({
  key: 'fake-app', name: 'FakeCAD', status, adapterId: 'fake', adapterName: 'FakeCAD Adapter',
  commands: [spec],
}) as unknown as ExternalAppInfo;
const success: CommandResult = { ok: true, verified: true, message: 'Cube created', evidence: ['cube exists'], outputs: [], durationMs: 5 };

describe('external application tools', () => {
  it('discovers connected applications and routes through the existing manager', async () => {
    const calls: unknown[][] = [];
    const backend = { list: async () => [app()], execute: async (...args: unknown[]) => { calls.push(args); return success; } } as unknown as IntegrationManager;
    const registry = addExternalTools(new ToolRegistry(), backend);
    const snap = registry.snapshot();
    const apps = await registry.call(snap, 'external_apps', {});
    expect(apps.isError).toBeFalsy(); expect(apps.text).toContain('FakeCAD');
    const commands = await registry.call(snap, 'external_commands', { app_key: 'fake-app' });
    expect(commands.text).toContain('create_cube');
    const result = await registry.call(snap, 'external_command', { app_key: 'fake-app', command: 'create_cube', params: {} });
    expect(result.isError).toBeFalsy(); expect(result.text).toContain('verified');
    expect(calls).toEqual([['fake-app', 'create_cube', {}, { background: false }]]);
  });
  it('blocks disconnected apps, unknown commands and invalid arguments', async () => {
    let status: ExternalAppInfo['status'] = 'connected'; let executed = 0;
    const backend = { list: async () => [app(status)], execute: async () => { executed++; return success; } } as unknown as IntegrationManager;
    const registry = addExternalTools(new ToolRegistry(), backend);
    const snap = registry.snapshot();
    expect((await registry.call(snap, 'external_command', { app_key: 'fake-app', command: 'nope' })).isError).toBe(true);
    expect((await registry.call(snap, 'external_command', { app_key: 'fake-app', command: 'create_cube', params: [] })).isError).toBe(true);
    status = 'available';
    expect((await registry.call(snap, 'external_command', { app_key: 'fake-app', command: 'create_cube' })).isError).toBe(true);
    expect(executed).toBe(0);
  });
  it('returns manager permission denials as failures', async () => {
    const backend = { list: async () => [app()], execute: async () => ({ ...success, ok: false, verified: false, message: 'The user did not allow this. Do not ask again.', error: { kind:'permission-denied', message:'denied' } }) } as unknown as IntegrationManager;
    const registry = addExternalTools(new ToolRegistry(), backend);
    const result = await registry.call(registry.snapshot(), 'external_command', { app_key:'fake-app', command:'create_cube' });
    expect(result.isError).toBe(true); expect(result.text).toContain('permission-denied');
  });
});

describe('external command detail without catalog token waste', () => {
  it('returns compact catalog and full schema only when requested', async () => {
    const detailed = { ...spec, params: { radius: { type: 'number', description: 'radius', min: 5, max: 200 } } };
    const backend = { list: async () => [{ ...app(), commands: [detailed] }] } as unknown as IntegrationManager;
    const registry = addExternalTools(new ToolRegistry(), backend);
    const catalog = await registry.call(registry.snapshot(), 'external_commands', { app_key: 'fake-app' });
    expect(catalog.text).not.toContain('"min"'); expect(catalog.text).toContain('radius?:number(5..200)');
    const detail = await registry.call(registry.snapshot(), 'external_commands', { app_key: 'fake-app', command_id: 'create_cube' });
    expect(detail.text).toContain('"min":5');
    expect(detail.text).toContain('"max":200');
  });
});

describe('preflight prevents invalid external execution', () => {
  it('rejects wrong ranges without calling the manager', async () => {
    let executed = 0;
    const ranged = { ...spec, params: { radius: { type:'number', description:'', required:true, min:5, max:50 } } };
    const backend = { list: async () => [{ ...app(), commands:[ranged] }], execute: async () => { executed++; return success; } } as unknown as IntegrationManager;
    const registry = addExternalTools(new ToolRegistry(), backend);
    const result = await registry.call(registry.snapshot(), 'external_command', { app_key:'fake-app', command:'create_cube', params:{radius:1} });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('at least 5');
    expect(executed).toBe(0);
  });
});

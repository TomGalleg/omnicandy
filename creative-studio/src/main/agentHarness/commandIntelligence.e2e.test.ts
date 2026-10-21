/** Offline command-intelligence contract tests. No installed apps or AI credentials required. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent } from './loop';
import { addExternalTools } from './externalTools';
import { ScriptedProvider } from './providers/scripted';
import { ToolRegistry, tool } from './registry';
import type { LiveTaskController } from '../liveTask';
import type { IntegrationManager } from '../integrations/manager';
import type { ExternalAppInfo, CommandResult } from '@shared/integrations';

const command = {
  id: 'create_cube', label: 'Create cube', description: 'Create a 3D cube',
  params: { size: { type: 'number', description: 'Cube size', min: 2, max: 10, required: true } },
  permissions: ['modify-project'],
};
const connectedApp = () => ({
  key: 'cad-1', name: 'ExampleCAD', status: 'connected', adapterId: 'example-adapter',
  adapterName: 'Example adapter', commands: [command],
}) as unknown as ExternalAppInfo;
const ok: CommandResult = { ok: true, verified: true, message: 'Cube created',
  evidence: ['cube-1'], outputs: [], durationMs: 1 };
const invoke = (id: string, name: string, args: unknown) => ({ text: null, toolCalls: [{ id, name, args }] });
const final = { text: 'Complete', toolCalls: [] };
function fakeController() {
  let released = 0;
  const ctl = {
    snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null } }),
    claudeDone: () => { released++; },
  } as unknown as LiveTaskController;
  return { ctl, get released() { return released; } };
}

describe('offline command intelligence end-to-end', () => {
  it('discovers, inspects, validates, executes through the manager, and reports verification evidence', async () => {
    const calls: unknown[][] = [];
    const manager = {
      list: async () => [connectedApp()],
      execute: async (...args: unknown[]) => { calls.push(args); return ok; },
    } as unknown as IntegrationManager;
    const registry = addExternalTools(new ToolRegistry(), manager);
    const controller = fakeController();
    const outcome = await runAgent({
      goal: 'Make a cube in ExampleCAD', registry, ctl: controller.ctl,
      provider: new ScriptedProvider([
        invoke('1', 'external_apps', {}),
        invoke('2', 'external_commands', { app_key: 'cad-1', filter: 'cube' }),
        invoke('3', 'external_commands', { app_key: 'cad-1', command_id: 'create_cube' }),
        invoke('4', 'external_command', { app_key: 'cad-1', command: 'create_cube', params: { size: 4 } }),
        final,
      ]),
    });
    expect(outcome.status).toBe('completed');
    const toolMessages = outcome.messages.filter(m => m.role === 'tool');
    expect(toolMessages).toHaveLength(4);
    expect(toolMessages[1]!.content).toContain('size?:number(2..10)');
    expect(toolMessages[2]!.content).toContain('"max":10');
    expect(toolMessages[3]!.content).toContain('"verified":true');
    expect(toolMessages[3]!.content).toContain('cube-1');
    expect(calls).toEqual([['cad-1', 'create_cube', { size: 4 }, { background: false }]]);
    expect(controller.released).toBe(1);
  });

  it('rejects invalid external parameters locally before any manager execution', async () => {
    let executed = 0;
    const manager = {
      list: async () => [connectedApp()],
      execute: async () => { executed++; return ok; },
    } as unknown as IntegrationManager;
    const ctl = fakeController();
    const outcome = await runAgent({ goal: 'Make cube', ctl: ctl.ctl,
      registry: addExternalTools(new ToolRegistry(), manager),
      provider: new ScriptedProvider([
        invoke('bad', 'external_command', {app_key:'cad-1',command:'create_cube',params:{size:1}}), final,
      ]),
    });
    expect(executed).toBe(0);
    expect(outcome.messages.find(m => m.role === 'tool')?.content).toMatch(/validation|at least 2/i);
    expect(ctl.released).toBe(1);
  });

  it('halts on manager permission denial and never executes a following command', async () => {
    let executed = 0;
    const manager = {
      list: async () => [connectedApp()],
      execute: async () => { executed++; return { ...ok, ok:false, verified:false,
        message:'User did not allow this operation',
        error:{kind:'permission-denied',message:'User did not allow this operation'} }; },
    } as unknown as IntegrationManager;
    const ctl = fakeController();
    const outcome = await runAgent({ goal:'Create cubes', ctl:ctl.ctl,
      registry:addExternalTools(new ToolRegistry(),manager),
      provider:new ScriptedProvider([
        {text:null,toolCalls:[
          {id:'first',name:'external_command',args:{app_key:'cad-1',command:'create_cube',params:{size:4}}},
          {id:'second',name:'external_command',args:{app_key:'cad-1',command:'create_cube',params:{size:5}}},
        ]}, final,
      ]),
    });
    expect(outcome.status).toBe('paused');
    expect(executed).toBe(1);
    const results = outcome.messages.filter(m => m.role === 'tool');
    expect(results).toHaveLength(2);
    expect(results[1]!.content).toContain('Not executed');
    expect(ctl.released).toBe(1);
  });

  it('routes a native command through the controller surface rather than the external manager', async () => {
    let executions = 0;
    const registry = new ToolRegistry([
      tool('app_commands','Discover native commands',z.object({filter:z.string().optional()}).strict(),
        async () => JSON.stringify([{id:'shape.circle',parameterHints:'radius!:number(5..50)'}])),
      tool('app_command','Execute through LiveTaskController',z.object({command:z.string(),params:z.record(z.string(),z.unknown())}).strict(),
        async ({command,params}) => { expect(command).toBe('shape.circle'); expect(params.radius).toBe(10); executions++; return 'Native controller accepted edit'; }),
    ]);
    const ctl = fakeController();
    const outcome = await runAgent({ goal:'Draw a circle', ctl:ctl.ctl,registry,
      provider:new ScriptedProvider([
        invoke('discover','app_commands',{filter:'circle'}),
        invoke('execute','app_command',{command:'shape.circle',params:{radius:10}}),final,
      ]),
    });
    expect(outcome.status).toBe('completed');
    expect(executions).toBe(1);
    expect(ctl.released).toBe(1);
  });
});

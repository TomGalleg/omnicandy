import { describe, it, expect } from 'vitest';
import { clampAgentBudgets } from './executionBudget';
import { boundToolOutput, compactAgentHistory, MAX_TOOL_OUTPUT } from './contextBudget';
import type { Message } from './types';
import { runAgent } from './loop';
import { ToolRegistry, tool } from './registry';
import { ScriptedProvider } from './providers/scripted';
import type { LiveTaskController } from '../liveTask';
import { z } from 'zod';

const ctl = () => ({ snapshot: () => ({ collab: {phase:'idle',lockOwner:null,activeOperation:null} }), claudeDone: () => undefined }) as unknown as LiveTaskController;
const call = (name: string, args: unknown = {}) => ({text:null,toolCalls:[{id:'c1',name,args}]});
const finish = {text:'finished',toolCalls:[]};
describe('Package A limits', () => {
  it('clamps finite configured budgets to the documented limits (defaults sized for a chat that builds a scene step by step)', () => {
    expect(clampAgentBudgets()).toEqual({maxTurns:60,maxToolCalls:150});
    expect(clampAgentBudgets(900,900)).toEqual({maxTurns:100,maxToolCalls:250});
    expect(clampAgentBudgets(0,Number.NaN)).toEqual({maxTurns:1,maxToolCalls:150});
  });
  it('bounds tool results and keeps old tool-call IDs paired with results', () => {
    expect(boundToolOutput('x'.repeat(200000)).length).toBeLessThan(13000);
    expect(boundToolOutput('x'.repeat(10))).toHaveLength(10);
    const messages: Message[] = [{role:'assistant',content:null,toolCalls:[{id:'c1',name:'read',args:{}}]},{role:'tool',toolCallId:'c1',content:'x'.repeat(1000)},{role:'user',content:'latest'}];
    compactAgentHistory(messages,1);
    expect(messages[0]).toMatchObject({role:'assistant',toolCalls:[{id:'c1'}]});
    expect(messages[1]).toMatchObject({role:'tool',toolCallId:'c1'});
    expect((messages[1] as Extract<Message,{role:'tool'}>).content.length).toBeLessThan(200);
    expect(MAX_TOOL_OUTPUT).toBeGreaterThan(1000);
  });
  it('does not accept prose completion after a successful app mutation without verification', async () => {
    const registry = new ToolRegistry([tool('app_command','edit',z.object({command:z.string()}).strict(),async () => ({text:'applied'}))]);
    const result = await runAgent({goal:'edit rectangle',ctl:ctl(),registry,provider:new ScriptedProvider([call('app_command',{command:'shape.edit'}),finish]),maxTurns:2});
    expect(result.status).toBe('limit');
    expect(result.text).toContain('not verified');
  });
  it('still allows prose completion for read-only tasks', async () => {
    const result = await runAgent({goal:'answer question',ctl:ctl(),registry:new ToolRegistry(),provider:new ScriptedProvider([finish])});
    expect(result.status).toBe('completed');
  });
});

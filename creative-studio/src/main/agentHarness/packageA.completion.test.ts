import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agentBudgetSchema } from './executionBudget';
import { validateAgentBudget } from '@shared/agentBudget';
import { hasUnverifiedChanges, runAgent } from './loop';
import { ToolRegistry, tool } from './registry';
import { ScriptedProvider } from './providers/scripted';
import type { Message, ProviderReply } from './types';
import type { LiveTaskController } from '../liveTask';

const ctl = () => ({ snapshot: () => ({ collab: {phase:'idle',lockOwner:null,activeOperation:null} }), claudeDone: () => undefined }) as unknown as LiveTaskController;
const finish: ProviderReply = {text:'finished',toolCalls:[]};
const plain = (name: string, args: unknown = {}, id = 'c1'): ProviderReply => ({text:null,toolCalls:[{id,name,args}]});
const shapeTools = () => new ToolRegistry([
  tool('app_command','native command',z.object({command:z.string()}).strict(),async ({command}) =>
    command === 'shape.info' ? 'Result: {"layer":1,"live":{"rect":[300,400,150,150]}}' : 'applied'),
  tool('external_command','external command',z.object({}).strict(),async () => ({text:JSON.stringify({ok:true,verified:true}),verified:true})),
  tool('save_version','save',z.object({}).strict(),async () => '{"saved":true,"versionId":"v2","message":"Saved"}'),
]);
const edit = (id: string) => plain('app_command',{command:'shape.edit'},id);
const read = (id: string) => plain('app_command',{command:'shape.info'},id);
const verify = (id: string, receipt: string) => plain('evidence_verify',{receipt_id:receipt,path:'live.rect.0',expected:300},id);
const run = (script: ProviderReply[], extra: Partial<Parameters<typeof runAgent>[0]> = {}) =>
  runAgent({goal:'move shape',ctl:ctl(),registry:shapeTools(),provider:new ScriptedProvider(script),...extra});

describe('Package A completion enforcement', () => {
  it('completes after a change followed by a fresh read-back and a passing comparison', async () => {
    expect((await run([edit('1'),read('2'),verify('3','r2'),finish])).status).toBe('completed');
  });
  it('rejects a read-back taken before the latest change', async () => {
    expect((await run([read('1'),edit('2'),verify('3','r1'),finish,finish])).status).toBe('limit');
  });
  it('treats a later mutation as unverified even after an earlier passing verification', async () => {
    const r = await run([edit('1'),read('2'),verify('3','r2'),edit('4'),finish,finish]);
    expect(r.status).toBe('limit');
    expect(r.text).toContain('not verified');
  });
  it('does not accept an external adapter verified:true flag as evidence', async () => {
    const r = await run([plain('external_command',{}),finish,finish]);
    expect(r.status).toBe('limit');
    expect(r.messages.some(m => m.role === 'tool' && m.content.includes('"verified":true'))).toBe(true);
  });
  it('does not let a completed plan authorize a later unverified mutation', async () => {
    const plan = {goal:'move shape',steps:[{id:'a',title:'Move the shape',status:'completed' as const,evidence:'earlier'}]};
    expect((await run([edit('1'),finish,finish],{resumePlan:plan})).status).toBe('limit');
  });
  it('lets a confirmed save alone and read-only work complete', async () => {
    expect((await run([plain('save_version'),finish])).status).toBe('completed');
    expect((await run([read('1'),finish])).status).toBe('completed');
  });
  it('keeps an unverified task resumable and conservative across a resumed transcript', async () => {
    const first = await run([edit('1'),finish,finish]);
    expect(first.status).toBe('limit');
    expect(hasUnverifiedChanges(first.messages)).toBe(true);
    const registry = () => { const r = shapeTools(); r.add(tool('get_status','status',z.object({}).strict(),async () => 'current')); return r; };
    const resumed = await runAgent({goal:'move shape',ctl:ctl(),registry:registry(),provider:new ScriptedProvider([finish,finish]),resumeMessages:first.messages});
    expect(resumed.status).toBe('limit');
    const verified = await runAgent({goal:'move shape',ctl:ctl(),registry:registry(),provider:new ScriptedProvider([read('2'),verify('3','r1'),finish]),resumeMessages:first.messages});
    expect(verified.status).toBe('completed');
  });
  it('reconstructs verification only when a passing comparison follows the latest change', () => {
    const call = (id: string, name: string, args: unknown): Message => ({role:'assistant',content:null,toolCalls:[{id,name,args}]});
    const result = (id: string, content: string): Message => ({role:'tool',toolCallId:id,content});
    const base: Message[] = [call('1','app_command',{command:'shape.edit'}),result('1','applied')];
    expect(hasUnverifiedChanges(base)).toBe(true);
    const verified = [...base,call('2','evidence_verify',{}),result('2','{"passed":true}')];
    expect(hasUnverifiedChanges(verified)).toBe(false);
    expect(hasUnverifiedChanges([...verified,call('3','app_command',{command:'x'}),result('3','ok')])).toBe(true);
    expect(hasUnverifiedChanges([call('1','app_command',{command:'shape.edit'}),result('1','Error: failed')])).toBe(false);
  });
});

describe('Package A budgets, usage and bounded history', () => {
  it('validates IPC budgets strictly and keeps defaults when omitted', () => {
    expect(agentBudgetSchema.safeParse({}).success).toBe(true);
    expect(agentBudgetSchema.safeParse({maxTurns:100,maxToolCalls:250}).success).toBe(true);
    for (const bad of [{maxTurns:0},{maxTurns:101},{maxToolCalls:251},{maxTurns:1.5},{maxTurns:Number.POSITIVE_INFINITY},{maxTurns:'20'},{unlimited:true}])
      expect(agentBudgetSchema.safeParse(bad).success).toBe(false);
    expect(validateAgentBudget({maxTurns:20,maxToolCalls:50})).toBeNull();
    expect(validateAgentBudget({maxTurns:Number.NaN})).not.toBeNull();
    expect(validateAgentBudget({maxToolCalls:0})).not.toBeNull();
  });
  it('enforces a configured tool-call budget', async () => {
    const r = await run([read('1'),read('2'),read('3'),read('4')],{maxToolCalls:2});
    expect(r.status).toBe('limit');
    expect(r.messages.filter(m => m.role === 'tool' && m.content.includes('Not executed')).length).toBeGreaterThan(0);
  });
  it('sums provider-reported usage and omits it when providers report none', async () => {
    const withUsage = await run([{...read('1'),usage:{input:10,output:2}},{...finish,usage:{input:5,output:1}}]);
    expect(withUsage.usage).toEqual({input:15,output:3});
    expect((await run([read('1'),finish])).usage).toBeUndefined();
  });
  it('keeps checkpoint-bound history small while preserving pairing and recovery messages', async () => {
    const registry = new ToolRegistry([
      tool('get_status','status',z.object({}).strict(),async () => 'current'),
      tool('app_command','native',z.object({command:z.string()}).strict(),async ({command}) => command === 'shape.info' ? `Result: ${'x'.repeat(50000)}` : 'ok'),
    ]);
    const script: ProviderReply[] = Array.from({length:45},(_, i) => read(`c${i}`));
    const done = await runAgent({goal:'inspect',ctl:ctl(),registry,provider:new ScriptedProvider([...script,finish]),maxTurns:50,maxToolCalls:50,
      resumeMessages:[{role:'user',content:'inspect'}],resumeUncertainEdit:'app_command (shape.edit)'});
    expect(Buffer.byteLength(JSON.stringify(done.messages))).toBeLessThan(700_000);
    expect(done.messages.some(m => m.role === 'user' && m.content.includes('Recovery safety lock'))).toBe(true);
    const ids = new Set(done.messages.flatMap(m => m.role === 'assistant' ? (m.toolCalls ?? []).map(c => c.id) : []));
    const answered = new Set(done.messages.flatMap(m => m.role === 'tool' ? [m.toolCallId] : []));
    expect(answered).toEqual(ids);
  });
});

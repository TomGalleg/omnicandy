import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, tool } from './registry';
import { runAgent } from './loop';
import { ScriptedProvider } from './providers/scripted';
import type { LiveTaskController } from '../liveTask';

function fakeController() {
  const state = { phase: 'idle', lockOwner: null as string | null, activeOperation: null as string | null };
  let done = 0;
  const ctl = { snapshot: () => ({ collab: state }), claudeDone: () => { done++; state.phase='completed'; state.lockOwner=null; } } as unknown as LiveTaskController;
  return { ctl, state, get done() { return done; } };
}
const reply = (name: string, args: unknown = {}) => ({ text: null, toolCalls: [{ id:'call_1',name,args }] });
const final = { text:'Done, pending verification', toolCalls:[] };

describe('model-independent harness', () => {
  it('executes tools and returns results to the model', async () => {
    const f=fakeController(); let edits=0;
    const registry=new ToolRegistry([tool('edit','Validated edit',z.object({amount:z.number()}).strict(),async ({amount})=>{edits+=amount;return 'executed';})]);
    const outcome=await runAgent({goal:'edit',provider:new ScriptedProvider([reply('edit',{amount:2}),final]),ctl:f.ctl,registry});
    expect(outcome.status).toBe('completed'); expect(edits).toBe(2);
    expect(outcome.messages.find(m=>m.role==='tool')).toMatchObject({role:'tool',toolCallId:'call_1',content:'executed'});
    expect(f.done).toBe(1);
  });
  it('rejects invalid and unknown tools with structured error results', async () => {
    const f=fakeController();
    const registry=new ToolRegistry([tool('edit','Edit',z.object({amount:z.number()}).strict(),async ()=>'unexpected')]);
    const outcome=await runAgent({goal:'edit',provider:new ScriptedProvider([reply('edit',{amount:'bad'}),reply('absent'),final]),ctl:f.ctl,registry});
    expect(outcome.status).toBe('completed');
    expect(outcome.messages.filter(m=>m.role==='tool')).toHaveLength(2);
    expect(outcome.events.filter(e=>e.kind==='result').every(e=>e.isError)).toBe(true);
  });
  it('respects cancellation, max turns, and user takeover', async () => {
    const f=fakeController(); const signal=new AbortController(); signal.abort();
    expect((await runAgent({goal:'x',ctl:f.ctl,registry:new ToolRegistry(),provider:new ScriptedProvider([final]),signal:signal.signal})).status).toBe('cancelled');
    expect((await runAgent({goal:'x',ctl:f.ctl,registry:new ToolRegistry(),provider:new ScriptedProvider([reply('missing')]),maxTurns:1})).status).toBe('limit');
    const g=fakeController();
    const reg=new ToolRegistry([tool('takeover','Change control',z.object({}).strict(),async ()=>{g.state.phase='manual';g.state.lockOwner='user';return 'user took control';})]);
    expect((await runAgent({goal:'x',ctl:g.ctl,registry:reg,provider:new ScriptedProvider([reply('takeover'),final])})).status).toBe('paused');
  });
  it('revalidates that a tool snapshot is still current', async () => {
    const t=tool('edit','Edit',z.object({}).strict(),async ()=>'ok');
    const a=new ToolRegistry([t]);
    const b=new ToolRegistry();
    expect((await b.call(a.snapshot(),'edit',{})).isError).toBe(true);
  });
});

describe('manual takeover continuation', () => {
  it('preserves history and inspects current state before continuing', async () => {
    const f=fakeController(); let edits=0;
    const registry=new ToolRegistry([
      tool('get_status','Current revision',z.object({}).strict(),async ()=>`revision:${edits}`),
      tool('edit','Edit',z.object({}).strict(),async ()=>{ edits++;f.state.phase='manual';f.state.lockOwner='user';return 'user took control'; }),
    ]);
    const first=await runAgent({goal:'edit once',provider:new ScriptedProvider([reply('edit'),final]),registry,ctl:f.ctl});
    expect(first.status).toBe('paused'); expect(edits).toBe(1);
    f.state.phase='idle'; f.state.lockOwner=null;
    const resumed=await runAgent({goal:'edit once',resumeMessages:first.messages,provider:new ScriptedProvider([final]),registry,ctl:f.ctl});
    expect(resumed.status).toBe('completed'); expect(edits).toBe(1);
    expect(resumed.messages.some(m=>m.role==='user' && m.content.includes('revision:1'))).toBe(true);
  });
  it('rejects resuming without a valid status tool', async () => {
    const f=fakeController();
    await expect(runAgent({goal:'x',resumeMessages:[{role:'user',content:'x'}],provider:new ScriptedProvider([final]),registry:new ToolRegistry(),ctl:f.ctl})).rejects.toThrow('Cannot resume');
  });
});


describe('repeated tool failure guard', () => {
  it('stops before a third identical failing execution', async () => {
    const f = fakeController(); let executions = 0;
    const registry = new ToolRegistry([tool('fail', 'Always fails', z.object({n:z.number()}).strict(), async () => { executions++; throw new Error('Invalid operation'); })]);
    const outcome = await runAgent({goal:'try', ctl:f.ctl, registry, provider:new ScriptedProvider([reply('fail',{n:1}),reply('fail',{n:1}),reply('fail',{n:1}),final])});
    expect(outcome.status).toBe('limit');
    expect(executions).toBe(2);
    expect(outcome.messages.filter(m=>m.role==='tool')).toHaveLength(3);
    expect(outcome.messages.some(m=>m.role==='tool' && m.content.includes('failed twice'))).toBe(true);
    expect(f.done).toBe(1);
  });
});

describe('error recovery guidance', () => {
  it('suggests schema inspection after invalid arguments without retrying automatically', async () => {
    const f = fakeController(); let calls = 0;
    const registry = new ToolRegistry([tool('edit', 'Edit', z.object({n:z.number().min(5)}).strict(), async () => {calls++;return 'done';})]);
    const outcome = await runAgent({goal:'edit',ctl:f.ctl,registry,provider:new ScriptedProvider([reply('edit',{n:1}),final])});
    expect(outcome.messages.find(m=>m.role==='tool')?.content).toContain('Inspect the exact command schema');
    expect(calls).toBe(0);
  });
  it('stops after permission-denied without a second model call', async () => {
    const f = fakeController(); let calls = 0;
    const registry = new ToolRegistry([tool('permission', 'Forbidden action', z.object({}).strict(), async () => {calls++;throw new Error('permission-denied: user did not allow');})]);
    const outcome = await runAgent({goal:'edit',ctl:f.ctl,registry,provider:new ScriptedProvider([reply('permission'),final])});
    expect(outcome.status).toBe('paused'); expect(calls).toBe(1);
  });
});


describe('turn-budget continuation', () => {
  it('resumes a limited task after inspecting current state without replaying an edit', async () => {
    const f = fakeController(); let edits = 0;
    const registry = new ToolRegistry([
      tool('get_status','Current document state',z.object({}).strict(),async () => `edits:${edits}`),
      tool('edit','Make edit',z.object({}).strict(),async () => { edits++; return 'edit applied'; }),
    ]);
    const first = await runAgent({goal:'make one edit',provider:new ScriptedProvider([reply('edit')]),registry,ctl:f.ctl,maxTurns:1});
    expect(first.status).toBe('limit');
    expect(edits).toBe(1);
    const second = await runAgent({goal:'make one edit',resumeMessages:first.messages,provider:new ScriptedProvider([final]),registry,ctl:f.ctl});
    expect(second.status).toBe('completed');
    expect(edits).toBe(1);
    expect(second.messages.some(m=>m.role==='user' && m.content.includes('edits:1'))).toBe(true);
    expect(second.messages.some(m=>m.role==='user' && m.content.includes('Do not replay finished actions'))).toBe(true);
  });
});


describe('structured completion gate', () => {
  it('does not report success while plan contains unfinished steps and allows safe continuation', async () => {
    const f=fakeController();
    const registry=new ToolRegistry();
    const initial={goal:'Landscape',steps:[{id:'save',title:'Verify and save',status:'active' as const}]};
    const outcome=await runAgent({goal:'Landscape',ctl:f.ctl,registry,provider:new ScriptedProvider([final, final]),resumePlan:initial,maxTurns:3});
    expect(outcome.status).toBe('limit');
    expect(outcome.text).toContain('save (active)');
    expect(outcome.plan?.steps[0]?.status).toBe('active');
    expect(outcome.messages.some(m=>m.role==='user' && m.content.includes('still has unfinished steps'))).toBe(true);
  });
  it('allows completing a plan after the model reconciles steps', async () => {
    const f=fakeController();
    // Completing a step now needs machine evidence: a confirmed new-version save receipt (or a passing evidence_verify).
    const registry=new ToolRegistry([tool('save_version','Save',z.object({}).strict(),async ()=>'{"saved":true,"versionId":"asset-9","message":"Saved"}')]);
    const initial={goal:'Landscape',steps:[{id:'save',title:'Verify and save',status:'active' as const}]};
    const planReply={text:null,toolCalls:[{id:'plan-1',name:'task_plan',args:{steps:[{id:'save',title:'Verify and save',status:'completed',evidence:'Version asset-9 saved',receiptIds:['r1']}]}}]};
    const outcome=await runAgent({goal:'Landscape',ctl:f.ctl,registry,provider:new ScriptedProvider([final,reply('save_version'),planReply,final]),resumePlan:initial,maxTurns:6});
    expect(outcome.status).toBe('completed');
    expect(outcome.plan?.steps[0]?.status).toBe('completed');
  });
  it('does not change the status of an empty-plan short task',async () => {
    const f=fakeController();
    const outcome=await runAgent({goal:'Read only',ctl:f.ctl,registry:new ToolRegistry(),provider:new ScriptedProvider([final])});
    expect(outcome.status).toBe('completed');
  });
});

describe('application execution receipts',()=>{
  it('returns a receipt for successful application operations but none for failed ones',async()=>{
    const f=fakeController();
    const reg=new ToolRegistry([tool('app_command','Edit document',z.object({ok:z.boolean()}).strict(),async ({ok})=>ok?'accepted':{text:'not accepted',isError:true})]);
    const outcome=await runAgent({goal:'edit',ctl:f.ctl,registry:reg,provider:new ScriptedProvider([reply('app_command',{ok:true}),reply('app_command',{ok:false}),final])});
    const results=outcome.messages.filter(m=>m.role==='tool');
    expect(results[0]?.content).toContain('Execution receipt: r1');
    expect(results[1]?.content).not.toContain('Execution receipt:');
  });
});

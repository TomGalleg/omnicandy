import { describe, it, expect } from 'vitest';
import { ToolRegistry } from './registry';
import { registerTaskPlan } from './taskPlan';
describe('task plan tool',()=>{
  it('records a structured, externally observable plan without modifying application state', async()=>{
    const registry=new ToolRegistry(); const updates: string[]=[];
    const control=registerTaskPlan(registry,'Three shapes',undefined,p=>updates.push(p.steps[0]?.status??''));
    const snap=registry.snapshot();
    const r=await registry.call(snap,'task_plan',{steps:[{id:'create',title:'Create three shapes',status:'active'}]});
    expect(r.isError).not.toBe(true);
    expect(control.snapshot().steps[0]?.status).toBe('active');
    expect(updates).toEqual(['active']);
  });
  it('rejects duplicate ids and unsupported completion claims',async()=>{
    const registry=new ToolRegistry();const ctl=registerTaskPlan(registry,'Goal',undefined,()=>{});
    const snap=registry.snapshot();
    expect((await registry.call(snap,'task_plan',{steps:[{id:'x',title:'First',status:'completed'}]})).isError).toBe(true);
    expect((await registry.call(snap,'task_plan',{steps:[{id:'x',title:'One',status:'pending'},{id:'x',title:'Two',status:'pending'}]})).isError).toBe(true);
    expect(ctl.snapshot().steps).toEqual([]);
    expect((await registry.call(snap,'task_plan',{steps:[{id:'x',title:'First',status:'completed',evidence:'shape.info rect matches requested placement'}]})).isError).toBe(true);
  });
  it('restores plan and does not mutate returned copies',()=>{
    const reg=new ToolRegistry();const ctl=registerTaskPlan(reg,'Goal',{goal:'Goal',steps:[{id:'a',title:'First',status:'active'}]},()=>{});
    const plan=ctl.snapshot();plan.steps[0]!.title='changed';expect(ctl.snapshot().steps[0]?.title).toBe('First');
  });
});

describe('tool-result evidence receipts', () => {
  it('rejects invented receipts and accepts only runner-issued successful tool receipts',async () => {
    const registry=new ToolRegistry();
    const control=registerTaskPlan(registry,'Edit image',undefined,()=>{});
    const snap=registry.snapshot();
    const fake=await registry.call(snap,'task_plan',{steps:[{id:'draw',title:'Draw',status:'completed',evidence:'Used tool',receiptIds:['r1']}]});
    expect(fake.isError).toBe(true);
    expect(control.record('app_command','shape created',false)).toBe('r1');
    const valid=await registry.call(snap,'task_plan',{steps:[{id:'draw',title:'Draw',status:'completed',evidence:'shape.info checked',receiptIds:['r1']}]});
    expect(valid.isError).toBe(true);
    const listed=await registry.call(snap,'evidence_receipts',{});
    expect(listed.text).toContain('shape created');
    expect(listed.text).toContain('"verified":false');
    expect(control.record('task_plan','model claim',false)).toBeUndefined();
  });
});


describe('enforced plan completion and save confirmations', () => {
  it('refuses model-only evidence; permits a passing structured read-back verification', async () => {
    const registry = new ToolRegistry();const control=registerTaskPlan(registry,'Goal',undefined,()=>{});
    const id=control.record('app_command','Result: {"live":{"rect":[300,490,100,100]}}',false,{command:'shape.info'});
    const tools=registry.snapshot();
    const verified=await registry.call(tools,'evidence_verify',{receipt_id:id,path:'live.rect.0',expected:300});
    expect(verified.verified).toBe(true);
    const complete=await registry.call(tools,'task_plan',{steps:[{id:'position',title:'Position shape',status:'completed',evidence:'Read back x=300',verificationIds:['v1']}]});
    expect(complete.isError).not.toBe(true);
    const notASave=await registry.call(tools,'task_plan',{steps:[{id:'save',title:'Save version',status:'completed',evidence:'only read-back',verificationIds:['v1']}]});
    expect(notASave.isError).toBe(true);
  });
  it('requires a confirmed new version before completing a save step',async()=>{
    const registry=new ToolRegistry();const control=registerTaskPlan(registry,'Goal',undefined,()=>{});
    const tools=registry.snapshot();
    expect(control.record('save_version','Nothing changed since last save.',false)).toBeUndefined();
    expect((await registry.call(tools,'task_plan',{steps:[{id:'save',title:'Save version',status:'completed',evidence:'saved',receiptIds:['r1']}]})).isError).toBe(true);
    expect(control.record('save_version','{"saved":true,"versionId":"asset-123","message":"Saved"}',false)).toBe('r1');
    expect((await registry.call(tools,'task_plan',{steps:[{id:'save',title:'Save version',status:'completed',evidence:'new asset-123',receiptIds:['r1']}]})).isError).not.toBe(true);
  });
  it('preserves previously completed steps from restored plans without retroactive verification',async()=>{
    const registry=new ToolRegistry();const control=registerTaskPlan(registry,'Goal',{goal:'Goal',steps:[{id:'legacy',title:'Old complete',status:'completed',evidence:'Historical model claim'}]},()=>{});
    const r=await registry.call(registry.snapshot(),'task_plan',{steps:control.snapshot().steps});
    expect(r.isError).not.toBe(true);
  });
});

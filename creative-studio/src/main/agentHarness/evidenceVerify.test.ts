import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry';
import { registerTaskPlan } from './taskPlan';

describe('read-back evidence verification', () => {
  it('compares actual structured inspection results with explicit expectations', async () => {
    const registry=new ToolRegistry();
    const plan=registerTaskPlan(registry,'Move a shape',undefined,()=>{});
    const id=plan.record('app_command','Result: {"layer":20,"live":{"rect":[300,490,100,100]},"fill":"#ff0000"}',false,{command:'shape.info'});
    expect(id).toBe('r1');
    const tools=registry.snapshot();
    const ok=await registry.call(tools,'evidence_verify',{receipt_id:id,path:'live.rect.0',expected:300});
    expect(ok.isError).not.toBe(true);
    expect(ok.verified).toBe(true);
    expect(JSON.parse(ok.text)).toMatchObject({sourceReceiptId:'r1',passed:true,observed:300});
    const goodPlan=await registry.call(tools,'task_plan',{steps:[{id:'move',title:'Move ellipse',status:'completed',evidence:'Confirmed read-back coordinate',verificationIds:['v1']}]});
    expect(goodPlan.isError).not.toBe(true);
    const wrong=await registry.call(tools,'evidence_verify',{receipt_id:id,path:'live.rect.0',expected:700});
    expect(wrong.verified).toBe(false);
    expect(JSON.parse(wrong.text).passed).toBe(false);
    const fake=await registry.call(tools,'task_plan',{steps:[{id:'move',title:'Move ellipse',status:'completed',evidence:'Unverified',verificationIds:['v2']}]});
    expect(fake.isError).toBe(true);
  });
  it('never treats edit command output, arbitrary text, or an external command as read-back',async()=>{
    const registry=new ToolRegistry();const plan=registerTaskPlan(registry,'Goal',undefined,()=>{});
    const a=plan.record('app_command','{"x":300}',true,{command:'shape.edit'});
    const b=plan.record('external_command','{"x":300}',true,{command:'inspect'});
    const c=plan.record('app_command','applied',true,{command:'shape.info'});
    const tools=registry.snapshot();
    for(const id of [a,b,c]){
      const result=await registry.call(tools,'evidence_verify',{receipt_id:id,path:'x',expected:300});
      expect(result.isError).toBe(true);
    }
    const spoofed=await registry.call(tools,'evidence_verify',{receipt_id:'r99',path:'x',expected:300});
    expect(spoofed.isError).toBe(true);
  });
  it('refuses absent fields and supports bounded numeric tolerance',async()=>{
    const registry=new ToolRegistry();const plan=registerTaskPlan(registry,'Goal',undefined,()=>{});
    const id=plan.record('app_command','{"bounds":[299.8,500]}',false,{command:'shape.info'});
    const tools=registry.snapshot();
    expect((await registry.call(tools,'evidence_verify',{receipt_id:id,path:'bounds.0',expected:300,tolerance:0.5})).verified).toBe(true);
    expect((await registry.call(tools,'evidence_verify',{receipt_id:id,path:'bounds.0',expected:300,tolerance:0.1})).verified).toBe(false);
    expect((await registry.call(tools,'evidence_verify',{receipt_id:id,path:'doesNotExist',expected:300})).verified).toBe(false);
    expect((await registry.call(tools,'evidence_verify',{receipt_id:id,path:'bounds.0',expected:300,tolerance:-1})).isError).toBe(true);
  });
});

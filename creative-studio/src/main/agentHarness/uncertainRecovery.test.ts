import {describe,expect,it} from 'vitest';
import {z} from 'zod';
import {ToolRegistry,tool} from './registry';
import {runAgent} from './loop';
import {ScriptedProvider} from './providers/scripted';
import type {LiveTaskController} from '../liveTask';
const controller=()=>({snapshot:()=>({collab:{phase:'idle',lockOwner:null,activeOperation:null}}),claudeDone:()=>{}} as unknown as LiveTaskController);
const call=(id:string,name:string,args:unknown)=>({text:null,toolCalls:[{id,name,args}]});
const end={text:'Completed',toolCalls:[]};
const tools=(hits:{writes:number;reads:number})=>new ToolRegistry([
  tool('get_status','Current document state',z.object({}).strict(),async ()=>'revision:current'),
  tool('app_command','Native app command',z.object({command:z.string()}).strict(),async ({command})=>{
    if(command==='shape.edit'){hits.writes++;if(hits.writes===1)throw new Error('Bridge timeout after execution');return 'edited';}
    if(command==='shape.info'){hits.reads++;return 'Result: {"live":{"rect":[300,490,100,100]}}';}
    return 'unknown';
  }),
]);
describe('uncertain application-edit recovery',()=>{
  it('blocks another write following a potentially partial failure',async()=>{
    const hits={writes:0,reads:0};const result=await runAgent({goal:'move shape',registry:tools(hits),ctl:controller(),provider:new ScriptedProvider([call('1','app_command',{command:'shape.edit'}),call('2','app_command',{command:'shape.edit'}),end])});
    expect(hits.writes).toBe(1);expect(result.status).toBe('limit');
    expect(result.messages.some(m=>m.role==='tool'&&m.content.includes('Further edits remain blocked'))).toBe(true);
  });
  it('does not unlock edits after inspection alone',async()=>{
    const hits={writes:0,reads:0};const result=await runAgent({goal:'move shape',registry:tools(hits),ctl:controller(),provider:new ScriptedProvider([call('1','app_command',{command:'shape.edit'}),call('2','app_command',{command:'shape.info'}),call('3','app_command',{command:'shape.edit'}),end])});
    expect(hits.reads).toBe(1);expect(hits.writes).toBe(1);expect(result.status).toBe('limit');expect(result.uncertainEdit).toBeDefined();
  });
  it('does not block corrections of schema-validation failures',async()=>{
    const hits={writes:0,reads:0};const registry=new ToolRegistry([tool('app_command','command',z.object({command:z.string(),x:z.number().min(5)}).strict(),async()=>{hits.writes++;return 'ok';})]);
    const result=await runAgent({goal:'edit',registry,ctl:controller(),provider:new ScriptedProvider([call('1','app_command',{command:'shape.edit',x:1}),call('2','app_command',{command:'shape.edit',x:5}),end,end])});
    expect(result.status).toBe('limit');expect(hits.writes).toBe(1);
  });
  it('retains an uncertain edit across turn-limited continuation and blocks replay',async()=>{
    const hits={writes:0,reads:0};
    const first=await runAgent({goal:'move shape',registry:tools(hits),ctl:controller(),provider:new ScriptedProvider([call('1','app_command',{command:'shape.edit'}),end])});
    expect(first.status).toBe('limit');
    expect(first.uncertainEdit).toContain('shape.edit');
    const resumed=await runAgent({goal:'move shape',registry:tools(hits),ctl:controller(),resumeMessages:first.messages,resumeUncertainEdit:first.uncertainEdit,provider:new ScriptedProvider([call('2','app_command',{command:'shape.edit'}),end])});
    expect(hits.writes).toBe(1);
    expect(resumed.status).toBe('limit');
    expect(resumed.uncertainEdit).toBe(first.uncertainEdit);
  });
  it('preserves a restored edit barrier after inspection without comparison',async()=>{
    const hits={writes:1,reads:0};
    const resumed=await runAgent({goal:'move shape',registry:tools(hits),ctl:controller(),resumeMessages:[{role:'user',content:'move shape'}],resumeUncertainEdit:'app_command (shape.edit)',provider:new ScriptedProvider([call('1','app_command',{command:'shape.info'}),end])});
    expect(hits.reads).toBe(1);
    expect(resumed.uncertainEdit).toBe('app_command (shape.edit)');
  });

  it('does not release the barrier for a model-chosen value without a recorded intent',async()=>{
    const hits={writes:1,reads:0};
    const registry=tools(hits);
    const resumed=await runAgent({goal:'move shape',registry,ctl:controller(),resumeMessages:[{role:'user',content:'move shape'}],resumeUncertainEdit:'app_command (shape.edit)',provider:new ScriptedProvider([
      call('1','app_command',{command:'shape.info'}),
      call('2','evidence_verify',{receipt_id:'r1',path:'live.rect.0',expected:300}),
      end,
    ])});
    expect(hits.reads).toBe(1);
    expect(resumed.uncertainEdit).toBe('app_command (shape.edit)');
  });
  it('keeps the barrier if a fresh structured comparison fails',async()=>{
    const hits={writes:1,reads:0};
    const resumed=await runAgent({goal:'move shape',registry:tools(hits),ctl:controller(),resumeMessages:[{role:'user',content:'move shape'}],resumeUncertainEdit:'app_command (shape.edit)',provider:new ScriptedProvider([
      call('1','app_command',{command:'shape.info'}),
      call('2','evidence_verify',{receipt_id:'r1',path:'live.rect.0',expected:999}),
      end,
    ])});
    expect(resumed.uncertainEdit).toBe('app_command (shape.edit)');
  });

});

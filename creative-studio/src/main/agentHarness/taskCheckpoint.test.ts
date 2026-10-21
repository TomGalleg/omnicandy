import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { checkpointMessages, TaskCheckpointStore, type CheckpointCrypto } from './taskCheckpoint';
const dirs:string[]=[];
const fakeCrypto = (available=true): CheckpointCrypto => ({
  isEncryptionAvailable:()=>available,
  encryptString:s=>Buffer.from(s).reverse(),
  decryptString:b=>Buffer.from(b).reverse().toString('utf8'),
});
const task = {goal:'Edit shape',model:'gpt-4.1-mini',status:'limit' as const,plan:{goal:'Edit shape',steps:[{id:'move',title:'Move shape',status:'active' as const}]},messages:[
  {role:'user' as const,content:'Edit shape'},
  {role:'assistant' as const,content:null,toolCalls:[{id:'1',name:'edit',args:{layer:20}}]},
  {role:'tool' as const,toolCallId:'1',content:'Applied'},
  {role:'user' as const,content:'Preview',imageDataUrl:'data:image/png;base64,AAAA'},
]};
async function store(crypto=fakeCrypto()) {const dir=await fs.mkdtemp(path.join(tmpdir(),'agent-checkpoint-'));dirs.push(dir);return {dir,store:new TaskCheckpointStore(dir,crypto)};}
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>fs.rm(d,{force:true,recursive:true})));});
describe('encrypted project task checkpoint',()=>{
  it('round-trips a resumable task without writing preview images',async()=>{
    const {dir,store:s}=await store();expect(await s.save(task)).toBe(true);
    expect(await s.load()).toMatchObject({goal:'Edit shape',status:'limit'});
    expect((await s.load())?.messages).toHaveLength(3);
    expect((await s.load())?.plan?.steps[0]?.id).toBe('move');
    const raw=await fs.readFile(path.join(dir,'.omnicandy-agent-checkpoint.enc'));
    expect(raw.toString()).not.toContain('Edit shape');
    await s.clear();expect(await s.load()).toBeNull();
  });
  it('retains the uncertain edit guard through an encrypted restart checkpoint',async()=>{
    const {store:s}=await store();
    expect(await s.save({...task,uncertainEdit:'app_command (shape.edit)'})).toBe(true);
    expect((await s.load())?.uncertainEdit).toBe('app_command (shape.edit)');
  });
  it('never writes plaintext when encryption is unavailable',async()=>{
    const {dir,store:s}=await store(fakeCrypto(false));expect(await s.save(task)).toBe(false);
    expect(await fs.readdir(dir)).toEqual([]);
  });
  it('rejects corrupt contents and oversized transcripts',async()=>{
    const {dir,store:s}=await store();await fs.writeFile(path.join(dir,'.omnicandy-agent-checkpoint.enc'),randomBytes(8));
    expect(await s.load()).toBeNull();
    expect(await s.save({...task,messages:[{role:'user',content:'x'.repeat(5*1024*1024)}]})).toBe(false);
  });
  it('keeps model tool-call sequencing while removing images',()=>{
    expect(checkpointMessages(task.messages)).toEqual(task.messages.slice(0,3));
  });
});

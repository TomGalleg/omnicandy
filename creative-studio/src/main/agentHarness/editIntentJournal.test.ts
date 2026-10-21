import { afterEach,describe,expect,it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EditIntentJournal } from './editIntentJournal';
import type { CheckpointCrypto } from './taskCheckpoint';
const paths:string[]=[];
const crypto:CheckpointCrypto={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).reverse(),decryptString:b=>Buffer.from(b).reverse().toString()};
async function journal(){const p=await fs.mkdtemp(path.join(os.tmpdir(),'intent-journal-'));paths.push(p);return {p,j:new EditIntentJournal(p,crypto)};}
afterEach(async()=>{await Promise.all(paths.splice(0).map(p=>fs.rm(p,{recursive:true,force:true})));});
describe('encrypted write-ahead edit journal',()=>{
 it('persists intent before an operation and detects it after a simulated restart',async()=>{
  const {p,j}=await journal(); const item=await j.begin('Make poster','app_command','shape.edit');
  expect((await new EditIntentJournal(p,crypto).load())?.id).toBe(item.id);
  const raw=await fs.readFile(path.join(p,'.omnicandy-edit-intent.enc'));
  expect(raw.toString()).not.toContain('Make poster');
  await expect(j.begin('Another edit','app_command','shape.edit')).rejects.toThrow('unresolved');
  await j.clear(); expect(await j.load()).toBeNull();
 });
 it('blocks editing when encryption is unavailable or journal is corrupt',async()=>{
  const {p,j}=await journal();
  const unavailable=new EditIntentJournal(p,{...crypto,isEncryptionAvailable:()=>false});
  await expect(unavailable.begin('goal','external_command','blender')).rejects.toThrow('unavailable');
  await fs.writeFile(path.join(p,'.omnicandy-edit-intent.enc'),'invalid');
  await expect(j.load()).rejects.toThrow('cannot be decrypted');
 });
});

describe('recorded expected shape geometry',()=>{
 it('saves only recognized geometry, never arbitrary command arguments',async()=>{
  const {p,j}=await journal();
  await j.begin('Move object','app_command','shape.edit',{command:'shape.edit',params:{layer:20,rect:[300,490,100,100],secret:'do not store'}});
  const restored=await new EditIntentJournal(p,crypto).load();
  expect(restored?.expected).toEqual({kind:'photocraft.shape.edit.rect',layer:20,rect:[300,490,100,100]});
  expect(JSON.stringify(restored)).not.toContain('secret');
 });
});

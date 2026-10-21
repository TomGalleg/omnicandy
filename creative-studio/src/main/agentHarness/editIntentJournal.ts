/** Crash-aware, encrypted write-ahead journal for one in-flight model-initiated edit.
 * The journal is distinct from the paused-task checkpoint because it MUST be
 * persisted before dispatching the application command. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CheckpointCrypto } from './taskCheckpoint';

export const expectedRectSchema = z.object({kind:z.literal('photocraft.shape.edit.rect'), layer:z.number().int().min(1), rect:z.tuple([z.number().finite(),z.number().finite(),z.number().finite().positive(),z.number().finite().positive()])});
export type ExpectedRect = z.infer<typeof expectedRectSchema>;
/** A deliberately narrow, deterministic intent extractor. Unknown operations remain unresolvable. */
export function expectedEditIntent(tool:string, args:unknown):ExpectedRect | undefined {
  if(tool !== 'app_command' || !args || typeof args !== 'object' || Array.isArray(args))return;
  const call=args as Record<string,unknown>;
  if(call.command !== 'shape.edit' || !call.params || typeof call.params !== 'object' || Array.isArray(call.params))return;
  const params=call.params as Record<string,unknown>;
  const result=expectedRectSchema.safeParse({kind:'photocraft.shape.edit.rect',layer:params.layer,rect:params.rect});
  return result.success ? result.data : undefined;
}
const journalSchema = z.object({
  version:z.literal(1), id:z.string().uuid(), goal:z.string().min(1).max(4000),
  tool:z.enum(['app_command','external_command']), command:z.string().max(200),
  // Intentionally do not store raw arguments, filenames, document content, or secrets.
  // Precise expected state must be separately bound to trusted intent before auto-recovery.
  startedAt:z.string(), expected:expectedRectSchema.optional(),
});
export type EditIntent = z.infer<typeof journalSchema>;
const FILE = '.omnicandy-edit-intent.enc';
export class EditIntentJournal {
  constructor(private readonly root:string,private readonly crypto:CheckpointCrypto) {}
  private file(){return path.join(this.root,FILE);}
  async load():Promise<EditIntent|null>{
    if (!this.crypto.isEncryptionAvailable()) throw new Error('Secure journal storage unavailable; editing is disabled.');
    let bytes:Buffer;
    try { const stat=await fs.stat(this.file());if(stat.size>8192)throw new Error('Edit journal too large.');bytes=await fs.readFile(this.file()); }
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
    try {return journalSchema.parse(JSON.parse(this.crypto.decryptString(bytes)));}
    catch {throw new Error('Edit journal cannot be decrypted or validated. Editing is disabled until reviewed.');}
  }
  async begin(goal:string,tool:'app_command'|'external_command',command:string,args?:unknown):Promise<EditIntent>{
    // Refuse to replace an unresolved journal, including a journal from a prior crash.
    if(await this.load())throw new Error('Previous edit intent is unresolved. Inspect and resolve it before another edit.');
    const item=journalSchema.parse({version:1,id:randomUUID(),goal,tool,command:command.slice(0,200),startedAt:new Date().toISOString(),expected:expectedEditIntent(tool,args)});
    const encrypted=this.crypto.encryptString(JSON.stringify(item));
    const temp=`${this.file()}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp,encrypted,{flag:'wx',mode:0o600});
      await fs.rename(temp,this.file());
    } finally {await fs.rm(temp,{force:true}).catch(()=>undefined);}
    return item;
  }
  async clear():Promise<void>{await fs.rm(this.file(),{force:true});}
}

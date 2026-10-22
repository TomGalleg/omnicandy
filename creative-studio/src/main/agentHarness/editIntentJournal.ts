/** Crash-aware, encrypted write-ahead journal for one in-flight model-initiated edit.
 * The journal is distinct from the paused-task checkpoint because it MUST be
 * persisted before dispatching the application command. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CheckpointCrypto } from './taskCheckpoint';
import { expectedBatchFromParams, expectedBatchSchema } from '../integrations/adapters/blenderBatchSpec';
import { expectedScriptFromParams, expectedScriptSchema } from '../integrations/adapters/blenderScriptSpec';

export const expectedRectSchema = z.object({kind:z.literal('photocraft.shape.edit.rect'), layer:z.number().int().min(1), rect:z.tuple([z.number().finite(),z.number().finite(),z.number().finite().positive(),z.number().finite().positive()])});
export type ExpectedRect = z.infer<typeof expectedRectSchema>;
const AXES = ['x','y','z','rx','ry','rz','sx','sy','sz'] as const;
export const expectedBlenderTransformSchema = z.object({
  kind: z.literal('blender.object.transform'), file: z.string().min(1).max(200), object: z.string().min(1).max(200),
  values: z.partialRecord(z.enum(AXES), z.number().finite().min(-1e9).max(1e9)).refine((v) => Object.keys(v).length > 0),
});
export const expectedBlenderMaterialSchema = z.object({
  kind: z.literal('blender.object.color'), file: z.string().min(1).max(200), object: z.string().min(1).max(200), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export const expectedEditSchema = z.discriminatedUnion('kind', [expectedRectSchema, expectedBlenderTransformSchema, expectedBlenderMaterialSchema, expectedBatchSchema, expectedScriptSchema]);
export type ExpectedEdit = z.infer<typeof expectedEditSchema>;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/**
 * A deliberately narrow, deterministic intent extractor: only edits whose result a structured, trusted read-back can
 * confirm. Every other operation stays unresolvable (editing remains blocked) rather than being guessed.
 *  - PhotoCraft shape.edit rectangle (read back with shape.info)
 *  - Blender object.transform / object.color via material.set (read back with the built-in scene.inspect)
 */
export function expectedEditIntent(tool:string, args:unknown):ExpectedEdit | undefined {
  const call = record(args);
  if (!call) return;
  const params = record(call.params);
  if (tool === 'app_command') {
    if (call.command !== 'shape.edit' || !params) return;
    const result = expectedRectSchema.safeParse({kind:'photocraft.shape.edit.rect',layer:params.layer,rect:params.rect});
    return result.success ? result.data : undefined;
  }
  // Blender script.run: the script's hash; recovery compares the saved project's hash with the run marker's before/after hashes.
  if (tool === 'external_command' && call.command === 'script.run' && params) return expectedScriptFromParams(params);
  // Blender scene.build: the batch identity, hash, object ids and a few requested facts (read back with scene.inspect_detail).
  if (tool === 'external_command' && call.command === 'scene.build' && params) return expectedBatchFromParams(params);
  if (tool === 'external_command' && params && typeof params.file_name === 'string' && typeof params.name === 'string') {
    if (call.command === 'object.transform') {
      const values: Record<string, number> = {};
      for (const axis of AXES) if (params[axis] !== undefined) { if (typeof params[axis] !== 'number') return; values[axis] = params[axis] as number; }
      // look_at, parent and new_name change state this read-back cannot compare, so they are not auto-resolvable.
      if (params.look_at !== undefined || params.parent !== undefined || params.new_name !== undefined) return;
      const result = expectedBlenderTransformSchema.safeParse({kind:'blender.object.transform',file:params.file_name,object:params.name,values});
      return result.success ? result.data : undefined;
    }
    if (call.command === 'material.set' && typeof params.color === 'string') {
      const others = ['metallic','roughness','alpha','emission_color','emission_strength'].some((k) => params[k] !== undefined);
      if (others) return;
      const result = expectedBlenderMaterialSchema.safeParse({kind:'blender.object.color',file:params.file_name,object:params.name,color:params.color});
      return result.success ? result.data : undefined;
    }
  }
  return;
}
export const JOURNALED_TOOLS = ['app_command','external_command','photocraft_command','timeline_add','timeline_move_clip','timeline_remove_clip'] as const;
export type JournaledTool = (typeof JOURNALED_TOOLS)[number];
const journalSchema = z.object({
  version:z.literal(1), id:z.string().uuid(), goal:z.string().min(1).max(4000),
  tool:z.enum(JOURNALED_TOOLS), command:z.string().max(200),
  // Intentionally do not store raw arguments, filenames, document content, or secrets.
  // Precise expected state must be separately bound to trusted intent before auto-recovery.
  startedAt:z.string(), expected:expectedEditSchema.optional(),
});
export type EditIntent = z.infer<typeof journalSchema>;
const FILE = '.omnicandy-edit-intent.enc';
/** A batch records its object ids and a few facts, so the record is larger than a single edit; still one small file. */
export const MAX_JOURNAL_BYTES = 32768;
export class EditIntentJournal {
  constructor(private readonly root:string,private readonly crypto:CheckpointCrypto) {}
  private file(){return path.join(this.root,FILE);}
  async load():Promise<EditIntent|null>{
    if (!this.crypto.isEncryptionAvailable()) throw new Error('Secure journal storage unavailable; editing is disabled.');
    let bytes:Buffer;
    try { const stat=await fs.stat(this.file());if(stat.size>MAX_JOURNAL_BYTES)throw new Error('Edit journal too large.');bytes=await fs.readFile(this.file()); }
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
    try {return journalSchema.parse(JSON.parse(this.crypto.decryptString(bytes)));}
    catch {throw new Error('Edit journal cannot be decrypted or validated. Editing is disabled until reviewed.');}
  }
  async begin(goal:string,tool:JournaledTool,command:string,args?:unknown):Promise<EditIntent>{
    // Refuse to replace an unresolved journal, including a journal from a prior crash.
    if(await this.load())throw new Error('Previous edit intent is unresolved. Inspect and resolve it before another edit.');
    const item=journalSchema.parse({version:1,id:randomUUID(),goal,tool,command:command.slice(0,200),startedAt:new Date().toISOString(),expected:expectedEditIntent(tool,args)});
    const encrypted=this.crypto.encryptString(JSON.stringify(item));
    // A record that could not be read back later would disable editing: refuse BEFORE the command is dispatched.
    if(encrypted.length>MAX_JOURNAL_BYTES)throw new Error('Edit intent too large to journal safely; split the edit.');
    const temp=`${this.file()}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp,encrypted,{flag:'wx',mode:0o600});
      await fs.rename(temp,this.file());
    } finally {await fs.rm(temp,{force:true}).catch(()=>undefined);}
    return item;
  }
  async clear():Promise<void>{await fs.rm(this.file(),{force:true});}
}

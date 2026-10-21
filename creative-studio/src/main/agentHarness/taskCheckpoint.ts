/** Encrypted, per-project checkpoint for interrupted independent agent sessions.
 * No secrets, previews, or event logs are stored in cleartext. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Message } from './types';
import { planSchema } from './taskPlan';

const callSchema = z.object({ id: z.string().max(200), name: z.string().max(160), args: z.unknown() });
const messageSchema = z.discriminatedUnion('role', [
  z.object({role: z.literal('user'), content: z.string()}),
  z.object({role: z.literal('tool'), toolCallId: z.string(), content: z.string()}),
  z.object({role: z.literal('assistant'), content: z.string().nullable(), toolCalls: z.array(callSchema).optional()}),
]);
const checkpointSchema = z.object({
  version: z.literal(1), goal: z.string().min(1).max(4000), model: z.string().min(1).max(80),
  status: z.enum(['paused','limit']), messages: z.array(messageSchema).min(1), plan: planSchema.optional(),
  savedAt: z.string(), uncertainEdit: z.string().min(1).max(240).optional(),
});
export type TaskCheckpoint = Omit<z.infer<typeof checkpointSchema>, 'version'|'savedAt'>;
export interface CheckpointCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
const MAX_BYTES = 4 * 1024 * 1024;
const FILE_NAME = '.omnicandy-agent-checkpoint.enc';

/** Drop visual payloads, never persist images or full previews. Retain tool-call order for provider protocol. */
export function checkpointMessages(messages: Message[]): Message[] {
  return messages.flatMap((m): Message[] => {
    if (m.role === 'user' && m.imageDataUrl) return [];
    if (m.role === 'user') return [{role:'user',content:m.content}];
    if (m.role === 'tool') return [{role:'tool',toolCallId:m.toolCallId,content:m.content}];
    return [{role:'assistant',content:m.content,...(m.toolCalls ? { toolCalls:m.toolCalls } : {})}];
  });
}

/** Atomic write. The project folder is determined by ProjectStore, not by model output. */
export class TaskCheckpointStore {
  constructor(private readonly projectRoot: string, private readonly crypto: CheckpointCrypto) {}
  private file(): string { return path.join(this.projectRoot, FILE_NAME); }
  async save(task: TaskCheckpoint): Promise<boolean> {
    if (!this.crypto.isEncryptionAvailable()) return false; // Never downgrade to plaintext.
    const parsed = checkpointSchema.parse({ ...task, version:1, savedAt:new Date().toISOString(), messages:checkpointMessages(task.messages as Message[]) });
    const raw = JSON.stringify(parsed);
    if (Buffer.byteLength(raw) > MAX_BYTES) return false;
    const encrypted = this.crypto.encryptString(raw);
    const temp = `${this.file()}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, encrypted, {flag:'wx',mode:0o600});
      await fs.rename(temp,this.file());
    } finally { await fs.rm(temp,{force:true}).catch(()=>undefined); }
    return true;
  }
  async load(): Promise<TaskCheckpoint | null> {
    if (!this.crypto.isEncryptionAvailable()) return null;
    let bytes: Buffer;
    try { const st = await fs.stat(this.file()); if (st.size > MAX_BYTES * 2) return null; bytes = await fs.readFile(this.file()); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    try {
      const parsed=checkpointSchema.parse(JSON.parse(this.crypto.decryptString(bytes)));
      return {goal:parsed.goal,model:parsed.model,status:parsed.status,messages:parsed.messages as Message[],...(parsed.plan?{plan:parsed.plan}:{}),...(parsed.uncertainEdit?{uncertainEdit:parsed.uncertainEdit}:{})};
    } catch { return null; } // Corrupt / outdated / undecryptable checkpoint: never execute it.
  }
  async clear(): Promise<void> { await fs.rm(this.file(),{force:true}); }
}

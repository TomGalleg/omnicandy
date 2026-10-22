import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { EditIntentJournal, type JournaledTool } from './editIntentJournal';
import { runAgent } from './loop';
import { ScriptedProvider } from './providers/scripted';
import { ToolRegistry, tool } from './registry';
import { TaskCheckpointStore, type CheckpointCrypto } from './taskCheckpoint';
import type { LiveTaskController } from '../liveTask';

/** R2C3B2A end to end, offline: PhotoCraft shape.edit on layer 33 whose edit is applied but whose tool response fails. */
const INTENDED: [number, number, number, number] = [300, 400, 150, 150];
const crypto: CheckpointCrypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))); });

const controller = () => ({ snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null } }), claudeDone: () => {} } as unknown as LiveTaskController);
const call = (id: string, args: unknown, name = 'app_command') => ({ text: null, toolCalls: [{ id, name, args }] });
const end = { text: 'Done', toolCalls: [] };
const edit = { command: 'shape.edit', params: { layer: 33, rect: INTENDED } };

async function rig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shape-recovery-'));
  dirs.push(dir);
  const journal = new EditIntentJournal(dir, crypto);
  const world = { rect: [0, 0, 10, 10] as number[], writes: 0, journalAtExecution: undefined as unknown };
  const registry = () => new ToolRegistry([
    tool('get_status', 'State', z.object({}).strict(), async () => 'revision:current'),
    tool('app_command', 'Native command', z.object({ command: z.string(), params: z.record(z.string(), z.unknown()).optional() }).strict(), async ({ command }) => {
      if (command === 'shape.edit') {
        world.writes++;
        world.journalAtExecution = await journal.load(); // what is on disk at the moment the app is told to edit
        world.rect = [...INTENDED]; // the edit IS applied ...
        throw new Error('Bridge timeout after execution'); // ... but the response is lost
      }
      if (command === 'shape.info') return `Result: ${JSON.stringify({ layer: 33, live: { rect: world.rect } })}`;
      return 'unknown';
    }),
  ]);
  let resolved = 0;
  const hooks = {
    onEditBegin: async (t: JournaledTool, c: string, a: unknown) => { await journal.begin('Resize shape', t, c, a); },
    onEditSettled: async (safe: boolean) => { if (safe) await journal.clear(); },
    onRecoveryResolved: async () => { resolved++; await journal.clear(); },
  };
  return { dir, journal, world, registry, hooks, resolvedCount: () => resolved };
}

async function failedFirstRun(r: Awaited<ReturnType<typeof rig>>) {
  return runAgent({ goal: 'Resize shape', registry: r.registry(), ctl: controller(), ...r.hooks,
    provider: new ScriptedProvider([call('1', edit), call('2', edit), end]) });
}

describe('R2C3B2A shape.edit recovery (layer 33, mocked)', () => {
  it('records the intended rectangle before execution, blocks further edits, and never replays', async () => {
    const r = await rig();
    const first = await failedFirstRun(r);
    expect(r.world.journalAtExecution).toMatchObject({ command: 'shape.edit', expected: { kind: 'photocraft.shape.edit.rect', layer: 33, rect: INTENDED } });
    expect(r.world.writes).toBe(1); // the second shape.edit attempt never reached the app
    expect(first.messages.some((m) => m.role === 'tool' && m.content.includes('Further edits remain blocked'))).toBe(true);
    expect(first.status).toBe('limit');
    expect(first.uncertainEdit).toContain('shape.edit');
    expect(await r.journal.load()).not.toBeNull(); // unresolved operation stays on disk
  });

  it('survives checkpoint and journal restoration, and a mismatched read-back does not release it', async () => {
    const r = await rig();
    const first = await failedFirstRun(r);
    const checkpoint = new TaskCheckpointStore(r.dir, crypto);
    expect(await checkpoint.save({ goal: 'Resize shape', model: 'gpt-4.1-mini', status: 'limit', messages: first.messages, ...(first.uncertainEdit ? { uncertainEdit: first.uncertainEdit } : {}) })).toBe(true);
    // "restart": fresh store and journal instances read the encrypted files
    const restored = await new TaskCheckpointStore(r.dir, crypto).load();
    const intent = await new EditIntentJournal(r.dir, crypto).load();
    expect(restored?.uncertainEdit).toBe(first.uncertainEdit);
    expect(intent?.expected).toEqual({ kind: 'photocraft.shape.edit.rect', layer: 33, rect: INTENDED });

    r.world.rect = [300, 400, 150, 149]; // actual state differs from the intent in one value
    const resumed = await runAgent({ goal: 'Resize shape', registry: r.registry(), ctl: controller(), ...r.hooks,
      resumeMessages: restored!.messages, resumeUncertainEdit: restored!.uncertainEdit, ...(intent?.expected ? { resumeExpectedEdit: intent.expected } : {}),
      provider: new ScriptedProvider([
        call('3', { command: 'shape.info' }),
        call('4', { receipt_id: 'r1', path: 'live.rect.0', expected: 300 }, 'evidence_verify'), // this field alone matches
        call('5', edit), // a retry attempt must still be refused
        end,
      ]) });
    expect(resumed.uncertainEdit).toBe(first.uncertainEdit);
    expect(r.resolvedCount()).toBe(0);
    expect(r.world.writes).toBe(1);
    expect(await r.journal.load()).not.toBeNull();
  });

  it('releases the block only for a matching shape.info read-back plus a passing evidence_verify, still without replay', async () => {
    const r = await rig();
    const first = await failedFirstRun(r);
    const intent = await new EditIntentJournal(r.dir, crypto).load();
    expect(r.world.rect).toEqual(INTENDED);
    const resumed = await runAgent({ goal: 'Resize shape', registry: r.registry(), ctl: controller(), ...r.hooks,
      resumeMessages: first.messages, resumeUncertainEdit: first.uncertainEdit, ...(intent?.expected ? { resumeExpectedEdit: intent.expected } : {}),
      provider: new ScriptedProvider([
        call('3', { command: 'shape.info' }),
        call('4', { receipt_id: 'r1', path: 'live.rect.0', expected: 300 }, 'evidence_verify'),
        end,
      ]) });
    expect(resumed.uncertainEdit).toBeUndefined();
    expect(r.resolvedCount()).toBe(1);
    expect(await r.journal.load()).toBeNull();
    expect(r.world.writes).toBe(1); // the original shape.edit was never replayed
  });
});

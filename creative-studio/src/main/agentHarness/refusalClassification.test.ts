// Regression: Independent AI reached an "uncertain edit" recovery lock after scene.build although NOTHING had been dispatched
// to change anything. The project had no .blend yet, so the adapter refused the command (kind invalid-params: "X.blend is not
// in the Blender folder of this project"). That refusal did not match the text patterns the loop used to recognise a
// definitive refusal, so it was treated as a possibly partial edit: the journal stayed, all edits were blocked, and the way
// out (scene.create_basic, then a read-back of the new file) was itself an edit - a deadlock.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult, CommandErrorKind, ExternalAppInfo } from '@shared/integrations';
import { BLENDER_MANIFEST } from '../integrations/adapters/blender';
import { classifyCommandError } from './commandPreflight';
import { EditIntentJournal } from './editIntentJournal';
import { addExternalTools } from './externalTools';
import { runAgent } from './loop';
import { ScriptedProvider } from './providers/scripted';
import { ToolRegistry } from './registry';
import type { CheckpointCrypto } from './taskCheckpoint';
import type { Message, ProviderReply } from './types';
import type { LiveTaskController } from '../liveTask';

const call = (id: string, name: string, args: unknown): ProviderReply => ({ text: null, toolCalls: [{ id, name, args }] });
const final: ProviderReply = { text: 'done', toolCalls: [] };
const idle = () => ({ snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined }) as unknown as LiveTaskController;
const texts = (m: Message[]) => m.filter((x) => x.role === 'tool').map((x) => x.content);

describe('which command errors can leave an edit uncertain', () => {
  const classify = (kind: CommandErrorKind, message: string) => classifyCommandError(`${kind} ${message}`);
  it('treats every refusal that happens before anything runs as a definitive refusal', () => {
    expect(classify('invalid-params', 'Castle_Batch_Test.blend is not in the Blender folder of this project.')).toBe('validation');
    expect(classify('invalid-params', '"spec" is required for scene.build.')).toBe('validation');
    expect(classify('invalid-params', 'ids must be at most 64 comma-separated cc_ids.')).toBe('validation');
    expect(classify('permission-denied', 'The user did not allow this.')).toBe('permission');
    expect(classify('not-connected', 'Could not connect to Blender: x')).toBe('unavailable');
    expect(classify('missing-app', 'That application is not installed or was not found.')).toBe('unavailable');
    expect(classify('unsupported', 'Blender does not support "nope".')).toBe('unavailable');
  });
  it('still treats anything that may have run as uncertain', () => {
    for (const kind of ['app-error', 'verification-failed', 'timeout', 'cancelled', 'internal'] as const)
      expect(classify(kind, 'Blender stopped with exit code 1: something'), kind).toBe('execution');
    expect(classify('verification-failed', 'The saved file does not show batch b (chunk 1 of 1) as built: absent - nothing')).toBe('execution');
  });
});

const KEY = 'c:\\program files\\blender foundation\\blender 4.0\\blender.exe';
const app = { key: KEY, name: 'Blender', status: 'connected', adapterId: 'blender', adapterName: 'Blender', commands: BLENDER_MANIFEST.commands } as unknown as ExternalAppInfo;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }))); });
const crypto: CheckpointCrypto = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString('utf8') };

describe('a scene.build that the adapter refuses because the project file does not exist yet', () => {
  it('leaves no lock and no journal, so the agent can create the project and build', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-refusal-'));
    roots.push(root);
    const journal = new EditIntentJournal(root, crypto);
    const files = new Set<string>();
    const executed: string[] = [];
    const backend = {
      list: async () => [app], isBuiltin: (id: string) => id === 'blender',
      execute: async (_k: string, command: string, params: Record<string, unknown>): Promise<CommandResult> => {
        executed.push(command);
        if (command === 'scene.create_basic') { files.add(String(params.file_name)); return { ok: true, verified: true, message: 'created', evidence: [], outputs: [], durationMs: 1 }; }
        if (!files.has(String(params.file_name))) {
          const message = `${String(params.file_name)} is not in the Blender folder of this project.`;
          return { ok: false, verified: false, message, evidence: [], outputs: [], durationMs: 1, error: { kind: 'invalid-params', message } };
        }
        return { ok: true, verified: true, message: 'built', evidence: [], outputs: [], durationMs: 1, data: {} };
      },
    } as unknown as Parameters<typeof addExternalTools>[1];
    const spec = { batch_id: 'castle-1', objects: [{ id: 'keep', kind: 'box' }] };
    const build = (id: string) => call(id, 'external_command', { app_key: KEY, command: 'scene.build', params: { file_name: 'Castle.blend', spec } });
    const r = await runAgent({
      goal: 'build a castle', ctl: idle(), registry: addExternalTools(new ToolRegistry(), backend),
      provider: new ScriptedProvider([build('1'), call('2', 'external_command', { app_key: KEY, command: 'scene.create_basic', params: { file_name: 'Castle.blend' } }), build('3'), final]),
      onEditBegin: async (t, c, a) => { await journal.begin('build a castle', t, c, a); },
      onEditSettled: async (safe) => { if (safe) await journal.clear(); },
    });
    expect(texts(r.messages)[0]).toContain('is not in the Blender folder');
    expect(texts(r.messages)[1]).not.toContain('edits remain blocked');
    expect(executed).toEqual(['scene.build', 'scene.create_basic', 'scene.build']); // the refusal did not block the next edits
    expect(r.uncertainEdit).toBeUndefined();
    expect(await journal.load()).toBeNull();
  });
});

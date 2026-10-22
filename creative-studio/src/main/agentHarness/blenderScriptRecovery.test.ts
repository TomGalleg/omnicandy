// Interrupted script.run through the real agent loop, command specs and encrypted journal. Only Blender is faked: a "project file"
// with a content hash and the run marker the adapter keeps, producing the same read-back fields the real adapter does.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CommandResult, ExternalAppInfo } from '@shared/integrations';
import { BLENDER_MANIFEST } from '../integrations/adapters/blender';
import { assessScriptRun, scriptHashOf, type ScriptMarker } from '../integrations/adapters/blenderScriptSpec';
import { EditIntentJournal } from './editIntentJournal';
import { addExternalTools } from './externalTools';
import { runAgent } from './loop';
import { ScriptedProvider } from './providers/scripted';
import { ToolRegistry, tool } from './registry';
import type { CheckpointCrypto } from './taskCheckpoint';
import type { Message, ProviderReply } from './types';
import type { LiveTaskController } from '../liveTask';

const call = (id: string, name: string, args: unknown): ProviderReply => ({ text: null, toolCalls: [{ id, name, args }] });
const final: ProviderReply = { text: 'done', toolCalls: [] };
const idle = () => ({ snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined }) as unknown as LiveTaskController;
const texts = (m: Message[]) => m.filter((x) => x.role === 'tool').map((x) => x.content);

const CODE = 'import bpy\narm = bpy.data.armatures.new("Rig")';
const HASH = scriptHashOf(CODE);
const BEFORE = 'a'.repeat(64);
const AFTER = 'b'.repeat(64);
const run = (id: string) => call(id, 'external_command', { app_key: 'blender-1', command: 'script.run', params: { file_name: 'a.blend', script: { purpose: 'add a rig', code: CODE } } });
const inspect = (id: string) => call(id, 'external_command', { app_key: 'blender-1', command: 'scene.inspect_detail', params: { file_name: 'a.blend', script_hash: HASH } });
const verify = (id: string, receipt: string, expected: string) => call(id, 'evidence_verify', { receipt_id: receipt, path: 'data.script.outcome', expected });

function world(sha: string, marker: ScriptMarker | null, file = 'a.blend') {
  const w = { sha, marker, file, executed: [] as string[], atDispatch: undefined as unknown };
  return w;
}
type World = ReturnType<typeof world>;
const started = (over: Partial<ScriptMarker> = {}): ScriptMarker => ({ file: 'a.blend', script_hash: HASH, state: 'swapping', before_sha256: BEFORE, after_sha256: AFTER, at: 'now', ...over });

function backend(w: World, opts: { script?: 'lose-before-swap' | 'swap-then-lose' | 'refused'; journal?: EditIntentJournal } = {}) {
  const app = { key: 'blender-1', name: 'Blender', status: 'connected', adapterId: 'blender', adapterName: 'Blender', commands: BLENDER_MANIFEST.commands } as unknown as ExternalAppInfo;
  const ok = (data: Record<string, unknown>): CommandResult => ({ ok: true, verified: true, message: 'ok', evidence: ['fresh process'], outputs: [], durationMs: 1, data });
  return {
    list: async () => [app], isBuiltin: (id: string) => id === 'blender',
    execute: async (_k: string, command: string, params: Record<string, unknown>): Promise<CommandResult> => {
      w.executed.push(command);
      if (command === 'script.run') {
        w.atDispatch = await opts.journal?.load();
        if (opts.script === 'refused') { const message = 'invalid parameter - script_refused: line 2: the name os is not available. Nothing was changed.'; return { ok: false, verified: false, message, evidence: [], outputs: [], durationMs: 1, error: { kind: 'app-error', message } }; }
        w.marker = { file: 'a.blend', script_hash: HASH, state: 'started', before_sha256: w.sha, at: 'now' };
        if (opts.script === 'lose-before-swap') throw new Error('Blender crashed before the swap');
        w.marker = { ...w.marker, state: 'swapping', after_sha256: AFTER };
        w.sha = AFTER;
        if (opts.script === 'swap-then-lose') throw new Error('Bridge timeout after the swap');
        return ok({ status: 'applied' });
      }
      if (command === 'scene.inspect_detail') {
        const project = { file: w.file, file_sha256: w.sha };
        const h = String(params.script_hash ?? '');
        return ok({ project, script_marker: w.marker, ...(h ? { script: { script_hash: h, ...assessScriptRun(w.marker, w.sha, project, { file: 'a.blend', script_hash: h }) } } : {}) });
      }
      return ok({});
    },
  } as unknown as Parameters<typeof addExternalTools>[1];
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }))); });
const crypto: CheckpointCrypto = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString('utf8') };
async function journal() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-script-rec-')); roots.push(root); return new EditIntentJournal(root, crypto); }
const withStatus = (b: ReturnType<typeof backend>) => { const r = addExternalTools(new ToolRegistry(), b); r.add(tool('get_status', 'status', z.object({}).strict(), async () => 'current')); return r; };

async function interrupted(how: 'lose-before-swap' | 'swap-then-lose') {
  const j = await journal();
  const w = world(BEFORE, null);
  const first = await runAgent({
    goal: 'rig the model', ctl: idle(), registry: addExternalTools(new ToolRegistry(), backend(w, { script: how, journal: j })), provider: new ScriptedProvider([run('1'), final]),
    onEditBegin: async (t, c, a) => { await j.begin('rig the model', t, c, a); }, onEditSettled: async (safe) => { if (safe) await j.clear(); },
  });
  return { j, first, w };
}
async function resume(j: EditIntentJournal, first: Awaited<ReturnType<typeof interrupted>>['first'], w: World, script: ProviderReply[], cleared = { n: 0 }) {
  return runAgent({
    goal: 'rig the model', ctl: idle(), registry: withStatus(backend(w, { script: 'swap-then-lose', journal: j })), provider: new ScriptedProvider(script),
    resumeMessages: first.messages, resumeUncertainEdit: first.uncertainEdit, resumeExpectedEdit: (await j.load())!.expected,
    onEditBegin: async (t, c, a) => { await j.begin('rig the model', t, c, a); }, onEditSettled: async (safe) => { if (safe) await j.clear(); },
    onRecoveryResolved: async () => { cleared.n++; await j.clear(); },
  });
}

describe('an interrupted script.run, through the real agent loop', () => {
  it('records the script identity (hash, never the code) before the command reaches Blender', async () => {
    const { j, first, w } = await interrupted('lose-before-swap');
    expect(first.uncertainEdit).toContain('script.run');
    expect((w.atDispatch as { expected?: unknown })?.expected).toEqual({ kind: 'blender.script.run', file: 'a.blend', script_hash: HASH });
    expect(JSON.stringify(await j.load())).not.toContain('armatures');
  });

  it('APPLIED: the project is exactly the validated result; the lock is released and the script is never replayed', async () => {
    const { j, first } = await interrupted('swap-then-lose');
    const w = world(AFTER, started());
    const cleared = { n: 0 };
    const r = await resume(j, first, w, [run('2'), inspect('3'), verify('4', 'r1', 'applied'), final], cleared);
    expect(w.executed).toEqual(['scene.inspect_detail']);
    expect(texts(r.messages).some((t) => t.includes('Further edits remain blocked') && t.includes('script_hash') && t.includes('data.script.outcome'))).toBe(true);
    expect(texts(r.messages).some((t) => /Recovery assessment \(host.*applied/.test(t) && t.includes('do not run the script again'))).toBe(true);
    expect(r.uncertainEdit).toBeUndefined();
    expect(cleared.n).toBe(1);
    expect(await j.load()).toBeNull();
  });

  it('ABSENT: the project is exactly what it was before, so the script may run again (and is approved again by the manager)', async () => {
    const { j, first } = await interrupted('lose-before-swap');
    const w = world(BEFORE, started({ state: 'started', after_sha256: undefined }));
    const cleared = { n: 0 };
    const r = await resume(j, first, w, [run('2'), inspect('3'), verify('4', 'r1', 'absent'), run('5'), final], cleared);
    expect(texts(r.messages).filter((t) => t.includes('Further edits remain blocked')).length).toBe(1); // refused before the proof
    expect(w.executed).toEqual(['scene.inspect_detail', 'script.run']); // exactly one run, after the proof
    expect(cleared.n).toBe(1);
  });

  it('AMBIGUOUS: a project that is neither the old nor the new file keeps the lock, whatever the model verifies', async () => {
    const { j, first } = await interrupted('swap-then-lose');
    const w = world('c'.repeat(64), started()); // changed by hand after the run
    const cleared = { n: 0 };
    const r = await resume(j, first, w, [inspect('2'), verify('3', 'r1', 'ambiguous'), run('4'), final, final], cleared);
    expect(texts(r.messages).some((t) => /Recovery assessment \(host.*ambiguous/.test(t) && t.includes('The lock stays'))).toBe(true);
    expect(w.executed).toEqual(['scene.inspect_detail']);
    expect(r.uncertainEdit).toContain('script.run');
    expect(cleared.n).toBe(0);
    expect(await j.load()).not.toBeNull();
  });

  it('AMBIGUOUS: another script\'s record, or a different project, never releases the lock', async () => {
    for (const w of [world(AFTER, started({ script_hash: 'f'.repeat(64) })), world(AFTER, started(), 'other.blend'), world(AFTER, null)]) {
      const { j, first } = await interrupted('swap-then-lose');
      const r = await resume(j, first, w, [inspect('2'), verify('3', 'r1', 'ambiguous'), final, final]);
      expect(r.uncertainEdit).toContain('script.run');
      expect(await j.load()).not.toBeNull();
    }
  });

  it('a script refused before it ran (restricted import, syntax) leaves no lock and no journal', async () => {
    const j = await journal();
    const w = world(BEFORE, null);
    const r = await runAgent({
      goal: 'rig', ctl: idle(), registry: addExternalTools(new ToolRegistry(), backend(w, { script: 'refused', journal: j })), provider: new ScriptedProvider([run('1'), final, final]),
      onEditBegin: async (t, c, a) => { await j.begin('rig', t, c, a); }, onEditSettled: async (safe) => { if (safe) await j.clear(); },
    });
    expect(texts(r.messages)[0]).toContain('script_refused');
    expect(r.uncertainEdit).toBeUndefined();
    expect(await j.load()).toBeNull();
  });
});

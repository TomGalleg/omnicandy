// Recovery of an interrupted Blender batch through the REAL agent loop, the real external tools, the real command specs of the
// built-in Blender adapter, the encrypted edit journal and the host's recovery assessment. Only Blender itself is faked
// (a small world with a batch ledger); the live tests prove the real Blender produces exactly this read-back.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CommandResult, ExternalAppInfo } from '@shared/integrations';
import { BLENDER_MANIFEST } from '../integrations/adapters/blender';
import { expectedBatchFromParams } from '../integrations/adapters/blenderBatchSpec';
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
const ctlWith = (phase: () => string) => ({
  snapshot: () => ({ collab: { phase: phase(), lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }),
  claudeDone: () => undefined,
}) as unknown as LiveTaskController;
const idle = () => ctlWith(() => 'idle');
const toolTexts = (messages: Message[]) => messages.filter((m) => m.role === 'tool').map((m) => m.content);

const SPEC = {
  batch_id: 'castle',
  objects: [
    { id: 'tower', kind: 'cylinder', loc: [4, 4, 0], material: { color: '#ff0000' } },
    { id: 'wall', kind: 'box', loc: [0, 4, 1.5] },
  ],
};
const PARAMS = { file_name: 'a.blend', spec: SPEC };
const EXPECTED = expectedBatchFromParams(PARAMS)!;
const build = (id: string, over: Record<string, unknown> = {}) => call(id, 'external_command', { app_key: 'blender-1', command: 'scene.build', params: { ...PARAMS, ...over } });
const inspect = (id: string) => call(id, 'external_command', { app_key: 'blender-1', command: 'scene.inspect_detail', params: { file_name: 'a.blend', ids: 'tower,wall', batch_id: 'castle' } });
const verifyState = (id: string, receipt: string, expected: string) => call(id, 'evidence_verify', { receipt_id: receipt, path: 'data.batch.state', expected });

interface Item { id: string; location: number[]; materials: Array<{ name: string; color: number[] }> }
function world(init: { file?: string; applied?: boolean; only?: string[]; ledgerOk?: boolean; moved?: boolean } = {}) {
  const w = { file: init.file ?? 'a.blend', pid: 'pid0123456789', objects: new Map<string, Item>(), ledger: [] as Array<Record<string, unknown>>, ledgerOk: init.ledgerOk ?? true, executed: [] as string[], atDispatch: undefined as unknown };
  const apply = (only?: string[]) => {
    for (const o of SPEC.objects) if (!only || only.includes(o.id)) w.objects.set(o.id, { id: o.id, location: [...o.loc], materials: [{ name: 'm', color: o.material ? [1, 0, 0] : [0.8, 0.8, 0.8] }] });
  };
  if (init.applied) { apply(); w.ledger.push({ batch: 'castle', chunk: 0, total: 1, hash: EXPECTED.spec_hash, n: 2 }); }
  if (init.only) apply(init.only);
  if (init.moved) w.objects.get('tower')!.location = [40, 4, 0];
  return Object.assign(w, { apply });
}
type World = ReturnType<typeof world>;

function backend(w: World, opts: { build?: 'apply-then-lose' | 'lose-before' | 'ok' | 'denied'; journal?: EditIntentJournal } = {}) {
  const app = { key: 'blender-1', name: 'Blender', status: 'connected', adapterId: 'blender', adapterName: 'Blender', commands: BLENDER_MANIFEST.commands } as unknown as ExternalAppInfo;
  const ok = (data: Record<string, unknown>): CommandResult => ({ ok: true, verified: true, message: 'ok', evidence: ['fresh process'], outputs: [], durationMs: 1, data });
  return {
    list: async () => [app],
    isBuiltin: (id: string) => id === 'blender',
    execute: async (_k: string, command: string, params: Record<string, unknown>): Promise<CommandResult> => {
      w.executed.push(command);
      if (command === 'scene.build') {
        w.atDispatch = await opts.journal?.load(); // what the journal held at the moment the command reached Blender
        if (opts.build === 'denied') return { ok: false, verified: false, message: 'The user did not allow this. Do not ask again unless they bring it up.', evidence: [], outputs: [], durationMs: 1, error: { kind: 'permission-denied', message: 'The user did not allow this.' } };
        if (opts.build === 'lose-before') throw new Error('Bridge timeout before the command ran');
        w.apply();
        w.ledger.push({ batch: 'castle', chunk: 0, total: 1, hash: EXPECTED.spec_hash, n: 2 });
        if (opts.build === 'apply-then-lose') throw new Error('Bridge timeout after execution');
        return ok({ status: 'applied' });
      }
      if (command === 'scene.inspect_detail') {
        const ids = String(params.ids ?? '').split(',').filter(Boolean);
        const present = ids.filter((i) => w.objects.has(i));
        const recorded = w.ledger.some((e) => e.batch === params.batch_id && e.chunk === Number(params.chunk ?? 0));
        return ok({
          count: w.objects.size, project: { file: w.file, project_id: w.pid }, cc_ids: [...w.objects.keys()], cc_ids_truncated: false,
          details: ids.map((i) => w.objects.get(i)).filter(Boolean),
          ledger: w.ledgerOk ? { ok: true, entries: w.ledger } : { ok: false, error: 'the ledger is not valid JSON', entries: [] },
          batch: { batch_id: params.batch_id, state: !w.ledgerOk ? 'corrupt' : recorded ? 'recorded' : present.length ? 'partial' : 'absent' },
        });
      }
      return ok({});
    },
  } as unknown as Parameters<typeof addExternalTools>[1];
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }))); });
const crypto: CheckpointCrypto = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString('utf8') };
async function journal() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-batch-rec-')); roots.push(root); return new EditIntentJournal(root, crypto); }
const withStatus = (b: ReturnType<typeof backend>) => { const r = addExternalTools(new ToolRegistry(), b); r.add(tool('get_status', 'status', z.object({}).strict(), async () => 'current')); return r; };

/** First run: the build is dispatched with the journal armed, and its answer is lost. */
async function interrupted(w: World, how: 'apply-then-lose' | 'lose-before') {
  const j = await journal();
  const first = await runAgent({
    goal: 'build the castle', ctl: idle(), registry: addExternalTools(new ToolRegistry(), backend(w, { build: how, journal: j })), provider: new ScriptedProvider([build('1'), final]),
    onEditBegin: async (t, c, a) => { await j.begin('build the castle', t, c, a); },
    onEditSettled: async (safe) => { if (safe) await j.clear(); },
  });
  return { j, first };
}
/** Continue Task after a restart: the persisted transcript, uncertain edit and journalled expectation are all that is known. */
async function resume(j: EditIntentJournal, first: Awaited<ReturnType<typeof interrupted>>['first'], w: World, script: ProviderReply[], cleared = { n: 0 }) {
  const intent = await j.load();
  const b = backend(w, { build: 'ok', journal: j });
  const r = await runAgent({
    goal: 'build the castle', ctl: idle(), registry: withStatus(b), provider: new ScriptedProvider(script),
    resumeMessages: first.messages, resumeUncertainEdit: first.uncertainEdit, resumeExpectedEdit: intent!.expected,
    onEditBegin: async (t, c, a) => { await j.begin('build the castle', t, c, a); },
    onEditSettled: async (safe) => { if (safe) await j.clear(); },
    onRecoveryResolved: async () => { cleared.n++; await j.clear(); },
  });
  return r;
}

describe('an interrupted Blender batch, through the real agent loop', () => {
  it('records the batch identity and expected objects durably BEFORE the command reaches Blender', async () => {
    const w = world();
    const { j, first } = await interrupted(w, 'lose-before');
    expect(first.uncertainEdit).toContain('scene.build');
    const atDispatch = w.atDispatch as Awaited<ReturnType<EditIntentJournal['load']>>;
    expect(atDispatch?.expected).toMatchObject({ kind: 'blender.scene.batch', file: 'a.blend', batch_id: 'castle', chunk: 0, total: 1, ids: ['tower', 'wall'], spec_hash: EXPECTED.spec_hash });
    expect(atDispatch?.expected).toEqual(EXPECTED);
    expect(JSON.stringify(atDispatch)).not.toContain('cylinder'); // the raw spec is never stored
    expect((await j.load())?.expected).toEqual(EXPECTED); // and it survives the lost response
  });

  it('SUCCESSFUL: the lost answer hid a completed batch; a fresh read-back releases the lock and the batch is never replayed', async () => {
    const w = world();
    const { j, first } = await interrupted(w, 'apply-then-lose');
    expect(w.objects.size).toBe(2); // it did happen
    const cleared = { n: 0 };
    const w2 = world({ applied: true }); // the next process sees the saved project
    const r = await resume(j, first, w2, [build('2'), inspect('3'), verifyState('4', 'r1', 'recorded'), final], cleared);
    expect(w2.executed).toEqual(['scene.inspect_detail']); // the blocked replay never reached Blender
    expect(toolTexts(r.messages).some((t) => t.includes('Further edits remain blocked'))).toBe(true);
    expect(toolTexts(r.messages).some((t) => /Recovery assessment \(host.*applied/.test(t))).toBe(true);
    expect(r.uncertainEdit).toBeUndefined();
    expect(cleared.n).toBe(1);
    expect(await j.load()).toBeNull();
    expect(r.status).toBe('completed');
  });

  it('ABSENT: only a fresh read-back that proves nothing was saved lets the same batch run again', async () => {
    const w = world();
    const { j, first } = await interrupted(w, 'lose-before');
    const w2 = world(); // nothing in the saved project
    const b2 = backend(w2, { build: 'ok', journal: j });
    const cleared = { n: 0 };
    const r = await runAgent({
      goal: 'build the castle', ctl: idle(), registry: withStatus(b2), provider: new ScriptedProvider([build('2'), inspect('3'), verifyState('4', 'r1', 'absent'), build('5'), inspect('6'), verifyState('7', 'r3', 'recorded'), final]),
      resumeMessages: first.messages, resumeUncertainEdit: first.uncertainEdit, resumeExpectedEdit: (await j.load())!.expected,
      onEditBegin: async (t, c, a) => { await j.begin('build the castle', t, c, a); },
      onEditSettled: async (safe) => { if (safe) await j.clear(); },
      onRecoveryResolved: async () => { cleared.n++; await j.clear(); },
    });
    const texts = toolTexts(r.messages);
    expect(texts.filter((t) => t.includes('Further edits remain blocked')).length).toBe(1); // before the proof: the retry was refused
    expect(texts.some((t) => /Recovery assessment \(host.*absent/.test(t) && t.includes('may be run again'))).toBe(true);
    expect(w2.executed).toEqual(['scene.inspect_detail', 'scene.build', 'scene.inspect_detail']); // after the proof: exactly one build
    expect(cleared.n).toBe(1);
    expect(r.uncertainEdit).toBeUndefined();
    expect(r.status).toBe('completed');
  });

  it('PARTIAL: objects without a ledger entry keep the lock, the journal, and refuse any replay', async () => {
    const { j, first } = await interrupted(world(), 'apply-then-lose');
    const w = world({ only: ['tower'] });
    const cleared = { n: 0 };
    const r = await resume(j, first, w, [inspect('2'), verifyState('3', 'r1', 'partial'), build('4'), final, final], cleared);
    expect(toolTexts(r.messages).some((t) => /Recovery assessment \(host.*partial/.test(t) && t.includes('The lock stays'))).toBe(true);
    expect(toolTexts(r.messages).some((t) => t.includes('"passed":true'))).toBe(true); // the comparison itself is fine; the host still decides
    expect(w.executed).toEqual(['scene.inspect_detail']);
    expect(r.uncertainEdit).toContain('scene.build');
    expect(cleared.n).toBe(0);
    expect(await j.load()).not.toBeNull();
    expect(r.status).not.toBe('completed');
  });

  const ambiguous: Array<[string, () => World, string]> = [
    ['an incorrect project identity', () => world({ applied: true, file: 'someone-else.blend' }), 'recorded'],
    ['a damaged ledger', () => world({ applied: true, ledgerOk: false }), 'corrupt'],
    ['requested content that no longer matches', () => world({ applied: true, moved: true }), 'recorded'],
    ['a ledger entry without its objects', () => { const w = world({ applied: true }); w.objects.delete('wall'); return w; }, 'recorded'],
  ];
  for (const [name, make, state] of ambiguous) {
    it(`AMBIGUOUS (${name}): never cleared automatically and never replayed, whatever the model verifies`, async () => {
      const { j, first } = await interrupted(world(), 'apply-then-lose');
      const w = make();
      const cleared = { n: 0 };
      const r = await resume(j, first, w, [inspect('2'), verifyState('3', 'r1', state), build('4'), final, final], cleared);
      expect(toolTexts(r.messages).some((t) => /Recovery assessment \(host.*ambiguous/.test(t))).toBe(true);
      expect(w.executed).toEqual(['scene.inspect_detail']);
      expect(r.uncertainEdit).toContain('scene.build');
      expect(cleared.n).toBe(0);
      expect(await j.load()).not.toBeNull();
      expect(r.status).not.toBe('completed');
    });
  }

  it('does not trust a read-back taken before the interruption was inspected, or the edit response itself', async () => {
    const { j, first } = await interrupted(world(), 'apply-then-lose');
    const w = world({ applied: true });
    // verifying against a receipt that is not a trusted read-back of this project (the execution receipt) cannot release the lock
    const r = await resume(j, first, w, [call('2', 'evidence_verify', { receipt_id: 'r1', path: 'data.batch.state', expected: 'recorded' }), final, final]);
    expect(r.uncertainEdit).toContain('scene.build');
    expect(await j.load()).not.toBeNull();
  });

  it('a refused permission is not an uncertain edit: nothing was dispatched to change anything and the journal is cleared', async () => {
    const w = world();
    const j = await journal();
    const r = await runAgent({
      goal: 'build', ctl: idle(), registry: addExternalTools(new ToolRegistry(), backend(w, { build: 'denied', journal: j })), provider: new ScriptedProvider([build('1'), final, final]),
      onEditBegin: async (t, c, a) => { await j.begin('build', t, c, a); }, onEditSettled: async (safe) => { if (safe) await j.clear(); },
    });
    expect(toolTexts(r.messages)[0]).toMatch(/permission/i);
    expect(r.uncertainEdit).toBeUndefined();
    expect(await j.load()).toBeNull();
    expect(w.objects.size).toBe(0);
  });

  it('a spec that fails validation is refused before dispatch and leaves no uncertainty', async () => {
    const w = world();
    const j = await journal();
    const r = await runAgent({
      goal: 'build', ctl: idle(), registry: addExternalTools(new ToolRegistry(), backend(w, { build: 'ok', journal: j })), provider: new ScriptedProvider([build('1', { spec: '{not json' }), build('2', { nope: 1 }), final, final]),
      onEditBegin: async (t, c, a) => { await j.begin('build', t, c, a); }, onEditSettled: async (safe) => { if (safe) await j.clear(); },
    });
    expect(w.executed).toEqual([]);
    expect(toolTexts(r.messages)[0]).toMatch(/valid JSON/);
    expect(toolTexts(r.messages)[1]).toMatch(/Unknown parameter "nope"/);
    expect(r.uncertainEdit).toBeUndefined();
    expect(await j.load()).toBeNull();
  });

  it('human takeover: nothing is dispatched once the user takes control of the application', async () => {
    const w = world();
    const j = await journal();
    let began = 0;
    let phase = 'idle';
    const provider = new ScriptedProvider([build('1'), final]);
    const orig = provider.complete.bind(provider);
    provider.complete = async (i) => { const r = await orig(i); if (r.toolCalls[0]?.id === '1') phase = 'manual'; return r; }; // the user takes over while the model is answering
    const r = await runAgent({
      goal: 'build', ctl: ctlWith(() => phase), registry: addExternalTools(new ToolRegistry(), backend(w, { build: 'ok', journal: j })), provider,
      onEditBegin: async () => { began++; },
    });
    expect(r.status).toBe('paused');
    expect(w.executed).toEqual([]);
    expect(began).toBe(0);
    expect(await j.load()).toBeNull();
  });
});

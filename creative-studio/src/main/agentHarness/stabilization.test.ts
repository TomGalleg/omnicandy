// Regression tests for the four failures confirmed by live validation (Round 4). Offline; no provider, app or approval is contacted.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent } from './loop';
import { ToolRegistry, tool } from './registry';
import { ScriptedProvider } from './providers/scripted';
import { prepareNewTask } from './startGuard';
import { TaskCheckpointStore, type CheckpointCrypto } from './taskCheckpoint';
import { NATIVE_READBACK_COMMANDS } from './nativeReadback';
import { ClaudePartner, type ClaudePartnerDeps } from '../claudePartner';
import { approvalAsker, GenerationService, type ApprovalRequest } from '../generation';
import { keepPermittedCommands } from '../photocraftLive';
import { formatDiscoveredCommands } from '../commandDiscovery';
import { checkPhotoCraftOp, commandTier } from '@shared/photocraftOps';
import { SafeStorageVault, type Encryptor } from '../credentialVault';
import { ProjectStore } from '../projectStore';
import type { LiveTaskController } from '../liveTask';
import type { ProviderReply } from './types';

const ctlWith = (phase: string, lockOwner: string | null = null, activeOperation: string | null = null) =>
  ({ snapshot: () => ({ collab: { phase, lockOwner, activeOperation }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined }) as unknown as LiveTaskController;
const call = (id: string, name: string, args: unknown): ProviderReply => ({ text: null, toolCalls: [{ id, name, args }] });
const final: ProviderReply = { text: 'done', toolCalls: [] };
const toolText = (messages: Array<{ role: string; content?: string | null }>, n: number) => messages.filter((m) => m.role === 'tool').map((m) => m.content ?? '')[n] ?? '';

// ------------------------------------------------------------------ F3
describe('F3: a refused Run never destroys the paused task', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }))); });
  const crypto: CheckpointCrypto = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString('utf8') };
  const base = (over: Partial<Parameters<typeof prepareNewTask>[0]> = {}) => {
    const calls = { reset: 0 };
    return { calls, request: { busy: false, loadJournal: async () => null, claudeWorking: false, ctl: ctlWith('idle'), hasPausedTask: true, reset: async () => { calls.reset++; }, ...over } };
  };

  it('rejects before reset in every blocked state', async () => {
    const cases: Array<[string, Partial<Parameters<typeof prepareNewTask>[0]>, RegExp]> = [
      ['busy', { busy: true }, /already working/],
      ['unresolved journal', { loadJournal: async () => ({ tool: 'app_command' }) }, /Unresolved edit journal/],
      ['claude working', { claudeWorking: true }, /Stop Claude/],
      ['running operation', { ctl: ctlWith('idle', null, 'op-1') }, /already running/],
      ['phase running', { ctl: ctlWith('running') }, /already running/],
      ['user has control (manual)', { ctl: ctlWith('manual', 'user') }, /user has control/],
      ['pausing', { ctl: ctlWith('pausing') }, /paused/],
      ['dormant pause after hand-back', { ctl: ctlWith('paused') }, /Continue Task/],
      ['awaiting approval', { ctl: ctlWith('awaiting_approval') }, /paused/],
      ['lock owner user', { ctl: ctlWith('idle', 'user') }, /user has control/],
    ];
    for (const [name, over, message] of cases) {
      const { calls, request } = base(over);
      await expect(prepareNewTask(request), name).rejects.toThrow(message);
      expect(calls.reset, `${name}: reset must not run`).toBe(0);
    }
  });
  it('tells the user how to keep or discard the interrupted task', async () => {
    await expect(prepareNewTask(base({ ctl: ctlWith('paused') }).request)).rejects.toThrow(/interrupted task is kept.*Continue Task.*Cancel task/);
    await expect(prepareNewTask(base({ ctl: ctlWith('paused'), hasPausedTask: false }).request)).rejects.not.toThrow(/interrupted task is kept/);
  });
  it('replaces the old task only when every check passed (existing replacement rule)', async () => {
    const { calls, request } = base();
    await prepareNewTask(request);
    expect(calls.reset).toBe(1);
  });
  it('keeps the encrypted checkpoint loadable after a rejected Run, so Continue Task still works', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicandy-f3-'));
    roots.push(root);
    const store = new TaskCheckpointStore(root, crypto);
    expect(await store.save({ goal: 'interrupted work', model: 'm', status: 'paused', messages: [{ role: 'user', content: 'interrupted work' }], provider: { provider: 'local', endpoint: 'http://127.0.0.1:1/v1' }, budget: { maxTurns: 7 } })).toBe(true);
    const reset = async () => { await store.clear(); };
    await expect(prepareNewTask({ busy: false, loadJournal: async () => null, claudeWorking: false, ctl: ctlWith('paused'), hasPausedTask: true, reset })).rejects.toThrow();
    const kept = await store.load();
    expect(kept).toMatchObject({ goal: 'interrupted work', status: 'paused', provider: { provider: 'local' }, budget: { maxTurns: 7 } });
    // after hand-back and a free controller, the same task resumes and a genuinely new task may replace it
    await prepareNewTask({ busy: false, loadJournal: async () => null, claudeWorking: false, ctl: ctlWith('idle'), hasPausedTask: true, reset });
    expect(await store.load()).toBeNull();
  });
  it('resuming after hand-back still works: the interrupted transcript continues without replaying edits', async () => {
    let edits = 0;
    const registry = new ToolRegistry([
      tool('get_status', 'status', z.object({}).strict(), async () => 'current'),
      tool('app_command', 'cmd', z.object({ command: z.string() }).strict(), async () => { edits++; return 'Result: {}'; }),
    ]);
    const r = await runAgent({ goal: 'g', ctl: ctlWith('idle'), registry, provider: new ScriptedProvider([final]), resumeMessages: [{ role: 'user', content: 'g' }] });
    expect(r.status).toBe('completed');
    expect(edits).toBe(0);
    await expect(runAgent({ goal: 'g', ctl: ctlWith('paused'), registry, provider: new ScriptedProvider([final]), resumeMessages: [{ role: 'user', content: 'g' }] })).rejects.toThrow(/User control or pause/);
  });
});

// ------------------------------------------------------------------ F1
describe('F1: structured read-back followed by PhotoCraft diagnostics', () => {
  // Exact format captured from real PhotoCraft (Round 4): result, then the controller's validation note.
  const captured = 'shape.info (PhotoCraft) applied.\nResult: {"bounds":[20,30,100,60],"fill":"#ff0000","kind":"rect","layer":43,"live":{"kind":"rect","radii":[0,0,0,0],"rect":[20,30,100,60]},"name":"Live}Rect","path":{"fillRule":"nonzero","inverted":false,"subpaths":[{"closed":true,"knots":[{"anchor":[20,30],"in":[20,30],"out":[20,30],"smooth":false},{"anchor":[120,30],"in":[120,30],"out":[120,30],"smooth":false}],"op":"combine"}]},"stroke":null}\nParameter validation unavailable: Cannot validate shape.info: unsupported schema for "layer". Do not execute.';
  const registryFor = (reply: string, applied: () => void = () => undefined) => new ToolRegistry([
    tool('app_command', 'cmd', z.object({ command: z.string(), params: z.record(z.string(), z.unknown()).optional() }).strict(), async ({ command }) => { if (command === 'shape.create') applied(); return command === 'shape.info' ? reply : 'shape.create applied.'; }),
  ]);
  const verify = (id: string, receipt: string, path: string, expected: unknown) => call(id, 'evidence_verify', { receipt_id: receipt, path, expected });
  const edit = call('1', 'app_command', { command: 'shape.create', params: { kind: 'rect' } });
  const info = call('2', 'app_command', { command: 'shape.info', params: { layer: 43 } });
  const run = (reply: string, script: ProviderReply[]) => runAgent({ goal: 'g', ctl: ctlWith('idle'), registry: registryFor(reply), provider: new ScriptedProvider(script) });

  it('accepts shape.info {layer} with trailing diagnostics as a read-back and completes after a matching comparison', async () => {
    const r = await run(captured, [edit, info, verify('3', 'r2', 'live.rect.0', 20), verify('4', 'r2', 'layer', 43), final]);
    expect(toolText(r.messages, 2)).toContain('"passed":true');
    expect(toolText(r.messages, 3)).toContain('"passed":true');
    expect(r.status).toBe('completed');
  });
  it('still rejects a mismatch and does not treat the diagnostic text as evidence', async () => {
    const mismatch = await run(captured, [edit, info, verify('3', 'r2', 'live.rect.0', 21), final, final]);
    expect(toolText(mismatch.messages, 2)).toContain('"passed":false');
    expect(mismatch.status).toBe('limit');
    const diag = await run(captured, [edit, info, verify('3', 'r2', 'Parameter', 'validation'), final, final]);
    expect(toolText(diag.messages, 2)).toMatch(/not (present|usable)|Error/);
    expect(diag.status).toBe('limit');
  });
  it('does not accept partial or malformed JSON, or junk glued to the closing bracket', async () => {
    for (const reply of [
      'Result: {"layer":43,"live":{"rect":[20,30,100,60]',
      'Result: {"layer":43,"live":{"rect":[20,30,100,60]}}garbage\nnote',
      'Result: {"layer":43,"live":}',
      'Result: ]',
      'Result: not json at all\n{"layer":43}',
    ]) {
      const r = await run(reply, [edit, info, verify('3', 'r2', 'live.rect.0', 20), final, final]);
      expect(toolText(r.messages, 2), reply).toContain('no eligible structured read-back');
      expect(r.status).toBe('limit');
    }
  });
  it('keeps the freshness rule: a read-back taken before the latest edit does not verify it', async () => {
    const r = await run(captured, [info, edit, verify('3', 'r1', 'live.rect.0', 20), final, final]);
    expect(r.status).toBe('limit');
  });
  it('lets the diagnostic-bearing read-back release a recorded rectangle recovery lock', async () => {
    const registry = registryFor(captured);
    registry.add(tool('get_status', 'status', z.object({}).strict(), async () => 'current'));
    const r = await runAgent({ goal: 'g', ctl: ctlWith('idle'), registry, resumeMessages: [{ role: 'user', content: 'g' }], resumeUncertainEdit: 'app_command (shape.edit)',
      resumeExpectedEdit: { kind: 'photocraft.shape.edit.rect', layer: 43, rect: [20, 30, 100, 60] },
      provider: new ScriptedProvider([info, verify('3', 'r1', 'live.rect.0', 20), final]) });
    expect(r.uncertainEdit).toBeUndefined();
  });
});

// ------------------------------------------------------------------ F2
describe('F2: document.inspect is not a read-back candidate or an offered command', () => {
  it('keeps only supported read-backs, each of which PhotoCraft\'s own permission check allows', () => {
    expect([...NATIVE_READBACK_COMMANDS].sort()).toEqual(['layer.list', 'shape.info']);
    for (const id of NATIVE_READBACK_COMMANDS) { expect(commandTier(id)).not.toBe('never'); expect(checkPhotoCraftOp(id, {}).ok).toBe(true); }
    expect(commandTier('document.inspect')).toBe('never');
    expect(checkPhotoCraftOp('document.inspect', {}).ok).toBe(false); // the permission system is unchanged
  });
  it('a document.inspect result can no longer become evidence', async () => {
    const registry = new ToolRegistry([tool('app_command', 'cmd', z.object({ command: z.string() }).strict(), async ({ command }) => (command === 'document.inspect' ? 'Result: {"layers":1}' : 'ok'))]);
    const r = await runAgent({ goal: 'g', ctl: ctlWith('idle'), registry, provider: new ScriptedProvider([call('1', 'app_command', { command: 'ok.edit' }), call('2', 'app_command', { command: 'document.inspect' }),
      call('3', 'evidence_verify', { receipt_id: 'r2', path: 'layers', expected: 1 }), final, final]) });
    expect(toolText(r.messages, 2)).toContain('no eligible structured read-back');
    expect(r.status).toBe('limit');
  });
  it('discovery no longer offers commands the permission system refuses, and keeps shape.info and layer.list', () => {
    const catalog = [{ id: 'document.inspect', label: 'Inspect Document' }, { id: 'shape.info', label: 'Shape Layer Info' }, { id: 'layer.list', label: 'List Layers' }, { id: 'file.open', label: 'Open' }, { id: 'bad id' }];
    const shown = formatDiscoveredCommands(keepPermittedCommands(catalog), undefined, 'PhotoCraft');
    expect(shown).toContain('shape.info');
    expect(shown).toContain('layer.list');
    expect(shown).not.toContain('document.inspect');
    const wrapped = keepPermittedCommands({ commands: catalog, note: 'x' }) as { commands: Array<{ id: string }>; note: string };
    expect(wrapped.commands.map((c) => c.id)).toEqual(['shape.info', 'layer.list', 'file.open']); // approval-tier commands stay offered (they still ask); only refused ones are dropped
    expect(wrapped.note).toBe('x');
    expect(keepPermittedCommands('not a catalog')).toBe('not a catalog');
  });
});

// ------------------------------------------------------------------ F4
describe('F4: approval identity', () => {
  it('names Independent AI for its requests and keeps the Claude and user wording', () => {
    expect(approvalAsker({ requestedBy: 'claude', requester: 'independent' })).toBe('Independent AI is asking to generate');
    expect(approvalAsker({ requestedBy: 'claude', requester: 'claude' })).toBe('Claude is asking to generate');
    expect(approvalAsker({ requestedBy: 'claude' })).toBe('Claude is asking to generate');
    expect(approvalAsker({ requestedBy: 'user' })).toBe('Generate');
    expect(approvalAsker({ requestedBy: 'user', requester: 'independent' })).toBe('Independent AI is asking to generate');
  });

  const fakeCrypto: Encryptor = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64')}`), decryptString: (b) => Buffer.from(b.toString().slice(4), 'base64').toString() };
  it('passes the requester to the card without changing price, billing identity or cancellation', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicandy-f4-'));
    try {
      const store = new ProjectStore(path.join(tmp, 'proj'));
      await store.create('F4');
      const vault = new SafeStorageVault(path.join(tmp, 'secrets', 'providers'), fakeCrypto);
      await vault.save('openai', 'sk-test-0123456789abcdefghijklmnop');
      const seen: ApprovalRequest[] = [];
      let fetched = 0;
      const svc = new GenerationService({ vault, store: async () => store, approve: async (r) => { seen.push(r); return false; }, fetch: (async () => { fetched++; return new Response('{}'); }) as unknown as typeof fetch });
      const job = { modelId: 'gpt-image-2.5-flare', prompt: 'a cat', referenceAssetIds: [], settings: {}, count: 1 };
      await expect(svc.generate(job, 'claude', 'independent')).rejects.toThrow();
      await expect(svc.generate(job, 'claude')).rejects.toThrow();
      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({ requestedBy: 'claude', requester: 'independent' });
      expect(seen[1]!.requester).toBeUndefined();
      expect(seen[0]!.estimate).toEqual(seen[1]!.estimate); // same price
      expect(fetched).toBe(0); // a declined approval sends nothing
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });

  const partner = (generate: (job: unknown, requester?: string) => Promise<unknown>) => new ClaudePartner({
    live: async () => ({ snapshot: () => ({}), claudeDone: () => undefined }), store: async () => ({ loadManifest: async () => ({ assets: [] }) }), emit: () => undefined,
    history: { load: async () => [], save: async () => undefined }, imageModels: async () => [], generate,
  } as unknown as ClaudePartnerDeps);
  it('Independent AI tool calls carry the independent requester; Claude\'s own tools keep the Claude wording', async () => {
    const requesters: Array<string | undefined> = [];
    const p = partner(async (_job, requester) => { requesters.push(requester); throw new Error('declined'); });
    const [agentTool] = await p.agentToolDefs(['generate_image']);
    await agentTool!.execute({ prompt: 'a cat', model_id: 'gpt-image-2.5-flare' });
    const own = (await (p as unknown as { toolDefinitions: (a: (t: string) => void) => Promise<Array<{ name: string; handler: (a: unknown, e: unknown) => Promise<unknown> }>> }).toolDefinitions(() => undefined)).find((t) => t.name === 'generate_image')!;
    await own.handler({ prompt: 'a cat', model_id: 'gpt-image-2.5-flare' }, {});
    expect(requesters).toEqual(['independent', 'claude']);
  });
});

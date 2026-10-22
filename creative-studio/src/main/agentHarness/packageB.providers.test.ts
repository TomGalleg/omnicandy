import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentProviderSchema, sumUsage, withAgentProvider, type AgentKeyVault } from './providerFactory';
import { validateProviderSelection } from '@shared/agentProvider';
import { TaskCheckpointStore, type CheckpointCrypto } from './taskCheckpoint';
import { EditIntentJournal } from './editIntentJournal';
import { restoreRecoveryState } from './crashRecovery';
import { recoveryIpcState } from './recoveryIpcState';
import type { AgentUiState } from '@shared/agentHarness';

const SECRET = 'sk-test-0123456789abcdefghijklmnop';
function vault(configured: Record<string, boolean>) {
  const lent: string[] = [];
  const v: AgentKeyVault = {
    status: async (id) => ({ configured: configured[id] === true }),
    withKey: async (id, fn) => { lent.push(id); return fn(`${SECRET}-${id}`); },
  };
  return { v, lent };
}
const reply = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const complete = (provider: { complete: (i: never) => Promise<unknown> }) =>
  provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal } as never);

describe('provider selection', () => {
  it('validates provider-specific settings', () => {
    expect(validateProviderSelection({ provider: 'openai' }, 'gpt-4.1')).toBeNull();
    expect(validateProviderSelection({ provider: 'gemini' }, 'gemini-2.5-flash')).toBeNull();
    expect(validateProviderSelection({ provider: 'local', endpoint: 'http://127.0.0.1:11434/v1' }, 'llama3')).toBeNull();
    expect(validateProviderSelection({ provider: 'local' }, 'llama3')).not.toBeNull();
    expect(validateProviderSelection({ provider: 'local', endpoint: 'https://example.com/v1' }, 'llama3')).not.toBeNull();
    expect(validateProviderSelection({ provider: 'local', endpoint: 'http://192.168.1.5:11434/v1' }, 'llama3')).not.toBeNull();
    expect(validateProviderSelection({ provider: 'local', endpoint: 'http://user:pw@localhost:1/v1' }, 'llama3')).not.toBeNull();
    expect(validateProviderSelection({ provider: 'openai', endpoint: 'http://localhost:1/v1' }, 'gpt-4.1')).not.toBeNull();
    expect(validateProviderSelection({ provider: 'openai' }, 'bad model name!')).not.toBeNull();
  });
  it('rejects unknown fields so no credential can ride along with the selection', () => {
    expect(agentProviderSchema.safeParse({ provider: 'openai' }).success).toBe(true);
    expect(agentProviderSchema.safeParse({ provider: 'openai', apiKey: SECRET }).success).toBe(false);
    expect(agentProviderSchema.safeParse({ provider: 'anthropic' }).success).toBe(false);
  });
  it('fails before sending anything when the credential is missing', async () => {
    const { v, lent } = vault({ openai: false, gemini: false });
    let called = false;
    for (const provider of ['openai', 'gemini'] as const) {
      await expect(withAgentProvider({ provider }, provider === 'openai' ? 'gpt-4.1' : 'gemini-2.5-flash', v, async () => { called = true; })).rejects.toThrow(/API key is saved/);
    }
    expect(called).toBe(false);
    expect(lent).toEqual([]);
  });
  it('uses the vault key for OpenAI and Gemini and the selected endpoint for a local model', async () => {
    const { v, lent } = vault({ openai: true, gemini: true });
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const spy = (body: unknown): typeof fetch => (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return reply(body)();
    }) as typeof fetch;
    const openaiBody = { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } };
    const geminiBody = { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } };
    expect(await withAgentProvider({ provider: 'openai' }, 'gpt-4.1', v, complete, spy(openaiBody))).toMatchObject({ usage: { input: 3, output: 1 } });
    expect(await withAgentProvider({ provider: 'gemini' }, 'gemini-2.5-flash', v, complete, spy(geminiBody))).toMatchObject({ usage: { input: 4, output: 2 } });
    expect(await withAgentProvider({ provider: 'local', endpoint: 'http://127.0.0.1:11434/v1' }, 'llama3', v, complete, spy(openaiBody))).toMatchObject({ text: 'ok' });
    expect(lent).toEqual(['openai', 'gemini']);
    expect(seen[0]!.url).toContain('api.openai.com');
    expect(seen[0]!.headers.authorization).toContain(SECRET);
    expect(seen[1]!.url).toContain('generativelanguage.googleapis.com');
    expect(seen[1]!.headers['x-goog-api-key']).toContain(SECRET);
    expect(seen[2]!.url.startsWith('http://127.0.0.1:11434/v1/')).toBe(true);
    expect(seen[2]!.headers.authorization).toBeUndefined();
  });
});

const roots: string[] = [];
const crypto: CheckpointCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text).reverse(),
  decryptString: (bytes) => Buffer.from(bytes).reverse().toString('utf8'),
};
const initial: AgentUiState = { status: 'idle', model: 'gpt-4.1-mini', goal: '', result: '', events: [] };
async function stores() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicandy-pkgb-'));
  roots.push(root);
  return { root, task: new TaskCheckpointStore(root, crypto), journal: new EditIntentJournal(root, crypto) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }))); });

describe('provider, budget and usage persistence (Continue Task)', () => {
  it('restores the provider selection, budget and usage that the task started with', async () => {
    const { root, task, journal } = await stores();
    expect(await task.save({ goal: 'g', model: 'gemini-2.5-pro', status: 'limit', messages: [{ role: 'user', content: 'g' }],
      provider: { provider: 'gemini' }, budget: { maxTurns: 40, maxToolCalls: 120 }, usage: { input: 10, output: 5 } })).toBe(true);
    const restored = await restoreRecoveryState(new TaskCheckpointStore(root, crypto), journal);
    const { paused, state } = recoveryIpcState(restored, initial);
    expect(paused).toMatchObject({ model: 'gemini-2.5-pro', provider: { provider: 'gemini' }, budget: { maxTurns: 40, maxToolCalls: 120 }, usage: { input: 10, output: 5 } });
    expect(state).toMatchObject({ provider: { provider: 'gemini' }, usage: { input: 10, output: 5 } });
  });
  it('loads a checkpoint written before provider and budget existed and treats it as OpenAI with default budgets', async () => {
    const { root, task, journal } = await stores();
    await task.save({ goal: 'old', model: 'gpt-4.1-mini', status: 'paused', messages: [{ role: 'user', content: 'old' }] });
    const raw = JSON.parse(crypto.decryptString(await fs.readFile(path.join(root, '.omnicandy-agent-checkpoint.enc'))));
    expect(raw.provider).toBeUndefined();
    expect(raw.budget).toBeUndefined();
    const restored = await restoreRecoveryState(new TaskCheckpointStore(root, crypto), journal);
    const { paused, state } = recoveryIpcState(restored, initial);
    expect(paused?.provider).toBeUndefined(); // ipc resumes with DEFAULT_AGENT_PROVIDER (OpenAI) and default budgets
    expect(paused?.budget).toBeUndefined();
    expect(state.provider).toEqual({ provider: 'openai' });
    expect(state.usage).toBeUndefined();
  });
  it('rejects a checkpoint whose provider or budget is invalid instead of executing it', async () => {
    const { root, task } = await stores();
    await task.save({ goal: 'g', model: 'm', status: 'limit', messages: [{ role: 'user', content: 'g' }] });
    const file = path.join(root, '.omnicandy-agent-checkpoint.enc');
    const raw = JSON.parse(crypto.decryptString(await fs.readFile(file)));
    await fs.writeFile(file, crypto.encryptString(JSON.stringify({ ...raw, budget: { maxTurns: 100000 } })));
    expect(await task.load()).toBeNull();
    await fs.writeFile(file, crypto.encryptString(JSON.stringify({ ...raw, provider: { provider: 'local', apiKey: SECRET } })));
    expect(await task.load()).toBeNull();
  });
  it('never writes credentials into the checkpoint', async () => {
    const { root, task } = await stores();
    await task.save({ goal: 'g', model: 'llama3', status: 'limit', messages: [{ role: 'user', content: 'g' }], provider: { provider: 'local', endpoint: 'http://127.0.0.1:11434/v1' } });
    const text = crypto.decryptString(await fs.readFile(path.join(root, '.omnicandy-agent-checkpoint.enc')));
    expect(text).not.toMatch(/sk-|apiKey|authorization/i);
    expect(text).toContain('127.0.0.1');
  });
  it('sums provider-reported usage across runs and never invents it', () => {
    expect(sumUsage(undefined, undefined)).toBeUndefined();
    expect(sumUsage({ input: 10, output: 5 }, undefined)).toEqual({ input: 10, output: 5 });
    expect(sumUsage({ input: 10, output: 5 }, { input: 1, output: 2 })).toEqual({ input: 11, output: 7 });
  });
});

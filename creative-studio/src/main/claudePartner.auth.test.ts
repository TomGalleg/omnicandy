import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_VAULT_ID, ClaudeAuth } from './claudeAuth';
import { ClaudePartner, type ClaudePartnerDeps } from './claudePartner';
import { SafeStorageVault, type Encryptor } from './credentialVault';

const KEY = 'sk-ant-api03-TESTKEY0123456789abcdefghij';
const seen: Array<Record<string, string>> = [];
let behaviour: 'ok' | 'throw-key' | 'bad-key' = 'ok';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { env: Record<string, string> } }) => {
    seen.push(options.env);
    return (async function* () {
      if (behaviour === 'throw-key') throw new Error(`upstream said: bad request for ${options.env.ANTHROPIC_API_KEY ?? 'no key'}`);
      if (behaviour === 'bad-key') { yield { type: 'result', is_error: true, result: 'Invalid API key \u00b7 Please run /login', total_cost_usd: 0 }; return; }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
      yield { type: 'result', is_error: false, total_cost_usd: 0 };
    })();
  },
}));

const crypto: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4), 'base64').toString(),
};

let tmp: string;
let auth: ClaudeAuth;
let vault: SafeStorageVault;
let partner: ClaudePartner;
let saved: string | undefined;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pauth-'));
  vault = new SafeStorageVault(path.join(tmp, 'p'), crypto);
  saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-INHERITED0123456789abcdefgh';
  auth = new ClaudeAuth(path.join(tmp, 'a.json'), vault);
  partner = new ClaudePartner({ cliPath: path.join(tmp, 'none'), auth, emit: () => undefined, workDir: async () => tmp, history: { load: async () => [], save: async () => undefined }, imageModels: async () => [] } as unknown as ClaudePartnerDeps);
  seen.length = 0; behaviour = 'ok';
});
afterEach(async () => {
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('Claude sessions use the selected credentials', () => {
  it('sign-in mode: the session never sees the inherited key', async () => {
    await partner.planChat('sys', 'hi');
    expect(seen[0]!.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('API-key mode: the session gets the saved key, and the panel state says so without containing it', async () => {
    await vault.save(ANTHROPIC_VAULT_ID, KEY);
    await auth.setMode('api-key');
    await partner.authChanged();
    await partner.planChat('sys', 'hi');
    expect(seen[0]!.ANTHROPIC_API_KEY).toBe(KEY);
    expect(partner.state().billing).toMatchObject({ mode: 'api-key', keyReady: true });
    expect(JSON.stringify(partner.state())).not.toContain(KEY);
  });

  it('API-key mode without a key refuses to start a session', async () => {
    await auth.setMode('api-key');
    await expect(partner.planChat('sys', 'hi')).rejects.toThrow(/no usable key/);
    expect(seen).toHaveLength(0);
  });

  it('removes the key from error messages shown to the user', async () => {
    await vault.save(ANTHROPIC_VAULT_ID, KEY);
    await auth.setMode('api-key');
    behaviour = 'throw-key';
    const err = await partner.planChat('sys', 'hi').then(() => '', (e: Error) => e.message);
    expect(err).toContain('upstream said');
    expect(err).not.toContain(KEY);
  });

  it('a rejected API key is reported as a key problem, not as a missing sign-in', async () => {
    await vault.save(ANTHROPIC_VAULT_ID, KEY);
    await auth.setMode('api-key');
    behaviour = 'bad-key';
    await expect(partner.planChat('sys', 'hi')).rejects.toThrow(/did not accept the API key/);
    expect(partner.state().status).not.toBe('signed-out');
  });

  it('checking the sign-in is skipped in API-key mode (no Claude Code needed)', async () => {
    await vault.save(ANTHROPIC_VAULT_ID, KEY);
    await auth.setMode('api-key');
    expect(await partner.checkAuth()).toBe(true);
    expect(partner.state().signedIn).toBeNull();
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANTHROPIC_VAULT_ID, ClaudeAuth, NO_KEY_MESSAGE, signInEnv } from './claudeAuth';
import { SafeStorageVault, type Encryptor } from './credentialVault';
import { buildQueryOptions } from './integrations/builder/author';

const KEY = 'sk-ant-api03-TESTKEY0123456789abcdefghij';
const fakeCrypto: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => { const t = b.toString(); if (!t.startsWith('ENC:')) throw new Error('cannot decrypt'); return Buffer.from(t.slice(4), 'base64').toString(); },
};

let tmp: string;
let vault: SafeStorageVault;
let pcEnv: NodeJS.ProcessEnv;
let auth: ClaudeAuth;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-auth-'));
  vault = new SafeStorageVault(path.join(tmp, 'secrets', 'providers'), fakeCrypto);
  pcEnv = { PATH: 'p', ANTHROPIC_API_KEY: 'sk-ant-INHERITED0123456789abcdefgh', ANTHROPIC_AUTH_TOKEN: 'tok' };
  auth = new ClaudeAuth(path.join(tmp, 'claudeAuth.json'), vault, () => pcEnv);
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('signInEnv', () => {
  it('drops inherited keys and tokens and keeps everything else', () => {
    const e = signInEnv(pcEnv);
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(e.PATH).toBe('p');
    expect(e.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('CreateCraft/0.1');
  });
});

describe('ClaudeAuth', () => {
  it('defaults to the Claude sign-in, never using an inherited key', async () => {
    expect(await auth.mode()).toBe('sign-in');
    const e = await auth.env();
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(await auth.billing()).toEqual({ mode: 'sign-in', keyReady: false, keyUnreadable: false, keyIgnored: true });
  });

  it('remembers the mode across restarts and treats a damaged file as the default', async () => {
    await auth.setMode('api-key');
    expect(await new ClaudeAuth(path.join(tmp, 'claudeAuth.json'), vault, () => pcEnv).mode()).toBe('api-key');
    await fs.writeFile(path.join(tmp, 'claudeAuth.json'), '{nonsense');
    expect(await auth.mode()).toBe('sign-in');
  });

  it('in API-key mode uses the saved key, not the inherited one', async () => {
    await vault.save(ANTHROPIC_VAULT_ID, KEY);
    await auth.setMode('api-key');
    expect((await auth.env()).ANTHROPIC_API_KEY).toBe(KEY);
    expect((await auth.env()).ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(await auth.billing()).toMatchObject({ mode: 'api-key', keyReady: true });
  });

  it('in API-key mode with no usable key it refuses instead of falling back to the sign-in or the inherited key', async () => {
    await auth.setMode('api-key');
    await expect(auth.env()).rejects.toThrow(NO_KEY_MESSAGE);
    await vault.save(ANTHROPIC_VAULT_ID, KEY);
    await fs.writeFile(path.join(tmp, 'secrets', 'providers', 'anthropic.key'), Buffer.from('FOREIGN-from-another-pc'));
    await expect(auth.env()).rejects.toThrow(NO_KEY_MESSAGE);
    expect(await auth.billing()).toMatchObject({ mode: 'api-key', keyReady: false, keyUnreadable: true });
  });

  it('switching back to the sign-in drops the key from the session environment even though it is still saved', async () => {
    await vault.save(ANTHROPIC_VAULT_ID, KEY);
    await auth.setMode('api-key');
    await auth.setMode('sign-in');
    expect((await auth.env()).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('scrubs the saved key (and key-shaped text) from messages', async () => {
    await vault.save(ANTHROPIC_VAULT_ID, KEY);
    const out = await auth.scrub(`request failed for key ${KEY} and sk-ant-OTHER0123456789`);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain('OTHER0123456789');
  });

  it('stores the key encrypted, never in the mode file or the metadata', async () => {
    await vault.save(ANTHROPIC_VAULT_ID, KEY);
    await auth.setMode('api-key');
    for (const f of ['claudeAuth.json', 'secrets/providers/anthropic.key', 'secrets/providers/anthropic.json']) {
      expect(await fs.readFile(path.join(tmp, ...f.split('/')), 'utf8')).not.toContain(KEY);
    }
  });

  it('only accepts keys that look like Anthropic keys', async () => {
    await expect(vault.save(ANTHROPIC_VAULT_ID, 'sk-proj-0123456789abcdefghijklmnop')).rejects.toThrow(/sk-ant-/);
  });
});

describe('the AI Adapter Builder uses the same credentials', () => {
  it('builds its request with the environment it is given, and by default without an inherited key', async () => {
    const abort = new AbortController();
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-INHERITED0123456789abcdefgh';
    try {
      const dflt = buildQueryOptions('m', 'C:/x', 's', { tools: [], maxTurns: 1 }, abort);
      expect((dflt.env as Record<string, string>).ANTHROPIC_API_KEY).toBeUndefined();
    } finally { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; }
    await vault.save(ANTHROPIC_VAULT_ID, KEY);
    await auth.setMode('api-key');
    const keyed = buildQueryOptions('m', 'C:/x', 's', { tools: [], maxTurns: 1 }, abort, await auth.env());
    expect((keyed.env as Record<string, string>).ANTHROPIC_API_KEY).toBe(KEY);
  });
});

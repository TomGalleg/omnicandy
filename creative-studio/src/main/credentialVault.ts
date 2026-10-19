// Provider API keys, encrypted with Electron safeStorage (Windows DPAPI: only this Windows user can
// decrypt; Linux: only through a real keyring, see platform/secureStorage.ts). Lives in the main process only: keys are never sent to the renderer, written to logs or
// project files, or shown to Claude. The renderer only ever sees {configured, savedAt, lastTest}.
//
//   <secretsDir>/providers/<id>.key    encrypted key (DPAPI blob)
//   <secretsDir>/providers/<id>.json   non-secret metadata (saved time, last connection test)

import fs from 'node:fs/promises';
import path from 'node:path';
import type { CredentialStatus, CredentialVault } from '@shared/contracts';

export interface Encryptor {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
  /** Why keys cannot be saved, in plain words (shown to the user). */
  unavailableReason?(): string;
}

export interface KeyTest { ok: boolean; at: string; message: string; models?: string[] }
export interface KeyMeta { savedAt: string; lastTest?: KeyTest }

const PROVIDER = /^[a-z][a-z0-9-]{1,31}$/;

/** Plausible API key: one token of printable ASCII, no spaces. Format checks are provider-specific. */
export function checkKeyShape(providerId: string, raw: string): string {
  const key = raw.trim();
  if (!key) throw new Error('The clipboard is empty. Copy your API key first.');
  if (key.length < 20 || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) throw new Error("That doesn't look like an API key. Copy just the key (one line, no spaces).");
  if (providerId === 'anthropic' && !key.startsWith('sk-ant-')) throw new Error('Anthropic API keys start with "sk-ant-". Copy the key from console.anthropic.com/settings/keys.');
  if (providerId === 'openai' && !key.startsWith('sk-')) throw new Error('OpenAI keys start with "sk-". Copy the key from platform.openai.com/api-keys.');
  return key;
}

/** Removes any copy of `secret` (and its tail) from text that might be shown or logged. */
export function redact(text: string, secret: string | null): string {
  let t = text;
  if (secret && secret.length >= 8) t = t.split(secret).join('[key]');
  // Also hides partial/masked echoes such as OpenAI's "sk-abcd****1234".
  return t.replace(/\bsk-[A-Za-z0-9_*.-]{4,}/g, 'sk-…').replace(/\bAIza[0-9A-Za-z_*.-]{8,}/g, 'AIza…');
}

export class SafeStorageVault implements CredentialVault {
  constructor(private readonly dir: string, private readonly crypto: Encryptor) {}

  get available() { return this.crypto.isEncryptionAvailable(); }

  private file(id: string, ext: 'key' | 'json') {
    if (!PROVIDER.test(id)) throw new Error('Invalid provider.');
    return path.join(this.dir, `${id}.${ext}`);
  }

  async status(providerId: string): Promise<CredentialStatus> {
    const present = await fs.access(this.file(providerId, 'key')).then(() => true, () => false);
    // A key file that cannot be decrypted here (copied from another PC or user) is not a usable key.
    const readable = present && (await fs.readFile(this.file(providerId, 'key')).then((b) => { this.crypto.decryptString(b); return true; }).catch(() => false));
    return { providerId, configured: readable, ...(present && !readable ? { unreadable: true } : {}), handle: readable ? `vault:${providerId}` : null };
  }

  async meta(providerId: string): Promise<KeyMeta | null> {
    try { return JSON.parse(await fs.readFile(this.file(providerId, 'json'), 'utf8')) as KeyMeta; } catch { return null; }
  }

  async save(providerId: string, rawKey: string): Promise<void> {
    if (!this.available) throw new Error(this.crypto.unavailableReason?.() || 'There is no protected storage available on this computer, so the key cannot be saved safely.');
    const key = checkKeyShape(providerId, rawKey);
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(providerId, 'key')}.tmp`;
    await fs.writeFile(tmp, this.crypto.encryptString(key), { mode: 0o600 });
    await fs.rename(tmp, this.file(providerId, 'key'));
    await this.writeMeta(providerId, { savedAt: new Date().toISOString() });
  }

  async setLastTest(providerId: string, test: KeyTest): Promise<void> {
    const m = await this.meta(providerId);
    if (m) await this.writeMeta(providerId, { ...m, lastTest: test });
  }

  private async writeMeta(providerId: string, m: KeyMeta) {
    await fs.writeFile(this.file(providerId, 'json'), JSON.stringify(m, null, 2), 'utf8');
  }

  async remove(providerId: string): Promise<void> {
    await fs.rm(this.file(providerId, 'key'), { force: true });
    await fs.rm(this.file(providerId, 'json'), { force: true });
  }

  /**
   * Lends the decrypted key to `fn` (main-process provider code) and nothing else. Errors thrown
   * by `fn` are redacted so a key echoed back by a server can't leak into messages.
   */
  async withKey<T>(providerId: string, fn: (key: string) => Promise<T>): Promise<T> {
    let key: string;
    try { key = this.crypto.decryptString(await fs.readFile(this.file(providerId, 'key'))); } catch {
      throw new Error('No API key is saved for this provider (or it can no longer be decrypted). Add the key again.');
    }
    try { return await fn(key); } catch (e) {
      throw new Error(redact(e instanceof Error ? e.message : String(e), key));
    }
  }
}

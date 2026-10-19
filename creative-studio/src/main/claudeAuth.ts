// How Claude sessions authenticate. Default: the user's Claude Code sign-in (plan). Optional: an Anthropic API key the user adds in Settings
// (stored by the credential vault, usage billed separately by Anthropic). A key inherited from the PC's environment is never used.
// One place builds the environment for every Claude session (chat, planner, AI Adapter Builder), so they always agree.

import fs from 'node:fs/promises';
import type { ClaudeAuthMode, ClaudeState } from '@shared/claude';
import { redact, type SafeStorageVault } from './credentialVault';
import { writeJsonAtomic } from './projectStore';

export const ANTHROPIC_VAULT_ID = 'anthropic';

/** Variables that make Claude Code authenticate with a key or token instead of the sign-in. */
const KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** The PC's environment for a Claude session with every inherited key or token removed (so the sign-in is used). */
export function signInEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || (KEY_VARS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  out.CLAUDE_AGENT_SDK_CLIENT_APP = 'OmniCandi/0.1';
  return out;
}

export const NO_KEY_MESSAGE = 'Claude is set to use an Anthropic API key, but no usable key is saved on this PC. Add the key in Settings, or switch back to the Claude sign-in.';

type KeyVault = Pick<SafeStorageVault, 'status' | 'withKey'>;

export class ClaudeAuth {
  constructor(private readonly file: string, private readonly vault: KeyVault, private readonly pcEnv: () => NodeJS.ProcessEnv = () => process.env) {}

  async mode(): Promise<ClaudeAuthMode> {
    try {
      const j = JSON.parse(await fs.readFile(this.file, 'utf8')) as { mode?: unknown };
      return j.mode === 'api-key' ? 'api-key' : 'sign-in';
    } catch { return 'sign-in'; }
  }

  async setMode(mode: ClaudeAuthMode): Promise<void> {
    await writeJsonAtomic(this.file, { mode: mode === 'api-key' ? 'api-key' : 'sign-in' });
  }

  /** What the Settings card and the Claude panel show. Never contains the key. */
  async billing(): Promise<ClaudeState['billing']> {
    const mode = await this.mode();
    const key = await this.vault.status(ANTHROPIC_VAULT_ID);
    const inherited = KEY_VARS.some((k) => !!this.pcEnv()[k]?.trim());
    return { mode, keyReady: key.configured, keyUnreadable: !!key.unreadable, keyIgnored: inherited };
  }

  /** The environment for one Claude session. In API-key mode the saved key is added; without one this throws instead of falling back. */
  async env(): Promise<Record<string, string>> {
    const base = signInEnv(this.pcEnv());
    if ((await this.mode()) !== 'api-key') return base;
    try {
      return await this.vault.withKey(ANTHROPIC_VAULT_ID, async (key) => ({ ...base, ANTHROPIC_API_KEY: key }));
    } catch { throw new Error(NO_KEY_MESSAGE); }
  }

  /** Removes the saved key (if any) from text that may be shown or logged. */
  async scrub(text: string): Promise<string> {
    try { return await this.vault.withKey(ANTHROPIC_VAULT_ID, async (key) => redact(text, key)); } catch { return redact(text, null); }
  }
}

// Which credentials Claude Code sees. CreateCraft promises "your Claude sign-in", so an API key that happens to be set for the whole
// PC (a developer's ANTHROPIC_API_KEY) must not silently switch the chat to pay-per-use API billing.
// Deliberate use of a key: set CREATECRAFT_USE_ANTHROPIC_API_KEY=1 before starting CreateCraft.

import type { ClaudeState } from '@shared/claude';

/** Variables that make Claude Code authenticate with a key or token instead of the sign-in. */
const KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

export const USE_KEY_VARIABLE = 'CREATECRAFT_USE_ANTHROPIC_API_KEY';

const hasKey = (env: NodeJS.ProcessEnv) => KEY_VARS.some((k) => !!env[k]?.trim());
const optedIn = (env: NodeJS.ProcessEnv) => /^(1|true|yes)$/i.test((env[USE_KEY_VARIABLE] ?? '').trim());

/** The environment for a Claude Code session: the PC's own, minus inherited keys unless the user opted in. */
export function claudeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  const keep = optedIn(env);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (!keep && (KEY_VARS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  out.CLAUDE_AGENT_SDK_CLIENT_APP = 'CreateCraft/0.1';
  return out;
}

export function claudeBilling(env: NodeJS.ProcessEnv): ClaudeState['billing'] {
  const key = hasKey(env);
  if (key && optedIn(env)) return { mode: 'api-key', keyIgnored: false };
  return { mode: 'sign-in', keyIgnored: key };
}

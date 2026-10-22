import { z } from 'zod';
import { AGENT_PROVIDER_IDS, AGENT_PROVIDERS, validateProviderSelection, type AgentProviderSelection } from '@shared/agentProvider';
import type { ModelProvider } from './types';
import { OpenAICompatibleProvider } from './providers/openaiCompatible';
import { GeminiProvider } from './providers/gemini';
import { createLocalModelProvider } from './providers/localCompatible';

/** The slice of the credential vault the agent needs: keys are lent for one call and never returned. */
export interface AgentKeyVault {
  status(providerId: string): Promise<{ configured: boolean }>;
  withKey<T>(providerId: string, fn: (key: string) => Promise<T>): Promise<T>;
}

/**
 * Builds the selected provider and runs `fn` with it. Keys come only from the vault and exist only for the
 * duration of `fn`; the selection (non-secret) is the only thing that may be persisted or sent to the renderer.
 * Run and Continue Task both go through here, so a task always resumes on the provider it started with.
 */
export async function withAgentProvider<T>(
  selection: AgentProviderSelection,
  model: string,
  vault: AgentKeyVault,
  fn: (provider: ModelProvider) => Promise<T>,
  fetchImpl?: typeof fetch,
): Promise<T> {
  const problem = validateProviderSelection(selection, model);
  if (problem) throw new Error(problem);
  const info = AGENT_PROVIDERS[selection.provider];
  if (selection.provider === 'local') {
    return fn(createLocalModelProvider({ model, baseUrl: selection.endpoint!, ...(fetchImpl ? { fetchImpl } : {}) }));
  }
  if (!info.vaultId || !(await vault.status(info.vaultId)).configured)
    throw new Error(`No ${info.label} API key is saved. Add it in Settings, then run again. Nothing was sent.`);
  return vault.withKey(info.vaultId, (key) => {
    const getKey = async () => key;
    return fn(selection.provider === 'gemini'
      ? new GeminiProvider({ model, getKey, ...(fetchImpl ? { fetchImpl } : {}) })
      : new OpenAICompatibleProvider({ model, baseUrl: 'https://api.openai.com/v1', getKey, ...(fetchImpl ? { fetchImpl } : {}) }));
  });
}

/** IPC / checkpoint shape of a provider selection. Strict: unknown fields (for example a smuggled key) are rejected. */
export const agentProviderSchema = z.object({ provider: z.enum(AGENT_PROVIDER_IDS), endpoint: z.string().max(200).optional() }).strict();

/** Adds provider-reported usage only; returns undefined when neither side ever reported any. */
export function sumUsage(a?: { input: number; output: number }, b?: { input: number; output: number }): { input: number; output: number } | undefined {
  if (!a && !b) return undefined;
  return { input: (a?.input ?? 0) + (b?.input ?? 0), output: (a?.output ?? 0) + (b?.output ?? 0) };
}

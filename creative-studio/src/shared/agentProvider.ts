/** Providers the Independent AI agent can run on. Secrets are never part of this contract: keys stay in the main-process credential vault. */
export const AGENT_PROVIDER_IDS = ['openai', 'gemini', 'local'] as const;
export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];

export interface AgentProviderSelection {
  provider: AgentProviderId;
  /** Local provider only: a loopback http(s) OpenAI-compatible base URL. Non-secret. */
  endpoint?: string;
}

export const AGENT_PROVIDERS: Record<AgentProviderId, { label: string; vaultId: 'openai' | 'gemini' | null; models: readonly string[] }> = {
  openai: { label: 'OpenAI', vaultId: 'openai', models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'] },
  gemini: { label: 'Google Gemini', vaultId: 'gemini', models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
  local: { label: 'Local model', vaultId: null, models: [] },
};
export const DEFAULT_AGENT_PROVIDER: AgentProviderSelection = { provider: 'openai' };
export const DEFAULT_LOCAL_ENDPOINT = 'http://127.0.0.1:11434/v1';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Same rules in the renderer (early feedback) and the main process (authoritative). Returns an error message or null. */
export function validateProviderSelection(selection: AgentProviderSelection, model: string): string | null {
  if (!AGENT_PROVIDER_IDS.includes(selection.provider)) return 'Unknown AI provider.';
  if (!MODEL.test(model)) return 'Select a valid model.';
  if (selection.provider !== 'local') return selection.endpoint === undefined ? null : 'Only the local provider takes an endpoint.';
  if (!selection.endpoint) return 'Enter the local model endpoint.';
  let url: URL;
  try { url = new URL(selection.endpoint); } catch { return 'The local endpoint is not a valid URL.'; }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) return 'Local models must use a loopback HTTP endpoint (localhost or 127.0.0.1).';
  if (url.username || url.password || url.search || url.hash) return 'The local endpoint must not contain credentials, a query or a fragment.';
  return null;
}

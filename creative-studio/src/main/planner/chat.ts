// Calls an AI for the planning chat. Runs only when the owner presses a button in the Planner. The key is lent per call from the vault
// (never returned to the page); nothing here writes to a plan: suggestions come back as text and go through the usual approval.
import { CLAUDE_MODELS } from '@shared/claude';
import { type ChatMessage, type ChatProviderId, CHAT_PROVIDERS, MAX_REPLY_TOKENS, trimChat, transcriptText } from '@shared/plannerChat';
import { GEMINI_BASE, OPENAI_BASE } from '../generation';
import { parseModelList } from '../imageApis';

type KeyProvider = 'openai' | 'gemini';
export interface ChatDeps {
  vault: { status(id: string): Promise<{ configured: boolean }>; withKey<T>(id: string, fn: (key: string) => Promise<T>): Promise<T> };
  fetch: typeof fetch;
  /** One no-tools Claude request (the Claude Code sign-in). */
  claude: () => { planChat(system: string, prompt: string, model?: string): Promise<string> };
}
export interface ChatProviderState { id: ChatProviderId; label: string; cost: string; ready: boolean; note: string }

const NOT_TEXT = /(image|audio|tts|whisper|embedding|moderation|realtime|transcribe|dall|search|instruct|davinci|babbage|codex|imagen|veo|aqa|live|native|vision|computer-use)/i;

/** Models that can chat, from a provider's own models list (so no model name is guessed here). */
export function textModels(provider: KeyProvider, json: unknown): string[] {
  if (provider === 'openai') return parseModelList('openai', json).filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !NOT_TEXT.test(id)).sort().reverse();
  const models = (json as { models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }> })?.models ?? [];
  return models
    .filter((m) => typeof m?.name === 'string' && Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => String(m.name).replace(/^models\//, ''))
    .filter((id) => /^gemini/.test(id) && !NOT_TEXT.test(id)).sort().reverse();
}

export const openaiChatBody = (model: string, system: string, messages: ChatMessage[]) => ({
  model, max_completion_tokens: MAX_REPLY_TOKENS,
  messages: [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.text }))],
});
export function parseOpenAIChat(json: unknown): string {
  const text = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('OpenAI sent no text back. Try again, or pick another model.');
  return text.trim();
}
export const geminiChatBody = (system: string, messages: ChatMessage[]) => ({
  systemInstruction: { parts: [{ text: system }] },
  contents: messages.map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] })),
  generationConfig: { maxOutputTokens: MAX_REPLY_TOKENS },
});
export function parseGeminiChat(json: unknown): string {
  const j = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>; promptFeedback?: { blockReason?: unknown } };
  const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
  if (!text) throw new Error(j?.promptFeedback?.blockReason ? 'Gemini declined to answer that message.' : 'Gemini sent no text back. Try again, or pick another model.');
  return text;
}

async function failure(res: Response, label: string, key: string): Promise<Error> {
  let detail = '';
  try { const j = (await res.json()) as { error?: { message?: unknown } | string }; detail = typeof j.error === 'string' ? j.error : typeof j.error?.message === 'string' ? j.error.message : ''; detail = detail.split(key).join('[key]'); } catch { /* not JSON */ }
  const hint = res.status === 401 || res.status === 403 ? ' Check the key in Settings > Integrations.' : res.status === 429 ? ' You may be out of credit or sending too fast.' : '';
  return new Error(`${label} refused the request (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}.${hint}`);
}

export class PlannerChat {
  constructor(private readonly d: ChatDeps) {}

  async providers(): Promise<ChatProviderState[]> {
    const out: ChatProviderState[] = [];
    for (const p of CHAT_PROVIDERS) {
      if (p.id === 'claude') { out.push({ ...p, ready: true, note: '' }); continue; }
      const configured = (await this.d.vault.status(p.id)).configured;
      out.push({ ...p, ready: configured, note: configured ? '' : `Add your ${p.label} key in Settings > Integrations first.` });
    }
    return out;
  }

  async models(provider: ChatProviderId): Promise<string[]> {
    if (provider === 'claude') return CLAUDE_MODELS.map((m) => m.id);
    return this.d.vault.withKey(provider, async (key) => {
      const res = provider === 'openai'
        ? await this.d.fetch(`${OPENAI_BASE}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) })
        : await this.d.fetch(`${GEMINI_BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw await failure(res, CHAT_PROVIDERS.find((p) => p.id === provider)?.label ?? provider, key);
      return textModels(provider, await res.json());
    });
  }

  /** One reply. History is trimmed to the limits first; only the newest messages are sent. */
  async reply(req: { system: string; provider: ChatProviderId; model: string; messages: ChatMessage[] }): Promise<{ text: string }> {
    const messages = trimChat(req.messages);
    if (!messages.length || messages[messages.length - 1]?.role !== 'user') throw new Error('Write a message first.');
    const label = CHAT_PROVIDERS.find((p) => p.id === req.provider)?.label ?? req.provider;
    if (req.provider === 'claude') {
      if (!CLAUDE_MODELS.some((m) => m.id === req.model)) throw new Error('Pick one of the listed Claude models.');
      return { text: (await this.d.claude().planChat(req.system, transcriptText(messages), req.model)).trim() };
    }
    if (!/^[\w.:-]{1,80}$/.test(req.model)) throw new Error('That model name is not valid.');
    return this.d.vault.withKey(req.provider, async (key) => {
      const res = req.provider === 'openai'
        ? await this.d.fetch(`${OPENAI_BASE}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(openaiChatBody(req.model, req.system, messages)), signal: AbortSignal.timeout(120_000) })
        : await this.d.fetch(`${GEMINI_BASE}/models/${encodeURIComponent(req.model)}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(geminiChatBody(req.system, messages)), signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw await failure(res, label, key);
      const json = await res.json();
      return { text: req.provider === 'openai' ? parseOpenAIChat(json) : parseGeminiChat(json) };
    });
  }
}

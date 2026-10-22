import type { Message, ModelProvider, ProviderReply, ToolDef } from '../types';
import { explainHttp, fetchWithRetry } from './retry';

export interface GeminiProviderOptions {
  model: string;
  getKey: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface FunctionPart { functionCall?: { id?: string; name: string; args?: Record<string, unknown> }; text?: string }

/** Pure translation: never dispatches tools, bypasses approvals, or stores credentials. */
export function toGeminiContents(messages: Message[]): Array<{ role: string; parts: Record<string, unknown>[] }> {
  const names = new Map<string, string>();
  for (const m of messages) if (m.role === 'assistant') for (const call of m.toolCalls ?? []) names.set(call.id, call.name);
  return messages.map(m => {
    if (m.role === 'user') {
      const parts: Record<string, unknown>[] = [{ text: m.content }];
      if (m.imageDataUrl) {
        const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(m.imageDataUrl);
        if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
      }
      return { role: 'user', parts };
    }
    if (m.role === 'assistant') {
      const parts: Record<string, unknown>[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { id: c.id, name: c.name, args: c.args } });
      return { role: 'model', parts: parts.length ? parts : [{ text: '' }] };
    }
    const name = names.get(m.toolCallId);
    if (!name) throw new Error('Unmatched tool response.');
    return { role: 'user', parts: [{ functionResponse: { id: m.toolCallId, name, response: { result: m.content } } }] };
  });
}

export function parseGeminiResponse(data: unknown): ProviderReply {
  if (!data || typeof data !== 'object') throw new Error('Invalid Gemini response.');
  const d = data as { candidates?: Array<{ content?: { parts?: FunctionPart[] } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  const parts = d.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new Error('Invalid Gemini response.');
  const textParts: string[] = [];
  const toolCalls: ProviderReply['toolCalls'] = [];
  for (const part of parts) {
    if (typeof part.text === 'string') textParts.push(part.text);
    if (part.functionCall) {
      const call = part.functionCall;
      if (typeof call.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(call.name) || (call.args !== undefined && (typeof call.args !== 'object' || call.args === null || Array.isArray(call.args)))) throw new Error('Invalid Gemini function call.');
      toolCalls.push({ id: typeof call.id === 'string' && call.id ? call.id : `gemini-call-${toolCalls.length}`, name: call.name, args: call.args ?? {} });
    }
  }
  return { text: textParts.length ? textParts.join('\n') : null, toolCalls, usage: d.usageMetadata ? { input: d.usageMetadata.promptTokenCount ?? 0, output: d.usageMetadata.candidatesTokenCount ?? 0 } : undefined };
}

export class GeminiProvider implements ModelProvider {
  readonly id = 'gemini';
  readonly supportsVision = true;
  constructor(private readonly options: GeminiProviderOptions) {
    if (!/^[a-zA-Z0-9._-]+$/.test(options.model)) throw new Error('Invalid Gemini model identifier.');
  }
  async complete(input: Parameters<ModelProvider['complete']>[0]): Promise<ProviderReply> {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    input.signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => abort.abort(), this.options.timeoutMs ?? 120000);
    try {
      const key = await this.options.getKey();
      if (!key || input.signal.aborted) throw new Error('Gemini request unavailable.');
      const body = {
        systemInstruction: { parts: [{ text: input.system }] },
        contents: toGeminiContents(input.messages),
        ...(input.tools.length ? { tools: [{ functionDeclarations: input.tools.map((t: Pick<ToolDef, 'name' | 'description' | 'parameters'>) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] } : {}),
      };
      const res = await fetchWithRetry(() => (this.options.fetchImpl ?? fetch)(`https://generativelanguage.googleapis.com/v1beta/models/${this.options.model}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: abort.signal,
      }), abort.signal);
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}${explainHttp(res.status)}`);
      return parseGeminiResponse(await res.json());
    } catch (e) {
      if (input.signal.aborted) throw new Error('Aborted');
      if (e instanceof Error && /^Gemini HTTP \d+/.test(e.message)) throw e;
      throw new Error('Gemini request failed or returned invalid data.');
    } finally { clearTimeout(timeout); input.signal.removeEventListener('abort', onAbort); }
  }
}

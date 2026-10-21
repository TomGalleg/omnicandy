import { describe, expect, it, vi } from 'vitest';
import { GeminiProvider, parseGeminiResponse, toGeminiContents } from './gemini';
import { createLocalModelProvider } from './localCompatible';

describe('Gemini provider offline compatibility', () => {
  it('translates model calls and matched tool responses', () => {
    const contents = toGeminiContents([
      { role: 'user', content: 'Edit the document' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'app_command', args: { command: 'x' } }] },
      { role: 'tool', toolCallId: 'c1', content: 'done' },
    ]);
    expect(contents[1]!.parts[0]).toHaveProperty('functionCall.name', 'app_command');
    expect(contents[2]!.parts[0]).toHaveProperty('functionResponse.name', 'app_command');
    expect(() => toGeminiContents([{ role: 'tool', toolCallId: 'missing', content: '' }])).toThrow('Unmatched');
  });
  it('parses function calls, text and token usage', () => {
    const reply = parseGeminiResponse({ candidates: [{ content: { parts: [{ text: 'OK' }, { functionCall: { id: 'z', name: 'app_commands', args: { filter: 'shape' } } }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } });
    expect(reply.toolCalls).toEqual([{ id: 'z', name: 'app_commands', args: { filter: 'shape' } }]);
    expect(reply.text).toBe('OK');
    expect(reply.usage).toEqual({ input: 5, output: 3 });
  });
  it('makes no network request until complete, then uses injected fetch', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(JSON.parse(init.body as string).tools[0].functionDeclarations[0].name).toBe('app_commands');
      expect(init.headers).toMatchObject({ 'x-goog-api-key': 'test-key' });
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Ready' }] } }] }) } as Response;
    });
    const provider = new GeminiProvider({ model: 'gemini-test-model', getKey: async () => 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    const result = await provider.complete({ system: 'Help', messages: [{ role: 'user', content: 'Hello' }], tools: [{ name: 'app_commands', description: 'Discover commands', parameters: { type: 'object' } }], signal: new AbortController().signal });
    expect(result.text).toBe('Ready');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('restricts local-compatible endpoints to loopback', () => {
    expect(() => createLocalModelProvider({ model: 'local', baseUrl: 'http://192.168.1.2:11434/v1' })).toThrow('loopback');
    expect(createLocalModelProvider({ model: 'local', baseUrl: 'http://127.0.0.1:11434/v1' }).id).toBe('openai-compatible');
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeJob, type ImageJob } from '@shared/generation';
import { geminiInteractionBody, openaiGenerationBody, parseGeminiImage, parseModelList, parseOpenAIImages } from './imageApis';

const job = (o: Partial<ImageJob> = {}): ImageJob => ({ modelId: 'gpt-image-2.5-flare', prompt: 'A red fox in snow', referenceAssetIds: [], settings: {}, count: 1, ...o });

describe('request and response mapping', () => {
  it('builds the OpenAI generations body', () => {
    expect(openaiGenerationBody(normalizeJob(job({ count: 2 })))).toEqual({ model: 'gpt-image-2.5-flare', prompt: 'A red fox in snow', n: 2, size: '1024x1024', quality: 'medium', background: 'auto', output_format: 'png' });
  });

  it('builds the Gemini Interactions body with reference images as base64 parts', () => {
    const b = geminiInteractionBody(normalizeJob(job({ modelId: 'gemini-nano-banana-2.1', referenceAssetIds: ['a'] })), [{ mime: 'image/png', name: 'a.png', data: Buffer.from('xyz') }]);
    expect(b).toEqual({
      model: 'gemini-nano-banana-2.1',
      input: [{ type: 'text', text: 'A red fox in snow' }, { type: 'image', mime_type: 'image/png', data: Buffer.from('xyz').toString('base64') }],
      response_format: { type: 'image', aspect_ratio: '1:1', image_size: '1K' },
    });
  });

  it('parses images out of provider responses and explains empty ones', () => {
    expect(parseOpenAIImages({ data: [{ b64_json: Buffer.from('png1').toString('base64') }] })[0]!.data.toString()).toBe('png1');
    expect(() => parseOpenAIImages({ data: [] })).toThrow(/no images/);
    const g = parseGeminiImage({
      status: 'completed',
      steps: [
        { type: 'thought', content: [{ type: 'image', data: Buffer.from('draft').toString('base64') }] },
        { type: 'model_output', content: [{ type: 'text', text: 'Here you go' }, { type: 'image', mime_type: 'image/jpeg', data: Buffer.from('final').toString('base64') }] },
      ],
    });
    expect(g).toEqual({ mime: 'image/jpeg', data: Buffer.from('final') });
    expect(() => parseGeminiImage({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot draw that.' }] }] })).toThrow(/I cannot draw that/);
    expect(() => parseGeminiImage({ status: 'failed' })).toThrow(/failed/);
  });

  it('reads model lists from both providers', () => {
    expect(parseModelList('openai', { data: [{ id: 'gpt-image-2.5-flare' }, { id: 'x' }] })).toEqual(['gpt-image-2.5-flare', 'x']);
    expect(parseModelList('gemini', { models: [{ name: 'models/gemini-nano-banana-2.1' }] })).toEqual(['gemini-nano-banana-2.1']);
  });
});

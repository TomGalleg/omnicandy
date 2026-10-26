// Regression guard for the existing Gemini + OpenAI image generation (written before the provider
// capability registry was added). If one of these fails, an existing model, setting, price or
// request shape changed: that must be deliberate, not a side effect of the AI Studio work.
import { describe, expect, it } from 'vitest';
import { estimateCost, IMAGE_MODELS, PROVIDERS, normalizeJob, type ImageJob } from '@shared/generation';
import { geminiInteractionBody, openaiEditFields, openaiGenerationBody } from './imageApis';

const job = (o: Partial<ImageJob> = {}): ImageJob => ({ modelId: 'gpt-image-2.5-flare', prompt: 'A red fox', referenceAssetIds: [], settings: {}, count: 1, ...o });

describe('existing image catalog is frozen', () => {
  it('providers', () => {
    expect(PROVIDERS.map((p) => [p.id, p.billable, p.keyUrl])).toMatchInlineSnapshot(`
      [
        [
          "openai",
          true,
          "https://platform.openai.com/api-keys",
        ],
        [
          "gemini",
          true,
          "https://aistudio.google.com/apikey",
        ],
        [
          "runway",
          true,
          "https://dev.runwayml.com/",
        ],
        [
          "mock",
          false,
          null,
        ],
      ]
    `);
  });
  it('models, capabilities, setting keys, defaults and option values', () => {
    expect(IMAGE_MODELS.map((m) => ({
      id: m.id, provider: m.provider, caps: m.capabilities, maxCount: m.maxCount,
      settings: m.settings.map((s) => `${s.key}=${s.default} [${s.options.map((o) => o.value).join(',')}]`),
    }))).toMatchInlineSnapshot(`
      [
        {
          "caps": [
            "text-to-image",
            "image-edit",
          ],
          "id": "gpt-image-2.5-flare",
          "maxCount": 4,
          "provider": "openai",
          "settings": [
            "size=1024x1024 [1024x1024,1536x1024,1024x1536,2048x2048]",
            "quality=medium [low,medium,high,xhigh,max]",
            "background=auto [auto,opaque,transparent]",
          ],
        },
        {
          "caps": [
            "text-to-image",
            "image-edit",
          ],
          "id": "gpt-image-2.5-sunburst",
          "maxCount": 4,
          "provider": "openai",
          "settings": [
            "size=1024x1024 [1024x1024,1536x1024,1024x1536,2048x2048]",
            "quality=medium [low,medium,high,xhigh,max]",
            "background=auto [auto,opaque,transparent]",
          ],
        },
        {
          "caps": [
            "text-to-image",
            "image-edit",
          ],
          "id": "gemini-nano-banana-2.1",
          "maxCount": 4,
          "provider": "gemini",
          "settings": [
            "aspect_ratio=1:1 [1:1,3:2,2:3,4:3,3:4,4:5,5:4,16:9,9:16,21:9]",
            "image_size=1K [1K,2K,4K]",
          ],
        },
        {
          "caps": [
            "text-to-image",
            "image-edit",
          ],
          "id": "gemini-3.1-flash-lite-image",
          "maxCount": 4,
          "provider": "gemini",
          "settings": [
            "aspect_ratio=1:1 [1:1,3:2,2:3,4:3,3:4,4:5,5:4,16:9,9:16,21:9]",
            "image_size=1K [1K]",
          ],
        },
        {
          "caps": [
            "text-to-image",
            "image-edit",
          ],
          "id": "gemini-3.1-flash-image",
          "maxCount": 4,
          "provider": "gemini",
          "settings": [
            "aspect_ratio=1:1 [1:1,3:2,2:3,4:3,3:4,4:5,5:4,16:9,9:16,21:9]",
            "image_size=1K [512,1K,2K,4K]",
          ],
        },
        {
          "caps": [
            "text-to-image",
            "image-edit",
          ],
          "id": "gemini-3-pro-image",
          "maxCount": 4,
          "provider": "gemini",
          "settings": [
            "aspect_ratio=1:1 [1:1,3:2,2:3,4:3,3:4,4:5,5:4,16:9,9:16,21:9]",
            "image_size=1K [1K,2K,4K]",
          ],
        },
        {
          "caps": [
            "text-to-image",
            "image-edit",
          ],
          "id": "mock-image",
          "maxCount": 4,
          "provider": "mock",
          "settings": [
            "size=512x512 [512x512,1024x1024]",
          ],
        },
      ]
    `);
  });
});

describe('existing estimates are frozen', () => {
  it('prices for every model at its defaults, with and without a reference', () => {
    const rows = IMAGE_MODELS.map((m) => {
      const a = estimateCost(job({ modelId: m.id }));
      const b = estimateCost(job({ modelId: m.id, referenceAssetIds: ['x'], count: 2 }));
      return [m.id, a.amount, a.perImage, b.amount];
    });
    expect(rows).toMatchInlineSnapshot(`
      [
        [
          "gpt-image-2.5-flare",
          0.0132,
          0.0132,
          0.0392,
        ],
        [
          "gpt-image-2.5-sunburst",
          0.0132,
          0.0132,
          0.0392,
        ],
        [
          "gemini-nano-banana-2.1",
          0.0346,
          0.0336,
          0.0692,
        ],
        [
          "gemini-3.1-flash-lite-image",
          0.0346,
          0.0336,
          0.0692,
        ],
        [
          "gemini-3.1-flash-image",
          0.068,
          0.067,
          0.136,
        ],
        [
          "gemini-3-pro-image",
          0.135,
          0.134,
          0.27,
        ],
        [
          "mock-image",
          0,
          0,
          0,
        ],
      ]
    `);
  });
});

describe('existing request bodies are frozen', () => {
  it('OpenAI generations and edits', () => {
    const j = normalizeJob(job({ count: 2, settings: { quality: 'high', size: '1536x1024', background: 'transparent' } }));
    expect(openaiGenerationBody(j)).toMatchInlineSnapshot(`
      {
        "background": "transparent",
        "model": "gpt-image-2.5-flare",
        "n": 2,
        "output_format": "png",
        "prompt": "A red fox",
        "quality": "high",
        "size": "1536x1024",
      }
    `);
    expect(openaiEditFields(j)).toMatchInlineSnapshot(`
      {
        "background": "transparent",
        "model": "gpt-image-2.5-flare",
        "n": "2",
        "output_format": "png",
        "prompt": "A red fox",
        "quality": "high",
        "size": "1536x1024",
      }
    `);
  });
  it('Gemini interactions with a reference image', () => {
    const j = normalizeJob(job({ modelId: 'gemini-nano-banana-2.1', settings: { aspect_ratio: '16:9', image_size: '2K' } }));
    expect(geminiInteractionBody(j, [{ mime: 'image/png', name: 'r.png', data: Buffer.from('abc') }])).toMatchInlineSnapshot(`
      {
        "input": [
          {
            "text": "A red fox",
            "type": "text",
          },
          {
            "data": "YWJj",
            "mime_type": "image/png",
            "type": "image",
          },
        ],
        "model": "gemini-nano-banana-2.1",
        "response_format": {
          "aspect_ratio": "16:9",
          "image_size": "2K",
          "type": "image",
        },
      }
    `);
  });
});

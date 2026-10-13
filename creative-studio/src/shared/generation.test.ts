import { describe, expect, it } from 'vitest';
import { estimateCost, IMAGE_MODELS, normalizeJob, openaiOutputTokens, type ImageJob } from './generation';

const job = (o: Partial<ImageJob> = {}): ImageJob => ({ modelId: 'gpt-image-2.5-flare', prompt: 'A red fox in snow', referenceAssetIds: [], settings: {}, count: 1, ...o });

describe('generation catalog', () => {
  it('offers the verified OpenAI and Gemini image models, each with defaults inside its options', () => {
    expect(IMAGE_MODELS.filter((m) => m.provider === 'openai').map((m) => m.id)).toEqual(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']);
    expect(IMAGE_MODELS.filter((m) => m.provider === 'gemini').map((m) => m.id)).toContain('gemini-nano-banana-2.1');
    for (const m of IMAGE_MODELS) for (const s of m.settings) expect(s.options.map((o) => o.value)).toContain(s.default);
  });

  it('fills defaults and rejects settings, counts and prompts the model does not support', () => {
    expect(normalizeJob(job()).settings).toEqual({ size: '1024x1024', quality: 'medium', background: 'auto' });
    expect(() => normalizeJob(job({ settings: { quality: 'ultra' } }))).toThrow(/Quality/);
    expect(() => normalizeJob(job({ modelId: 'gemini-3.1-flash-lite-image', settings: { image_size: '4K' } }))).toThrow(/Resolution/);
    expect(() => normalizeJob(job({ count: 9 }))).toThrow(/Count/);
    expect(() => normalizeJob(job({ prompt: '   ' }))).toThrow(/prompt/);
    expect(() => normalizeJob(job({ modelId: 'dall-e-9' }))).toThrow(/Unknown model/);
  });
});

describe('cost estimates', () => {
  it("matches OpenAI's published token calculator for GPT Image 2.5", () => {
    expect(openaiOutputTokens(1024, 1024, 'low')).toBe(196);
    expect(openaiOutputTokens(1024, 1024, 'medium')).toBe(439);
    // OpenAI notes a larger non-square size can use fewer tokens than square at the same quality.
    expect(openaiOutputTokens(1536, 1024, 'high')).toBeLessThan(openaiOutputTokens(1024, 1024, 'high'));
    const e = estimateCost(job({ settings: { quality: 'high' }, count: 2 }));
    expect(e.approximate).toBe(true);
    expect(e.perImage).toBeCloseTo((openaiOutputTokens(1024, 1024, 'high') * 30) / 1e6, 4);
    expect(e.amount).toBeGreaterThanOrEqual(e.perImage * 2);
  });

  it("uses Google's per-image prices for Gemini and is free for the mock", () => {
    expect(estimateCost(job({ modelId: 'gemini-nano-banana-2.1', settings: { image_size: '2K' } })).perImage).toBe(0.0504);
    expect(estimateCost(job({ modelId: 'gemini-3-pro-image', settings: { image_size: '4K' }, count: 3 })).amount).toBeCloseTo(0.721, 3);
    expect(estimateCost(job({ modelId: 'mock-image' }))).toMatchObject({ amount: 0, approximate: false });
  });
});

import { describe, expect, it } from 'vitest';
import { IMAGE_MODELS } from './generation';
import { findModels, STUDIO_MODELS, STUDIO_PROVIDERS, studioModel, supports } from './providerCapabilities';

describe('provider capability registry', () => {
  it('lists every shipped Gemini/OpenAI/mock model exactly once, as wired raster', () => {
    for (const m of IMAGE_MODELS) {
      const e = studioModel(m.provider, m.id)!;
      expect(e, m.id).toBeDefined();
      expect(e).toMatchObject({ availability: 'wired', output: 'raster', source: 'in-app' });
      expect(e.operations).toContain('text-to-image');
    }
    expect(STUDIO_MODELS.filter((m) => m.availability === 'wired' && m.providerId !== 'recraft' && m.providerId !== 'higgsfield')).toHaveLength(IMAGE_MODELS.length);
  });

  it('has unique ids per provider and only known providers', () => {
    const keys = STUDIO_MODELS.map((m) => `${m.providerId}/${m.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    const ids = STUDIO_PROVIDERS.map((p) => p.id);
    for (const m of STUDIO_MODELS) expect(ids).toContain(m.providerId);
  });

  it('never claims what the docs do not', () => {
    expect(supports('openai', 'gpt-image-2.5-flare', 'inpaint')).toBe(false);
    expect(supports('gemini', 'gemini-nano-banana-2.1', 'vectorize')).toBe(false);
    expect(supports('recraft', 'recraftv4_1_flash', 'styles')).toBe(false);
    expect(supports('recraft', 'recraftv4_1', 'styles')).toBe(true);
    expect(supports('recraft', 'recraftv4_1', 'inpaint')).toBe(false);
    expect(supports('recraft', 'recraftv3', 'inpaint')).toBe(true);
    expect(findModels({ providerId: 'recraft', operation: 'text-to-video' })).toEqual([]);
    expect(supports('recraft', 'does-not-exist', 'text-to-image')).toBe(false);
  });

  it('keeps raster and genuine SVG apart', () => {
    const svg = findModels({ output: 'svg' });
    expect(svg.length).toBeGreaterThan(0);
    for (const m of svg) { expect(m.providerId).toBe('recraft'); expect(m.operations).not.toContain('remove-background'); }
    expect(findModels({ providerId: 'gemini' }).every((m) => m.output === 'raster')).toBe(true);
    expect(findModels({ operation: 'vectorize' }).map((m) => m.output)).toEqual(['svg']);
  });

  it('only offers wired models for generation today, and searches across providers', () => {
    expect(findModels({ wiredOnly: true }).every((m) => ['gemini', 'openai', 'mock', 'recraft', 'higgsfield'].includes(m.providerId))).toBe(true);
    expect(findModels({ search: 'nano banana' }).map((m) => m.id)).toEqual(['gemini-nano-banana-2.1']);
    expect(findModels({ search: 'soul' }).map((m) => `${m.providerId}:${m.availability}`)).toEqual(['higgsfield:planned']);
    expect(findModels({ search: 'seedance', wiredOnly: true }).length).toBeGreaterThanOrEqual(6);
  });

  it('keeps Higgsfield (API vs MCP) and Recraft independent; Higgsfield video is wired, Soul is not', () => {
    const hf = STUDIO_PROVIDERS.find((p) => p.id === 'higgsfield')!;
    expect(hf.note).toMatch(/MCP.*different/);
    expect(hf.cancel).toMatch(/queued/);
    expect(hf.availability).toBe('wired');
    // Soul is the only Higgsfield picture model that is not connected; the Recraft ones are.
    expect(findModels({ providerId: 'higgsfield', output: 'raster' }).filter((m) => m.availability === 'planned').map((m) => m.id)).toEqual(['higgsfield-ai/soul/v2/standard']);
    expect(findModels({ providerId: 'higgsfield', search: 'recraft', wiredOnly: true }).map((m) => m.id)).toEqual(['recraft/v4.1/text-to-image', 'recraft/v4.1/pro/text-to-image', 'recraft/v4.1/utility/text-to-image', 'recraft/v4.1/utility/pro/text-to-image']);
    expect(findModels({ providerId: 'higgsfield', operation: 'video-extend' }).map((m) => m.id)).toEqual(['bytedance/seedance-2.5/video-extend']);
    expect(findModels({ providerId: 'higgsfield' }).every((m) => m.output === 'raster' || m.output === 'video')).toBe(true);
    // Recraft: the four V4.1 generation models and the picture tools are connected; masked editing stays planned.
    expect(findModels({ providerId: 'recraft', wiredOnly: true }).map((m) => m.id)).toEqual(['recraftv4_1', 'recraftv4_1_vector', 'recraftv4_1_pro', 'recraftv4_1_pro_vector', ...['vectorize', 'removeBackground', 'crispUpscale', 'creativeUpscale', 'imageToImage', 'imageToImageVector', 'replaceBackground', 'replaceBackgroundVector'].map((t) => `recraft-tool/${t}`)]);
    expect(findModels({ providerId: 'recraft', operation: 'inpaint', wiredOnly: true })).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { HF_MODELS, hfModel, higgsfieldBody, isHiggsfieldApiUrl, normalizeHiggsfieldJob, parseHfStatus, type HiggsfieldJob } from './higgsfield';

const job = (modelId: string, o: Partial<HiggsfieldJob> = {}): HiggsfieldJob => ({ modelId, prompt: 'A fox', params: {}, inputs: {}, ...o });

describe('Higgsfield catalog', () => {
  it('has unique endpoint ids, a docs source for each, and only documented kinds', () => {
    expect(new Set(HF_MODELS.map((m) => m.id)).size).toBe(HF_MODELS.length);
    for (const m of HF_MODELS) {
      expect(m.source, m.id).toMatch(/^https:\/\/docs\.higgsfield\.ai\//);
      expect(m.operations.length, m.id).toBeGreaterThan(0);
      for (const a of m.anyOf ?? []) expect(m.inputs.map((i) => i.key), m.id).toContain(a);
    }
  });
  it('offers the Seedance 2.5 text, picture, reference, edit and extend endpoints', () => {
    expect(HF_MODELS.filter((m) => m.family === 'Seedance 2.5').map((m) => m.id.split('/').pop())).toEqual(['text-to-video', 'image-to-video', 'reference-to-video', 'video-edit', 'video-extend']);
    expect(hfModel('bytedance/seedance-2.5/video-edit')!.params.some((p) => p.key === 'duration')).toBe(false); // the docs say never send duration
  });
  it('offers Recraft V4.1 through Higgsfield as pictures only, with the documented settings', () => {
    const r = HF_MODELS.filter((m) => m.family === 'Recraft V4.1 (Higgsfield)');
    expect(r.map((m) => m.id)).toEqual(['recraft/v4.1/text-to-image', 'recraft/v4.1/pro/text-to-image', 'recraft/v4.1/utility/text-to-image', 'recraft/v4.1/utility/pro/text-to-image']);
    for (const m of r) { expect(m.output).toBe('image'); expect(m.inputs).toEqual([]); expect(m.params.find((p) => p.key === 'aspect_ratio')!.options).toHaveLength(14); }
    const body = higgsfieldBody({ modelId: 'recraft/v4.1/text-to-image', prompt: 'A fox', params: { aspect_ratio: '16:9', output_format: 'png', colors: '#ff6600, #1a1a1a', background_color: '#ffffff' }, inputs: {} }, {});
    expect(body).toEqual({ prompt: 'A fox', aspect_ratio: '16:9', output_format: 'png', colors: [{ rgb: [255, 102, 0] }, { rgb: [26, 26, 26] }], background_color: { rgb: [255, 255, 255] } });
    expect(() => normalizeHiggsfieldJob({ modelId: 'recraft/v4.1/text-to-image', prompt: 'x', params: { colors: 'red' }, inputs: {} })).toThrow(/not a colour/);
    expect(() => normalizeHiggsfieldJob({ modelId: 'recraft/v4.1/text-to-image', prompt: 'x', params: { background_color: '#fff000 #000fff' }, inputs: {} })).toThrow(/one colour/);
    expect(() => normalizeHiggsfieldJob({ modelId: 'recraft/v4.1/text-to-image', prompt: 'x', params: { aspect_ratio: '7:5' }, inputs: {} })).toThrow(/not allowed/);
  });
  it('does not list Soul, whose endpoint the docs state two ways', () => {
    expect(HF_MODELS.some((m) => /soul/.test(m.id))).toBe(false);
  });
});

describe('Higgsfield job validation', () => {
  it('builds the documented body: only given settings, single vs array inputs', () => {
    const body = higgsfieldBody(job('bytedance/seedance-2.5/image-to-video', { prompt: '', params: { duration: 8, generate_audio: false }, inputs: { image_url: ['a'], end_image_url: ['b'] } }), { image_url: ['https://x/a'], end_image_url: ['https://x/b'] });
    expect(body).toEqual({ duration: 8, generate_audio: false, image_url: 'https://x/a', end_image_url: 'https://x/b' });
    const ref = higgsfieldBody(job('bytedance/seedance-2.5/reference-to-video', { inputs: { image_urls: ['a', 'b'] } }), { image_urls: ['https://x/a', 'https://x/b'] });
    expect(ref).toEqual({ prompt: 'A fox', image_urls: ['https://x/a', 'https://x/b'] });
  });
  it('rejects what the docs do not allow', () => {
    expect(() => normalizeHiggsfieldJob(job('nope/model'))).toThrow(/Unknown/);
    expect(() => normalizeHiggsfieldJob(job('bytedance/seedance-2.5/text-to-video', { prompt: ' ' }))).toThrow(/prompt/);
    expect(() => normalizeHiggsfieldJob(job('bytedance/seedance-2.5/text-to-video', { params: { duration: 31 } }))).toThrow(/between 4 and 30/);
    expect(() => normalizeHiggsfieldJob(job('bytedance/seedance-2.5/text-to-video', { params: { duration: 4.5 } }))).toThrow(/whole/);
    expect(() => normalizeHiggsfieldJob(job('bytedance/seedance-2.5/text-to-video', { params: { resolution: '8k' } }))).toThrow(/not allowed/);
    expect(() => normalizeHiggsfieldJob(job('bytedance/seedance-2.5/text-to-video', { params: { seed: 1 } }))).toThrow(/not a setting/);
    expect(() => normalizeHiggsfieldJob(job('bytedance/seedance-2.5/text-to-video', { inputs: { image_urls: ['a'] } }))).toThrow(/takes no/);
    expect(() => normalizeHiggsfieldJob(job('kling-video/v2.5-turbo/pro/text-to-video', { params: { duration: 7 } }))).toThrow(/not allowed/);
    expect(() => normalizeHiggsfieldJob(job('kling-video/v2.5-turbo/pro/text-to-video', { params: { cfg_scale: 2 } }))).toThrow(/between 0 and 1/);
  });
  it('needs the inputs each endpoint requires', () => {
    expect(() => normalizeHiggsfieldJob(job('bytedance/seedance-2.5/image-to-video'))).toThrow(/Starting picture/);
    expect(() => normalizeHiggsfieldJob(job('bytedance/seedance-2.5/video-edit'))).toThrow(/Source video/);
    expect(() => normalizeHiggsfieldJob(job('bytedance/seedance-2.5/reference-to-video'))).toThrow(/at least one of/);
    // Seedance 2.0 references need a picture or a video: sound alone is not enough.
    expect(() => normalizeHiggsfieldJob(job('bytedance/seedance-2.0/reference-to-video', { inputs: { audio_urls: ['a'] } }))).toThrow(/at least one of/);
    expect(() => normalizeHiggsfieldJob(job('bytedance/seedance-2.0/reference-to-video', { inputs: { image_urls: Array.from({ length: 10 }, (_, i) => `a${i}`) } }))).toThrow(/at most 9/);
    expect(normalizeHiggsfieldJob(job('bytedance/seedance-2.5/image-to-video', { prompt: '', inputs: { image_url: ['a'] } })).prompt).toBe('');
  });
});

describe('Higgsfield responses', () => {
  it('reads the documented status shapes', () => {
    expect(parseHfStatus({ status: 'queued', request_id: 'r', status_url: 'https://api.higgsfield.ai/requests/r/status', cancel_url: 'https://api.higgsfield.ai/requests/r/cancel' })).toMatchObject({ status: 'queued', requestId: 'r' });
    expect(parseHfStatus({ status: 'completed', video: { url: 'https://x/v.mp4' } }).outputs).toEqual([{ url: 'https://x/v.mp4', kind: 'video' }]);
    expect(parseHfStatus({ status: 'completed', images: [{ url: 'https://x/1.png' }, { url: 'https://x/2.png' }] }).outputs).toHaveLength(2);
    expect(parseHfStatus({ status: 'failed', error: 'boom' }).error).toBe('boom');
    expect(() => parseHfStatus({ status: 'weird' })).toThrow(/not documented/);
  });
  it('only trusts Higgsfield API addresses', () => {
    expect(isHiggsfieldApiUrl('https://api.higgsfield.ai/requests/1/status')).toBe(true);
    expect(isHiggsfieldApiUrl('http://api.higgsfield.ai/requests/1/status')).toBe(false);
    expect(isHiggsfieldApiUrl('https://api.higgsfield.ai.evil.example/x')).toBe(false);
    expect(isHiggsfieldApiUrl('https://evil.example/api.higgsfield.ai')).toBe(false);
  });
});

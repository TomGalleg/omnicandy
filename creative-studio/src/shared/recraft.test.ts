import { describe, expect, it } from 'vitest';
import { estimateRecraft, normalizeRecraftJob, recraftBody, type RecraftJob } from './recraft';

const job = (o: Partial<RecraftJob> = {}): RecraftJob => ({ modelId: 'recraftv4_1', prompt: 'A fox', count: 1, aspect: 'auto', colors: [], background: '', ...o });

describe('Recraft job', () => {
  it('builds the documented request body', () => {
    expect(recraftBody(job())).toEqual({ model: 'recraftv4_1', prompt: 'A fox', n: 1, response_format: 'b64_json', image_format: 'png' });
    expect(recraftBody(job({ modelId: 'recraftv4_1_vector', aspect: '16:9', count: 2, colors: ['#ff6600'], background: '#FFFFFF' }))).toEqual({
      model: 'recraftv4_1_vector', prompt: 'A fox', n: 2, response_format: 'b64_json', size: '16:9',
      controls: { colors: [{ rgb: [255, 102, 0] }], background_color: { rgb: [255, 255, 255] } },
    });
  });
  it('rejects what the model or docs do not allow', () => {
    expect(() => normalizeRecraftJob(job({ modelId: 'recraftv9' }))).toThrow(/Unknown/);
    expect(() => normalizeRecraftJob(job({ prompt: ' ' }))).toThrow(/prompt/);
    expect(() => normalizeRecraftJob(job({ count: 5 }))).toThrow(/Count/);
    expect(() => normalizeRecraftJob(job({ aspect: '7:5' }))).toThrow(/Shape/);
    expect(() => normalizeRecraftJob(job({ colors: ['red'] }))).toThrow(/colour/);
    expect(() => normalizeRecraftJob(job({ colors: Array(11).fill('#000000') }))).toThrow(/10/);
  });
  it('connects V4.1 Flash and V3 with their own prices and prompt limits', () => {
    expect(estimateRecraft(job({ modelId: 'recraftv4_1_flash', count: 4 })).amount).toBe(0.028);
    expect(estimateRecraft(job({ modelId: 'recraftv3' })).amount).toBe(0.04);
    expect(estimateRecraft(job({ modelId: 'recraftv3_vector', count: 2 })).amount).toBe(0.16);
    expect(recraftBody(job({ modelId: 'recraftv4_1_flash', aspect: '16:9' }))).toEqual({ model: 'recraftv4_1_flash', prompt: 'A fox', n: 1, response_format: 'b64_json', size: '16:9', image_format: 'png' });
    expect(recraftBody(job({ modelId: 'recraftv3_vector' }))).toEqual({ model: 'recraftv3_vector', prompt: 'A fox', n: 1, response_format: 'b64_json' }); // image_format is ignored for SVG, so it is not sent
    expect(() => normalizeRecraftJob(job({ modelId: 'recraftv3', prompt: 'x'.repeat(1001) }))).toThrow(/too long for Recraft V3/);
    expect(normalizeRecraftJob(job({ modelId: 'recraftv4_1_flash', prompt: 'x'.repeat(1001) })).prompt).toHaveLength(1001);
  });
  it('uses the published per-image prices', () => {
    expect(estimateRecraft(job({ count: 3 })).amount).toBe(0.105);
    expect(estimateRecraft(job({ modelId: 'recraftv4_1_pro_vector' })).amount).toBe(0.3);
  });
});

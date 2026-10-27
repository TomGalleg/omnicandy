import { describe, expect, it } from 'vitest';
import { checkToolSource, estimateTool, normalizeToolJob, RECRAFT_TOOLS, recraftTool, toolBody, type RecraftToolJob } from './recraftTools';

const job = (toolId: string, o: Partial<RecraftToolJob> = {}): RecraftToolJob => ({ toolId, assetId: 'a1', prompt: '', strength: 0.5, count: 1, shapeStacking: 'hierarchical', ...o });

describe('Recraft tools', () => {
  it('lists each tool once with a docs source and a published price', () => {
    expect(new Set(RECRAFT_TOOLS.map((t) => t.id)).size).toBe(RECRAFT_TOOLS.length);
    for (const t of RECRAFT_TOOLS) { expect(t.source).toMatch(/^https:\/\/www\.recraft\.ai\/docs\//); expect(t.usd).toBeGreaterThan(0); }
    expect(RECRAFT_TOOLS.filter((t) => t.output === 'svg').map((t) => t.id)).toEqual(['vectorize', 'imageToImageVector', 'replaceBackgroundVector']);
  });

  it('uses the published prices', () => {
    expect(estimateTool(job('vectorize')).amount).toBe(0.01);
    expect(estimateTool(job('crispUpscale')).amount).toBe(0.004);
    expect(estimateTool(job('creativeUpscale')).amount).toBe(0.25);
    expect(estimateTool(job('imageToImage', { prompt: 'x', count: 3 })).amount).toBe(0.12);
    expect(estimateTool(job('replaceBackgroundVector', { prompt: 'x' })).amount).toBe(0.08);
    // The single-result tools ignore a count: they always cost one request.
    expect(estimateTool(job('removeBackground', { count: 4 })).amount).toBe(0.01);
  });

  it('builds the documented request bodies', () => {
    const png = 'data:image/png;base64,AAAA';
    expect(toolBody(job('vectorize', { shapeStacking: 'cut_out' }), png)).toEqual({ image_url: png, response_format: 'url', shape_stacking: 'cut_out' });
    expect(toolBody(job('removeBackground'), png)).toEqual({ image_url: png, response_format: 'url', image_format: 'png' });
    expect(toolBody(job('crispUpscale'), png)).toEqual({ image_url: png, response_format: 'url', image_format: 'png' });
    expect(toolBody(job('imageToImage', { prompt: 'make it autumn', strength: 0.4, count: 2 }), png)).toEqual({ image_url: png, response_format: 'url', model: 'recraftv3', prompt: 'make it autumn', strength: 0.4, n: 2, image_format: 'png' });
    expect(toolBody(job('replaceBackgroundVector', { prompt: 'a beach' }), png)).toEqual({ image_url: png, response_format: 'url', model: 'recraftv3_vector', prompt: 'a beach', n: 1 });
  });

  it('rejects what the docs do not allow', () => {
    expect(() => normalizeToolJob(job('nope'))).toThrow(/Unknown/);
    expect(() => normalizeToolJob(job('vectorize', { assetId: '' }))).toThrow(/Choose the picture/);
    expect(() => normalizeToolJob(job('imageToImage', { prompt: ' ' }))).toThrow(/Describe the change/);
    expect(() => normalizeToolJob(job('imageToImage', { prompt: 'x', strength: 1.5 }))).toThrow(/Strength/);
    expect(() => normalizeToolJob(job('replaceBackground', { prompt: 'x', count: 5 }))).toThrow(/Count/);
    expect(() => normalizeToolJob(job('replaceBackground', { prompt: 'x'.repeat(1001) }))).toThrow(/too long/);
  });

  it('checks the source picture before anything is paid for', () => {
    const png = (w: number, h: number) => ({ name: 'p.png', sourceFormat: 'png', width: w, height: h });
    const crisp = recraftTool('crispUpscale')!, creative = recraftTool('creativeUpscale')!, vec = recraftTool('vectorize')!, bg = recraftTool('removeBackground')!;
    expect(() => checkToolSource(crisp, png(40, 40), 1000)).not.toThrow(); // crisp allows 32 px sides
    expect(() => checkToolSource(creative, png(40, 40), 1000)).toThrow(/between 256 and 4096/);
    expect(() => checkToolSource(vec, png(5000, 300), 1000)).toThrow(/between 256 and 4096/);
    expect(() => checkToolSource(vec, png(4096, 4096), 1000)).toThrow(/16 megapixels/);
    expect(() => checkToolSource(vec, png(512, 512), 21 * 1024 * 1024)).toThrow(/20 MB/);
    expect(() => checkToolSource(vec, { name: 'a.svg', sourceFormat: 'svg' }, 1000)).toThrow(/accepts/); // vectorize takes pictures, not SVG
    expect(() => checkToolSource(bg, { name: 'a.svg', sourceFormat: 'svg' }, 1000)).not.toThrow(); // remove background takes SVG
  });
});

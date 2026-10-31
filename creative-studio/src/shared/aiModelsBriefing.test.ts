import { describe, expect, it } from 'vitest';
import { aiModelsLines, aiPictures, pictureContext, wantsAiModels } from './aiModelsBriefing';
import type { Asset } from './types';
import { IMAGE_MODELS } from './generation';
import { VIDEO_MODELS } from './video';

describe('what the directors are told about the AI makers', () => {
  it('lists every real picture and video model, and no others', () => {
    const t = aiModelsLines({}).join('\n');
    for (const m of [...IMAGE_MODELS, ...VIDEO_MODELS]) expect(t).toContain(m.label);
    expect(t).not.toMatch(/dall-e|midjourney|stable diffusion xl/i);
  });
  it('says which are ready and which need a key', () => {
    const t = aiModelsLines({ gemini: true }).join('\n');
    expect(t).toMatch(/Nano Banana 2\.1 \(Google Gemini; ready \(key saved\)\)/);
    expect(t).toMatch(/GPT Image 2\.5 Flare \(OpenAI; needs a key/);
    expect(t).toContain('Mock image (Mock (offline, free); free, offline test pattern only)');
    expect(t).not.toContain('No paid AI maker has a key saved');
  });
  it('is honest when nothing is set up', () => { expect(aiModelsLines({}).join('\n')).toContain('No paid AI maker has a key saved yet'); });
  it('tells everyone AI work goes through the AI Director, and tells the AI Director it owns it', () => {
    expect(aiModelsLines({}, 'creative-director').join('\n')).toContain('Anything that uses AI goes through the AI Director');
    expect(aiModelsLines({}, 'ai-director').join('\n')).toContain('Everything that uses AI goes through you');
  });
  it('is for the AI Director and Creative Director only', () => {
    expect(wantsAiModels('ai-director') && wantsAiModels('creative-director')).toBe(true);
    expect(wantsAiModels('quality-director') || wantsAiModels(undefined)).toBe(false);
  });
});

const pic = (name: string, at: string, o: Partial<Asset> = {}, prov: Partial<Asset['provenance']> = {}): Asset => ({
  id: name, name, kind: 'image', relPath: name, sha256: '', bytes: 1, sourceFormat: 'png', approval: 'none', ...o,
  provenance: { origin: 'generated', source: 'x', createdAt: at, ...prov },
} as Asset);

describe('the pictures the AI Director shows', () => {
  it('are only AI-made pictures, newest first, and not too many', () => {
    const list = [pic('old', '2026-01-01T00:00:00Z'), pic('new', '2026-03-01T00:00:00Z'), pic('imported', '2026-04-01T00:00:00Z', {}, { origin: 'imported' }), pic('clip', '2026-05-01T00:00:00Z', { kind: 'video' })];
    expect(aiPictures(list).map((a) => a.name)).toEqual(['new', 'old']);
    expect(aiPictures(Array.from({ length: 30 }, (_, i) => pic(`p${i}`, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`)))).toHaveLength(12);
  });
  it('are described by how they were made, and the chat is told it cannot see them', () => {
    const t = pictureContext(pic('dragon.png', '2026-03-01T10:00:00Z', {}, { model: 'gemini-3.1-flash-lite-image', provider: 'gemini', prompt: 'a baby dragon reading', settings: { aspect_ratio: '1:1' }, estimatedCostUsd: 0.04 }));
    expect(t).toContain('"dragon.png"'); expect(t).toContain('gemini-3.1-flash-lite-image'); expect(t).toContain('a baby dragon reading'); expect(t).toContain('aspect_ratio 1:1'); expect(t).toContain('$0.04');
    expect(t).toContain('You cannot see the picture itself');
  });
  it('copes with a picture that has no recorded prompt, and cuts a very long one', () => {
    expect(pictureContext(pic('x.png', '2026-03-01T00:00:00Z'))).toContain('The prompt was not recorded.');
    expect(pictureContext(pic('x.png', '2026-03-01T00:00:00Z', {}, { prompt: 'word '.repeat(500) })).length).toBeLessThan(1200);
  });
});

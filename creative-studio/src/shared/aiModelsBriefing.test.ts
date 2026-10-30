import { describe, expect, it } from 'vitest';
import { aiModelsLines, wantsAiModels } from './aiModelsBriefing';
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

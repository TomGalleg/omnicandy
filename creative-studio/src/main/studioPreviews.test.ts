import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HF_MODELS } from '@shared/higgsfield';
import { studioModel } from '@shared/providerCapabilities';
import { FAMILY_PREVIEWS, MODEL_PREVIEWS, previewFor } from '@shared/studioPreviews';

const dir = path.join(__dirname, '..', 'renderer', 'src', 'assets', 'previews');

describe('model card previews', () => {
  it('only lists files that exist, and keeps them small', () => {
    const all = [...Object.entries(MODEL_PREVIEWS), ...Object.entries(FAMILY_PREVIEWS)];
    for (const [key, p] of all) {
      for (const f of [p.poster, p.video].filter((x): x is string => !!x)) {
        const file = path.join(dir, f);
        expect(fs.existsSync(file), `${key}: ${f}`).toBe(true);
        expect(fs.statSync(file).size, f).toBeLessThan(2 * 1024 * 1024);
      }
      expect(p.credit.length).toBeGreaterThan(0);
      expect(p.aspect).toBeGreaterThan(0.3);
    }
    for (const key of Object.keys(MODEL_PREVIEWS)) expect(studioModel(key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)), `${key} is a real registry model`).toBeDefined();
    for (const family of Object.keys(FAMILY_PREVIEWS)) expect(HF_MODELS.some((m) => m.family === family), `${family} is a real family`).toBe(true);
  });

  it('gives every Seedance 2.5 card its own preview, plus the other cards that have one', () => {
    const sd = HF_MODELS.filter((m) => m.family === 'Seedance 2.5');
    expect(sd).toHaveLength(5);
    for (const m of sd) expect(previewFor(studioModel('higgsfield', m.id)!)?.poster, m.id).toMatch(/^seedance-.*\.jpg$/);
    expect(new Set(sd.map((m) => previewFor(studioModel('higgsfield', m.id)!)?.poster)).size).toBe(5);
    expect(previewFor(studioModel('higgsfield', 'bytedance/seedance-2.0/reference-to-video')!)?.video).toBe('seedance2.mp4');
    expect(previewFor(studioModel('higgsfield', 'higgsfield/genjutsu/motion-transfer/v1.0')!)?.aspect).toBeLessThan(1); // a tall clip
    expect(previewFor(studioModel('higgsfield', 'higgsfield-ai/soul/v2/standard')!)?.video).toBeUndefined(); // a still
    expect(previewFor(studioModel('openai', 'gpt-image-2.5-flare')!)?.credit).toMatch(/GPT Image 2\.0/);
    expect(previewFor(studioModel('gemini', 'gemini-nano-banana-2.1')!)).toBeNull();
  });
});

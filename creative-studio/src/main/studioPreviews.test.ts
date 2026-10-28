import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HF_MODELS } from '@shared/higgsfield';
import { STUDIO_MODELS, studioModel } from '@shared/providerCapabilities';
import { isShown } from '@shared/studioCatalog';
import { FAMILY_PREVIEWS, MODEL_PREVIEWS, previewFor } from '@shared/studioPreviews';
import { PACK_PREVIEWS } from '@shared/studioPreviews.generated';

const dir = path.join(__dirname, '..', 'renderer', 'src', 'assets', 'previews');
const all = () => [...Object.entries(MODEL_PREVIEWS), ...Object.entries(FAMILY_PREVIEWS)];
const walk = (d: string, rel = ''): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));

describe('model card previews', () => {
  it('only lists files that exist, keeps them small, and refers to real models', () => {
    for (const [key, p] of all()) {
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

  it('ships no example file that no card uses', () => {
    const used = new Set(all().flatMap(([, p]) => [p.poster, p.video].filter((x): x is string => !!x)));
    expect(walk(dir).filter((f) => !used.has(f))).toEqual([]);
  });

  it('shows the shipped Sample media results on their cards, ahead of the hand-supplied examples', () => {
    expect(Object.keys(PACK_PREVIEWS).length).toBeGreaterThanOrEqual(25);
    for (const [key, p] of Object.entries(PACK_PREVIEWS)) { expect(p.poster, key).toMatch(/^cards\/sample-\d+\.jpg$/); expect(MODEL_PREVIEWS[key], key).toBe(p); }
    expect(previewFor(studioModel('openai', 'gpt-image-2.5-flare')!)?.credit).toBe('Sample made with this model');
    expect(previewFor(studioModel('recraft', 'recraft-tool/imageToImage')!)?.poster).toMatch(/^cards\//);
    expect(previewFor(studioModel('higgsfield', 'bytedance/seedance-2.5/text-to-video')!)?.video).toMatch(/^cards\/sample-\d+\.mp4$/);
    expect(previewFor(studioModel('higgsfield', 'higgsfield-ai/soul/cinema')!)?.poster).toMatch(/^cards\//);
  });

  it('keeps the hand-supplied examples for models the pack has no result of yet', () => {
    const sd = HF_MODELS.filter((m) => m.family === 'Seedance 2.5');
    expect(new Set(sd.map((m) => previewFor(studioModel('higgsfield', m.id)!)?.poster)).size).toBe(5); // every Seedance 2.5 card has its own picture
    expect(previewFor(studioModel('higgsfield', 'bytedance/seedance-2.0/reference-to-video')!)?.video).toBe('seedance2.mp4');
    expect(previewFor(studioModel('higgsfield', 'higgsfield/genjutsu/motion-transfer/v1.0')!)?.aspect).toBeLessThan(1); // a tall clip
    expect(previewFor(studioModel('higgsfield', 'higgsfield-ai/soul/v2/standard')!)?.video).toBeUndefined(); // a still
    for (const id of ['vectorize', 'removeBackground', 'crispUpscale', 'creativeUpscale']) expect(previewFor(studioModel('recraft', `recraft-tool/${id}`)!), id).not.toBeNull();
    expect(previewFor(studioModel('recraft', 'recraft-mask-tools')!)?.poster).toBe('recraft-masked-editing.jpg');
  });

  it('leaves no card without an example', () => {
    const blank = STUDIO_MODELS.filter(isShown).filter((m) => !previewFor(m)).map((m) => `${m.providerId}/${m.id}`);
    expect(blank).toEqual([]);
  });
});

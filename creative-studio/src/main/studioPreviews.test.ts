import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HF_MODELS } from '@shared/higgsfield';
import { studioModel } from '@shared/providerCapabilities';
import { FAMILY_PREVIEWS, previewFor } from '@shared/studioPreviews';

const dir = path.join(__dirname, '..', 'renderer', 'src', 'assets', 'previews');

describe('model card previews', () => {
  it('only lists files that exist, and keeps them small', () => {
    for (const [family, p] of Object.entries(FAMILY_PREVIEWS)) {
      for (const f of [p.poster, p.video].filter((x): x is string => !!x)) {
        const file = path.join(dir, f);
        expect(fs.existsSync(file), `${family}: ${f}`).toBe(true);
        expect(fs.statSync(file).size, f).toBeLessThan(2 * 1024 * 1024);
      }
      expect(p.credit.length).toBeGreaterThan(0);
      expect(HF_MODELS.some((m) => m.family === family), `${family} is a real Higgsfield family`).toBe(true);
    }
  });

  it('gives every Seedance 2.5 card the preview, and nothing else yet', () => {
    const sd = HF_MODELS.filter((m) => m.family === 'Seedance 2.5');
    expect(sd).toHaveLength(5);
    for (const m of sd) expect(previewFor(studioModel('higgsfield', m.id)!)?.poster).toBe('seedance-2-5.jpg');
    expect(previewFor(studioModel('higgsfield', 'bytedance/seedance-2.0/reference-to-video')!)).toBeNull();
    expect(previewFor(studioModel('gemini', 'gemini-nano-banana-2.1')!)).toBeNull();
  });
});

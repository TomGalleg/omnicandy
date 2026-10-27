// Example media shown on model cards when the user has not made anything with that model yet.
// Only media that was handed over by the user is listed, each with where it came from. A card with no entry keeps its neutral
// placeholder: nothing here is invented or taken from a site without the user's say-so.
// Files live in src/renderer/src/assets/previews/ (small copies: a poster picture and a short silent clip).

import { hfModel } from './higgsfield';
import type { StudioModel } from './providerCapabilities';

export interface ModelPreview {
  poster: string;
  /** A short silent clip that plays when the card is hovered. */
  video?: string;
  /** Shown on the card so nobody mistakes it for the user's own result. */
  credit: string;
  /** Width divided by height of the media. The mosaic view gives the card this shape. */
  aspect: number;
}

const CREDIT = 'Promo clip from Higgsfield';

/** One preview per model, by registry id (these win over a family preview). */
export const MODEL_PREVIEWS: Record<string, ModelPreview> = {
  'bytedance/seedance-2.5/text-to-video': { poster: 'seedance-text.jpg', video: 'seedance-text.mp4', credit: CREDIT, aspect: 1470 / 630 },
  'bytedance/seedance-2.5/image-to-video': { poster: 'seedance-picture.jpg', video: 'seedance-picture.mp4', credit: CREDIT, aspect: 16 / 9 },
  'bytedance/seedance-2.5/reference-to-video': { poster: 'seedance-reference.jpg', video: 'seedance-reference.mp4', credit: CREDIT, aspect: 1664 / 1248 },
  'bytedance/seedance-2.5/video-edit': { poster: 'seedance-edit.jpg', video: 'seedance-edit.mp4', credit: CREDIT, aspect: 16 / 9 },
  'bytedance/seedance-2.5/video-extend': { poster: 'seedance-extend.jpg', video: 'seedance-extend.mp4', credit: CREDIT, aspect: 16 / 9 },
};

/** One preview shared by every model of a Higgsfield family (see HfModel.family). */
export const FAMILY_PREVIEWS: Record<string, ModelPreview> = {};

export function previewFor(m: StudioModel): ModelPreview | null {
  const own = MODEL_PREVIEWS[m.id];
  if (own && m.providerId === 'higgsfield') return own;
  if (m.providerId === 'higgsfield') {
    const family = hfModel(m.id)?.family;
    if (family && FAMILY_PREVIEWS[family]) return FAMILY_PREVIEWS[family]!;
  }
  return null;
}

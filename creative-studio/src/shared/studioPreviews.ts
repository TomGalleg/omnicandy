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
}

/** Keyed by Higgsfield model family (see HfModel.family). */
export const FAMILY_PREVIEWS: Record<string, ModelPreview> = {
  'Seedance 2.5': { poster: 'seedance-2-5.jpg', video: 'seedance-2-5.mp4', credit: 'Promo clip from Higgsfield' },
};

export function previewFor(m: StudioModel): ModelPreview | null {
  if (m.providerId === 'higgsfield') {
    const family = hfModel(m.id)?.family;
    if (family && FAMILY_PREVIEWS[family]) return FAMILY_PREVIEWS[family]!;
  }
  return null;
}

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

/** One preview per model, keyed "provider/model id" (these win over a family preview). */
export const MODEL_PREVIEWS: Record<string, ModelPreview> = {
  'higgsfield/bytedance/seedance-2.5/text-to-video': { poster: 'seedance-text.jpg', video: 'seedance-text.mp4', credit: CREDIT, aspect: 1470 / 630 },
  'higgsfield/bytedance/seedance-2.5/image-to-video': { poster: 'seedance-picture.jpg', video: 'seedance-picture.mp4', credit: CREDIT, aspect: 16 / 9 },
  'higgsfield/bytedance/seedance-2.5/reference-to-video': { poster: 'seedance-reference.jpg', video: 'seedance-reference.mp4', credit: CREDIT, aspect: 1664 / 1248 },
  'higgsfield/bytedance/seedance-2.5/video-edit': { poster: 'seedance-edit.jpg', video: 'seedance-edit.mp4', credit: CREDIT, aspect: 16 / 9 },
  'higgsfield/bytedance/seedance-2.5/video-extend': { poster: 'seedance-extend.jpg', video: 'seedance-extend.mp4', credit: CREDIT, aspect: 16 / 9 },
  'higgsfield/bytedance/seedance-2.0/reference-to-video': { poster: 'seedance2.jpg', video: 'seedance2.mp4', credit: CREDIT, aspect: 600 / 338 },
  'higgsfield/higgsfield/genjutsu/motion-transfer/v1.0': { poster: 'genjutsu.jpg', video: 'genjutsu.mp4', credit: CREDIT, aspect: 480 / 854 },
  // Soul is not connected yet: its card shows this picture, still greyed as "coming soon".
  'higgsfield/higgsfield-ai/soul/v2/standard': { poster: 'soul.jpg', credit: 'Image from Higgsfield', aspect: 2048 / 1152 },
  // A cut-out the user supplied as the example of Recraft's remove-background tool.
  'recraft/recraft-tool/removeBackground': { poster: 'recraft-remove-bg.jpg', credit: 'Sample image (background removed)', aspect: 638 / 447 },
  // A soft picture the user supplied to show what Crisp upscale is for.
  'recraft/recraft-tool/crispUpscale': { poster: 'recraft-crisp-upscale.jpg', credit: 'Sample: a soft picture to upscale', aspect: 1536 / 1024 },
  // An illustration the user supplied for "V3 Vector · Edit with a prompt".
  'recraft/recraft-tool/imageToImageVector': { poster: 'recraft-v3-vector-edit.jpg', credit: 'Sample image', aspect: 1 },
  // A vector-style illustration the user supplied for "V3 Vector · New background".
  'recraft/recraft-tool/replaceBackgroundVector': { poster: 'recraft-v3-vector-background.jpg', credit: 'Sample image', aspect: 910 / 824 },
  // The cowboy dog in a new city background, supplied by the user for Recraft V3 New background.
  'recraft/recraft-tool/replaceBackground': { poster: 'recraft-new-background.jpg', credit: 'Sample image', aspect: 1013 / 667 },
  // A wide picture the user supplied for "Edit with a prompt".
  'recraft/recraft-tool/imageToImage': { poster: 'recraft-edit-wide.jpg', credit: 'Sample image', aspect: 1005 / 421 },
  'recraft/recraft-tool/creativeUpscale': { poster: 'recraft-creative-upscale.jpg', credit: 'Sample: a soft picture to upscale', aspect: 1536 / 1024 },
  // The file the user supplied is labelled GPT Image 2.0, so the card says so.
  'openai/gpt-image-2.5-flare': { poster: 'gpt-image.jpg', credit: 'Sample image (GPT Image 2.0)', aspect: 1744 / 2336 },
  'openai/gpt-image-2.5-sunburst': { poster: 'gpt-image.jpg', credit: 'Sample image (GPT Image 2.0)', aspect: 1744 / 2336 },
  // A panda photo turned into SVG with Recraft Vectorize (supplied by the user).
  'recraft/recraft-tool/vectorize': { poster: 'recraft-vectorize.jpg', credit: 'Sample: photo vectorized with Recraft', aspect: 1018 / 578 },
};

/** One preview shared by every model of a Higgsfield family (see HfModel.family). */
export const FAMILY_PREVIEWS: Record<string, ModelPreview> = {};

export function previewFor(m: StudioModel): ModelPreview | null {
  const own = MODEL_PREVIEWS[`${m.providerId}/${m.id}`];
  if (own) return own;
  if (m.providerId === 'higgsfield') {
    const family = hfModel(m.id)?.family;
    if (family && FAMILY_PREVIEWS[family]) return FAMILY_PREVIEWS[family]!;
  }
  return null;
}

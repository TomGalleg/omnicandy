// Recraft image tools: one picture in, a changed picture (or genuine SVG) out. Pure (no network).
// Verified against the official docs on 2026-10-27 (each page read in full):
//   https://www.recraft.ai/docs/api-reference/tools/{vectorize,remove-background,upscale,image-to-image,background}.md
//   https://www.recraft.ai/docs/api-reference/pricing.md   per-request prices (units are 1,000 per US dollar)
// Wired: vectorize, remove background, crisp upscale, creative upscale, image to image (V3), replace background (V3).
// Not wired: inpaint, outpaint, erase region and generate background (they need a pixel-exact black/white mask and the app has no
// mask painter yet), and image to image with V4.1 (its price is not published).

import type { CostEstimate } from './generation';

export type RecraftToolId =
  | 'vectorize' | 'removeBackground' | 'crispUpscale' | 'creativeUpscale'
  | 'imageToImage' | 'imageToImageVector' | 'replaceBackground' | 'replaceBackgroundVector';

export interface RecraftTool {
  id: RecraftToolId;
  label: string;
  blurb: string;
  /** Path under the API base. */
  path: string;
  /** Sent as "model" for the V3 tools. */
  model?: 'recraftv3' | 'recraftv3_vector';
  output: 'raster' | 'svg';
  /** USD per request for upscales, vectorize and background removal; per image for the V3 tools. */
  usd: number;
  perImage: boolean;
  needsPrompt: boolean;
  hasStrength: boolean;
  /** Source picture formats the endpoint accepts. */
  formats: string[];
  /** Allowed length of each side of the source picture, in pixels. */
  minSide: number;
  maxSide: number;
  /** 'data' = {data:[{url}]} (several results); 'image' = {image:{url}} (one result). */
  shape: 'data' | 'image';
  operation: 'vectorize' | 'remove-background' | 'upscale' | 'edit' | 'replace-background';
  source: string;
}

const T = 'https://www.recraft.ai/docs/api-reference/tools';
const RASTER = ['png', 'jpg', 'jpeg', 'webp'];
const WITH_SVG = [...RASTER, 'svg'];

export const RECRAFT_TOOLS: RecraftTool[] = [
  { id: 'vectorize', label: 'Recraft · Vectorize', blurb: 'Turn a picture into a real, editable SVG.', path: '/images/vectorize', output: 'svg', usd: 0.01, perImage: false, needsPrompt: false, hasStrength: false, formats: RASTER, minSide: 256, maxSide: 4096, shape: 'image', operation: 'vectorize', source: `${T}/vectorize.md` },
  { id: 'removeBackground', label: 'Recraft · Remove background', blurb: 'Cut the subject out of a picture.', path: '/images/removeBackground', output: 'raster', usd: 0.01, perImage: false, needsPrompt: false, hasStrength: false, formats: WITH_SVG, minSide: 256, maxSide: 4096, shape: 'image', operation: 'remove-background', source: `${T}/remove-background.md` },
  { id: 'crispUpscale', label: 'Recraft · Crisp upscale', blurb: 'Sharper and cleaner, keeping the picture the same.', path: '/images/crispUpscale', output: 'raster', usd: 0.004, perImage: false, needsPrompt: false, hasStrength: false, formats: RASTER, minSide: 32, maxSide: 4096, shape: 'image', operation: 'upscale', source: `${T}/upscale.md` },
  { id: 'creativeUpscale', label: 'Recraft · Creative upscale', blurb: 'Rebuilds fine detail and faces at a higher quality.', path: '/images/creativeUpscale', output: 'raster', usd: 0.25, perImage: false, needsPrompt: false, hasStrength: false, formats: RASTER, minSide: 256, maxSide: 4096, shape: 'image', operation: 'upscale', source: `${T}/upscale.md` },
  { id: 'imageToImage', label: 'Recraft V3 · Edit with a prompt', blurb: 'Change a picture by describing what to change; you set how much.', path: '/images/imageToImage', model: 'recraftv3', output: 'raster', usd: 0.04, perImage: true, needsPrompt: true, hasStrength: true, formats: WITH_SVG, minSide: 256, maxSide: 4096, shape: 'data', operation: 'edit', source: `${T}/image-to-image.md` },
  { id: 'imageToImageVector', label: 'Recraft V3 Vector · Edit with a prompt', blurb: 'Like the edit tool, but the result is a genuine SVG.', path: '/images/imageToImage', model: 'recraftv3_vector', output: 'svg', usd: 0.08, perImage: true, needsPrompt: true, hasStrength: true, formats: WITH_SVG, minSide: 256, maxSide: 4096, shape: 'data', operation: 'edit', source: `${T}/image-to-image.md` },
  { id: 'replaceBackground', label: 'Recraft V3 · New background', blurb: 'Keep the subject, describe a new background.', path: '/images/replaceBackground', model: 'recraftv3', output: 'raster', usd: 0.04, perImage: true, needsPrompt: true, hasStrength: false, formats: WITH_SVG, minSide: 256, maxSide: 4096, shape: 'data', operation: 'replace-background', source: `${T}/background.md` },
  { id: 'replaceBackgroundVector', label: 'Recraft V3 Vector · New background', blurb: 'New background, delivered as a genuine SVG.', path: '/images/replaceBackground', model: 'recraftv3_vector', output: 'svg', usd: 0.08, perImage: true, needsPrompt: true, hasStrength: false, formats: WITH_SVG, minSide: 256, maxSide: 4096, shape: 'data', operation: 'replace-background', source: `${T}/background.md` },
];

export const recraftTool = (id: string) => RECRAFT_TOOLS.find((t) => t.id === id);
/** Registry ids for the tools: "recraft-tool/<id>". */
export const toolModelId = (id: RecraftToolId) => `recraft-tool/${id}`;
export const recraftToolByModelId = (modelId: string) => (modelId.startsWith('recraft-tool/') ? recraftTool(modelId.slice('recraft-tool/'.length)) : undefined);

export const RECRAFT_TOOL_MAX_COUNT = 4;
export const RECRAFT_TOOL_MAX_BYTES = 20 * 1024 * 1024;
export const RECRAFT_TOOL_MAX_PROMPT = 1000;

export interface RecraftToolJob {
  toolId: string;
  /** The library picture to work on. It is never changed: the result is a new asset. */
  assetId: string;
  prompt: string;
  /** 0 to 1: near 0 stays almost identical, 1 is least similar. Only for the edit tools. */
  strength: number;
  count: number;
  /** Vectorize only: layered shapes, or shapes that do not overlap (plotters, vinyl cutters, screen printing). */
  shapeStacking: 'hierarchical' | 'cut_out';
}

export function normalizeToolJob(job: RecraftToolJob): RecraftToolJob {
  const t = recraftTool(job.toolId);
  if (!t) throw new Error(`Unknown Recraft tool "${job.toolId}".`);
  if (!job.assetId) throw new Error('Choose the picture to work on first.');
  const prompt = job.prompt.trim();
  if (t.needsPrompt && !prompt) throw new Error('Describe the change first.');
  if (prompt.length > RECRAFT_TOOL_MAX_PROMPT) throw new Error(`The description is too long (max ${RECRAFT_TOOL_MAX_PROMPT} characters).`);
  const count = t.perImage ? job.count : 1;
  if (!Number.isInteger(count) || count < 1 || count > RECRAFT_TOOL_MAX_COUNT) throw new Error(`Count must be 1–${RECRAFT_TOOL_MAX_COUNT}.`);
  if (t.hasStrength && !(job.strength >= 0 && job.strength <= 1)) throw new Error('Strength must be between 0 and 1.');
  if (job.shapeStacking !== 'hierarchical' && job.shapeStacking !== 'cut_out') throw new Error('Unknown shape stacking.');
  return { toolId: t.id, assetId: job.assetId, prompt: t.needsPrompt ? prompt : '', strength: t.hasStrength ? job.strength : 0, count, shapeStacking: job.shapeStacking };
}

export function estimateTool(raw: RecraftToolJob): CostEstimate {
  const job = normalizeToolJob(raw);
  const t = recraftTool(job.toolId)!;
  return {
    amount: Math.round(t.usd * job.count * 10000) / 10000, perImage: t.usd, currency: 'USD', approximate: true,
    basis: `$${t.usd} per ${t.perImage ? 'image' : 'request'} (Recraft's published price for ${t.label}).`,
  };
}

/** Checks the source picture before anything is paid for. Dimensions are only checked when the library knows them. */
export function checkToolSource(t: RecraftTool, a: { name: string; sourceFormat: string; width?: number; height?: number }, bytes: number): void {
  const fmt = a.sourceFormat.toLowerCase();
  if (!t.formats.includes(fmt)) throw new Error(`${a.name}: ${t.label} accepts ${t.formats.map((f) => f.toUpperCase()).join(', ')}.`);
  if (bytes >= RECRAFT_TOOL_MAX_BYTES) throw new Error(`${a.name} is too large (Recraft allows under 20 MB).`);
  if (fmt !== 'svg' && a.width && a.height) {
    if (Math.min(a.width, a.height) < t.minSide || Math.max(a.width, a.height) > t.maxSide) throw new Error(`${a.name} is ${a.width}×${a.height}; ${t.label} needs each side between ${t.minSide} and ${t.maxSide} pixels.`);
    if (a.width * a.height > 16_000_000) throw new Error(`${a.name} is over 16 megapixels, Recraft's limit.`);
  }
}

/** JSON body for the tool endpoint. The picture goes in as a data URL (the docs accept "URL or data URL"). */
export function toolBody(raw: RecraftToolJob, dataUrl: string): Record<string, unknown> {
  const job = normalizeToolJob(raw);
  const t = recraftTool(job.toolId)!;
  const body: Record<string, unknown> = { image_url: dataUrl, response_format: 'url' };
  if (t.model) body.model = t.model;
  if (t.needsPrompt) body.prompt = job.prompt;
  if (t.hasStrength) body.strength = job.strength;
  if (t.perImage) body.n = job.count;
  if (t.id === 'vectorize') body.shape_stacking = job.shapeStacking;
  // image_format applies to raster output only (the docs: "webp or png"); PNG matches the rest of the app.
  if (t.output === 'raster') body.image_format = 'png';
  return body;
}

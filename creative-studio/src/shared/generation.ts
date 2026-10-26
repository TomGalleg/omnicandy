// AI image generation: provider/model catalog, cost estimates and request/response mapping.
// Pure (no Electron, no network) so it is unit-tested with mocked responses. Verified against the
// official docs on 2026-10-13:
//   OpenAI Images API  POST https://api.openai.com/v1/images/generations (JSON) and /v1/images/edits
//     (multipart), "Authorization: Bearer <key>", response data[].b64_json. Price: image output
//     tokens $30 / 1M for gpt-image-2.5-*, text input $5 / 1M, image input $8 / 1M; output tokens
//     per image from OpenAI's own token calculator (developers.openai.com image-generation guide).
//   Gemini Interactions API  POST https://generativelanguage.googleapis.com/v1beta/interactions,
//     "x-goog-api-key: <key>", input parts {type:text|image}, response_format {type:"image",
//     aspect_ratio, image_size}, output in steps[].content[] {type:"image", mime_type, data}.
//     Per-image prices from ai.google.dev/gemini-api/docs/pricing (Standard tier).
// Model lists (free, no generation) are used for the connection test: GET /v1/models and
// GET /v1beta/models.

export type ProviderId = 'openai' | 'gemini' | 'runway' | 'recraft' | 'mock';
export type GenCapability = 'text-to-image' | 'image-edit';

export interface SettingOption { value: string; label: string }
export interface ModelSetting { key: string; label: string; options: SettingOption[]; default: string }

export interface ImageModel {
  id: string;
  provider: ProviderId;
  label: string;
  note: string;
  capabilities: GenCapability[];
  settings: ModelSetting[];
  maxCount: number;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  billable: boolean;
  /** Where the user creates a key (opened in their browser). */
  keyUrl: string | null;
  keyHint: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'openai', label: 'OpenAI', billable: true, keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'OpenAI API key (starts with "sk-")' },
  { id: 'gemini', label: 'Google Gemini', billable: true, keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'Gemini API key from Google AI Studio' },
  { id: 'runway', label: 'Runway (video)', billable: true, keyUrl: 'https://dev.runwayml.com/', keyHint: 'Runway API secret from dev.runwayml.com (needs prepaid credits)' },
  { id: 'recraft', label: 'Recraft (pictures and SVG)', billable: true, keyUrl: 'https://www.recraft.ai/profile/api', keyHint: 'Recraft API token from your Recraft profile page (needs API units)' },
  { id: 'mock', label: 'Mock (offline, free)', billable: false, keyUrl: null, keyHint: '' },
];

const opt = (...v: string[]): SettingOption[] => v.map((x) => ({ value: x, label: x }));
const OPENAI_SIZES: SettingOption[] = [
  { value: '1024x1024', label: 'Square 1024×1024' },
  { value: '1536x1024', label: 'Landscape 1536×1024' },
  { value: '1024x1536', label: 'Portrait 1024×1536' },
  { value: '2048x2048', label: 'Square 2048×2048' },
];
const openaiSettings: ModelSetting[] = [
  { key: 'size', label: 'Size', options: OPENAI_SIZES, default: '1024x1024' },
  { key: 'quality', label: 'Quality', options: opt('low', 'medium', 'high', 'xhigh', 'max'), default: 'medium' },
  { key: 'background', label: 'Background', options: opt('auto', 'opaque', 'transparent'), default: 'auto' },
];
const GEMINI_ASPECTS = opt('1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9');
const geminiSettings = (sizes: string[], def = '1K'): ModelSetting[] => [
  { key: 'aspect_ratio', label: 'Aspect', options: GEMINI_ASPECTS, default: '1:1' },
  { key: 'image_size', label: 'Resolution', options: opt(...sizes), default: def },
];

export const IMAGE_MODELS: ImageModel[] = [
  { id: 'gpt-image-2.5-flare', provider: 'openai', label: 'GPT Image 2.5 Flare', note: 'Fast, high-quality everyday generation', capabilities: ['text-to-image', 'image-edit'], settings: openaiSettings, maxCount: 4 },
  { id: 'gpt-image-2.5-sunburst', provider: 'openai', label: 'GPT Image 2.5 Sunburst', note: 'Best when editing precision matters', capabilities: ['text-to-image', 'image-edit'], settings: openaiSettings, maxCount: 4 },
  { id: 'gemini-nano-banana-2.1', provider: 'gemini', label: 'Nano Banana 2.1', note: "Google's recommended image model", capabilities: ['text-to-image', 'image-edit'], settings: geminiSettings(['1K', '2K', '4K']), maxCount: 4 },
  { id: 'gemini-3.1-flash-lite-image', provider: 'gemini', label: 'Gemini 3.1 Flash Lite Image', note: 'Lowest cost, 1K only', capabilities: ['text-to-image', 'image-edit'], settings: geminiSettings(['1K']), maxCount: 4 },
  { id: 'gemini-3.1-flash-image', provider: 'gemini', label: 'Gemini 3.1 Flash Image', note: 'Previous generation', capabilities: ['text-to-image', 'image-edit'], settings: geminiSettings(['512', '1K', '2K', '4K']), maxCount: 4 },
  { id: 'gemini-3-pro-image', provider: 'gemini', label: 'Gemini 3 Pro Image', note: 'Professional asset production', capabilities: ['text-to-image', 'image-edit'], settings: geminiSettings(['1K', '2K', '4K']), maxCount: 4 },
  { id: 'mock-image', provider: 'mock', label: 'Mock image', note: 'Draws a local test pattern. No network, no cost.', capabilities: ['text-to-image', 'image-edit'], settings: [{ key: 'size', label: 'Size', options: opt('512x512', '1024x1024'), default: '512x512' }], maxCount: 4 },
];

export const modelById = (id: string) => IMAGE_MODELS.find((m) => m.id === id);
export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);

export interface ImageJob {
  modelId: string;
  prompt: string;
  /** Library assets used as reference/input images (image-edit capability). */
  referenceAssetIds: string[];
  settings: Record<string, string>;
  count: number;
}

export const MAX_PROMPT = 4000;

/** Fills defaults and rejects anything the model does not offer. */
export function normalizeJob(job: ImageJob): ImageJob {
  const m = modelById(job.modelId);
  if (!m) throw new Error(`Unknown model "${job.modelId}".`);
  const prompt = job.prompt.trim();
  if (!prompt) throw new Error('Write a prompt first.');
  if (prompt.length > MAX_PROMPT) throw new Error(`Prompt is too long (max ${MAX_PROMPT} characters).`);
  if (!Number.isInteger(job.count) || job.count < 1 || job.count > m.maxCount) throw new Error(`Count must be 1–${m.maxCount}.`);
  if (job.referenceAssetIds.length > 4) throw new Error('Use at most 4 reference images.');
  if (job.referenceAssetIds.length && !m.capabilities.includes('image-edit')) throw new Error(`${m.label} can't use reference images.`);
  const settings: Record<string, string> = {};
  for (const s of m.settings) {
    const v = job.settings[s.key] ?? s.default;
    if (!s.options.some((o) => o.value === v)) throw new Error(`${s.label} "${v}" is not available for ${m.label}.`);
    settings[s.key] = v;
  }
  return { modelId: m.id, prompt, referenceAssetIds: [...job.referenceAssetIds], settings, count: job.count };
}

// ---- Cost estimates ----

/** OpenAI's published output-token formula for GPT Image 2.5 (from its token calculator). */
const GPT25_BASE: Record<string, number> = { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 };
export function openaiOutputTokens(width: number, height: number, quality: string): number {
  const base = GPT25_BASE[quality];
  if (base === undefined) throw new Error(`Unsupported quality ${quality}.`);
  const long = Math.max(width, height), short = Math.min(width, height);
  const s = base / (long / short);
  const fl = Math.floor(s);
  const shortTiles = s - fl === 0.5 ? fl + (fl % 2) : Math.round(s);
  const tiles = (width >= height ? base : shortTiles) * (width >= height ? shortTiles : base);
  return Math.ceil((tiles * (2e6 + width * height)) / 4e6);
}

/** USD per image, Standard tier. */
const GEMINI_PRICE: Record<string, Record<string, number>> = {
  'gemini-nano-banana-2.1': { '1K': 0.0336, '2K': 0.0504, '4K': 0.113 },
  'gemini-3.1-flash-lite-image': { '1K': 0.0336 },
  'gemini-3.1-flash-image': { '512': 0.045, '1K': 0.067, '2K': 0.101, '4K': 0.151 },
  'gemini-3-pro-image': { '1K': 0.134, '2K': 0.134, '4K': 0.24 },
};
const OPENAI = { outputPerM: 30, textInPerM: 5, imageInPerM: 8 };
/** Rough allowance per reference image sent to OpenAI (input image tokens). */
const OPENAI_REF_TOKENS = 1600;
/** Rough allowance per reference image / prompt sent to Gemini (input tokens, ~$0.50 / 1M or less). */
const GEMINI_INPUT_ALLOWANCE = 0.001;

export interface CostEstimate {
  /** USD for the whole job. */
  amount: number;
  perImage: number;
  currency: 'USD';
  approximate: boolean;
  basis: string;
}

export function estimateCost(raw: ImageJob): CostEstimate {
  const job = normalizeJob(raw);
  const m = modelById(job.modelId)!;
  const promptTokens = Math.ceil(job.prompt.length / 4);
  if (m.provider === 'mock') return { amount: 0, perImage: 0, currency: 'USD', approximate: false, basis: 'Mock provider: free and offline.' };
  if (m.provider === 'openai') {
    const [w, h] = job.settings.size!.split('x').map(Number) as [number, number];
    const out = openaiOutputTokens(w, h, job.settings.quality!);
    const perImage = (out * OPENAI.outputPerM) / 1e6;
    const input = (promptTokens * OPENAI.textInPerM + job.referenceAssetIds.length * OPENAI_REF_TOKENS * OPENAI.imageInPerM) / 1e6;
    return {
      amount: round(perImage * job.count + input), perImage: round(perImage), currency: 'USD', approximate: true,
      basis: `${out.toLocaleString('en-US')} output tokens per image at $${OPENAI.outputPerM}/1M, plus prompt${job.referenceAssetIds.length ? ' and reference images' : ''}.`,
    };
  }
  const perImage = GEMINI_PRICE[m.id]?.[job.settings.image_size!];
  if (perImage === undefined) throw new Error('No price known for this resolution.');
  const input = GEMINI_INPUT_ALLOWANCE * (1 + job.referenceAssetIds.length);
  return {
    amount: round(perImage * job.count + input), perImage, currency: 'USD', approximate: true,
    basis: `$${perImage} per ${job.settings.image_size} image (Google's Standard price), plus a small allowance for the prompt${job.referenceAssetIds.length ? ' and reference images' : ''}.`,
  };
}

const round = (n: number) => Math.round(n * 10000) / 10000;
export const formatUsd = (n: number) => (n === 0 ? '$0.00' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(n < 1 ? 3 : 2)}`);

// Recraft image generation: models, validation and cost estimates. Pure (no network).
// Verified against the official docs on 2026-10-26:
//   https://www.recraft.ai/docs/api-reference/getting-started.md  base URL, Bearer auth, response {created, credits, data[]}
//   https://www.recraft.ai/docs/api-reference/endpoints.md        POST /images/generations params (prompt, model, n 1-6, size,
//       response_format url|b64_json, image_format webp|png, controls.colors <=10, controls.background_color)
//   https://www.recraft.ai/docs/api-reference/models/recraft-v4-1.md  model ids and per-image prices
// Not wired (their docs were not confirmed well enough): V4.1 Flash id, Utility, V3 editing, tool endpoints.

import type { CostEstimate } from './generation';

export const RECRAFT_BASE = 'https://external.api.recraft.ai/v1';

export interface RecraftModel { id: string; label: string; output: 'raster' | 'svg'; usd: number; note: string }

export const RECRAFT_MODELS: RecraftModel[] = [
  { id: 'recraftv4_1', label: 'Recraft V4.1', output: 'raster', usd: 0.035, note: 'Default model, 1K pictures' },
  { id: 'recraftv4_1_vector', label: 'Recraft V4.1 Vector', output: 'svg', usd: 0.08, note: 'Genuine editable SVG' },
  { id: 'recraftv4_1_pro', label: 'Recraft V4.1 Pro', output: 'raster', usd: 0.21, note: '2K pictures, finer detail' },
  { id: 'recraftv4_1_pro_vector', label: 'Recraft V4.1 Pro Vector', output: 'svg', usd: 0.30, note: 'Genuine editable SVG, finer detail' },
];

export const recraftModel = (id: string) => RECRAFT_MODELS.find((m) => m.id === id);

/** Only sizes the docs show as examples; "auto" leaves the choice to Recraft (picked from the prompt). */
export const RECRAFT_ASPECTS = ['auto', '1:1', '16:9', '3:4'] as const;
export const RECRAFT_MAX_COUNT = 4;
export const RECRAFT_MAX_PROMPT = 10_000;

export interface RecraftJob {
  modelId: string;
  prompt: string;
  count: number;
  aspect: string;
  /** Preferred colours as #rrggbb (up to 10). */
  colors: string[];
  /** Background colour as #rrggbb, or empty. */
  background: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
export const hexToRgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export function normalizeRecraftJob(job: RecraftJob): RecraftJob {
  const m = recraftModel(job.modelId);
  if (!m) throw new Error(`Unknown Recraft model "${job.modelId}".`);
  const prompt = job.prompt.trim();
  if (!prompt) throw new Error('Write a prompt first.');
  if (prompt.length > RECRAFT_MAX_PROMPT) throw new Error(`Prompt is too long (max ${RECRAFT_MAX_PROMPT} characters).`);
  if (!Number.isInteger(job.count) || job.count < 1 || job.count > RECRAFT_MAX_COUNT) throw new Error(`Count must be 1–${RECRAFT_MAX_COUNT}.`);
  if (!(RECRAFT_ASPECTS as readonly string[]).includes(job.aspect)) throw new Error(`Shape "${job.aspect}" is not available.`);
  if (job.colors.length > 10) throw new Error('Use at most 10 colours.');
  for (const c of [...job.colors, ...(job.background ? [job.background] : [])]) if (!HEX.test(c)) throw new Error(`"${c}" is not a colour like #ff6600.`);
  return { modelId: m.id, prompt, count: job.count, aspect: job.aspect, colors: [...job.colors], background: job.background };
}

export function estimateRecraft(raw: RecraftJob): CostEstimate {
  const job = normalizeRecraftJob(raw);
  const m = recraftModel(job.modelId)!;
  return {
    amount: Math.round(m.usd * job.count * 10000) / 10000, perImage: m.usd, currency: 'USD', approximate: true,
    basis: `$${m.usd} per image (Recraft's published price for ${m.label}).`,
  };
}

/** JSON body for POST /images/generations. b64_json is used so nothing has to be fetched from an expiring link. */
export function recraftBody(raw: RecraftJob) {
  const job = normalizeRecraftJob(raw);
  const m = recraftModel(job.modelId)!;
  const controls: Record<string, unknown> = {};
  if (job.colors.length) controls.colors = job.colors.map((c) => ({ rgb: hexToRgb(c) }));
  if (job.background) controls.background_color = { rgb: hexToRgb(job.background) };
  return {
    model: job.modelId, prompt: job.prompt, n: job.count, response_format: 'b64_json',
    ...(job.aspect !== 'auto' ? { size: job.aspect } : {}),
    ...(m.output === 'raster' ? { image_format: 'png' } : {}),
    ...(Object.keys(controls).length ? { controls } : {}),
  };
}

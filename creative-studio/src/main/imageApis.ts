// Request/response mapping for the provider HTTP APIs (see the notes in @shared/generation).
// Pure, so it is unit-tested with recorded-shape mock responses.

import type { ImageJob, ProviderId } from '@shared/generation';

export interface RefImage { mime: string; data: Buffer; name: string }
export interface GeneratedImage { mime: string; data: Buffer }

export function openaiGenerationBody(job: ImageJob) {
  const s = job.settings;
  return { model: job.modelId, prompt: job.prompt, n: job.count, size: s.size, quality: s.quality, background: s.background, output_format: 'png' };
}

/** Multipart fields for /v1/images/edits (image[] files are appended by the caller). */
export function openaiEditFields(job: ImageJob): Record<string, string> {
  const s = job.settings;
  return { model: job.modelId, prompt: job.prompt, n: String(job.count), size: s.size!, quality: s.quality!, background: s.background!, output_format: 'png' };
}

export function parseOpenAIImages(json: unknown): GeneratedImage[] {
  const data = (json as { data?: Array<{ b64_json?: unknown }> })?.data;
  if (!Array.isArray(data)) throw new Error('OpenAI returned no images.');
  const out = data.filter((d) => typeof d?.b64_json === 'string').map((d) => ({ mime: 'image/png', data: Buffer.from(d.b64_json as string, 'base64') }));
  if (!out.length) throw new Error('OpenAI returned no images.');
  return out;
}

export function geminiInteractionBody(job: ImageJob, refs: RefImage[]) {
  return {
    model: job.modelId,
    input: [{ type: 'text', text: job.prompt }, ...refs.map((r) => ({ type: 'image', mime_type: r.mime, data: r.data.toString('base64') }))],
    response_format: { type: 'image', aspect_ratio: job.settings.aspect_ratio, image_size: job.settings.image_size },
  };
}

/** Last image of the interaction (the docs' `output_image`), skipping thought steps. */
export function parseGeminiImage(json: unknown): GeneratedImage {
  const j = json as { status?: string; steps?: Array<{ type?: string; content?: Array<{ type?: string; mime_type?: string; data?: unknown }> }> };
  if (j?.status && j.status !== 'completed') throw new Error(`Gemini did not finish (status: ${j.status}).`);
  let found: GeneratedImage | null = null;
  for (const step of j?.steps ?? []) {
    if (step?.type !== 'model_output') continue;
    for (const c of step.content ?? []) {
      if (c?.type === 'image' && typeof c.data === 'string') found = { mime: c.mime_type ?? 'image/jpeg', data: Buffer.from(c.data, 'base64') };
    }
  }
  if (!found) {
    const said = (j?.steps ?? []).flatMap((s) => s.content ?? []).map((c) => (c as { text?: string }).text).filter(Boolean).join(' ');
    throw new Error(said ? `Gemini returned no image: ${said.slice(0, 300)}` : 'Gemini returned no image.');
  }
  return found;
}

/** Ids from a models-list response (OpenAI: data[].id, Gemini: models[].name "models/<id>"). */
export function parseModelList(provider: ProviderId, json: unknown): string[] {
  if (provider === 'openai') return ((json as { data?: Array<{ id?: unknown }> })?.data ?? []).map((m) => m?.id).filter((x): x is string => typeof x === 'string');
  return ((json as { models?: Array<{ name?: unknown }> })?.models ?? []).map((m) => m?.name).filter((x): x is string => typeof x === 'string').map((n) => n.replace(/^models\//, ''));
}

export const extForMime = (mime: string) => (mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png');

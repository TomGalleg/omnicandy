// Higgsfield official API (api.higgsfield.ai): the model catalog, request validation and the job record. Pure (no network).
// Higgsfield publishes no model-list endpoint, so this file IS the catalog: a model appears only when its parameters were
// read from official documentation. A model not listed here is not offered.
// Verified against the official docs on 2026-10-27:
//   https://docs.higgsfield.ai/docs/authentication.md          "Authorization: Key <id>:<secret>", keys from console.higgsfield.ai
//   https://docs.higgsfield.ai/docs/concepts/requests.md       queued / in_progress / completed / failed / nsfw / canceled; cancel only while queued
//   https://docs.higgsfield.ai/docs/concepts/file-uploads.md   POST /files/generate-upload-url, PUT the file, pass public_url
//   https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md   failed / nsfw / canceled-while-queued are not charged; no price list
//   https://docs.higgsfield.ai/docs/models/{seedance-2-5/{text-to-video,image-to-video,reference-to-video,video-edit,video-extend},
//       seedance-2/reference-to-video,wan-3/reference-to-video,genjutsu/motion-transfer}.md
//   https://docs.higgsfield.ai/docs/openapi.json   (supplementary spec; Kling 2.5 Turbo and Hailuo 2.3 come only from here)
//   https://docs.higgsfield.ai/docs/models/{recraft-v4-1/text-to-image, recraft-v4-1-pro/generate, recraft-v4-1-utility/text-to-image,
//       recraft-v4-1-utility-pro/text-to-image}.md   (public pages that the docs index does not link; found by following related-page links)
// Not wired: Soul (the docs name two different endpoints: soul/v2/standard and soul/standard), Seedance 2.0 text/image/edit/extend,
// Wan 2.6/2.7, Hailuo image-to-video, Kling 3 and anything else whose page was not read.

import type { StudioOperation } from './providerCapabilities';

export const HIGGSFIELD_BASE = 'https://api.higgsfield.ai';
export const HIGGSFIELD_HOST = 'api.higgsfield.ai';
export const HIGGSFIELD_KEYS_URL = 'https://console.higgsfield.ai';

export type HfParamValue = string | number | boolean;
export type HfInputKind = 'image' | 'video' | 'audio';

/** A media input: `many` ones are sent as an array of URLs, the others as a single URL. */
export interface HfInput { key: string; kind: HfInputKind; label: string; many: boolean; max: number; required?: boolean }

export interface HfParam {
  /** 'colors' = up to 10 #rrggbb colours (sent as [{rgb:[r,g,b]}]); 'color' = one #rrggbb colour (sent as {rgb:[r,g,b]}). */
  key: string; label: string; type: 'enum' | 'int' | 'number' | 'bool' | 'text' | 'colors' | 'color';
  options?: Array<string | number>; default?: HfParamValue; min?: number; max?: number; step?: number;
}

export interface HfModel {
  /** Endpoint id, e.g. "bytedance/seedance-2.5/text-to-video"; the request goes to POST {base}/{id}. */
  id: string;
  label: string;
  /** Group shown on the card, e.g. "Seedance 2.5". */
  family: string;
  blurb: string;
  output: 'image' | 'video';
  operations: StudioOperation[];
  prompt: 'required' | 'optional';
  inputs: HfInput[];
  /** At least one of these input keys must be given (for the reference-to-video endpoints). */
  anyOf?: string[];
  /** Most media files the endpoint accepts in total, when the docs say so. */
  maxTotalInputs?: number;
  params: HfParam[];
  source: string;
  note?: string;
}

const DOCS = 'https://docs.higgsfield.ai/docs/models';
const SPEC = 'https://docs.higgsfield.ai/docs/openapi.json';
const ASPECT6 = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];

const duration = (min: number, max: number): HfParam => ({ key: 'duration', label: 'Length (seconds)', type: 'int', min, max, default: 5 });
const resolution = (options: string[], def: string): HfParam => ({ key: 'resolution', label: 'Resolution', type: 'enum', options, default: def });
const aspect = (options: string[] = ASPECT6): HfParam => ({ key: 'aspect_ratio', label: 'Shape', type: 'enum', options, default: '16:9' });
const bitrate: HfParam = { key: 'bitrate_mode', label: 'Quality', type: 'enum', options: ['standard', 'high'], default: 'high' };
const audio: HfParam = { key: 'generate_audio', label: 'Make sound', type: 'bool', default: true };
const images = (max: number, label = 'Reference pictures'): HfInput => ({ key: 'image_urls', kind: 'image', label, many: true, max });
const videos = (max: number, label = 'Reference videos', key = 'video_urls'): HfInput => ({ key, kind: 'video', label, many: true, max });
const audios = (max: number): HfInput => ({ key: 'audio_urls', kind: 'audio', label: 'Reference audio (WAV)', many: true, max });
const sourceVideo: HfInput = { key: 'video_url', kind: 'video', label: 'Source video (MP4)', many: false, max: 1, required: true };

const SD25 = `${DOCS}/seedance-2-5`;

export const HF_MODELS: HfModel[] = [
  {
    id: 'bytedance/seedance-2.5/text-to-video', label: 'Seedance 2.5 · Text to video', family: 'Seedance 2.5', output: 'video',
    blurb: 'Describe a scene and get a clip with sound, up to 30 seconds.', operations: ['text-to-video'], prompt: 'required', inputs: [],
    params: [duration(4, 30), resolution(['480p', '720p', '1080p'], '720p'), aspect(), bitrate, { key: 'output_format', label: 'File type', type: 'enum', options: ['mp4', 'mov'], default: 'mp4' }, audio],
    source: `${SD25}/text-to-video.md`,
  },
  {
    id: 'bytedance/seedance-2.5/image-to-video', label: 'Seedance 2.5 · Animate a picture', family: 'Seedance 2.5', output: 'video',
    blurb: 'Bring a still picture to life. Optionally pick the last frame too.', operations: ['image-to-video'], prompt: 'optional',
    inputs: [{ key: 'image_url', kind: 'image', label: 'Starting picture', many: false, max: 1, required: true }, { key: 'end_image_url', kind: 'image', label: 'Last frame (optional)', many: false, max: 1 }],
    params: [duration(4, 30), resolution(['480p', '720p', '1080p'], '720p'), bitrate, audio],
    source: `${SD25}/image-to-video.md`, note: 'The picture decides the shape of the clip.',
  },
  {
    id: 'bytedance/seedance-2.5/reference-to-video', label: 'Seedance 2.5 · Reference to video', family: 'Seedance 2.5', output: 'video',
    blurb: 'Steer a clip with up to 30 pictures, 10 videos and 10 sounds as references.', operations: ['reference-to-video', 'text-to-video'], prompt: 'optional',
    inputs: [images(30), videos(10), audios(10)], anyOf: ['image_urls', 'video_urls', 'audio_urls'], maxTotalInputs: 50,
    params: [duration(4, 30), resolution(['480p', '720p', '1080p'], '720p'), aspect(), bitrate, audio],
    source: `${SD25}/reference-to-video.md`,
  },
  {
    id: 'bytedance/seedance-2.5/video-edit', label: 'Seedance 2.5 · Edit a video', family: 'Seedance 2.5', output: 'video',
    blurb: 'Change an existing clip with a prompt, keeping its framing.', operations: ['video-edit'], prompt: 'required',
    inputs: [sourceVideo, videos(9, 'More reference videos'), images(30), audios(10)], maxTotalInputs: 50,
    params: [resolution(['480p', '720p', '1080p'], '720p'), bitrate, audio],
    source: `${SD25}/video-edit.md`, note: 'The length follows your source video (at least 4 seconds).',
  },
  {
    id: 'bytedance/seedance-2.5/video-extend', label: 'Seedance 2.5 · Extend a video', family: 'Seedance 2.5', output: 'video',
    blurb: 'Continue a clip further, guided by your prompt.', operations: ['video-extend'], prompt: 'required',
    inputs: [sourceVideo, videos(9, 'More reference videos'), images(30), audios(10)], maxTotalInputs: 50,
    params: [duration(4, 30), resolution(['480p', '720p', '1080p'], '720p'), bitrate, audio],
    source: `${SD25}/video-extend.md`,
  },
  {
    id: 'bytedance/seedance-2.0/reference-to-video', label: 'Seedance 2.0 · Reference to video', family: 'Seedance 2.0', output: 'video',
    blurb: 'Seedance 2.0 with up to 9 pictures, 3 videos and 3 sounds as references; up to 4K.', operations: ['reference-to-video', 'text-to-video'], prompt: 'optional',
    inputs: [images(9), videos(3), audios(3)], anyOf: ['image_urls', 'video_urls'],
    params: [duration(4, 15), resolution(['480p', '720p', '1080p', '4k'], '720p'), aspect(), audio],
    source: `${DOCS}/seedance-2/reference-to-video.md`, note: 'Needs at least one picture or video; sound alone is not enough.',
  },
  {
    id: 'alibaba/wan-3.0/reference-to-video', label: 'Wan 3.0 · Reference to video', family: 'Wan 3.0', output: 'video',
    blurb: 'Alibaba Wan 3.0: video from a prompt plus pictures, clips and sound.', operations: ['reference-to-video', 'text-to-video'], prompt: 'required',
    inputs: [images(10), videos(5), audios(5)],
    params: [duration(2, 30), resolution(['480p', '720p', '1080p'], '1080p'), aspect([...ASPECT6.filter((a) => a !== '21:9'), 'adaptive']), audio, { key: 'enable_thinking', label: 'Let the model reason first', type: 'bool', default: false }, { key: 'seed', label: 'Seed (optional)', type: 'int', min: 0, max: 2147483647 }],
    source: `${DOCS}/wan-3/reference-to-video.md`,
  },
  {
    id: 'higgsfield/genjutsu/motion-transfer/v1.0', label: 'Genjutsu · Motion transfer', family: 'Genjutsu', output: 'video',
    blurb: 'Copy the movement of a video onto your characters (1–8 pictures).', operations: ['motion-transfer', 'image-to-video'], prompt: 'optional',
    inputs: [sourceVideo, { key: 'image_urls', kind: 'image', label: 'Character pictures', many: true, max: 8, required: true }],
    params: [resolution(['480p', '720p', '1080p'], '720p')],
    source: `${DOCS}/genjutsu/motion-transfer.md`, note: 'The video must be at least 4 seconds; longer than 30 seconds is cut to 30.',
  },
  {
    id: 'kling-video/v2.5-turbo/pro/text-to-video', label: 'Kling 2.5 Turbo Pro · Text to video', family: 'Kling 2.5 Turbo', output: 'video',
    blurb: 'Kling 2.5 Turbo (Pro tier): a 5 or 10 second clip from a prompt.', operations: ['text-to-video'], prompt: 'required', inputs: [],
    params: [{ key: 'duration', label: 'Length (seconds)', type: 'enum', options: [5, 10], default: 5 }, { key: 'cfg_scale', label: 'Prompt strength', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 }, { key: 'negative_prompt', label: 'Avoid', type: 'text' }],
    source: SPEC, note: "From Higgsfield's supplementary OpenAPI file; newer Kling versions are not documented yet.",
  },
  {
    id: 'kling-video/v2.5-turbo/pro/image-to-video', label: 'Kling 2.5 Turbo Pro · Animate a picture', family: 'Kling 2.5 Turbo', output: 'video',
    blurb: 'Kling 2.5 Turbo (Pro tier): animate a still picture.', operations: ['image-to-video'], prompt: 'required',
    inputs: [{ key: 'image_url', kind: 'image', label: 'Starting picture', many: false, max: 1, required: true }],
    params: [{ key: 'duration', label: 'Length (seconds)', type: 'enum', options: [5, 10], default: 5 }, { key: 'cfg_scale', label: 'Prompt strength', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 }, { key: 'negative_prompt', label: 'Avoid', type: 'text' }],
    source: SPEC, note: "From Higgsfield's supplementary OpenAPI file.",
  },
  {
    id: 'kling-video/v2.5-turbo/standard/image-to-video', label: 'Kling 2.5 Turbo Standard · Animate a picture', family: 'Kling 2.5 Turbo', output: 'video',
    blurb: 'Kling 2.5 Turbo (Standard tier): animate a still picture.', operations: ['image-to-video'], prompt: 'required',
    inputs: [{ key: 'image_url', kind: 'image', label: 'Starting picture', many: false, max: 1, required: true }],
    params: [{ key: 'duration', label: 'Length (seconds)', type: 'enum', options: [5, 10], default: 5 }, { key: 'cfg_scale', label: 'Prompt strength', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 }, { key: 'negative_prompt', label: 'Avoid', type: 'text' }],
    source: SPEC, note: "From Higgsfield's supplementary OpenAPI file.",
  },
  {
    id: 'minimax/hailuo-2.3/standard/text-to-video', label: 'Hailuo 2.3 Standard · Text to video', family: 'Hailuo 2.3', output: 'video',
    blurb: 'MiniMax Hailuo 2.3: a 6 or 10 second clip from a prompt.', operations: ['text-to-video'], prompt: 'required', inputs: [],
    params: [{ key: 'duration', label: 'Length (seconds)', type: 'enum', options: [6, 10], default: 6 }, { key: 'prompt_optimizer', label: 'Improve my prompt', type: 'bool', default: true }],
    source: SPEC, note: "From Higgsfield's supplementary OpenAPI file.",
  },
];

const RECRAFT = 'https://docs.higgsfield.ai/docs/models';
const RECRAFT_ASPECTS = ['1:1', '2:1', '1:2', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '6:10', '14:10', '10:14', '16:9', '9:16'];
const recraftParams: HfParam[] = [
  { key: 'aspect_ratio', label: 'Shape', type: 'enum', options: RECRAFT_ASPECTS, default: '1:1' },
  { key: 'output_format', label: 'File type', type: 'enum', options: ['jpg', 'png', 'webp'], default: 'jpg' },
  { key: 'colors', label: 'Preferred colours (like #ff6600 #1a1a1a)', type: 'colors' },
  { key: 'background_color', label: 'Background colour (like #ffffff)', type: 'color' },
];
// Recraft V4.1 as Higgsfield hosts it: text to image only, one picture per request, pictures (no SVG, no editing tools).
const recraftModel = (id: string, label: string, blurb: string, source: string, note?: string): HfModel => ({
  id, label, family: 'Recraft V4.1 (Higgsfield)', blurb, output: 'image', operations: ['text-to-image', 'color-palette'], prompt: 'required', inputs: [], params: recraftParams, source, ...(note ? { note } : {}),
});
HF_MODELS.push(
  recraftModel('recraft/v4.1/text-to-image', 'Recraft V4.1 · via Higgsfield', 'Recraft V4.1 pictures, paid from your Higgsfield balance (1K).', `${RECRAFT}/recraft-v4-1/text-to-image.md`, 'Pictures only: Higgsfield lists no SVG or editing tools for Recraft.'),
  recraftModel('recraft/v4.1/pro/text-to-image', 'Recraft V4.1 Pro · via Higgsfield', 'Recraft V4.1 Pro: finer detail at 2K, paid from your Higgsfield balance.', `${RECRAFT}/recraft-v4-1-pro/generate.md`, 'Pictures only. 2K.'),
  recraftModel('recraft/v4.1/utility/text-to-image', 'Recraft V4.1 Utility · via Higgsfield', 'Recraft V4.1 Utility pictures (1K), paid from your Higgsfield balance.', `${RECRAFT}/recraft-v4-1-utility/text-to-image.md`, 'Higgsfield does not explain how Utility differs from the standard model.'),
  recraftModel('recraft/v4.1/utility/pro/text-to-image', 'Recraft V4.1 Utility Pro · via Higgsfield', 'Recraft V4.1 Utility Pro pictures (2K), paid from your Higgsfield balance.', `${RECRAFT}/recraft-v4-1-utility-pro/text-to-image.md`, 'Higgsfield does not explain how Utility differs from the standard model. 2K.'),
);

export const hfModel = (id: string) => HF_MODELS.find((m) => m.id === id);

export const HF_PRICE_UNKNOWN = "Higgsfield publishes no price for this model, so OmniCandy can't show one. It is charged to your Higgsfield API balance; failed, moderated and still-queued cancelled requests are not charged.";

/** What a job needs: the endpoint, the prompt, the settings (only documented keys) and asset ids per input key. */
export interface HiggsfieldJob {
  modelId: string;
  prompt: string;
  params: Record<string, HfParamValue>;
  /** Input key (e.g. "image_urls") to project asset ids. */
  inputs: Record<string, string[]>;
}

export const HF_MAX_PROMPT = 10_000;

export function normalizeHiggsfieldJob(raw: HiggsfieldJob): HiggsfieldJob {
  const m = hfModel(raw.modelId);
  if (!m) throw new Error(`Unknown Higgsfield model "${raw.modelId}".`);
  const prompt = raw.prompt.trim();
  if (m.prompt === 'required' && !prompt) throw new Error('Write a prompt first.');
  if (prompt.length > HF_MAX_PROMPT) throw new Error(`Prompt is too long (max ${HF_MAX_PROMPT} characters).`);

  const params: Record<string, HfParamValue> = {};
  for (const [k, v] of Object.entries(raw.params)) {
    const p = m.params.find((x) => x.key === k);
    if (!p) throw new Error(`"${k}" is not a setting of ${m.label}.`);
    if (v === '' || v === undefined) continue;
    if (p.type === 'colors' || p.type === 'color') {
      if (typeof v !== 'string') throw new Error(`${p.label} must be text like #ff6600.`);
      const list = v.split(/[\s,]+/).filter(Boolean);
      if (p.type === 'color' && list.length !== 1) throw new Error(`${p.label}: give one colour like #ffffff.`);
      if (list.length > 10) throw new Error(`${p.label}: use at most 10 colours.`);
      for (const c of list) if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw new Error(`"${c}" is not a colour like #ff6600.`);
      if (!list.length) continue;
    }
    else if (p.type === 'bool') { if (typeof v !== 'boolean') throw new Error(`${p.label} must be on or off.`); }
    else if (p.type === 'text') { if (typeof v !== 'string') throw new Error(`${p.label} must be text.`); if (v.length > 2000) throw new Error(`${p.label} is too long.`); }
    else if (p.type === 'enum') { if (!p.options?.some((o) => o === v)) throw new Error(`${p.label}: "${String(v)}" is not allowed.`); }
    else {
      if (typeof v !== 'number' || !Number.isFinite(v) || (p.type === 'int' && !Number.isInteger(v))) throw new Error(`${p.label} must be a ${p.type === 'int' ? 'whole ' : ''}number.`);
      if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) throw new Error(`${p.label} must be between ${p.min} and ${p.max}.`);
    }
    params[k] = v;
  }

  const inputs: Record<string, string[]> = {};
  let total = 0;
  for (const [k, ids] of Object.entries(raw.inputs)) {
    const spec = m.inputs.find((x) => x.key === k);
    if (!spec) throw new Error(`${m.label} takes no "${k}".`);
    const list = [...new Set(ids)];
    if (list.length > spec.max) throw new Error(`${spec.label}: at most ${spec.max}.`);
    if (list.length) { inputs[k] = list; total += list.length; }
  }
  for (const spec of m.inputs) if (spec.required && !inputs[spec.key]?.length) throw new Error(`${spec.label} is needed for ${m.label}.`);
  if (m.anyOf && !m.anyOf.some((k) => inputs[k]?.length)) {
    const names = m.anyOf.map((k) => m.inputs.find((x) => x.key === k)!.label.toLowerCase()).join(', ');
    throw new Error(`${m.label} needs at least one of: ${names}.`);
  }
  if (m.maxTotalInputs && total > m.maxTotalInputs) throw new Error(`${m.label} accepts at most ${m.maxTotalInputs} files in total.`);
  return { modelId: m.id, prompt, params, inputs };
}

/** JSON body for POST {base}/{modelId}. `urls` maps each input key to the public URLs the files were uploaded to. */
export function higgsfieldBody(raw: HiggsfieldJob, urls: Record<string, string[]>): Record<string, unknown> {
  const job = normalizeHiggsfieldJob(raw);
  const m = hfModel(job.modelId)!;
  const body: Record<string, unknown> = { ...(job.prompt ? { prompt: job.prompt } : {}) };
  const rgb = (h: string) => ({ rgb: [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] });
  for (const [k, v] of Object.entries(job.params)) {
    const type = m.params.find((x) => x.key === k)?.type;
    body[k] = type === 'colors' ? String(v).split(/[\s,]+/).filter(Boolean).map(rgb) : type === 'color' ? rgb(String(v).trim()) : v;
  }
  for (const spec of m.inputs) {
    const list = urls[spec.key];
    if (!list?.length) continue;
    body[spec.key] = spec.many ? list : list[0];
  }
  return body;
}

// ---- Job record (saved in the project so a restart resumes polling; polling is free) ----
export type HfJobState = 'submitting' | 'queued' | 'running' | 'downloading' | 'done' | 'failed' | 'canceled' | 'moderated';
export const HF_ACTIVE: HfJobState[] = ['submitting', 'queued', 'running', 'downloading'];

export interface HfJobRecord {
  id: string;
  job: HiggsfieldJob;
  state: HfJobState;
  /** Higgsfield's request id; empty until the submit is accepted. */
  requestId: string;
  /** The urls Higgsfield returned for this request (used as returned; only ever contacted on api.higgsfield.ai). */
  statusUrl?: string;
  cancelUrl?: string;
  requestedBy: 'user' | 'claude';
  createdAt: string;
  updatedAt: string;
  assetIds: string[];
  message: string;
}

export interface HfStatus {
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw' | 'canceled';
  requestId: string;
  /** Output files in order (images[].url, video.url, audio urls). */
  outputs: Array<{ url: string; kind: 'image' | 'video' | 'audio' }>;
  error: string;
  statusUrl: string;
  cancelUrl: string;
}

const STATUSES = ['queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled'] as const;

/** Reads a submit or status response. Throws on anything that is not a documented shape. */
export function parseHfStatus(json: unknown): HfStatus {
  const j = json as { status?: unknown; request_id?: unknown; images?: Array<{ url?: unknown }>; video?: { url?: unknown }; audio?: { url?: unknown }; audios?: Array<{ url?: unknown } | string>; error?: unknown; status_url?: unknown; cancel_url?: unknown };
  if (!j || typeof j !== 'object' || !(STATUSES as readonly unknown[]).includes(j.status)) throw new Error('Higgsfield sent a status that is not documented.');
  const outputs: HfStatus['outputs'] = [];
  for (const i of Array.isArray(j.images) ? j.images : []) if (typeof i?.url === 'string') outputs.push({ url: i.url, kind: 'image' });
  if (typeof j.video?.url === 'string') outputs.push({ url: j.video.url, kind: 'video' });
  if (typeof j.audio?.url === 'string') outputs.push({ url: j.audio.url, kind: 'audio' });
  for (const a of Array.isArray(j.audios) ? j.audios : []) { const u = typeof a === 'string' ? a : a?.url; if (typeof u === 'string') outputs.push({ url: u, kind: 'audio' }); }
  const err = typeof j.error === 'string' ? j.error : (j.error as { message?: unknown } | undefined)?.message;
  return {
    status: j.status as HfStatus['status'], requestId: typeof j.request_id === 'string' ? j.request_id : '', outputs,
    error: typeof err === 'string' ? err.slice(0, 400) : '',
    statusUrl: typeof j.status_url === 'string' ? j.status_url : '', cancelUrl: typeof j.cancel_url === 'string' ? j.cancel_url : '',
  };
}

/** The key may only be sent to Higgsfield's own API host over https; status_url / cancel_url come from a response, so they are checked. */
export function isHiggsfieldApiUrl(u: string): boolean {
  try { const x = new URL(u); return x.protocol === 'https:' && x.hostname === HIGGSFIELD_HOST; } catch { return false; }
}

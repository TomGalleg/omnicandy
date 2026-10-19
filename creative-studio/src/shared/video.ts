// AI video generation: model catalog, job validation, cost estimates and job records.
// Pure (no Electron, no network). Provider facts verified from ai.google.dev (2026-10-14):
//   Veo 3.1 / 3.1 Fast / 3.1 Lite, POST /v1beta/models/{model}:predictLongRunning, poll the operation,
//   video.uri downloaded with the same key; 16:9 or 9:16, 4/6/8 s, 720p (1080p and 4k only at 8 s,
//   Lite has no 4k); the file stays on Google's servers for 2 days. Prices per second of video
//   (paid tier, with audio): Veo 3.1 $0.40 / $0.40 / $0.60 (720p / 1080p / 4k), Fast $0.10 / $0.12 / $0.30,
//   Lite $0.05 / $0.08. Cancellation of a running Veo operation is not documented, so "Cancel" only
//   stops OmniCandi from waiting (the provider may still bill it).
//   Runway (docs.dev.runwayml.com, 2026-10-14): POST /v1/text_to_video | /v1/image_to_video with header
//   X-Runway-Version 2024-11-06, poll GET /v1/tasks/{id} (PENDING/THROTTLED/RUNNING/SUCCEEDED/FAILED/CANCELLED),
//   output[] temporary URLs, DELETE /v1/tasks/{id} cancels. 1 credit = $0.01; gen4.5 12 credits/s, gen4_turbo 5/s.
// Luma is NOT built: its docs give no price and image-to-video needs an already-hosted image URL.

import type { CostEstimate } from './generation';

export type VideoCapability = 'text-to-video' | 'image-to-video';
export type VideoProviderId = 'gemini' | 'runway';

export interface VideoSettingOption { value: string; label: string }
export interface VideoModel {
  id: string;
  provider: VideoProviderId;
  label: string;
  note: string;
  capabilities: VideoCapability[];
  aspectRatios: string[];
  durations: number[];
  resolutions: string[];
  /** USD per second of video, by resolution. */
  pricePerSecond: Record<string, number>;
  /** Resolutions that only exist at the longest duration. */
  eightSecondOnly: string[];
  /** Can a running job be stopped at the provider? */
  providerCancel: boolean;
}

export const VIDEO_PROVIDERS: Array<{ id: VideoProviderId | 'runway' | 'luma'; label: string; status: 'ready' | 'planned'; note: string }> = [
  { id: 'gemini', label: 'Google Veo (uses your Gemini key)', status: 'ready', note: 'Same API key as Gemini images.' },
  { id: 'runway', label: 'Runway', status: 'ready', note: 'Needs a Runway developer key and prepaid credits. Not yet tested with a real clip.' },
  { id: 'luma', label: 'Luma', status: 'planned', note: 'Not built: no published price and no way to send a local picture.' },
];

const common = { capabilities: ['text-to-video', 'image-to-video'] as VideoCapability[], aspectRatios: ['16:9', '9:16'], durations: [4, 6, 8], eightSecondOnly: ['1080p', '4k'], providerCancel: false };

const runwayCommon = { provider: 'runway' as const, aspectRatios: ['16:9', '9:16'], durations: [2, 4, 5, 6, 8, 10], resolutions: ['720p'], eightSecondOnly: [] as string[], providerCancel: true };

export const VIDEO_MODELS: VideoModel[] = [
  { id: 'gen4.5', label: 'Runway Gen-4.5', note: 'Text or picture to video', capabilities: ['text-to-video', 'image-to-video'], pricePerSecond: { '720p': 0.12 }, ...runwayCommon },
  { id: 'gen4_turbo', label: 'Runway Gen-4 Turbo', note: 'Needs a starting picture; cheaper', capabilities: ['image-to-video'], pricePerSecond: { '720p': 0.05 }, ...runwayCommon },
  { id: 'veo-3.1-lite-generate-preview', provider: 'gemini', label: 'Veo 3.1 Lite', note: 'Lowest cost, good for drafts', resolutions: ['720p', '1080p'], pricePerSecond: { '720p': 0.05, '1080p': 0.08 }, ...common },
  { id: 'veo-3.1-fast-generate-preview', provider: 'gemini', label: 'Veo 3.1 Fast', note: 'Faster and cheaper than Veo 3.1', resolutions: ['720p', '1080p', '4k'], pricePerSecond: { '720p': 0.10, '1080p': 0.12, '4k': 0.30 }, ...common },
  { id: 'veo-3.1-generate-preview', provider: 'gemini', label: 'Veo 3.1', note: 'Highest quality, with audio', resolutions: ['720p', '1080p', '4k'], pricePerSecond: { '720p': 0.40, '1080p': 0.40, '4k': 0.60 }, ...common },
];

export const videoModelById = (id: string) => VIDEO_MODELS.find((m) => m.id === id);

export interface VideoJob {
  modelId: string;
  prompt: string;
  /** Library picture used as the first frame (image-to-video). */
  referenceAssetId: string | null;
  aspectRatio: string;
  durationSeconds: number;
  resolution: string;
}

export const MAX_VIDEO_PROMPT = 2000;

export function normalizeVideoJob(job: VideoJob): VideoJob {
  const m = videoModelById(job.modelId);
  if (!m) throw new Error(`Unknown video model "${job.modelId}".`);
  const prompt = job.prompt.trim();
  if (!prompt) throw new Error('Write a prompt first.');
  if (prompt.length > MAX_VIDEO_PROMPT) throw new Error(`Prompt is too long (max ${MAX_VIDEO_PROMPT} characters).`);
  if (!m.aspectRatios.includes(job.aspectRatio)) throw new Error(`Aspect ratio ${job.aspectRatio} is not available for ${m.label}.`);
  if (!m.durations.includes(job.durationSeconds)) throw new Error(`${job.durationSeconds} seconds is not available for ${m.label}.`);
  if (!m.resolutions.includes(job.resolution)) throw new Error(`${job.resolution} is not available for ${m.label}.`);
  if (!job.referenceAssetId && !m.capabilities.includes('text-to-video')) throw new Error(`${m.label} needs a starting picture. Select a picture first.`);
  if (m.eightSecondOnly.includes(job.resolution) && job.durationSeconds !== 8) throw new Error(`${job.resolution} is only available for 8-second clips.`);
  return { ...job, prompt, referenceAssetId: job.referenceAssetId || null };
}

export function estimateVideoCost(raw: VideoJob): CostEstimate {
  const job = normalizeVideoJob(raw);
  const m = videoModelById(job.modelId)!;
  const perSecond = m.pricePerSecond[job.resolution];
  if (perSecond === undefined) throw new Error('No price known for this resolution.');
  const amount = Math.round(perSecond * job.durationSeconds * 10000) / 10000;
  return {
    amount, perImage: amount, currency: 'USD', approximate: true,
    basis: `$${perSecond.toFixed(2)} per second at ${job.resolution} × ${job.durationSeconds} s (Google's paid-tier price, with audio).`,
  };
}

// ---- Job records (saved with the project so a restart can pick a running job up again) ----

export type VideoJobState = 'submitted' | 'running' | 'downloading' | 'done' | 'failed' | 'cancelled';
export const ACTIVE_VIDEO_STATES: VideoJobState[] = ['submitted', 'running', 'downloading'];

export interface VideoJobRecord {
  id: string;
  provider: VideoProviderId;
  job: VideoJob;
  state: VideoJobState;
  /** Provider's operation / task name used for polling. */
  operation: string | null;
  estimateUsd: number;
  requestedBy: 'user' | 'claude';
  createdAt: string;
  updatedAt: string;
  assetId: string | null;
  message: string;
}

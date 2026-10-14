// Request/response mapping for Google Veo (see the notes in @shared/video). Pure, unit-tested.

import type { VideoJob } from '@shared/video';

export interface RefImage { mime: string; data: Buffer }

export function veoBody(job: VideoJob, ref: RefImage | null) {
  return {
    instances: [{
      prompt: job.prompt,
      ...(ref ? { image: { bytesBase64Encoded: ref.data.toString('base64'), mimeType: ref.mime } } : {}),
    }],
    parameters: { aspectRatio: job.aspectRatio, durationSeconds: job.durationSeconds, resolution: job.resolution },
  };
}

export function parseOperationName(json: unknown): string {
  const name = (json as { name?: unknown })?.name;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_./-]{3,300}$/.test(name)) throw new Error('Google did not return a job to wait for.');
  return name;
}

export type PollResult = { done: false } | { done: true; uri: string } | { done: true; error: string };

export function parseOperation(json: unknown): PollResult {
  const j = json as {
    done?: boolean;
    error?: { message?: string };
    response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }>; raiMediaFilteredReasons?: string[] } };
  };
  if (!j?.done) return { done: false };
  if (j.error) return { done: true, error: `Google could not make the video: ${(j.error.message ?? 'unknown error').slice(0, 300)}` };
  const g = j.response?.generateVideoResponse;
  const uri = g?.generatedSamples?.[0]?.video?.uri;
  if (typeof uri === 'string' && /^https:\/\/generativelanguage\.googleapis\.com\//.test(uri)) return { done: true, uri };
  const why = g?.raiMediaFilteredReasons?.join(' ');
  return { done: true, error: why ? `Google's safety filter blocked the video: ${why.slice(0, 300)}` : 'Google finished but returned no video.' };
}

// ---- Runway ----

const RUNWAY_RATIO: Record<string, string> = { '16:9': '1280:720', '9:16': '720:1280' };

export function runwayRequest(job: VideoJob, ref: RefImage | null): { path: string; body: Record<string, unknown> } {
  const ratio = RUNWAY_RATIO[job.aspectRatio];
  if (!ratio) throw new Error(`Aspect ratio ${job.aspectRatio} is not available for Runway.`);
  const base = { model: job.modelId, promptText: job.prompt, ratio, duration: job.durationSeconds };
  if (!ref) return { path: '/v1/text_to_video', body: base };
  const uri = `data:${ref.mime};base64,${ref.data.toString('base64')}`;
  return { path: '/v1/image_to_video', body: { ...base, promptImage: [{ uri, position: 'first' }] } };
}

export function parseRunwayTaskId(json: unknown): string {
  const id = (json as { id?: unknown })?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(id)) throw new Error('Runway did not return a job to wait for.');
  return id;
}

export function parseRunwayTask(json: unknown): PollResult {
  const j = json as { status?: string; output?: unknown; failure?: string; failureCode?: string };
  if (j?.status === 'SUCCEEDED') {
    const uri = Array.isArray(j.output) ? j.output.find((x): x is string => typeof x === 'string') : undefined;
    if (uri && /^https:\/\//.test(uri)) return { done: true, uri };
    return { done: true, error: 'Runway finished but returned no video.' };
  }
  if (j?.status === 'FAILED') return { done: true, error: `Runway could not make the video: ${(j.failure ?? j.failureCode ?? 'unknown error').slice(0, 300)}` };
  if (j?.status === 'CANCELLED') return { done: true, error: 'The Runway job was cancelled.' };
  return { done: false };
}

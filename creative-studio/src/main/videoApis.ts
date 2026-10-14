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

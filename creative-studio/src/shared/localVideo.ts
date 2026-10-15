// Free local AI video: job settings, quality presets and the stable-diffusion.cpp command line.
// Pure. The argument list follows stable-diffusion.cpp's Wan documentation (docs/wan.md); the
// output container is confirmed against the real tool once it is installed, so the runner looks
// for the file instead of assuming a name.

import type { LocalModel } from './localAi';

export type LocalPreset = 'experimental' | 'low' | 'balanced' | 'higher' | 'custom';

export interface LocalVideoJob {
  modelId: string;
  prompt: string;
  negativePrompt?: string;
  preset: LocalPreset;
  /** Multiples of 16. */
  width: number;
  height: number;
  /** Wan wants 4n+1 frames (17, 25, 33...). */
  frames: number;
  steps: number;
  seed?: number;
}

export const LOCAL_FPS = 16;

export const LOCAL_PRESETS: Record<Exclude<LocalPreset, 'custom'>, { label: string; width: number; height: number; frames: number; steps: number; note: string }> = {
  experimental: { label: 'Experimental', width: 320, height: 192, frames: 17, steps: 10, note: 'Tiny and quick: proves the setup works. About 1 second.' },
  low: { label: 'Low Resource', width: 448, height: 256, frames: 25, steps: 16, note: 'Light on memory. About 1.5 seconds.' },
  balanced: { label: 'Balanced', width: 624, height: 352, frames: 33, steps: 20, note: 'Reasonable detail. About 2 seconds.' },
  higher: { label: 'Higher Quality', width: 832, height: 480, frames: 33, steps: 25, note: 'Needs the most memory and time. About 2 seconds.' },
};

export const MAX_LOCAL_PROMPT = 1000;

export function normalizeLocalJob(j: LocalVideoJob): LocalVideoJob {
  const prompt = j.prompt.trim();
  if (!prompt) throw new Error('Write a prompt first.');
  if (prompt.length > MAX_LOCAL_PROMPT) throw new Error(`Prompt is too long (max ${MAX_LOCAL_PROMPT} characters).`);
  const p = j.preset === 'custom' ? j : { ...j, ...LOCAL_PRESETS[j.preset] };
  if (!Number.isInteger(p.width) || p.width % 16 || p.width < 128 || p.width > 1280) throw new Error('Width must be a multiple of 16 between 128 and 1280.');
  if (!Number.isInteger(p.height) || p.height % 16 || p.height < 128 || p.height > 720) throw new Error('Height must be a multiple of 16 between 128 and 720.');
  if (!Number.isInteger(p.frames) || (p.frames - 1) % 4 || p.frames < 5 || p.frames > 81) throw new Error('Frames must be 4n+1 (for example 17, 25, 33) and at most 81.');
  if (!Number.isInteger(p.steps) || p.steps < 1 || p.steps > 60) throw new Error('Steps must be between 1 and 60.');
  return { ...j, prompt, width: p.width, height: p.height, frames: p.frames, steps: p.steps };
}

export const clipSeconds = (j: Pick<LocalVideoJob, 'frames'>) => Math.round((j.frames / LOCAL_FPS) * 10) / 10;

/** sd-cli arguments for one clip. Paths are given absolute. `offloadToCpu` and `vaeTiling` keep video memory low. */
export function sdCliArgs(model: LocalModel, j: LocalVideoJob, modelDir: string, out: string, o: { offloadToCpu: boolean; vaeTiling: boolean }): string[] {
  const c = model.sdcpp;
  if (!c) throw new Error(`${model.name} cannot run on stable-diffusion.cpp.`);
  const f = (p: string) => `${modelDir}\\${p}`.replace(/\//g, '\\');
  const a = [
    '-M', 'vid_gen',
    '--diffusion-model', f(c.diffusion), '--vae', f(c.vae), '--t5xxl', f(c.textEncoder),
    '-p', j.prompt, '-W', String(j.width), '-H', String(j.height), '--video-frames', String(j.frames),
    '--steps', String(j.steps), '--cfg-scale', String(c.cfg), '--flow-shift', String(c.flowShift), '--sampling-method', 'euler',
    '-o', out,
  ];
  if (j.negativePrompt?.trim()) a.push('-n', j.negativePrompt.trim());
  if (j.seed !== undefined) a.push('-s', String(j.seed));
  if (o.offloadToCpu) a.push('--offload-to-cpu');
  if (o.vaeTiling) a.push('--vae-tiling');
  return a;
}

/** Pulls "step i/n" style progress out of a log line, as 0..1, or null. */
export function parseProgress(line: string): number | null {
  const m = /\b(\d+)\s*\/\s*(\d+)\b/.exec(line);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return b > 0 && a <= b ? a / b : null;
}

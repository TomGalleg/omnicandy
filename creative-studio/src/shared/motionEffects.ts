// Motion Effects: a free, non-generative way to turn one picture into a short video (Ken Burns zoom
// and pan). It is ordinary keyframed camera movement rendered by FilmCraft's headless engine, not AI,
// and it is always labelled that way. Pure (no Electron, no processes); the main process runs the plan.

export type MotionPreset = 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down';
export type MotionIntensity = 'subtle' | 'medium' | 'strong';

export const MOTION_PRESETS: Array<{ id: MotionPreset; label: string }> = [
  { id: 'zoom-in', label: 'Slow zoom in' },
  { id: 'zoom-out', label: 'Slow zoom out' },
  { id: 'pan-left', label: 'Pan left' },
  { id: 'pan-right', label: 'Pan right' },
  { id: 'pan-up', label: 'Pan up' },
  { id: 'pan-down', label: 'Pan down' },
];
export const MOTION_INTENSITIES: Array<{ id: MotionIntensity; label: string }> = [
  { id: 'subtle', label: 'Subtle' }, { id: 'medium', label: 'Medium' }, { id: 'strong', label: 'Strong' },
];
export const MOTION_ASPECTS = ['16:9', '9:16', '1:1'] as const;
export const MOTION_RESOLUTIONS = ['720p', '1080p'] as const;
export const MOTION_FPS = [24, 30] as const;
export const MOTION_MIN_SECONDS = 2;
export const MOTION_MAX_SECONDS = 20;
export const MOTION_FORMATS = ['png', 'jpg', 'jpeg', 'webp'];
export const MOTION_LABEL = 'Motion Effects (camera movement on a picture, not AI-generated)';
/** FilmCraft time unit. */
export const TICKS_PER_SECOND = 254016000000;

export interface MotionJob {
  assetId: string;
  preset: MotionPreset;
  intensity: MotionIntensity;
  aspectRatio: (typeof MOTION_ASPECTS)[number];
  resolution: (typeof MOTION_RESOLUTIONS)[number];
  fps: (typeof MOTION_FPS)[number];
  durationSeconds: number;
}

export function normalizeMotionJob(j: MotionJob): MotionJob {
  if (!MOTION_PRESETS.some((p) => p.id === j.preset)) throw new Error(`Unknown movement "${j.preset}".`);
  if (!MOTION_INTENSITIES.some((p) => p.id === j.intensity)) throw new Error(`Unknown strength "${j.intensity}".`);
  if (!MOTION_ASPECTS.includes(j.aspectRatio)) throw new Error(`Aspect ratio ${j.aspectRatio} is not available.`);
  if (!MOTION_RESOLUTIONS.includes(j.resolution)) throw new Error(`Resolution ${j.resolution} is not available.`);
  if (!MOTION_FPS.includes(j.fps)) throw new Error(`${j.fps} frames per second is not available.`);
  if (!Number.isFinite(j.durationSeconds) || j.durationSeconds < MOTION_MIN_SECONDS || j.durationSeconds > MOTION_MAX_SECONDS) {
    throw new Error(`Length must be ${MOTION_MIN_SECONDS} to ${MOTION_MAX_SECONDS} seconds.`);
  }
  return { ...j, durationSeconds: Math.round(j.durationSeconds * 10) / 10 };
}

/** Output frame size: the short edge is 720 or 1080. */
export function motionFrameSize(aspect: MotionJob['aspectRatio'], resolution: MotionJob['resolution']): { width: number; height: number } {
  const short = resolution === '1080p' ? 1080 : 720;
  const even = (n: number) => Math.round(n / 2) * 2;
  if (aspect === '1:1') return { width: short, height: short };
  const long = even((short * 16) / 9);
  return aspect === '16:9' ? { width: long, height: short } : { width: short, height: long };
}

const STRENGTH: Record<MotionIntensity, number> = { subtle: 0.08, medium: 0.18, strong: 0.3 };

export interface MotionKeyframe { time: number; scale: number; position: [number, number] }

/**
 * Two keyframes (start and end) for the camera move. The picture always covers the frame:
 * scale is the "cover" fit times a zoom factor, and a pan stays inside the picture's slack.
 * Scale is a percentage of the picture's own size; position is in output pixels.
 */
export function motionKeyframes(job: MotionJob, imageW: number, imageH: number): [MotionKeyframe, MotionKeyframe] {
  const j = normalizeMotionJob(job);
  if (!(imageW > 0 && imageH > 0)) throw new Error('The picture has no known size.');
  const { width: W, height: H } = motionFrameSize(j.aspectRatio, j.resolution);
  const cover = Math.max(W / imageW, H / imageH) * 100;
  const k = STRENGTH[j.intensity];
  const isPan = j.preset.startsWith('pan-');
  const zoomA = j.preset === 'zoom-out' ? 1 + k : 1;
  const zoomB = j.preset === 'zoom-in' ? 1 + k : j.preset === 'zoom-out' ? 1 : 1;
  const panZoom = 1 + k + 0.05;
  const sA = cover * (isPan ? panZoom : zoomA);
  const sB = cover * (isPan ? panZoom : zoomB);
  const slack = (s: number) => ({ x: Math.max(0, (imageW * s) / 100 - W) / 2, y: Math.max(0, (imageH * s) / 100 - H) / 2 });
  const at = (s: number, fx: number, fy: number): [number, number] => {
    const sl = slack(s);
    return [Math.round((W / 2 + fx * sl.x) * 100) / 100, Math.round((H / 2 + fy * sl.y) * 100) / 100];
  };
  // Content moves opposite to the camera: "pan left" slides the picture to the right.
  const dir: Record<MotionPreset, [number, number]> = {
    'zoom-in': [0, 0], 'zoom-out': [0, 0], 'pan-left': [1, 0], 'pan-right': [-1, 0], 'pan-up': [0, 1], 'pan-down': [0, -1],
  };
  const [dx, dy] = dir[j.preset];
  const end = Math.round(j.durationSeconds * TICKS_PER_SECOND);
  return [
    { time: 0, scale: Math.round(sA * 100) / 100, position: at(sA, -dx, -dy) },
    { time: end, scale: Math.round(sB * 100) / 100, position: at(sB, dx, dy) },
  ];
}

export interface FilmScriptLine { id: string; params: Record<string, unknown> }

/** Step 1 (project is saved afterwards; the clip id is read back before step 2). */
export function motionSetupScript(job: MotionJob, sourcePath: string): FilmScriptLine[] {
  const j = normalizeMotionJob(job);
  const { width, height } = motionFrameSize(j.aspectRatio, j.resolution);
  return [
    { id: 'file.newProject', params: { name: 'Motion' } },
    { id: 'file.import', params: { paths: [sourcePath] } },
    { id: 'file.newSequence', params: { name: 'Motion', fromItem: 1 } },
    { id: 'sequence.settings', params: { width, height, fps: j.fps } },
  ];
}

/** Step 2: stretch the still to the length and key the camera move. */
export function motionMoveScript(job: MotionJob, clipId: number, imageW: number, imageH: number): FilmScriptLine[] {
  const j = normalizeMotionJob(job);
  const [a, b] = motionKeyframes(j, imageW, imageH);
  const key = (param: 'scale' | 'position', time: number, value: number | [number, number]): FilmScriptLine =>
    ({ id: 'effects.setParam', params: { clip: clipId, effect: 'motion', param, value, time, keyframe: true } });
  return [
    // A still is 5 s by default; speed 100% = 5 s.
    { id: 'clip.speedDuration', params: { clips: [clipId], speed: Math.round((5 / j.durationSeconds) * 10000) / 100 } },
    key('scale', a.time, a.scale), key('scale', b.time, b.scale),
    key('position', a.time, a.position), key('position', b.time, b.position),
  ];
}

/** Which FilmCraft clip id does `inspect sequence` report first on the first video track? */
export function firstClipId(inspect: unknown): number | null {
  const v = (inspect as { video?: Array<{ items?: Array<{ clip?: number }> }> } | null)?.video;
  for (const t of v ?? []) for (const it of t.items ?? []) if (typeof it.clip === 'number') return it.clip;
  return null;
}

import { describe, expect, it } from 'vitest';
import { LOCAL_MODELS } from './localAi';
import { LOCAL_PRESETS, normalizeLocalJob, parseProgress, sdCliArgs, type LocalVideoJob } from './localVideo';

const model = LOCAL_MODELS.find((m) => m.id === 'wan-2.1-t2v-1.3b')!;
const job: LocalVideoJob = { modelId: model.id, prompt: ' a lighthouse ', preset: 'low', width: 0, height: 0, frames: 0, steps: 0 };

describe('local video settings', () => {
  it('presets fill size, frames and steps and stay valid', () => {
    for (const k of Object.keys(LOCAL_PRESETS) as Array<keyof typeof LOCAL_PRESETS>) {
      const n = normalizeLocalJob({ ...job, preset: k });
      expect(n.width % 16).toBe(0);
      expect((n.frames - 1) % 4).toBe(0);
      expect(n.prompt).toBe('a lighthouse');
    }
  });
  it('rejects values the model cannot take', () => {
    const c = { ...job, preset: 'custom' as const, width: 640, height: 352, frames: 33, steps: 20 };
    expect(normalizeLocalJob(c).frames).toBe(33);
    expect(() => normalizeLocalJob({ ...c, width: 650 })).toThrow(/multiple of 16/);
    expect(() => normalizeLocalJob({ ...c, frames: 30 })).toThrow(/4n\+1/);
    expect(() => normalizeLocalJob({ ...c, prompt: '  ' })).toThrow(/prompt/);
  });
  it('builds the sd-cli command with low-memory flags', () => {
    const a = sdCliArgs(model, normalizeLocalJob(job), 'C:\\m\\wan', 'C:\\t\\out.avi', { offloadToCpu: true, vaeTiling: true });
    expect(a.slice(0, 2)).toEqual(['-M', 'vid_gen']);
    expect(a).toContain('--offload-to-cpu');
    expect(a).toContain('--vae-tiling');
    expect(a[a.indexOf('--diffusion-model') + 1]).toBe('C:\\m\\wan\\wan2.1_t2v_1.3B_fp16.safetensors');
    expect(a[a.indexOf('-W') + 1]).toBe('448');
  });
  it('parses step progress', () => {
    expect(parseProgress('  |==>   | 5/20 - 3.2s/it')).toBeCloseTo(0.25);
    expect(parseProgress('loading model')).toBeNull();
  });
});

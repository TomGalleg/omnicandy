import { describe, expect, it } from 'vitest';
import { firstClipId, motionFrameSize, motionKeyframes, motionMoveScript, motionSetupScript, normalizeMotionJob, TICKS_PER_SECOND, type MotionJob } from './motionEffects';

const job: MotionJob = { assetId: 'a', preset: 'zoom-in', intensity: 'medium', aspectRatio: '16:9', resolution: '720p', fps: 24, durationSeconds: 10 };

describe('motion effects', () => {
  it('sizes frames', () => {
    expect(motionFrameSize('16:9', '720p')).toEqual({ width: 1280, height: 720 });
    expect(motionFrameSize('9:16', '1080p')).toEqual({ width: 1080, height: 1920 });
    expect(motionFrameSize('1:1', '720p')).toEqual({ width: 720, height: 720 });
  });
  it('rejects bad settings', () => {
    expect(() => normalizeMotionJob({ ...job, durationSeconds: 1 })).toThrow(/Length/);
    expect(() => normalizeMotionJob({ ...job, durationSeconds: 99 })).toThrow(/Length/);
    expect(() => normalizeMotionJob({ ...job, preset: 'spin' as never })).toThrow(/movement/);
  });
  it('zoom keeps the picture covering the frame and ends at the requested time', () => {
    const [a, b] = motionKeyframes(job, 1920, 1080);
    expect(a.scale).toBeCloseTo((1280 / 1920) * 100, 1);
    expect(b.scale).toBeGreaterThan(a.scale);
    expect(a.position).toEqual([640, 360]);
    expect(b.time).toBe(10 * TICKS_PER_SECOND);
    const [zo1, zo2] = motionKeyframes({ ...job, preset: 'zoom-out' }, 1920, 1080);
    expect(zo1.scale).toBeGreaterThan(zo2.scale);
  });
  it('pans stay inside the picture', () => {
    const [a, b] = motionKeyframes({ ...job, preset: 'pan-left' }, 1920, 1080);
    const half = (1920 * a.scale) / 100 / 2;
    for (const k of [a, b]) {
      expect(k.position[0] - half).toBeLessThanOrEqual(1e-6);
      expect(k.position[0] + half).toBeGreaterThanOrEqual(1280 - 1e-6);
    }
    expect(b.position[0]).toBeGreaterThan(a.position[0]);
    expect(a.position[1]).toBe(b.position[1]);
  });
  it('a portrait picture in a wide frame still covers it', () => {
    const [a] = motionKeyframes(job, 1000, 2000);
    expect((2000 * a.scale) / 100).toBeGreaterThanOrEqual(720 - 1e-6);
    expect((1000 * a.scale) / 100).toBeGreaterThanOrEqual(1280 - 1e-6);
  });
  it('builds FilmCraft scripts', () => {
    const setup = motionSetupScript(job, 'E:/p.png');
    expect(setup.map((l) => l.id)).toEqual(['file.newProject', 'file.import', 'file.newSequence', 'sequence.settings']);
    const move = motionMoveScript(job, 9, 1920, 1080);
    expect(move[0]).toMatchObject({ id: 'clip.speedDuration', params: { clips: [9], speed: 50 } });
    expect(move.filter((l) => l.id === 'effects.setParam')).toHaveLength(4);
  });
  it('reads the clip id back', () => {
    expect(firstClipId({ video: [{ items: [{ clip: 9 }] }] })).toBe(9);
    expect(firstClipId({ video: [] })).toBeNull();
  });
});

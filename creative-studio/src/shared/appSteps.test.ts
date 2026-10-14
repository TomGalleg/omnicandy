import { describe, expect, it } from 'vitest';
import { appForTab, checkEditValues, designcraftSteps, EDITOR_APPS, editorFor, effectcraftSteps, filmcraftSteps, lightcraftSteps, type FilmSequence } from './appEditors';

const seq: FilmSequence = {
  fps: 24000 / 1001,
  video: [{ clip: 10, startFrame: 0, durationFrames: 96 }],
  audio: [{ clip: 11, startFrame: 0, durationFrames: 96 }],
};
/** Two clips with sound, a still without, and music. */
const multi: FilmSequence = {
  fps: 24,
  video: [{ clip: 10, startFrame: 0, durationFrames: 96 }, { clip: 20, startFrame: 96, durationFrames: 72 }, { clip: 30, startFrame: 168, durationFrames: 72 }],
  audio: [{ clip: 11, startFrame: 0, durationFrames: 96 }, { clip: 21, startFrame: 96, durationFrames: 72 }],
  music: [{ clip: 40, startFrame: 0, durationFrames: 240 }],
};
const defaults = (app: keyof typeof EDITOR_APPS, id: string) => {
  const op = EDITOR_APPS[app].quickEdits.find((o) => o.id === id)!;
  const r = checkEditValues(op, {});
  if (!r.ok) throw new Error(r.reason);
  return r.values;
};

describe('which app opens a file in which tab', () => {
  it('keeps the Edit tab on the editing apps and sends Color/Effects to LightCraft/EffectCraft', () => {
    expect(editorFor('jpg')?.id).toBe('photocraft');
    expect(editorFor('mp4')?.id).toBe('filmcraft');
    expect(editorFor('designcraft')?.id).toBe('designcraft');
    expect(appForTab('color', 'jpg')?.id).toBe('lightcraft');
    expect(appForTab('color', 'svg')).toBeNull();
    expect(appForTab('effects', 'mp4')?.id).toBe('effectcraft');
    expect(appForTab('effects', 'png')?.id).toBe('effectcraft');
    expect(appForTab('effects', 'wav')).toBeNull();
  });
});

describe('FilmCraft quick edits', () => {
  it('trims both ends with ripple trims on the picture (sound follows its link)', () => {
    expect(filmcraftSteps('trim', { start: 0.5, end: 1 }, seq)).toEqual([
      { command: 'timeline.trim', params: { clip: 10, edge: 'out', mode: 'ripple', deltaFrames: -24 } },
      { command: 'timeline.trim', params: { clip: 10, edge: 'in', mode: 'ripple', deltaFrames: 12 } },
    ]);
    expect(() => filmcraftSteps('trim', { start: 2, end: 2 }, seq)).toThrow(/whole clip/);
  });

  it('builds speed, volume, fades and looks from the verified commands', () => {
    expect(filmcraftSteps('speed', { percent: 150 }, seq)).toEqual([{ command: 'clip.speedDuration', params: { clips: [10, 11], speed: 150, ripple: true } }]);
    expect(filmcraftSteps('volume', { db: -6 }, seq)).toEqual([{ command: 'clip.audioGain', params: { clips: [11], mode: 'adjust', db: -6 } }]);
    expect(filmcraftSteps('fades', { fadeIn: 0.5, fadeOut: 0 }, seq).map((s) => [s.command, s.params.edge])).toEqual([
      ['sequence.applyVideoTransition', 'in'], ['sequence.applyAudioTransition', 'in']]);
    expect(filmcraftSteps('blackWhite', {}, seq)).toEqual([{ command: 'effects.apply', params: { clips: [10], effect: 'black_white' } }]);
    expect(filmcraftSteps('saturation', { saturation: 150 }, seq)[1]).toEqual({ command: 'effects.setParam', params: { clip: 10, effect: 'lumetri', param: 'saturation', value: 150 } });
    expect(() => filmcraftSteps('volume', { db: 1 }, { ...seq, audio: [] })).toThrow(/no sound/);
    expect(() => filmcraftSteps('speed', { percent: 100 }, { fps: 24, video: [], audio: [] })).toThrow(/no clips/);
  });

  it('every FilmCraft quick edit builds with its default settings', () => {
    for (const op of EDITOR_APPS.filmcraft.quickEdits) expect(filmcraftSteps(op.id, defaults('filmcraft', op.id), multi).length, op.id).toBeGreaterThan(0);
  });

  it('crossfades every cut, and fades and turns down the music separately', () => {
    expect(filmcraftSteps('crossfades', { seconds: 0.5 }, multi)).toEqual([
      { command: 'sequence.applyVideoTransition', params: { clip: 20, effect: 'cross_dissolve', edge: 'in', frames: 12 } },
      { command: 'sequence.applyVideoTransition', params: { clip: 30, effect: 'cross_dissolve', edge: 'in', frames: 12 } },
      { command: 'sequence.applyAudioTransition', params: { clip: 21, effect: 'constant_power', edge: 'in', frames: 12 } },
    ]);
    expect(() => filmcraftSteps('crossfades', { seconds: 0.5 }, seq)).toThrow(/only one clip/);
    expect(filmcraftSteps('musicVolume', { db: -10 }, multi)).toEqual([{ command: 'clip.audioGain', params: { clips: [40], mode: 'adjust', db: -10 } }]);
    expect(() => filmcraftSteps('musicVolume', { db: -10 }, seq)).toThrow(/no music/);
    const fades = filmcraftSteps('fades', { fadeIn: 0.5, fadeOut: 1 }, multi).map((s) => s.params.clip);
    expect(fades).toEqual([10, 30, 11, 21, 40, 40]);
  });
});

describe('LightCraft and EffectCraft quick edits', () => {
  it('uses develop controls and built-in presets', () => {
    expect(lightcraftSteps('light', defaults('lightcraft', 'light'))).toEqual([{ command: 'develop.set', params: { values: { 'light.exposure': 0.3, 'light.contrast': 10, 'light.highlights': -20, 'light.shadows': 20 } } }]);
    expect(lightcraftSteps('look', defaults('lightcraft', 'look'))).toEqual([{ command: 'preset.apply', params: { id: 'lc.golden-hour', amount: 100 } }]);
    expect(checkEditValues(EDITOR_APPS.lightcraft.quickEdits.find((o) => o.id === 'look')!, { preset: 'lc.not-a-preset' }).ok).toBe(false);
    for (const op of EDITOR_APPS.lightcraft.quickEdits) expect(lightcraftSteps(op.id, defaults('lightcraft', op.id)).length).toBe(1);
  });

  it('applies effects to the footage layer and adds titles', () => {
    expect(effectcraftSteps('blur', { blurriness: 8 }, { layer: 3 })).toEqual([{ command: 'tool:add_effect', params: { layer: 3, effect: 'Gaussian Blur', values: { blurriness: 8 } } }]);
    expect(effectcraftSteps('title', defaults('effectcraft', 'title'), { layer: 3 })).toEqual([{ command: 'layer.newText', params: { text: 'Title', size: 90, fill: '#ffffff' } }]);
    for (const op of EDITOR_APPS.effectcraft.quickEdits) expect(effectcraftSteps(op.id, defaults('effectcraft', op.id), { layer: 1 }).length).toBe(1);
  });

  it('cleans text settings and rejects empty or long text', () => {
    const title = EDITOR_APPS.effectcraft.quickEdits.find((o) => o.id === 'title')!;
    expect(checkEditValues(title, { text: ' Hello\nWorld ' })).toEqual({ ok: true, values: { text: 'Hello World', size: 90, color: '#ffffff' } });
    expect(checkEditValues(title, { text: '   ' }).ok).toBe(false);
    expect(checkEditValues(title, { text: 'x'.repeat(121) }).ok).toBe(false);
    expect(checkEditValues(title, { text: 42 }).ok).toBe(false);
  });
});

describe('DesignCraft steps', () => {
  const page = { bounds: [0, 0, 612, 792] as [number, number, number, number], margins: { top: 36, bottom: 36, inside: 36, outside: 36 } };
  it('replaces text with Find/Change and places new text inside the margins', () => {
    expect(designcraftSteps('replaceText', { find: 'Sunset', replace: 'Dawn' }, page)).toEqual([{ command: 'find.change', params: { find: 'Sunset', change: 'Dawn' } }]);
    const [bottom] = designcraftSteps('addText', defaults('designcraft', 'addText'), page);
    expect(bottom).toEqual({ command: 'createcraft.addText', params: { rect: [36, 712, 576, 756], text: 'Your text', size: 24, fill: '[Black]' } });
    const [top] = designcraftSteps('addText', { text: 'Hi', position: 'top', size: 24, color: '[Paper]' }, page);
    expect((top!.params.rect as number[])[1]).toBe(36);
  });
  it('only offers the swatch colours every document has', () => {
    const add = EDITOR_APPS.designcraft.quickEdits.find((o) => o.id === 'addText')!;
    expect(checkEditValues(add, { text: 'x', color: '#ff0000' }).ok).toBe(false);
  });
});
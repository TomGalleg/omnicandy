import { describe, expect, it } from 'vitest';
import { gridcraftSteps, appForTab, checkEditValues, designcraftSteps, EDITOR_APPS, editorFor, effectcraftSteps, filmcraftSteps, lightcraftSteps, parsePageList, pdfcraftSteps, type FilmSequence, wordcraftSteps } from './appEditors';

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
    expect(editorFor('DOCX')?.id).toBe('wordcraft');
    expect(editorFor('xlsx')?.id).toBe('gridcraft');
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
describe('WordCraft steps', () => {
  it('replaces text everywhere and appends a paragraph at the end', () => {
    expect(wordcraftSteps('replaceText', { find: 'Sunset', replace: 'Dawn' })).toEqual([{ command: 'edit.replaceAll', params: { text: 'Sunset', with: 'Dawn', matchCase: true } }]);
    expect(wordcraftSteps('addParagraph', { text: 'Bye' }).map((s) => s.command)).toEqual(['caret.docEnd', 'text.newParagraph', 'text.insert']);
    expect(() => wordcraftSteps('nope', {})).toThrow();
  });
});

describe('PdfCraft steps', () => {
  it('opens .pdf in PdfCraft by default, while VectorCraft can still be chosen', () => {
    expect(editorFor('pdf')?.id).toBe('pdfcraft');
    expect(EDITOR_APPS.vectorcraft.formats).toContain('pdf');
  });
  it('parses page lists strictly', () => {
    expect(parsePageList('all')).toEqual([]);
    expect(parsePageList('1, 3-5')).toEqual([1, 3, 4, 5]);
    expect(parsePageList('2,2,1')).toEqual([1, 2]);
    expect(() => parsePageList('0')).toThrow();
    expect(() => parsePageList('5-3')).toThrow();
    expect(() => parsePageList('1;2')).toThrow();
    expect(() => parsePageList('-1')).toThrow();
    expect(() => parsePageList('4', 3)).toThrow(/only 3 pages/);
  });
  it('maps every quick edit to a driver command or an allowed tool', () => {
    expect(pdfcraftSteps('replaceText', { find: 'a', replace: 'b' })).toEqual([{ command: 'pdf.replaceText', params: { find: 'a', replace: 'b' } }]);
    expect(pdfcraftSteps('addText', { text: 'Hi', page: 2, position: 'top', size: 12 })[0]).toMatchObject({ command: 'pdf.addText', params: { page: 2, position: 'top' } });
    expect(pdfcraftSteps('rotatePages', { degrees: '90', pages: 'all' })).toEqual([{ command: 'tool:page_rotate', params: { degrees: 90 } }]);
    expect(pdfcraftSteps('rotatePages', { degrees: '270', pages: '1,3' })).toEqual([{ command: 'tool:page_rotate', params: { degrees: 270, pages: [1, 3] } }]);
    expect(pdfcraftSteps('deletePages', { pages: '2' })).toEqual([{ command: 'tool:page_delete', params: { pages: [2] } }]);
    expect(() => pdfcraftSteps('deletePages', { pages: 'all' })).toThrow(/Name the pages/);
    expect(pdfcraftSteps('watermark', { text: 'DRAFT', opacity: 30 })).toEqual([{ command: 'tool:doc_watermark', params: { text: 'DRAFT', opacity: 0.3 } }]);
    expect(pdfcraftSteps('setTitle', { title: 'T' })).toEqual([{ command: 'tool:doc_set_info', params: { key: 'Title', value: 'T' } }]);
    expect(() => pdfcraftSteps('nope', {})).toThrow();
    for (const op of EDITOR_APPS.pdfcraft.quickEdits) {
      const check = checkEditValues(op, {});
      expect(check.ok, op.id).toBe(true);
    }
  });
  it('validates values before anything runs', () => {
    const add = EDITOR_APPS.pdfcraft.quickEdits.find((o) => o.id === 'addText')!;
    expect(checkEditValues(add, { text: 'x', page: 0 }).ok).toBe(false);
    expect(checkEditValues(add, { text: 'x', position: 'left' }).ok).toBe(false);
    expect(checkEditValues(add, { text: 'x', bold: true }).ok).toBe(false);
    const rot = EDITOR_APPS.pdfcraft.quickEdits.find((o) => o.id === 'rotatePages')!;
    expect(checkEditValues(rot, { degrees: '45' }).ok).toBe(false);
  });
});

describe('GridCraft steps', () => {
  it('sets a cell and sorts a table, checking cell references first', () => {
    expect(gridcraftSteps('setCell', { cell: 'b2', value: '=SUM(A1:A3)' })).toEqual([{ command: 'cell.set', params: { cell: 'B2', input: '=SUM(A1:A3)' } }]);
    expect(gridcraftSteps('sortColumn', { range: 'a1:d5', column: 'b', order: 'desc' })).toEqual([
      { command: 'data.sort', params: { range: 'A1:D5', header: true, keys: [{ column: 'B', order: 'desc' }] } }]);
    expect(() => gridcraftSteps('setCell', { cell: 'B0', value: '1' })).toThrow(/cell reference/);
    expect(() => gridcraftSteps('setCell', { cell: 'DROP', value: '1' })).toThrow();
    expect(() => gridcraftSteps('sortColumn', { range: 'A1', column: 'B', order: 'asc' })).toThrow(/range/);
    expect(() => gridcraftSteps('nope', {})).toThrow();
  });
});

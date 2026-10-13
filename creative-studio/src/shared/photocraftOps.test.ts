import { describe, expect, it } from 'vitest';
import { checkPhotoCraftOp, isAllowedCommand, PHOTOCRAFT_PRESETS } from './photocraftOps';

describe('PhotoCraft command allowlist', () => {
  it('allows adjustments, filters, rotations and fill', () => {
    for (const id of ['image.adjustments.levels', 'filter.blur.gaussianBlur', 'image.imageRotation.90cw', 'edit.fill', 'image.autoTone', 'layer.flattenImage']) {
      expect(isAllowedCommand(id), id).toBe(true);
    }
  });

  it('blocks file, script, automation and cross-document commands', () => {
    for (const id of ['file.saveAs', 'file.open', 'file.scripts.flattenAllMasks', 'file.automate.photomerge', 'actions.play', 'plugin.run',
      'image.adjustments.matchColor', 'image.adjustments.colorLookup', 'layer.new', 'prefs.set', '', 'image.adjustments', 'image..x', 'image.adjustments.levels;rm']) {
      expect(isAllowedCommand(id), id).toBe(false);
    }
  });

  it('every preset passes its own check', () => {
    for (const p of PHOTOCRAFT_PRESETS) expect(checkPhotoCraftOp(p.id, p.params), p.id).toMatchObject({ ok: true });
  });
});

describe('PhotoCraft param checks', () => {
  it('parses JSON text and accepts plain values', () => {
    expect(checkPhotoCraftOp('filter.blur.gaussianBlur', '{"radius": 3}')).toEqual({ ok: true, params: { radius: 3 } });
    expect(checkPhotoCraftOp('image.adjustments.curves', { points: [[0, 0], [128, 150], [255, 255]] })).toMatchObject({ ok: true });
    expect(checkPhotoCraftOp('edit.fill', { contents: 'color', color: '#ff8800' })).toMatchObject({ ok: true });
    expect(checkPhotoCraftOp('image.adjustments.invert', '')).toEqual({ ok: true, params: {} });
  });

  it('rejects malformed JSON, non-objects and path-like data', () => {
    expect(checkPhotoCraftOp('filter.blur.gaussianBlur', '{radius:3}')).toMatchObject({ ok: false, reason: expect.stringContaining('JSON') });
    expect(checkPhotoCraftOp('filter.blur.gaussianBlur', '[1,2]')).toMatchObject({ ok: false });
    expect(checkPhotoCraftOp('edit.fill', { contents: 'pattern', pattern: 'C:\\evil.pat' })).toMatchObject({ ok: false, reason: expect.stringContaining('path') });
    expect(checkPhotoCraftOp('edit.fill', { contents: 'pattern', pattern: '../../x' })).toMatchObject({ ok: false });
    expect(checkPhotoCraftOp('image.adjustments.levels', { file: 'x' })).toMatchObject({ ok: false, reason: expect.stringContaining('"file"') });
    expect(checkPhotoCraftOp('image.adjustments.levels', { red: { nested: { profile: 'x' } } })).toMatchObject({ ok: false });
    expect(checkPhotoCraftOp('image.adjustments.levels', { gamma: Number.NaN })).toMatchObject({ ok: false });
    expect(checkPhotoCraftOp('image.adjustments.levels', { note: 'x'.repeat(500) })).toMatchObject({ ok: false });
  });
});

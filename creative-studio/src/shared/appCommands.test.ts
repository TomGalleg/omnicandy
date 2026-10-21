import { describe, expect, it } from 'vitest';
import { appCommandTier, checkAppCommand } from './appCommands';

describe('app command tiers', () => {
  it('edits to the open document run freely', () => {
    for (const id of ['layer.add', 'frame.create', 'object.rotate', 'select.all', 'tool:add_title', 'find.change', 'track.mute']) expect(appCommandTier(id), id).toBe('free');
  });
  it('anything that reaches files, scripts or plugins needs approval', () => {
    for (const id of ['file.open', 'file.saveAs', 'document.save', 'export.pdf', 'exportPdf', 'tool:open_file', 'plugin.load', 'batch.process', 'import_image']) expect(appCommandTier(id), id).toBe('approval');
    expect(appCommandTier('script.run'), 'script.run').toBe('never');
  });
  it('preferences and OmniCandy internals are never reachable', () => {
    for (const id of ['prefs.set', 'edit.preferences.general', 'createcraft.place', 'x;rm -rf', '']) expect(appCommandTier(id), id).toBe('never');
  });
  it('approval commands run only once approved and may then name a file', () => {
    expect(checkAppCommand('file.open', { path: 'C:/a.png' })).toMatchObject({ ok: false });
    expect(checkAppCommand('file.open', { path: 'C:/a.png' }, { approved: true })).toMatchObject({ ok: true });
    expect(checkAppCommand('frame.create', { text: 'AND/OR' })).toMatchObject({ ok: true });
    expect(checkAppCommand('frame.create', { path: 'C:/a.png' })).toMatchObject({ ok: false });
    expect(checkAppCommand('prefs.set', {}, { approved: true })).toMatchObject({ ok: false });
  });
});

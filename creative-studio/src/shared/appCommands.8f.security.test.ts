import { describe, expect, it } from 'vitest';
import { appCommandTier, checkAppCommand } from './appCommands';

describe('8F audit-driven command security', () => {
  it.each([
    'photo.convertToDng', 'photo.editExternal',
    'library.xmpPreferences', 'library.toggleAutoWriteXmp',
    'library.smartPreviewsLocation', 'folder.synchronize',
    'refclose', 'session.revert', 'links.unembed', 'links.copyTo',
    'fields.setCode',
  ])('%s requires approval even without a path parameter', (command) => {
    expect(appCommandTier(command)).toBe('approval');
    expect(checkAppCommand(command, {}).ok).toBe(false);
  });

  it.each([
    'plugin.run', 'plugins.runLast', 'home.addIns',
    'view.macros', 'tools.macros', 'prop.setExpression',
    'scriptui.click', 'scriptui.set', 'scriptui.get',
    'scriptui.mouse', 'scriptui.close', 'widget.insert', 'widget.click',
  ])('%s is disallowed even after approval', (command) => {
    expect(appCommandTier(command)).toBe('never');
    expect(checkAppCommand(command, {}, { approved: true }).ok).toBe(false);
  });

  it.each([
    'edit.undo', 'symbol.list', 'line', 'circle', 'layer.new',
    'text.insert', 'track.bounce', 'object.compare', 'file.replaceWithSolid',
  ])('%s preserves its previous policy classification', (command) => {
    const expected = command === 'file.replaceWithSolid' ? 'approval' : 'free';
    expect(appCommandTier(command)).toBe(expected);
  });
  it('does not treat similar names as matching sensitive full IDs', () => {
    expect(appCommandTier('widget.resize')).toBe('free');
    expect(appCommandTier('prop.setValue')).toBe('free');
  });
});

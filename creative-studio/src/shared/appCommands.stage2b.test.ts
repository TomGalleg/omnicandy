import { describe, expect, it } from 'vitest';
import { appCommandTier, checkAppCommand } from './appCommands';

describe('catalog-verified nonstandard CAD command IDs', () => {
  it('permits only the seven explicitly identified dash commands behind approval', () => {
    for (const id of ['-vports','-block','-attedit','-xref','-group','-linetype','-plottermanager']) {
      expect(appCommandTier(id, 'cadcraft')).toBe('approval');
      expect(checkAppCommand(id, {}, {appId:'cadcraft'})).toMatchObject({ok:false});
      expect(checkAppCommand(id, {}, { approved: true, appId:'cadcraft' })).toMatchObject({ok:true});
    }
  });
  it('keeps numeric-leading drawing/view commands under the existing generic ID grammar', () => {
    for (const id of ['3dpoly','3dorbit']) expect(appCommandTier(id, 'cadcraft')).toBe('free');
  });
  it('does not grant the dash-prefixed CAD exceptions to other Craft apps', () => {
    expect(appCommandTier('-vports')).toBe('never');
    expect(appCommandTier('-vports', 'wordcraft')).toBe('never');
    expect(checkAppCommand('-vports', {}, {approved:true,appId:'wordcraft'}).ok).toBe(false);
  });
  it('never permits unfamiliar dash-prefixed commands or script execution', () => {
    for (const id of ['-shell','-python','--vports','-block.bad','-export','lisp','script.run','app.settings']) {
      expect(appCommandTier(id)).toBe('never');
      expect(checkAppCommand(id, {}, {approved:true}).ok).toBe(false);
    }
  });
});

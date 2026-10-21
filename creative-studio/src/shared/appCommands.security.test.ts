import { describe, expect, it } from 'vitest';
import { appCommandTier, checkAppCommand } from './appCommands';

describe('native shared command security classifications', () => {
  it.each([
    'saveas', 'qsave', 'wblock', 'bsave', 'bsaveas', 'tableexport', 'plot',
    'exportpdf', 'pdfbook', 'stylesmanager', 'plottermanager', 'new',
    'recover', 'drawingrecovery', 'insert', 'xattach', 'compare',
    'datalink', 'aliasedit', 'reinit', 'hatch.patterns', 'linetype',
    'file.saveAs', 'save_as', 'save-as', 'exportPdf', 'EXPORTPDF',
    'tool:saveas', 'file:exportpdf', 'open_file', 'download', 'place', 'link', 'run',
  ])('requires approval for %s', (name) => {
    expect(appCommandTier(name)).toBe('approval');
    expect(checkAppCommand(name, {}).ok).toBe(false);
  });

  it.each(['lisp', 'appload', 'eval', 'exec', 'shell', 'script', 'runscript', 'python', 'tool:lisp', 'LISP'])(
    'blocks arbitrary execution through %s even after approval', (name) => {
      expect(appCommandTier(name)).toBe('never');
      expect(checkAppCommand(name, { code: '(command "erase" "all")' }, { approved: true }).ok).toBe(false);
    },
  );

  it('blocks no-path implicit writes without approval', () => {
    for (const name of ['qsave', 'plot', 'exportpdf', 'pdfbook']) {
      expect(checkAppCommand(name, {}).ok).toBe(false);
      expect(checkAppCommand(name, {}, { approved: true }).ok).toBe(true);
    }
  });

  it('keeps ordinary non-file editing operations free', () => {
    for (const name of ['edit.undo', 'symbol.list', 'image.adjustBrightness', 'line', 'circle', 'layers.list', 'units', 'layer.new', 'text.insert', 'object.compare']) {
      expect(appCommandTier(name)).toBe('free');
    }
  });

  it('continues to deny preferences and malformed names', () => {
    for (const name of ['app.settings', 'prefs', 'bad/id', '../saveas']) {
      expect(appCommandTier(name)).toBe('never');
    }
  });
});

// FilmCraft, LightCraft, EffectCraft and DesignCraft engines run headless (their CLI's own MCP
// server, NO window) for workflows: every quick edit, then a saved file. Skipped per app when absent.
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkEditValues, EDITOR_APPS, type EditorAppId } from '@shared/appEditors';
import { LiveDesignCraft, LiveEffectCraft, LiveFilmCraft, LiveLightCraft, LiveCadCraft, LiveDeckCraft, LiveFigCraft, LiveGridCraft, LivePdfCraft, LiveWordCraft } from './liveApps';
import { sniffMedia } from './media';

const PF = process.env.ProgramFiles ?? 'C:\\Program Files';
const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');
const installed = (app: EditorAppId) => existsSync(path.join(PF, EDITOR_APPS[app].name, `${app}-cli.exe`));
type Driver = LiveFilmCraft | LiveLightCraft | LiveEffectCraft | LiveDesignCraft | LiveWordCraft | LivePdfCraft | LiveGridCraft | LiveDeckCraft | LiveFigCraft | LiveCadCraft;
const MAKE: Record<string, (o: ConstructorParameters<typeof LiveFilmCraft>[0]) => Driver> = {
  filmcraft: (o) => new LiveFilmCraft(o), lightcraft: (o) => new LiveLightCraft(o), effectcraft: (o) => new LiveEffectCraft(o), designcraft: (o) => new LiveDesignCraft(o), wordcraft: (o) => new LiveWordCraft(o), pdfcraft: (o) => new LivePdfCraft(o), gridcraft: (o) => new LiveGridCraft(o), deckcraft: (o) => new LiveDeckCraft(o), figcraft: (o) => new LiveFigCraft(o), cadcraft: (o) => new LiveCadCraft(o),
};
const CASES: Array<{ app: EditorAppId; file: string; values?: Record<string, Record<string, unknown>> }> = [
  { app: 'filmcraft', file: 'sunset-clip.mp4' },
  { app: 'lightcraft', file: 'sunset-still.jpg' },
  { app: 'effectcraft', file: 'sunset-still.jpg', values: { title: { text: 'Evening' } } },
  { app: 'wordcraft', file: 'quarterly-report.docx', values: { replaceText: { find: 'Sunset Over the Sea', replace: 'Evening Tide' }, addParagraph: { text: 'Closing remarks.' } } },
  { app: 'pdfcraft', file: 'quarterly-summary.pdf', values: { replaceText: { find: 'Sunset Over the Sea', replace: 'Evening Tide' }, addText: { text: 'Approved', page: 1 } } },
  { app: 'gridcraft', file: 'region-sales.xlsx', values: { setCell: { cell: 'F1', value: '=SUM(D2:D5)' }, sortColumn: { range: 'A1:D5', column: 'B', order: 'desc' } } },
  { app: 'deckcraft', file: 'northern-lights.deckcraft', values: { replaceText: { find: 'Northern Lights', replace: 'Southern Lights' }, addSlide: { title: 'Closing', body: 'Thank you' } } },
  { app: 'figcraft', file: 'login-screen.figcraft', values: { replaceText: { find: 'Welcome back', replace: 'Hello again' }, addText: { text: 'Forgot password?', position: 'bottom', size: 14 } } },
  { app: 'cadcraft', file: 'bracket-drawing.dxf', values: { replaceText: { find: 'FRONT VIEW', replace: 'TOP VIEW' }, addNote: { text: 'REV A', position: 'below' } } },
  { app: 'designcraft', file: 'sunset-flyer.designcraft', values: { replaceText: { find: 'Sunset Over the Sea', replace: 'Evening Tide' } } },
];

describe.each(CASES)('$app engine without a window', ({ app, file, values }) => {
  let tmp: string;
  let d: Driver;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), `cs-headless-${app}-`));
    await fs.copyFile(path.join(FIXTURES, file), path.join(tmp, file));
  });
  afterAll(async () => { d?.killApp(); await new Promise((r) => setTimeout(r, 300)); await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }); });

  it.skipIf(!installed(app))('opens a file, runs every quick edit and writes the result', async () => {
    d = MAKE[app]!({ installDir: path.join(PF, EDITOR_APPS[app].name), readRoot: tmp, writeRoot: path.join(tmp, 'work'), headless: true });
    await d.ensureStarted();
    expect(d.pid).toBeNull(); // no window process
    await d.open(path.join(tmp, file));
    const before = (await d.history()).length;
    for (const op of EDITOR_APPS[app].quickEdits) {
      if (op.id === 'reset' || op.id === 'musicVolume' || op.id === 'crossfades') continue; // need music / several clips
      const check = checkEditValues(op, values?.[op.id] ?? {});
      if (!check.ok) throw new Error(check.reason);
      for (const s of await d.quickEditSteps!(op.id, check.values)) await d.run(s);
    }
    expect((await d.history()).length).toBeGreaterThan(before);
    const out = await d.writeVersion(path.join(tmp, 'work'), 'result');
    const st = await fs.stat(out.main);
    expect(st.size).toBeGreaterThan(1000);
    if (app === 'filmcraft') {
      const b = await fs.readFile(out.main);
      expect(sniffMedia('mp4', b.subarray(0, 256 * 1024), b.subarray(Math.max(0, b.length - 1024 * 1024))).durationSec).toBeGreaterThan(1.5);
    }
  }, 240000);
});

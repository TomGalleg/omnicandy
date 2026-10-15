// Drives the REAL FilmCraft, LightCraft, EffectCraft and DesignCraft windows through every quick edit
// CreateCraft offers, plus undo, save-as-new-version and theme. Opens windows on screen, so it only
// runs with CS_LIVE_TESTS=1. Each app's theme is put back to what it was before the test.
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDITOR_APPS, type EditorAppId } from '@shared/appEditors';
import { LiveDesignCraft, LiveEffectCraft, LiveFilmCraft, LiveLightCraft, LiveSoundCraft, LiveWordCraft, LiveGridCraft, LiveDeckCraft } from './liveApps';
import { LiveTaskController } from './liveTask';
import { sniffMedia } from './media';
import { ProjectStore } from './projectStore';

const PF = process.env.ProgramFiles ?? 'C:\\Program Files';
const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');
const has = (app: string) => process.env.CS_LIVE_TESTS === '1' && existsSync(path.join(PF, app, `${app.toLowerCase()}.exe`));

type Driver = LiveFilmCraft | LiveLightCraft | LiveEffectCraft | LiveDesignCraft | LiveSoundCraft;

async function setup(appId: EditorAppId, make: (o: { installDir: string; readRoot: string; writeRoot: string }) => Driver) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `cs-live-${appId}-`));
  const store = new ProjectStore(path.join(tmp, 'proj'));
  await store.create(appId);
  const writeRoot = path.join(store.root, 'work', `${appId}-live`);
  await fs.mkdir(writeRoot, { recursive: true });
  const app = make({ installDir: path.join(PF, EDITOR_APPS[appId].name), readRoot: store.root, writeRoot });
  const ctl = new LiveTaskController({ connect: async () => { await app.ensureStarted(); return app; }, store, emit: () => {}, writeDir: async () => writeRoot });
  const cleanup = async () => {
    app.killApp();
    await new Promise((r) => setTimeout(r, 800));
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p); else await fs.chmod(p, 0o666).catch(() => {});
      }
    };
    await walk(tmp);
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  };
  return { store, app, ctl, cleanup, writeRoot };
}

const fileInfo = async (store: ProjectStore, id: string) => {
  const a = (await store.loadManifest()).assets.find((x) => x.id === id)!;
  const b = readFileSync(await store.resolveAssetPath(id));
  return { asset: a, info: sniffMedia(a.sourceFormat, b.subarray(0, 256 * 1024), b.subarray(Math.max(0, b.length - 1024 * 1024))), bytes: b.length };
};

describe.skipIf(!has('FilmCraft'))('Live FilmCraft (real window)', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let clip: string;
  beforeAll(async () => {
    t = await setup('filmcraft', (o) => new LiveFilmCraft(o));
    clip = (await t.store.importFile(path.join(FIXTURES, 'sunset-clip.mp4'))).asset.id;
  }, 60000);
  afterAll(async () => { await t?.cleanup(); });

  it('opens a video on a timeline, applies every quick edit, undoes, and saves an MP4 version', async () => {
    const s = await t.ctl.open(clip);
    expect(s.status).toBe('ready');
    expect(s.history).toEqual(['Open']);
    const tl = (await t.ctl.timeline())!;
    expect(tl.tracks.map((x) => x.kind)).toEqual(['video', 'audio']);
    expect(tl.duration).toBeCloseTo(4.0, 1);

    await t.ctl.quickEdit('trim', { start: 0.5, end: 0.5 });
    expect((await t.ctl.timeline())!.duration).toBeCloseTo(3.0, 1);
    const afterTrim = (await t.ctl.timeline())!;
    expect(afterTrim.tracks[1]!.clips[0]!.duration).toBeCloseTo(3.0, 1); // the linked sound followed
    await t.ctl.quickEdit('speed', { percent: 150 });
    expect((await t.ctl.timeline())!.duration).toBeCloseTo(2.0, 1);
    await t.ctl.quickEdit('volume', { db: -6 });
    await t.ctl.quickEdit('fades', { fadeIn: 0.3, fadeOut: 0.3 });
    await t.ctl.quickEdit('blackWhite', {});
    const n = (await t.ctl.quickEdit('saturation', { saturation: 150 })).history.length;
    const tl2 = (await t.ctl.timeline())!;
    expect(tl2.tracks[0]!.clips[0]!.effects).toEqual(expect.arrayContaining(['black_white', 'lumetri']));
    expect(tl2.tracks[0]!.transitions).toBe(2);

    expect((await t.ctl.undo()).history.length).toBe(n - 1);
    await t.ctl.setPlayhead(1);
    expect((await t.ctl.timeline())!.playhead).toBeCloseTo(1, 1);

    const saved = await t.ctl.saveVersion();
    const v = await fileInfo(t.store, saved.savedVersionIds[0]!);
    expect(v.asset).toMatchObject({ kind: 'video', parentId: clip, name: 'sunset-clip-live1.mp4' });
    expect(v.info.durationSec).toBeGreaterThan(1.8);
    expect(v.info.durationSec).toBeLessThan(2.2);

    // Opening another video starts a fresh FilmCraft project.
    const again = await t.ctl.open(clip);
    expect(again.history).toEqual(['Open']);
    expect((await t.ctl.timeline())!.duration).toBeCloseTo(4.0, 1);
  }, 180000);

  it('builds a video from several clips with music: add, reorder, remove, crossfade, music volume, save', async () => {
    const lib = async (f: string) => (await t.store.importFile(path.join(FIXTURES, f))).asset.id;
    const [aurora, still, groove] = [await lib('aurora-clip.mp4'), await lib('sunset-still.jpg'), await lib('groove-loop.wav')];
    await t.ctl.open(clip);
    await t.ctl.editTimeline({ kind: 'add', assetId: aurora, as: 'clip' });
    await t.ctl.editTimeline({ kind: 'add', assetId: groove, as: 'music' }); // music first: cut to 7 s
    await t.ctl.editTimeline({ kind: 'add', assetId: still, as: 'clip' }); // then runs on under the still
    await expect(t.ctl.editTimeline({ kind: 'add', assetId: groove, as: 'clip' })).rejects.toThrow(/not a video or picture/);
    let tl = (await t.ctl.timeline())!;
    const v1 = () => tl.tracks.find((x) => x.kind === 'video')!.clips.slice().sort((a, b) => a.start - b.start);
    const music = () => tl.tracks.find((x) => x.music)!.clips;
    expect(v1().map((c) => [c.name.replace(/^[0-9a-f]{8}-/, ''), Math.round(c.duration)])).toEqual([['sunset-clip.mp4', 4], ['aurora-clip.mp4', 3], ['sunset-still.jpg', 3]]);
    expect(tl.duration).toBeCloseTo(10, 0);
    expect(music()[0]!.start).toBe(0);
    expect(music()[0]!.duration).toBeLessThanOrEqual(10.05); // trimmed to the picture
    expect(music()[0]!.duration).toBeGreaterThan(9.9); // and extended again when the still was added

    // Move the still to the front (Claude's path, same lock), then the aurora clip to the end.
    const stillClip = v1()[2]!.id;
    await t.ctl.claudeTimelineEdit({ kind: 'move', clip: stillClip, to: 0 });
    t.ctl.claudeDone();
    tl = (await t.ctl.timeline())!;
    expect(v1()[0]!.id).toBe(stillClip);
    expect(music()[0]!.start).toBe(0); // music did not move
    const auroraClip = v1()[2]!.id;
    await t.ctl.editTimeline({ kind: 'move', clip: auroraClip, to: 1 });
    tl = (await t.ctl.timeline())!;
    expect(v1()[1]!.id).toBe(auroraClip);
    expect(tl.duration).toBeCloseTo(10, 0);

    await t.ctl.editTimeline({ kind: 'remove', clip: auroraClip });
    tl = (await t.ctl.timeline())!;
    expect(v1()).toHaveLength(2);
    expect(v1()[1]!.start).toBeCloseTo(3, 1); // the gap closed

    await t.ctl.quickEdit('crossfades', { seconds: 0.5 });
    await t.ctl.quickEdit('musicVolume', { db: -12 });
    await t.ctl.quickEdit('fades', { fadeIn: 0.5, fadeOut: 0.5 });
    tl = (await t.ctl.timeline())!;
    expect(tl.tracks.find((x) => x.kind === 'video')!.transitions).toBeGreaterThanOrEqual(3);
    const n = (await t.ctl.refresh()).history.length;
    expect((await t.ctl.undo()).history.length).toBe(n - 1);

    const saved = await t.ctl.saveVersion();
    const v = await fileInfo(t.store, saved.savedVersionIds.at(-1)!);
    expect(v.asset.kind).toBe('video');
    expect(v.info.durationSec).toBeGreaterThan(6.5);
    expect(v.info.durationSec).toBeLessThan(7.5);
  }, 300000);

  it('switches its theme through its own preferences and back', async () => {
    expect(await t.app.applyTheme('light')).toBe('light');
    expect(await t.app.applyTheme('darkest')).toBe('darkest');
  }, 60000);
});

describe.skipIf(!has('LightCraft'))('Live LightCraft (real window)', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let still: string;
  beforeAll(async () => {
    t = await setup('lightcraft', (o) => new LiveLightCraft(o));
    still = (await t.store.importFile(path.join(FIXTURES, 'sunset-still.jpg'))).asset.id;
  }, 60000);
  afterAll(async () => { await t?.cleanup(); });

  it('develops a photo with every quick edit, undoes, and saves a full-size version', async () => {
    const s = await t.ctl.open(still, 'lightcraft');
    expect(s.status).toBe('ready');
    let len = s.history.length;
    for (const op of EDITOR_APPS.lightcraft.quickEdits) {
      if (op.id === 'reset') continue;
      const h = (await t.ctl.quickEdit(op.id, {})).history;
      expect(h.length, op.id).toBeGreaterThan(len);
      len = h.length;
    }
    expect((await t.ctl.undo()).history.length).toBe(len - 1);
    const png = await t.ctl.preview(512);
    expect(png?.subarray(1, 4).toString()).toBe('PNG');
    const saved = await t.ctl.saveVersion();
    const v = await fileInfo(t.store, saved.savedVersionIds[0]!);
    expect(v.asset).toMatchObject({ kind: 'image', parentId: still, name: 'sunset-still-color1.jpg' });
    expect(v.info).toMatchObject({ width: 960, height: 540 });
    expect((await t.ctl.quickEdit('reset', {})).history.at(-1)).toBeTruthy();
    // The library original was never handed to LightCraft (it imports a working copy).
    expect(existsSync(path.join(t.writeRoot))).toBe(true);
  }, 180000);

  it('switches its theme through the control channel and back', async () => {
    expect(await t.app.applyTheme('light')).toBe('light');
    expect(await t.app.applyTheme('dark')).toBe('dark');
  }, 60000);
});

describe.skipIf(!has('EffectCraft'))('Live EffectCraft (real window)', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let clip: string;
  let still: string;
  beforeAll(async () => {
    t = await setup('effectcraft', (o) => new LiveEffectCraft(o));
    clip = (await t.store.importFile(path.join(FIXTURES, 'sunset-clip.mp4'))).asset.id;
    still = (await t.store.importFile(path.join(FIXTURES, 'sunset-still.jpg'))).asset.id;
  }, 60000);
  afterAll(async () => { await t?.cleanup(); });

  it('makes a composition from a video, applies every effect, undoes, and renders an MP4 version', async () => {
    const s = await t.ctl.open(clip, 'effectcraft');
    expect(s.history).toEqual(['Open']);
    let len = 1;
    for (const op of EDITOR_APPS.effectcraft.quickEdits) {
      const h = (await t.ctl.quickEdit(op.id, op.id === 'title' ? { text: 'Sunset' } : {})).history;
      expect(h.length, op.id).toBe(len + 1);
      len = h.length;
    }
    expect((await t.ctl.undo()).history.length).toBe(len - 1);
    const saved = await t.ctl.saveVersion();
    const v = await fileInfo(t.store, saved.savedVersionIds[0]!);
    expect(v.asset).toMatchObject({ kind: 'video', parentId: clip, name: 'sunset-clip-fx1.mp4' });
    expect(v.info.durationSec).toBeGreaterThan(3.9);
    // Saving again without changes makes nothing new (same bytes); after another edit it renders again.
    expect((await t.ctl.saveVersion()).message).toMatch(/Nothing changed/);
    await t.ctl.quickEdit('posterize', { level: 4 });
    const saved2 = await t.ctl.saveVersion();
    expect((await fileInfo(t.store, saved2.savedVersionIds.at(-1)!)).asset.name).toBe('sunset-clip-fx2.mp4');
  }, 300000);

  it('renders a still as a PNG version', async () => {
    await t.ctl.open(still, 'effectcraft');
    await t.ctl.quickEdit('glow', {});
    const saved = await t.ctl.saveVersion();
    const v = await fileInfo(t.store, saved.savedVersionIds[0]!);
    expect(v.asset).toMatchObject({ kind: 'image', name: 'sunset-still-fx1.png' });
    expect(v.info).toMatchObject({ width: 960, height: 540 });
  }, 120000);

  it('switches its theme through its own preferences and back', async () => {
    expect(await t.app.applyTheme('light')).toBe('light');
    expect(await t.app.applyTheme('dark')).toBe('dark');
  }, 60000);
});

describe.skipIf(!has('DesignCraft'))('Live DesignCraft (real window)', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let flyer: string;
  beforeAll(async () => {
    t = await setup('designcraft', (o) => new LiveDesignCraft(o));
    flyer = (await t.store.importFile(path.join(FIXTURES, 'sunset-flyer.designcraft'))).asset.id;
  }, 60000);
  afterAll(async () => { await t?.cleanup(); });

  it('opens a layout, tracks its history, and saves a new .designcraft version with a PNG', async () => {
    const s = await t.ctl.open(flyer);
    expect(s.status).toBe('ready');
    expect(s.history).toEqual(['Open']);
    await t.app.run({ command: 'frame.create', params: { rect: [36, 600, 576, 700], content: 'text', text: 'Added by the live test' } });
    expect((await t.ctl.refresh()).history).toEqual(['Open', 'Create Frame']);
    expect((await t.ctl.undo()).history).toEqual(['Open']);
    expect((await t.ctl.saveVersion()).message).toMatch(/Nothing changed/); // same bytes as the original
    await t.app.run({ command: 'frame.create', params: { rect: [36, 600, 576, 700], content: 'text', text: 'Added by the live test' } });
    const saved = await t.ctl.saveVersion();
    expect(saved.savedVersionIds).toHaveLength(2);
    const main = await fileInfo(t.store, saved.savedVersionIds[0]!);
    const png = await fileInfo(t.store, saved.savedVersionIds[1]!);
    expect(main.asset).toMatchObject({ kind: 'design', parentId: flyer, name: 'sunset-flyer-live1.designcraft' });
    expect(png.info).toMatchObject({ width: 612, height: 792 });
    expect((await t.ctl.preview(800))?.subarray(1, 4).toString()).toBe('PNG');
  }, 120000);

  it('replaces text and adds a styled line of text through the quick edits', async () => {
    await t.ctl.open(flyer);
    const d = (await (t.app as LiveDesignCraft).describe()) as { text: string[] };
    expect(d.text[0]).toBe('Sunset Over the Sea');
    await t.ctl.quickEdit('replaceText', { find: 'Sunset Over the Sea', replace: 'Evening Tide' });
    await expect(t.ctl.quickEdit('replaceText', { find: 'not in this layout', replace: 'x' })).rejects.toThrow(/not found/);
    const h = (await t.ctl.quickEdit('addText', { text: 'Saturday 8 pm', position: 'bottom', size: 36 })).history;
    expect(h.length).toBeGreaterThanOrEqual(3);
    expect(((await (t.app as LiveDesignCraft).describe()) as { text: string[] }).text).toEqual(expect.arrayContaining(['Evening Tide', 'Saturday 8 pm']));
    expect((await t.ctl.preview(800))?.subarray(1, 4).toString()).toBe('PNG');
  }, 120000);

  it('switches its interface brightness and back', async () => {
    expect(await t.app.applyTheme('light')).toBe('light');
    expect(await t.app.applyTheme('mediumDark')).toBe('mediumDark');
  }, 60000);
});

describe.skipIf(!has('WordCraft'))('Live WordCraft (real window)', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let doc: string;
  beforeAll(async () => {
    t = await setup('wordcraft', (o) => new LiveWordCraft(o) as unknown as Driver);
    doc = (await t.store.importFile(path.join(FIXTURES, 'quarterly-report.docx'))).asset.id;
  }, 60000);
  afterAll(async () => { await t?.cleanup(); });

  it('opens a document, edits text, undoes, and saves a new .docx version with a PNG of page 1', async () => {
    const s = await t.ctl.open(doc);
    expect(s.status).toBe('ready');
    expect(s.history).toEqual(['Open']);
    const d = (await (t.app as unknown as LiveWordCraft).describe()) as { text: string[] };
    expect(d.text[0]).toBe('Quarterly Report');
    await t.ctl.quickEdit('replaceText', { find: 'Sunset Over the Sea', replace: 'Evening Tide' });
    await expect(t.ctl.quickEdit('replaceText', { find: 'not in this document', replace: 'x' })).rejects.toThrow(/not found/);
    const h = (await t.ctl.quickEdit('addParagraph', { text: 'Closing remarks.' })).history;
    expect(h.length).toBeGreaterThanOrEqual(3);
    expect((await t.ctl.undo()).history.length).toBe(h.length - 1);
    await t.ctl.quickEdit('addParagraph', { text: 'Closing remarks.' });
    const saved = await t.ctl.saveVersion();
    expect(saved.savedVersionIds).toHaveLength(2);
    const main = await fileInfo(t.store, saved.savedVersionIds[0]!);
    const png = await fileInfo(t.store, saved.savedVersionIds[1]!);
    expect(main.asset).toMatchObject({ kind: 'document', parentId: doc, sourceFormat: 'docx' });
    expect(png.asset.kind).toBe('image');
    expect(png.info.width).toBeGreaterThan(500);
    expect((await t.ctl.preview(800))?.subarray(1, 4).toString()).toBe('PNG');
  }, 120000);
});

describe.skipIf(!has('GridCraft'))('Live GridCraft (real window)', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let sheet: string;
  beforeAll(async () => {
    t = await setup('gridcraft', (o) => new LiveGridCraft(o) as unknown as Driver);
    sheet = (await t.store.importFile(path.join(FIXTURES, 'region-sales.xlsx'))).asset.id;
  }, 60000);
  afterAll(async () => { await t?.cleanup(); });

  it('opens a workbook, edits cells, sorts, undoes, and saves a new .xlsx version with a window picture', async () => {
    const s = await t.ctl.open(sheet);
    expect(s.status).toBe('ready');
    expect(s.history).toEqual(['Open']);
    const g = t.app as unknown as LiveGridCraft;
    const d0 = (await g.describe()) as { sheets: Array<{ usedRange: string }>; topRows: unknown[][] };
    expect(d0.sheets[0]!.usedRange).toBe('A1:D5');
    expect(d0.topRows[1]![0]).toBe('North');
    await t.ctl.quickEdit('setCell', { cell: 'F1', value: '=SUM(D2:D5)' });
    await expect(t.ctl.quickEdit('setCell', { cell: 'nope', value: '1' })).rejects.toThrow(/cell reference/);
    const h = (await t.ctl.quickEdit('sortColumn', { range: 'A1:D5', column: 'B', order: 'desc' })).history;
    expect(h.length).toBeGreaterThanOrEqual(3);
    expect(((await g.describe()) as { topRows: unknown[][] }).topRows[1]![0]).toBe('East');
    expect((await t.ctl.undo()).history.length).toBe(h.length - 1);
    expect(((await g.describe()) as { topRows: unknown[][] }).topRows[1]![0]).toBe('North');
    await t.ctl.quickEdit('sortColumn', { range: 'A1:D5', column: 'B', order: 'desc' });
    const saved = await t.ctl.saveVersion();
    expect(saved.savedVersionIds).toHaveLength(2);
    const main = await fileInfo(t.store, saved.savedVersionIds[0]!);
    const png = await fileInfo(t.store, saved.savedVersionIds[1]!);
    expect(main.asset).toMatchObject({ kind: 'sheet', parentId: sheet, sourceFormat: 'xlsx' });
    expect(png.asset.kind).toBe('image');
    expect(png.info.width).toBeGreaterThan(500);
    expect((await t.ctl.preview(800))?.subarray(1, 4).toString()).toBe('PNG');
  }, 120000);
});

describe.skipIf(!has('DeckCraft'))('Live DeckCraft (real window)', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let deck: string;
  beforeAll(async () => {
    t = await setup('deckcraft', (o) => new LiveDeckCraft(o) as unknown as Driver);
    deck = (await t.store.importFile(path.join(FIXTURES, 'northern-lights.deckcraft'))).asset.id;
  }, 60000);
  afterAll(async () => { await t?.cleanup(); });

  it('opens a deck, edits text, adds a slide, undoes, and saves a new .deckcraft version with a PNG', async () => {
    const s = await t.ctl.open(deck);
    expect(s.status).toBe('ready');
    expect(s.history).toEqual(['Open']);
    const g = t.app as unknown as LiveDeckCraft;
    const d0 = (await g.describe()) as { slideCount: number; slides: Array<{ title?: string }> };
    expect(d0.slides[0]!.title).toBe('Northern Lights');
    await t.ctl.quickEdit('replaceText', { find: 'Northern Lights', replace: 'Southern Lights' });
    await expect(t.ctl.quickEdit('replaceText', { find: 'not in this deck', replace: 'x' })).rejects.toThrow(/not found/);
    const h = (await t.ctl.quickEdit('addSlide', { title: 'Closing', body: 'Thank you' })).history;
    expect(h.length).toBeGreaterThanOrEqual(3);
    const d1 = (await g.describe()) as { slideCount: number; slides: Array<{ title?: string }> };
    expect(d1.slideCount).toBe(d0.slideCount + 1);
    expect(d1.slides[0]!.title).toBe('Southern Lights');
    expect(d1.slides[d1.slideCount - 1]!.title).toBe('Closing');
    expect((await t.ctl.undo()).history.length).toBe(h.length - 1);
    expect(((await g.describe()) as { slideCount: number }).slideCount).toBe(d0.slideCount);
    const saved = await t.ctl.saveVersion();
    expect(saved.savedVersionIds).toHaveLength(2);
    const main = await fileInfo(t.store, saved.savedVersionIds[0]!);
    const png = await fileInfo(t.store, saved.savedVersionIds[1]!);
    expect(main.asset).toMatchObject({ kind: 'deck', parentId: deck, sourceFormat: 'deckcraft' });
    expect(png.info).toMatchObject({ width: 960, height: 540 });
    expect((await t.ctl.preview(800))?.subarray(1, 4).toString()).toBe('PNG');
  }, 120000);

  it('makes no new version when edits are undone before saving', async () => {
    await t.ctl.open(deck);
    await t.ctl.quickEdit('replaceText', { find: 'Northern Lights', replace: 'Eastern Lights' });
    await t.ctl.undo();
    expect((await t.ctl.saveVersion()).message).toMatch(/Nothing changed/);
  }, 120000);
});

describe.skipIf(!has('SoundCraft'))('Live SoundCraft timeline and history (real window)', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let tone: string;
  beforeAll(async () => {
    t = await setup('soundcraft', (o) => new LiveSoundCraft(o));
    tone = (await t.store.importFile(path.join(FIXTURES, 'tone-a440.wav'))).asset.id;
  }, 60000);
  afterAll(async () => { await t?.cleanup(); });

  it('shows the clip on a timeline with gain and fades, tracks SoundCraft\'s own undo history, and moves the playhead', async () => {
    const s = await t.ctl.open(tone);
    expect(s.history).toEqual(['Open']);
    const tl = (await t.ctl.timeline())!;
    expect(tl.tracks).toHaveLength(1);
    expect(tl.tracks[0]!.clips[0]!.duration).toBeCloseTo(2, 1);
    await t.ctl.quickEdit('gain', { db: -6 });
    await t.ctl.quickEdit('fades', { fadeIn: 0.25, fadeOut: 0.5 });
    const h = (await t.ctl.refresh()).history;
    expect(h[0]).toBe('Open');
    expect(h.length).toBeGreaterThanOrEqual(3);
    const clip = (await t.ctl.timeline())!.tracks[0]!.clips[0]!;
    expect(clip.gainDb).toBeCloseTo(-6, 1);
    expect(clip.fadeIn).toBeCloseTo(0.25, 1);
    expect(clip.fadeOut).toBeCloseTo(0.5, 1);
    expect((await t.ctl.undo()).history.length).toBe(h.length - 1);
    await t.ctl.setPlayhead(1);
    expect((await t.ctl.timeline())!.playhead).toBeCloseTo(1, 1);
    const d = (await (t.app as LiveSoundCraft).describe()) as { tracks: unknown[] };
    expect(d.tracks).toHaveLength(1);
  }, 120000);
});
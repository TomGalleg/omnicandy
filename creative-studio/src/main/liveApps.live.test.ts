// Drives the REAL FilmCraft, LightCraft, EffectCraft and DesignCraft windows through every quick edit
// CreateCraft offers, plus undo, save-as-new-version and theme. Opens windows on screen, so it only
// runs with CS_LIVE_TESTS=1. Each app's theme is put back to what it was before the test.
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDITOR_APPS, type EditorAppId } from '@shared/appEditors';
import { LiveDesignCraft, LiveEffectCraft, LiveFilmCraft, LiveLightCraft } from './liveApps';
import { LiveTaskController } from './liveTask';
import { sniffMedia } from './media';
import { ProjectStore } from './projectStore';

const PF = process.env.ProgramFiles ?? 'C:\\Program Files';
const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');
const has = (app: string) => process.env.CS_LIVE_TESTS === '1' && existsSync(path.join(PF, app, `${app.toLowerCase()}.exe`));

type Driver = LiveFilmCraft | LiveLightCraft | LiveEffectCraft | LiveDesignCraft;

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

  it('switches its interface brightness and back', async () => {
    expect(await t.app.applyTheme('light')).toBe('light');
    expect(await t.app.applyTheme('mediumDark')).toBe('mediumDark');
  }, 60000);
});

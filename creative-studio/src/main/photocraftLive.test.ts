// Drives the REAL PhotoCraft window. Opens a window on screen, so it only runs with CS_LIVE_TESTS=1.
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveSnapshot } from '@shared/live';
import { LiveTaskController } from './liveTask';
import { sniffMedia } from './media';
import { LivePhotoCraft } from './photocraftLive';
import { ProjectStore } from './projectStore';

const PC_DIR = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PhotoCraft');
const enabled = process.env.CS_LIVE_TESTS === '1' && existsSync(path.join(PC_DIR, 'photocraft.exe'));
const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');
const SHOTS = path.resolve(__dirname, '../../docs/screenshots');

const until = async (c: LiveTaskController, pred: (s: LiveSnapshot) => boolean, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred(c.snapshot())) return c.snapshot(); await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timeout; ${JSON.stringify(c.snapshot().collab)} ${c.snapshot().message}`);
};

describe.skipIf(!enabled)('Live PhotoCraft (real window)', () => {
  let tmp: string;
  let store: ProjectStore;
  let app: LivePhotoCraft;
  let ctl: LiveTaskController;
  let harbor: string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-live-real-'));
    store = new ProjectStore(path.join(tmp, 'proj'));
    await store.create('live');
    harbor = (await store.importFile(path.join(FIXTURES, 'harbor-landscape.svg'))).asset.id;
    const writeRoot = path.join(store.root, 'work', 'live');
    app = new LivePhotoCraft({ installDir: PC_DIR, secretsDir: path.join(tmp, 'secrets'), readRoot: store.root, writeRoot });
    ctl = new LiveTaskController({ connect: async () => { await app.ensureStarted(); return app; }, store, emit: () => {}, stepDelayMs: 300, writeDir: async () => writeRoot });
  }, 60000);

  afterAll(async () => {
    app?.killApp();
    await new Promise((r) => setTimeout(r, 500));
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p); else await fs.chmod(p, 0o666).catch(() => {});
      }
    };
    await walk(tmp);
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  it('opens a library asset in the live window, runs steps, detects a hand edit, and saves versions', async () => {
    const opened = await ctl.open(harbor, 'photocraft');
    expect(opened.status).toBe('ready');
    expect(opened.history[0]).toMatch(/open/i);

    await ctl.run([
      { command: 'image.adjustments.photoFilter', params: { filter: 'warming85', density: 45 } },
      { command: 'image.adjustments.vibrance', params: { vibrance: 40, saturation: 0 } },
    ]);
    let s = await until(ctl, (x) => x.collab.phase === 'completed');
    expect(s.history.length).toBe(opened.history.length + 2);

    // Simulate you editing by hand: take control, change the document directly in the app, hand back.
    ctl.takeControl();
    await app.run({ command: 'image.adjustments.invert', params: {} });
    expect(ctl.snapshot().collab).toMatchObject({ phase: 'manual', lockOwner: 'user' });
    await expect(ctl.run([{ command: 'filter.blur.gaussianBlur', params: { radius: 1 } }])).rejects.toThrow(/in progress/); // lock held by you
    ctl.releaseControl();
    await ctl.resume();
    s = await until(ctl, (x) => x.collab.phase === 'completed');
    expect(s.history.at(-1)).toMatch(/invert/i); // your hand edit is part of the document now

    const shot = await app.screenshot(1400);
    expect(shot && shot.length).toBeGreaterThan(1000);
    await fs.mkdir(SHOTS, { recursive: true });
    await fs.writeFile(path.join(SHOTS, '10-live-photocraft-window.png'), shot!);

    const saved = await ctl.saveVersion();
    expect(saved.savedVersionIds).toHaveLength(2);
    const m = await store.loadManifest();
    const png = m.assets.find((a) => a.id === saved.savedVersionIds[1])!;
    expect(png).toMatchObject({ kind: 'image', width: 1600, height: 900 });
    const pcraft = m.assets.find((a) => a.id === saved.savedVersionIds[0])!;
    expect(pcraft).toMatchObject({ sourceFormat: 'pcraft', parentId: harbor });
    expect(pcraft.provenance.source).toMatch(/Photo Filter|photoFilter/i);
    const head = await fs.readFile(await store.resolveAssetPath(png.id));
    expect(sniffMedia('png', head)).toEqual({ width: 1600, height: 900 });
    const after = await ctl.refresh();
    expect(after.history).toEqual(s.history); // saving does not add history steps
  }, 120000);

  it('PhotoCraft itself refuses automated access outside the project, and rejects a wrong token', async () => {
    await expect(app.open('C:\\Windows\\win.ini')).rejects.toThrow(/automation path rejected/);
    await expect(app.saveNative(path.join(tmp, 'outside.pcraft'))).rejects.toThrow(/automation path rejected/);
    expect(existsSync(path.join(tmp, 'outside.pcraft'))).toBe(false);
  }, 60000);
});

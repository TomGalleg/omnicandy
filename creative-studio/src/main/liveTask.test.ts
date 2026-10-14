import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppOperation } from '@shared/contracts';
import type { LiveSnapshot } from '@shared/live';
import { LiveTaskController } from './liveTask';
import type { LiveDoc } from './photocraftLive';
import { ProjectStore } from './projectStore';

const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');

/** Fake app document: history grows with each op; `userEdit` simulates someone editing in the app window. */
class FakeDoc implements LiveDoc {
  hist = ['Open'];
  ran: string[] = [];
  gate: Promise<void> | null = null;
  async open() { this.hist = ['Open']; return { name: 'x' }; }
  async run(op: AppOperation) {
    if (op.command === 'filter.blur.boom') throw new Error('engine exploded');
    if (this.gate) await this.gate;
    this.ran.push(op.command);
    this.hist.push(op.command);
  }
  async history() { return [...this.hist]; }
  userEdit(name = 'Brush Tool') { this.hist.push(name); }
  async writeVersion(dir: string, base: string): Promise<{ main: string; preview?: string }> {
    const main = path.join(dir, `${base}.pcraft`);
    const preview = path.join(dir, `${base}.png`);
    await fs.writeFile(main, `pcraft:${this.hist.join(',')}`);
    await fs.writeFile(preview, Buffer.concat([await fs.readFile(path.join(FIXTURES, 'photocraft-smoke.png')), Buffer.from(this.hist.join(','))]));
    return { main, preview };
  }
  async undo() { if (this.hist.length > 1) this.hist.pop(); }
  quickEditSteps(opId: string): AppOperation[] | Promise<AppOperation[]> {
    if (opId === 'blackWhite') return [{ command: 'image.adjustments.blackWhite', params: {} }];
    if (opId === 'sharpen') return [{ command: 'file.saveAs', params: {} }]; // simulate a driver returning something disallowed
    return [];
  }
}

const until = async (c: LiveTaskController, pred: (s: LiveSnapshot) => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred(c.snapshot())) return c.snapshot(); await new Promise((r) => setTimeout(r, 5)); }
  throw new Error(`timeout; last: ${JSON.stringify(c.snapshot().collab)} ${c.snapshot().message}`);
};

let tmp: string;
let store: ProjectStore;
let doc: FakeDoc;
let ctl: LiveTaskController;
let assetId: string;
const STEPS = [
  { command: 'image.adjustments.invert', params: {} },
  { command: 'filter.blur.gaussianBlur', params: { radius: 2 } },
  { command: 'image.autoTone', params: {} },
];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-live-'));
  store = new ProjectStore(path.join(tmp, 'p'));
  await store.create('t');
  assetId = (await store.importFile(path.join(FIXTURES, 'photocraft-smoke.png'))).asset.id;
  doc = new FakeDoc();
  ctl = new LiveTaskController({
    connect: async () => doc, store, emit: () => {}, stepDelayMs: 30,
    writeDir: async () => { const d = path.join(store.root, 'work', 'live'); await fs.mkdir(d, { recursive: true }); return d; },
  });
  await ctl.open(assetId);
});
afterEach(async () => {
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else await fs.chmod(p, 0o666).catch(() => {});
    }
  };
  await walk(tmp);
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('LiveTaskController', () => {
  it('runs all steps in order and completes', async () => {
    await ctl.run(STEPS);
    const s = await until(ctl, (x) => x.collab.phase === 'completed');
    expect(doc.ran).toEqual(STEPS.map((x) => x.command));
    expect(s.stepIndex).toBe(3);
    expect(s.collab.lockOwner).toBeNull();
  });

  it('refuses disallowed steps before touching the app', async () => {
    await expect(ctl.run([{ command: 'file.saveAs', params: {} }])).rejects.toThrow(/allowed list/);
    expect(doc.ran).toEqual([]);
  });

  it('pause lands at the boundary after the current step', async () => {
    let release!: () => void;
    doc.gate = new Promise((r) => { release = r; });
    await ctl.run(STEPS);
    await until(ctl, (x) => !!x.collab.activeOperation);
    ctl.pause();
    expect(ctl.snapshot().collab.phase).toBe('pausing');
    release();
    const s = await until(ctl, (x) => x.collab.phase === 'paused');
    expect(doc.ran).toEqual(['image.adjustments.invert']); // finished the active step, started no other
    expect(s.stepIndex).toBe(1);
    doc.gate = null;
    await ctl.resume();
    await until(ctl, (x) => x.collab.phase === 'completed');
    expect(doc.ran).toHaveLength(3);
  });

  it('take control blocks automation; manual edits force a confirmed replan before continuing', async () => {
    let release!: () => void;
    doc.gate = new Promise((r) => { release = r; });
    await ctl.run(STEPS);
    await until(ctl, (x) => !!x.collab.activeOperation);
    ctl.takeControl();
    release();
    await until(ctl, (x) => x.collab.phase === 'manual');
    doc.gate = null;
    expect(ctl.snapshot().collab.lockOwner).toBe('user');
    await expect(ctl.run(STEPS)).rejects.toThrow(/already in progress/);

    doc.userEdit('Brush Tool');
    ctl.releaseControl();
    const s = await ctl.resume();
    expect(s.collab.phase).toBe('planning');
    expect(s.needsReplanConfirm).toBe(true);
    expect(s.message).toContain('Brush Tool');
    await new Promise((r) => setTimeout(r, 80));
    expect(doc.ran).toHaveLength(1); // nothing ran without the go-ahead

    await ctl.confirmReplan();
    await until(ctl, (x) => x.collab.phase === 'completed');
    expect(doc.hist).toEqual(['Open', 'image.adjustments.invert', 'Brush Tool', 'filter.blur.gaussianBlur', 'image.autoTone']);
  });

  it('resuming after take-control without edits continues directly', async () => {
    await ctl.run(STEPS);
    await until(ctl, (x) => x.stepIndex === 1 && !x.collab.activeOperation);
    ctl.takeControl();
    ctl.releaseControl();
    expect((await ctl.resume()).collab.phase).toBe('running');
    await until(ctl, (x) => x.collab.phase === 'completed');
  });

  it('detects edits made in the app while automation is between steps and pauses instead of editing on top', async () => {
    await ctl.run(STEPS);
    await until(ctl, (x) => x.stepIndex === 1 && !x.collab.activeOperation);
    doc.userEdit('Eraser');
    const s = await until(ctl, (x) => x.collab.phase === 'paused');
    expect(s.message).toMatch(/change automation did not make/);
    expect(doc.ran).toEqual(['image.adjustments.invert']);
  });

  it('a failing step fails the task and releases the lock', async () => {
    await ctl.run([{ command: 'image.adjustments.invert', params: {} }, { command: 'filter.blur.boom', params: {} }]);
    const s = await until(ctl, (x) => x.collab.phase === 'failed');
    expect(s.message).toMatch(/engine exploded/);
    expect(s.collab.lockOwner).toBeNull();
  });

  it('saves the live document as new read-only versions with lineage, never touching the opened asset', async () => {
    await ctl.run(STEPS.slice(0, 1));
    await until(ctl, (x) => x.collab.phase === 'completed');
    const s1 = await ctl.saveVersion();
    expect(s1.savedVersionIds).toHaveLength(2);
    const m = await store.loadManifest();
    const pc = m.assets.find((a) => a.id === s1.savedVersionIds[0])!;
    expect(pc).toMatchObject({ sourceFormat: 'pcraft', parentId: assetId, name: 'photocraft-smoke-live1.pcraft' });
    expect(pc.provenance.source).toContain('image.adjustments.invert');
    expect(m.assets.find((a) => a.id === s1.savedVersionIds[1])).toMatchObject({ kind: 'image', parentId: pc.id });

    doc.userEdit('Crop');
    const s2 = await ctl.saveVersion();
    const pc2 = (await store.loadManifest()).assets.find((a) => a.id === s2.savedVersionIds[2])!;
    expect(pc2).toMatchObject({ name: 'photocraft-smoke-live2.pcraft', parentId: pc.id });
    expect(await fs.readdir(path.join(store.root, 'work', 'live'))).toEqual([]);
  });

  it('quick edits run in the open document, respect the allowlist and the task lock; undo reverts', async () => {
    const s = await ctl.quickEdit('blackWhite', {});
    expect(doc.ran).toEqual(['image.adjustments.blackWhite']);
    expect(s.message).toMatch(/applied in PhotoCraft/);
    await expect(ctl.quickEdit('sharpen', {})).rejects.toThrow(/allowed list/);
    await expect(ctl.quickEdit('blur', { radius: 9999 })).rejects.toThrow(/between/);
    await expect(ctl.quickEdit('nope', {})).rejects.toThrow(/no quick edit/);
    await ctl.undo();
    expect(doc.hist).toEqual(['Open']);
    let release!: () => void;
    doc.gate = new Promise((r) => { release = r; });
    await ctl.run(STEPS);
    await until(ctl, (x) => !!x.collab.activeOperation);
    await expect(ctl.quickEdit('blackWhite', {})).rejects.toThrow(/task is running/);
    release();
  });

  it('Claude edits through the lock: allowed when free, refused when the user paused or took control', async () => {
    expect(await ctl.claudeQuickEdit('blackWhite', {})).toMatch(/applied/);
    expect(ctl.snapshot().collab).toMatchObject({ phase: 'running', lockOwner: 'claude' });
    await expect(ctl.claudePhotoCraftCommand('file.saveAs', {})).rejects.toThrow(/allowed list/);
    ctl.pause();
    await expect(ctl.claudeQuickEdit('blackWhite', {})).rejects.toThrow(/paused you/);
    ctl.takeControl();
    await expect(ctl.claudeQuickEdit('blackWhite', {})).rejects.toThrow(/taken control/);
    doc.userEdit('Brush Tool');
    ctl.releaseControl();
    await ctl.resume(); // document changed by hand: Claude's task waits for a go-ahead
    expect(ctl.snapshot().collab.phase).toMatch(/planning|running|completed/);
    ctl.claudeDone();
    expect(ctl.snapshot().collab.lockOwner).not.toBe('claude');
    expect(doc.ran.filter((c) => c === 'image.adjustments.blackWhite')).toHaveLength(1);
  });

  it('Claude pauses instead of editing on top of a hand edit made without taking control', async () => {
    await ctl.claudeQuickEdit('blackWhite', {});
    doc.userEdit('Eraser');
    await expect(ctl.claudeQuickEdit('blackWhite', {})).rejects.toThrow(/changed the document by hand/);
    expect(ctl.snapshot().collab.phase).toBe('paused');
  });

  it('opens each file type in its own app; multi-step automation stays PhotoCraft-only', async () => {
    const wav = (await store.importFile(path.join(FIXTURES, 'tone-a440.wav'))).asset.id;
    const s = await ctl.open(wav);
    expect(s.appId).toBe('soundcraft');
    expect(s.message).toMatch(/open in SoundCraft/);
    await expect(ctl.run(STEPS)).rejects.toThrow(/PhotoCraft only/);
    const svg = (await store.importFile(path.join(FIXTURES, 'harbor-landscape.svg'))).asset.id;
    expect((await ctl.open(svg)).appId).toBe('vectorcraft');
  });
});

describe('apps chosen by tab (Color = LightCraft) and async quick edits', () => {
  class FakeLightDoc extends FakeDoc {
    async writeVersion(dir: string, base: string) {
      const main = path.join(dir, `${base}.png`);
      await fs.writeFile(main, Buffer.concat([await fs.readFile(path.join(FIXTURES, 'photocraft-smoke.png')), Buffer.from(this.hist.join(','))]));
      return { main };
    }
    async quickEditSteps(opId: string) { await new Promise((r) => setTimeout(r, 5)); return [{ command: `develop.${opId}`, params: {} }]; }
  }

  it('opens the same photo in LightCraft for the Color tab, runs async steps and names versions -color', async () => {
    const light = new FakeLightDoc();
    const c = new LiveTaskController({
      connect: async (app) => (app === 'lightcraft' ? light : doc), store, emit: () => {},
      writeDir: async () => { const d = path.join(store.root, 'work', 'lc'); await fs.mkdir(d, { recursive: true }); return d; },
    });
    const s = await c.open(assetId, 'lightcraft');
    expect(s.appId).toBe('lightcraft');
    await c.quickEdit('auto', {});
    expect(light.ran).toEqual(['develop.auto']);
    const st = await c.statusForClaude();
    expect(st.edits.map((e) => e.id)).toContain('look');
    expect(st.open).toMatchObject({ app: 'LightCraft', tab: 'color' });
    expect(st.apps.map((a) => a.app)).toEqual(['photocraft', 'vectorcraft', 'soundcraft', 'filmcraft', 'lightcraft', 'effectcraft', 'designcraft']);
    const saved = await c.saveVersion();
    const v = (await store.loadManifest()).assets.find((a) => a.id === saved.savedVersionIds[0]);
    expect(v).toMatchObject({ name: 'photocraft-smoke-color1.png', parentId: assetId });
  });

  it('says so instead of claiming a new version when nothing changed since the last save', async () => {
    await ctl.quickEdit('blackWhite', {});
    const first = await ctl.saveVersion();
    expect(first.savedVersionIds).toHaveLength(2);
    const again = await ctl.saveVersion();
    expect(again.message).toMatch(/Nothing changed/);
    expect(again.savedVersionIds).toHaveLength(2);
  });

  it('refuses an app that cannot open the file type', async () => {
    await expect(ctl.open(assetId, 'soundcraft')).rejects.toThrow(/SoundCraft can't open PNG/);
  });

  it('lets Claude hand off to another app mid-task (its task on the first file ends) and marks who opened it', async () => {
    const light = new FakeLightDoc();
    const c = new LiveTaskController({
      connect: async (app) => (app === 'lightcraft' ? light : doc), store, emit: () => {},
      writeDir: async () => { const d = path.join(store.root, 'work', 'h'); await fs.mkdir(d, { recursive: true }); return d; },
    });
    expect((await c.open(assetId)).openedBy).toBe('user');
    await c.claudeQuickEdit('blackWhite', {});
    expect(c.snapshot().collab.phase).toBe('running'); // Claude's task is still going
    const s = await c.open(assetId, 'lightcraft', 'claude');
    expect(s).toMatchObject({ appId: 'lightcraft', openedBy: 'claude', status: 'ready' });
    expect(await c.claudeQuickEdit('auto', {})).toMatch(/applied/);
    expect(light.ran).toEqual(['develop.auto']);
  });

  it('only video apps have a timeline', async () => {
    expect(await ctl.timeline()).toBeNull();
    await expect(ctl.setPlayhead(1)).rejects.toThrow(/no timeline/);
  });
});

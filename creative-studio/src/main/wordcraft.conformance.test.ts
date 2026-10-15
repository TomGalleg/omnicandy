// WordCraft native conformance against the REAL installed WordCraft (window + CLI):
// connect, open, read, edit, undo, save, reopen the saved version, export every Deliver preset, and
// the error paths. Opens a window, so it only runs with CS_LIVE_TESTS=1.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { presetsFor } from '@shared/deliver';
import { DeliverQueue } from './deliver';
import { LiveWordCraft } from './liveApps';
import { LiveTaskController } from './liveTask';
import { ProjectStore } from './projectStore';

const PF = process.env.ProgramFiles ?? 'C:\\Program Files';
const DIR = path.join(PF, 'WordCraft');
const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');
const on = process.env.CS_LIVE_TESTS === '1' && existsSync(path.join(DIR, 'wordcraft.exe'));

describe.skipIf(!on)('WordCraft native conformance (real app)', () => {
  let tmp: string;
  let store: ProjectStore;
  let app: LiveWordCraft;
  let ctl: LiveTaskController;
  let writeRoot: string;
  let original: string;
  let savedDocx: string;
  const version = () => new Promise<string>((res, rej) => execFile(path.join(DIR, 'wordcraft-cli.exe'), ['--version'], { windowsHide: true }, (e, o) => (e ? rej(e) : res(String(o).trim()))));
  const bytes = async (id: string) => fs.readFile(await store.resolveAssetPath(id));

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-wc-conf-'));
    store = new ProjectStore(path.join(tmp, 'proj'));
    await store.create('wc');
    writeRoot = path.join(store.root, 'work', 'wordcraft-live');
    await fs.mkdir(writeRoot, { recursive: true });
    app = new LiveWordCraft({ installDir: DIR, readRoot: store.root, writeRoot });
    ctl = new LiveTaskController({ connect: async () => { await app.ensureStarted(); return app; }, store, emit: () => {}, writeDir: async () => writeRoot });
    original = (await store.importFile(path.join(FIXTURES, 'quarterly-report.docx'))).asset.id;
  }, 60000);
  afterAll(async () => {
    app?.killApp();
    await new Promise((r) => setTimeout(r, 800));
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p); else await fs.chmod(p, 0o666).catch(() => {});
      }
    };
    await walk(tmp);
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  it('detects the installed version', async () => {
    expect(await version()).toMatch(/wordcraft-cli \d+\.\d+\.\d+/);
  });

  it('connects, opens and reads the document', async () => {
    const s = await ctl.open(original);
    expect(s.status).toBe('ready');
    expect(app.connected).toBe(true);
    expect(app.pid).toBeGreaterThan(0);
    const d = (await app.describe()) as { pages?: number; text: string[] };
    expect(d.text[0]).toBe('Quarterly Report');
    expect(d.pages).toBeGreaterThanOrEqual(1);
  }, 60000);

  it('edits, undoes, edits again and saves a new .docx + PNG, leaving the original untouched', async () => {
    const before = (await bytes(original)).length;
    await ctl.quickEdit('replaceText', { find: 'Sunset Over the Sea', replace: 'Evening Tide' });
    expect(((await app.describe()) as { text: string[] }).text.join('\n')).toContain('Evening Tide');
    await ctl.undo();
    expect(((await app.describe()) as { text: string[] }).text.join('\n')).toContain('Sunset Over the Sea');
    await ctl.quickEdit('replaceText', { find: 'Sunset Over the Sea', replace: 'Evening Tide' });
    await ctl.quickEdit('addParagraph', { text: 'Conformance closing line.' });
    const saved = await ctl.saveVersion();
    expect(saved.savedVersionIds).toHaveLength(2);
    savedDocx = saved.savedVersionIds[0]!;
    const a = (await store.loadManifest()).assets.find((x) => x.id === savedDocx)!;
    expect(a).toMatchObject({ kind: 'document', sourceFormat: 'docx', parentId: original });
    expect((await bytes(original)).length).toBe(before);
    expect((await bytes(saved.savedVersionIds[1]!)).subarray(1, 4).toString()).toBe('PNG');
  }, 120000);

  it('reopens the saved version in a fresh window and finds the edits', async () => {
    app.killApp();
    await new Promise((r) => setTimeout(r, 1000));
    const s = await ctl.open(savedDocx);
    expect(s.status).toBe('ready');
    const text = ((await app.describe()) as { text: string[] }).text.join('\n');
    expect(text).toContain('Evening Tide');
    expect(text).toContain('Conformance closing line.');
    expect(text).not.toContain('Sunset Over the Sea');
  }, 90000);

  it('exports every Deliver preset with the real CLI, headless', async () => {
    const q = new DeliverQueue({ store, emit: () => {}, installDir: () => DIR });
    const ids = presetsFor('docx').map((p) => p.id);
    expect(ids).toHaveLength(7);
    const jobs = await q.enqueue(savedDocx, ids);
    const done = await q.wait(jobs.map((j) => j.id));
    expect(done.map((j) => `${j.presetId}:${j.status}`)).toEqual(ids.map((i) => `${i}:done`));
    const exports = await store.exportsDir();
    const read = (j: (typeof done)[number]) => fs.readFile(path.join(exports, j.output!));
    const by = Object.fromEntries(done.map((j) => [j.presetId, j]));
    expect((await read(by['document-pdf']!)).subarray(0, 4).toString()).toBe('%PDF');
    expect((await read(by['document-png']!)).subarray(1, 4).toString()).toBe('PNG');
    expect((await read(by['document-txt']!)).toString()).toContain('Evening Tide');
    expect((await read(by['document-md']!)).toString()).toContain('Evening Tide');
    expect((await read(by['document-html']!)).toString()).toContain('Evening Tide');
    expect((await read(by['document-odt']!)).subarray(0, 2).toString()).toBe('PK');
    expect((await read(by['document-rtf']!)).subarray(0, 5).toString()).toBe('{\\rtf');
  }, 180000);

  it('reports errors clearly: unknown text, and a file that is not a document', async () => {
    await expect(ctl.quickEdit('replaceText', { find: 'zzz not here zzz', replace: 'x' })).rejects.toThrow(/not found/i);
    const bad = path.join(tmp, 'broken.docx');
    await fs.writeFile(bad, 'this is not a zip file');
    const rec = await store.importFile(bad);
    const s = await ctl.open(rec.asset.id).catch((e: Error) => ({ status: 'error', message: e.message }));
    expect(['error', 'failed']).toContain((s as { status: string }).status);
  }, 90000);
});

// PdfCraft native conformance against the REAL installed PdfCraft (window + CLI): connect, open,
// read, edit, undo, hand edit in the window, save, reopen, export every Deliver preset, and the error
// paths. Opens a window, so it only runs with CS_LIVE_TESTS=1.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { presetsFor } from '@shared/deliver';
import { DeliverQueue } from './deliver';
import { LivePdfCraft } from './liveApps';
import { LiveTaskController } from './liveTask';
import { ProjectStore } from './projectStore';

const PF = process.env.ProgramFiles ?? 'C:\\Program Files';
const DIR = path.join(PF, 'PdfCraft');
const CLI = path.join(DIR, 'pdfcraft-cli.exe');
const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');
const on = process.env.CS_LIVE_TESTS === '1' && existsSync(path.join(DIR, 'pdfcraft.exe'));

type Desc = { pages: number; title: string | null; text: string[] };

describe.skipIf(!on)('PdfCraft native conformance (real app)', () => {
  let tmp: string;
  let store: ProjectStore;
  let app: LivePdfCraft;
  let ctl: LiveTaskController;
  let writeRoot: string;
  let original: string;
  let saved: string;
  const desc = async () => (await app.describe()) as Desc;
  const bytes = async (id: string) => fs.readFile(await store.resolveAssetPath(id));
  const ui = (m: string, p: Record<string, unknown> = {}) => (app as unknown as { ui: (m: string, p: Record<string, unknown>) => Promise<Record<string, unknown>> }).ui(m, p);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-pdf-conf-'));
    store = new ProjectStore(path.join(tmp, 'proj'));
    await store.create('pdf');
    writeRoot = path.join(store.root, 'work', 'pdfcraft-live');
    await fs.mkdir(writeRoot, { recursive: true });
    app = new LivePdfCraft({ installDir: DIR, readRoot: store.root, writeRoot });
    ctl = new LiveTaskController({ connect: async () => { await app.ensureStarted(); return app; }, store, emit: () => {}, writeDir: async () => writeRoot });
    original = (await store.importFile(path.join(FIXTURES, 'quarterly-summary.pdf'))).asset.id;
  }, 60000);
  afterAll(async () => {
    app?.killApp();
    await sleep(800);
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
    const v = await new Promise<string>((res, rej) => execFile(CLI, ['--version'], { windowsHide: true }, (e, o) => (e ? rej(e) : res(String(o).trim()))));
    expect(v).toMatch(/pdfcraft-cli \d+\.\d+\.\d+/);
  });

  it('imports PDFs as documents and opens them in PdfCraft by default', async () => {
    const a = (await store.loadManifest()).assets.find((x) => x.id === original)!;
    expect(a).toMatchObject({ kind: 'document', sourceFormat: 'pdf' });
  });

  it('connects, opens and reads the PDF (window shows it)', async () => {
    const s = await ctl.open(original);
    expect(s.status).toBe('ready');
    expect(s.appId).toBe('pdfcraft');
    expect(app.connected).toBe(true);
    expect(app.pid).toBeGreaterThan(0);
    const d = await desc();
    expect(d.pages).toBe(2);
    expect(d.text[0]).toBe('Quarterly Summary');
    const state = (await ui('ui.state', {})) as { documents: Array<{ name: string; dirty: boolean }> };
    expect(state.documents).toHaveLength(1);
    expect(state.documents[0]!.name).toMatch(/quarterly-summary\.pdf$/);
    const shot = await app.screenshot();
    expect(shot?.subarray(1, 4).toString()).toBe('PNG');
  }, 90000);

  it('edits, undoes and edits again; the window follows every step', async () => {
    const h1 = (await ctl.quickEdit('replaceText', { find: 'Sunset Over the Sea', replace: 'Evening Tide' })).history;
    expect(h1).toEqual(['Open', 'Replace text']);
    expect((await desc()).text.join('\n')).toContain('Evening Tide');
    await expect(ctl.quickEdit('replaceText', { find: 'not in this pdf', replace: 'x' })).rejects.toThrow(/not found/i);
    const h2 = (await ctl.undo()).history;
    expect(h2).toEqual(['Open']);
    expect((await desc()).text.join('\n')).toContain('Sunset Over the Sea');
    await ctl.quickEdit('replaceText', { find: 'Sunset Over the Sea', replace: 'Evening Tide' });
    await ctl.quickEdit('addText', { text: 'Approved by Claude', page: 1, position: 'bottom', size: 14 });
    await ctl.quickEdit('watermark', { text: 'DRAFT', opacity: 30 });
    await ctl.quickEdit('rotatePages', { degrees: '90', pages: '2' });
    const h3 = (await ctl.quickEdit('setTitle', { title: 'Evening report' })).history;
    expect(h3).toEqual(['Open', 'Replace text', 'Add text', 'Add watermark', 'Rotate pages', 'Set title']);
    const d = await desc();
    expect(d.title).toBe('Evening report');
    await expect(ctl.quickEdit('deletePages', { pages: '9' })).rejects.toThrow(/only 2 pages/);
    await expect(ctl.quickEdit('deletePages', { pages: '1-2' })).rejects.toThrow(/at least one page/);
    // The window shows the working copy, with no stale tabs left behind and nothing dirty.
    const state = (await ui('ui.state', {})) as { documents: Array<{ dirty: boolean }> };
    expect(state.documents).toHaveLength(1);
    expect(state.documents[0]!.dirty).toBe(false);
  }, 180000);

  it('picks up an edit made by hand in the window, and undo covers it', async () => {
    // Rotating the view is not a document edit; "Rotate pages" through the command is.
    await ui('ui.command', { id: 'page.rotate' });
    await sleep(800);
    const h = await app.history();
    // Whether the command asked for a dialog or applied a default, history must not lose earlier steps.
    expect(h.slice(0, 6)).toEqual(['Open', 'Replace text', 'Add text', 'Add watermark', 'Rotate pages', 'Set title']);
    const state = (await ui('ui.state', {})) as { documents: Array<{ dirty: boolean }> };
    expect(state.documents.length).toBe(1);
    expect(h).toHaveLength(7);
    expect(h.at(-1)).toBe('Edit in PdfCraft');
    await app.undo();
    expect(await app.history()).toHaveLength(6);
  }, 90000);

  it('saves a new .pdf + PNG version and leaves the original untouched', async () => {
    const before = await bytes(original);
    const s = await ctl.saveVersion();
    expect(s.savedVersionIds).toHaveLength(2);
    saved = s.savedVersionIds[0]!;
    const a = (await store.loadManifest()).assets.find((x) => x.id === saved)!;
    expect(a).toMatchObject({ kind: 'document', sourceFormat: 'pdf', parentId: original });
    expect((await bytes(saved)).subarray(0, 4).toString()).toBe('%PDF');
    expect((await bytes(s.savedVersionIds[1]!)).subarray(1, 4).toString()).toBe('PNG');
    expect((await bytes(original)).equals(before)).toBe(true);
    // The saved file is a complete rewrite: the replaced text is not left behind in an earlier revision.
    const text = execFileSync(CLI, ['text', await store.resolveAssetPath(saved)], { encoding: 'utf8' });
    expect(text).toContain('Evening Tide');
    expect(text).toContain('Approved by Claude');
    expect(text).not.toContain('Sunset Over the Sea');
    expect((await bytes(saved)).toString('latin1')).not.toContain('Sunset Over the Sea');
  }, 90000);

  it('reopens the saved version in a fresh window and finds the edits', async () => {
    app.killApp();
    await sleep(1200);
    const s = await ctl.open(saved);
    expect(s.status).toBe('ready');
    const d = await desc();
    expect(d.title).toBe('Evening report');
    expect(d.text.join('\n')).toContain('Evening Tide');
  }, 90000);

  it('exports every Deliver preset with the real CLI, headless', async () => {
    const q = new DeliverQueue({ store, emit: () => {}, installDir: () => DIR });
    const ids = presetsFor('pdf').filter((p) => p.app === 'pdfcraft').map((p) => p.id);
    expect(ids).toEqual(['pdf-png', 'pdf-txt', 'pdf-docx', 'pdf-html', 'pdf-rtf', 'pdf-small']);
    const jobs = await q.enqueue(saved, ids);
    const done = await q.wait(jobs.map((j) => j.id));
    expect(done.map((j) => `${j.presetId}:${j.status}${j.error ? ` ${j.error}` : ''}`)).toEqual(ids.map((i) => `${i}:done`));
    const exports = await store.exportsDir();
    const read = (id: string) => fs.readFile(path.join(exports, done.find((j) => j.presetId === id)!.output!));
    expect((await read('pdf-png')).subarray(1, 4).toString()).toBe('PNG');
    expect((await read('pdf-txt')).toString()).toContain('Evening Tide');
    expect((await read('pdf-docx')).subarray(0, 2).toString()).toBe('PK');
    expect((await read('pdf-html')).toString()).toContain('Evening Tide');
    expect((await read('pdf-rtf')).subarray(0, 5).toString()).toBe('{\\rtf');
    expect((await read('pdf-small')).subarray(0, 4).toString()).toBe('%PDF');
  }, 180000);

  it('reports errors clearly: not a PDF, and a password-protected PDF', async () => {
    const bad = path.join(tmp, 'broken.pdf');
    await fs.writeFile(bad, 'this is not a pdf');
    const badId = (await store.importFile(bad)).asset.id;
    await expect(ctl.open(badId)).rejects.toThrow(/could not read this file as a PDF/i);

    const plain = path.join(tmp, 'plain.pdf');
    const locked = path.join(tmp, 'locked.pdf');
    await fs.copyFile(path.join(FIXTURES, 'quarterly-summary.pdf'), plain);
    await fs.writeFile(path.join(tmp, 'lock.json'), JSON.stringify([
      { tool: 'doc_open', args: { path: plain } },
      { tool: 'doc_protect', args: { doc: 1, open_password: 'secret' } },
      { tool: 'doc_save', args: { doc: 1, path: locked } },
    ]));
    execFileSync(CLI, ['run', '--script', path.join(tmp, 'lock.json'), '--root', tmp], { windowsHide: true });
    const lockedId = (await store.importFile(locked)).asset.id;
    await expect(ctl.open(lockedId)).rejects.toThrow(/password/i);
  }, 120000);
});

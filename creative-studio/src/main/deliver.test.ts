// Deliver queue: command lines, queue behaviour (fake tools), and every preset against the REAL
// installed ArtCraft command-line tools (headless: no app window opens; skipped per app when absent).
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDITOR_APPS, type EditorAppId } from '@shared/appEditors';
import { DELIVER_PRESETS, laterVersions, lineage, presetById, presetsFor, type DeliverJob } from '@shared/deliver';
import { deliverCommand, DeliverQueue } from './deliver';
import { sniffMedia } from './media';
import { ProjectStore } from './projectStore';

const PF = process.env.ProgramFiles ?? 'C:\\Program Files';
const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');
const dirOf = (app: EditorAppId) => path.join(PF, EDITOR_APPS[app].name);
const installed = (app: EditorAppId) => existsSync(path.join(dirOf(app), `${app}-cli.exe`));

describe('deliver command lines', () => {
  it('downsizes only big pictures for the web, keeping the aspect ratio', () => {
    const p = presetById('image-web')!;
    expect(deliverCommand(p, 'in.png', 'out.jpg', { width: 960, height: 540 }, 't').args).toEqual(['convert', 'in.png', 'out.jpg', '--quality', '80']);
    expect(deliverCommand(p, 'in.png', 'out.jpg', { width: 4000, height: 3000 }, 't').args)
      .toEqual(['run', 'in.png', '--cmd', 'image.imageSize', '--params', '{"width":1920,"height":1440}', '--out', 'out.jpg', '--quality', '80']);
  });
  it('exports video through a fresh headless FilmCraft project', () => {
    const c = deliverCommand(presetById('video-gif')!, 'C:\\in.mp4', 'C:\\out.gif', {}, 'C:\\tmp');
    expect(c.app).toBe('filmcraft');
    expect(c.args).toEqual(['--data-dir', path.join('C:\\tmp', 'filmcraft-data'), '--compact', 'run', path.join('C:\\tmp', 'export.jsonl')]);
    expect(c.script!.map((l) => l.id)).toEqual(['file.newProject', 'file.import', 'file.newSequence', 'file.exportMedia']);
    expect(c.script![3]!.params).toEqual({ path: 'C:\\out.gif', wait: true, format: 'gif', scale: 0.5, audio: false });
  });
  it('has a command for every preset and offers presets by file type', () => {
    for (const p of DELIVER_PRESETS) expect(() => deliverCommand(p, 'a', 'b', {}, 't'), p.id).not.toThrow();
    expect(presetsFor('JPG').map((p) => p.group)).toContain('image');
    expect(presetsFor('designcraft').map((p) => p.id)).toEqual(['design-pdf', 'design-png']);
    expect(presetsFor('docx').map((p) => p.id)).toEqual(['document-pdf', 'document-png', 'document-txt', 'document-md', 'document-html', 'document-odt', 'document-rtf']);
    expect(presetsFor('PDF').map((p) => p.id)).toEqual(['pdf-png', 'pdf-txt', 'pdf-docx', 'pdf-html', 'pdf-rtf', 'pdf-small', 'vector-svg', 'vector-pdf', 'vector-png', 'vector-png2x', 'vector-eps']);
    expect(presetsFor('XLSX').map((p) => p.id)).toEqual(['sheet-csv', 'sheet-tsv', 'sheet-json', 'sheet-html']);
    expect(presetsFor('PPTX').map((p) => p.id)).toEqual(['deck-pdf', 'deck-pptx', 'deck-png']);
    expect(presetsFor('figcraft').map((p) => p.id)).toEqual(['ui-png', 'ui-png2x', 'ui-svg', 'ui-pdf']);
    expect(presetsFor('exe')).toEqual([]);
  });
});

describe('PdfCraft deliver commands', () => {
  const P = path.join('C:', 'p');
  it('renders page 1 with the CLI and runs a script (confined to the folder holding source and output) for the rest', () => {
    const src = path.join(P, 'Assets', 'a.pdf');
    const png = deliverCommand(presetById('pdf-png')!, src, path.join(P, 'exports', 'a.png'), {}, 't');
    expect(png).toMatchObject({ app: 'pdfcraft', args: ['render', src, '--page', '1', '--dpi', '150', '--out', path.join(P, 'exports', 'a.png')] });
    const docx = deliverCommand(presetById('pdf-docx')!, src, path.join(P, 'exports', 'a.docx'), {}, 'T');
    expect(docx.app).toBe('pdfcraft');
    expect(docx.args).toEqual(['run', '--script', path.join('T', 'export.json'), '--root', P]);
    expect(docx.jsonScript).toEqual([{ tool: 'doc_open', args: { path: src } }, { tool: 'doc_export_office', args: { doc: 1, path: path.join(P, 'exports', 'a.docx') } }]);
    expect(deliverCommand(presetById('pdf-txt')!, src, path.join(P, 'a.txt'), {}, 't').jsonScript![1]!.tool).toBe('doc_export_text');
    const small = deliverCommand(presetById('pdf-small')!, src, path.join(P, 'a-small.pdf'), {}, 't');
    expect(small.jsonScript![1]!.tool).toBe('doc_reduce');
    expect(small.copyIfNoOutput).toMatch(/unchanged copy/);
  });
});

describe('deliver queue', () => {
  let tmp: string;
  let store: ProjectStore;
  let still: string;
  let events: DeliverJob[][];
  const calls: Array<{ exe: string; args: string[] }> = [];
  let failNext = false;
  const fakeExec = async (exe: string, args: string[]) => {
    calls.push({ exe, args });
    await new Promise((r) => setTimeout(r, 20));
    if (failNext) { failNext = false; throw new Error('cannot write that'); }
    const out = args[2]!; // convert IN OUT
    await fs.writeFile(out, `fake ${path.basename(out)}`);
    return '';
  };

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-deliver-'));
    store = new ProjectStore(path.join(tmp, 'p'));
    await store.create('deliver');
    still = (await store.importFile(path.join(FIXTURES, 'sunset-still.jpg'))).asset.id;
  });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  const queue = () => { events = []; return new DeliverQueue({ store, emit: (j) => events.push(j), installDir: (app) => `C:\\Apps\\${app}`, exec: fakeExec }); };

  it('runs exports one at a time, never overwrites, and records source version and checksum', async () => {
    const q = queue();
    const jobs = await q.enqueue(still, ['image-png', 'image-jpg']);
    expect(jobs.map((j) => j.status)).toEqual(['queued', 'queued']);
    const again = await q.enqueue(still, ['image-png']);
    const done = await q.wait([...jobs, ...again].map((j) => j.id));
    expect(done.map((j) => [j.status, j.output])).toEqual([['done', 'sunset-still.png'], ['done', 'sunset-still.jpg'], ['done', 'sunset-still-2.png']]);
    expect(calls[0]!.exe).toBe(path.join('C:\\Apps\\photocraft', 'photocraft-cli.exe'));
    expect(events.some((e) => e.filter((j) => j.status === 'running').length > 1)).toBe(false);
    const hist = await q.history(still);
    expect(hist).toHaveLength(3);
    expect(hist[0]).toMatchObject({ preset: 'image-png', app: 'photocraft', source: { assetId: still, name: 'sunset-still.jpg', versions: ['sunset-still.jpg'] }, output: { file: 'sunset-still-2.png' } });
    expect(hist[0]!.output.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await store.listExports()).map((e) => e.name).sort()).toEqual(['sunset-still-2.png', 'sunset-still.jpg', 'sunset-still.png']);
  });

  it('refuses formats that do not fit the file, and reports failures without leaving files', async () => {
    const q = queue();
    await expect(q.enqueue(still, ['audio-wav'])).rejects.toThrow(/can't export JPG/);
    await expect(q.enqueue(still, [])).rejects.toThrow(/at least one/);
    failNext = true;
    const [j] = await q.enqueue(still, ['image-webp']);
    const [r] = await q.wait([j!.id]);
    expect(r).toMatchObject({ status: 'failed', error: 'cannot write that' });
    expect(existsSync(path.join(store.root, 'exports', 'sunset-still.webp'))).toBe(false);
  });

  it('refuses to hand on an export that has not finished', async () => {
    const q = queue();
    const [j] = await q.enqueue(still, ['image-tiff']);
    await expect(q.addToLibrary(j!.id)).rejects.toThrow(/not finished/);
    await q.wait([j!.id]);
  });

  it('keeps the export in exports/ and adds the library copy with provenance', async () => {
    const own = new ProjectStore(path.join(tmp, 'handoff'));
    await own.create('handoff');
    const src = (await own.importFile(path.join(FIXTURES, 'sunset-still.jpg'))).asset.id;
    const q = new DeliverQueue({ store: own, emit: () => {}, installDir: (app) => `C:\\Apps\\${app}`, exec: fakeExec });
    const [j] = await q.enqueue(src, ['image-png']);
    const [r] = await q.wait([j!.id]);
    const a = await q.addToLibrary(r!.id);
    expect(a).toMatchObject({ kind: 'image', sourceFormat: 'png', parentId: src });
    expect(a.name).toBe('sunset-still-from-jpg.png');
    expect(a.provenance.source).toMatch(/hand-off/);
    expect(existsSync(path.join(own.root, 'exports', r!.output!))).toBe(true);
    expect(existsSync(path.join(own.root, 'work', 'deliver-handoff', r!.id))).toBe(false);
  });

  it('cancels waiting exports and clears finished ones from the list', async () => {
    const q = queue();
    const jobs = await q.enqueue(still, ['image-tiff', 'image-psd']);
    q.cancel(jobs[1]!.id);
    const done = await q.wait(jobs.map((j) => j.id));
    expect(done.map((j) => j.status)).toEqual(['done', 'cancelled']);
    q.clearFinished();
    expect(q.list()).toEqual([]);
  });

  it('knows a file\'s version history', async () => {
    const m = await store.loadManifest();
    const src = path.join(store.root, 'work', 'v.jpg');
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(src, readFileSync(path.join(FIXTURES, 'sunset-still.jpg')).subarray(0, 4000));
    const v1 = await store.addDerivedFile(src, { name: 'sunset-still-live1.jpg', parentId: still, provenance: { origin: 'generated', source: 't' } });
    const all = (await store.loadManifest()).assets;
    expect(lineage(all, v1.id).map((a) => a.name)).toEqual(['sunset-still.jpg', 'sunset-still-live1.jpg']);
    expect(laterVersions(all, still).map((a) => a.name)).toEqual(['sunset-still-live1.jpg']);
    expect(m.assets.length).toBeLessThan(all.length);
  });
});

describe('every Deliver preset with the real ArtCraft tools (headless)', () => {
  let tmp: string;
  let store: ProjectStore;
  let q: DeliverQueue;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-deliver-real-'));
    store = new ProjectStore(path.join(tmp, 'p'));
    await store.create('deliver');
    for (const f of ['sunset-still.jpg', 'harbor-landscape.svg', 'tone-a440.wav', 'sunset-clip.mp4', 'sunset-flyer.designcraft', 'quarterly-report.docx', 'quarterly-summary.pdf', 'region-sales.xlsx', 'northern-lights.deckcraft', 'login-screen.figcraft']) ids[f] = (await store.importFile(path.join(FIXTURES, f))).asset.id;
    q = new DeliverQueue({ store, emit: () => {}, installDir: dirOf });
  });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }); });

  const head = async (name: string, n = 64) => (await fs.readFile(path.join(store.root, 'exports', name))).subarray(0, n);
  const run = async (file: string, group: string) => {
    const presets = DELIVER_PRESETS.filter((p) => p.group === group).map((p) => p.id);
    const jobs = await q.enqueue(ids[file]!, presets);
    const done = await q.wait(jobs.map((j) => j.id));
    for (const j of done) expect(j.status, `${j.presetId}: ${j.error}`).toBe('done');
    return Object.fromEntries(done.map((j) => [j.presetId, j.output!]));
  };

  it.skipIf(!installed('photocraft'))('pictures: PNG, JPEG, web JPEG, WebP, TIFF, PSD', async () => {
    const o = await run('sunset-still.jpg', 'image');
    expect(sniffMedia('png', await head(o['image-png']!, 4096))).toMatchObject({ width: 960, height: 540 });
    expect(sniffMedia('jpg', await head(o['image-web']!, 65536))).toMatchObject({ width: 960 });
    expect((await head(o['image-webp']!)).subarray(8, 12).toString()).toBe('WEBP');
    expect(['II*', 'MM\0']).toContain((await head(o['image-tiff']!)).subarray(0, 3).toString());
    expect((await head(o['image-psd']!)).subarray(0, 4).toString()).toBe('8BPS');
  }, 120000);

  it.skipIf(!installed('vectorcraft'))('vector art: SVG, PDF, PNG, PNG 2×, EPS', async () => {
    const o = await run('harbor-landscape.svg', 'vector');
    expect((await head(o['vector-pdf']!)).subarray(0, 5).toString()).toBe('%PDF-');
    const eps = await head(o['vector-eps']!);
    expect(eps.subarray(0, 4).toString() === '%!PS' || eps.readUInt32LE(0) === 0xc6d3d0c5).toBe(true); // plain, or DOS EPS with a preview
    expect((await head(o['vector-svg']!, 512)).toString()).toContain('<svg');
    expect(sniffMedia('png', await head(o['vector-png2x']!, 4096)).width).toBe(2 * sniffMedia('png', await head(o['vector-png']!, 4096)).width!);
  }, 120000);

  it.skipIf(!installed('soundcraft'))('audio: WAV 24-bit, CD WAV, normalized WAV, FLAC, AIFF', async () => {
    const o = await run('tone-a440.wav', 'audio');
    for (const k of ['audio-wav', 'audio-cd', 'audio-normalized']) expect(sniffMedia('wav', await head(o[k]!, 4096)).durationSec, k).toBeCloseTo(2, 1);
    const cd = await head(o['audio-cd']!, 4096);
    const fmt = cd.indexOf('fmt ');
    expect(cd.readUInt32LE(fmt + 12)).toBe(44100);
    expect(cd.readUInt16LE(fmt + 22)).toBe(16);
    expect((await head(o['audio-flac']!)).subarray(0, 4).toString()).toBe('fLaC');
    expect((await head(o['audio-aiff']!)).subarray(0, 4).toString()).toBe('FORM');
  }, 120000);

  it.skipIf(!installed('filmcraft'))('video: MP4, half-size MP4, ProRes, GIF, AAC and WAV sound', async () => {
    const o = await run('sunset-clip.mp4', 'video');
    const mp4 = async (name: string) => {
      const b = await fs.readFile(path.join(store.root, 'exports', name));
      return sniffMedia('mp4', b.subarray(0, 256 * 1024), b.subarray(Math.max(0, b.length - 1024 * 1024)));
    };
    expect(await mp4(o['video-mp4']!)).toMatchObject({ width: 960, height: 540 });
    expect((await mp4(o['video-mp4']!)).durationSec).toBeCloseTo(4, 0);
    expect(await mp4(o['video-mp4-half']!)).toMatchObject({ width: 480, height: 270 });
    expect((await head(o['video-gif']!)).subarray(0, 4).toString()).toBe('GIF8');
    expect((await head(o['video-prores']!)).subarray(4, 8).toString()).toBe('ftyp');
    expect((await head(o['video-aac']!)).subarray(4, 8).toString()).toBe('ftyp');
    expect(sniffMedia('wav', await head(o['video-wav']!, 4096)).durationSec).toBeCloseTo(4, 0);
  }, 300000);

  it.skipIf(!installed('wordcraft'))('documents: PDF, PNG, text, Markdown, HTML, ODT and RTF', async () => {
    const o = await run('quarterly-report.docx', 'document');
    expect((await head(o['document-pdf']!)).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await head(o['document-png']!, 4096)).subarray(1, 4).toString()).toBe('PNG');
    expect(await fs.readFile(path.join(store.root, 'exports', o['document-txt']!), 'utf8')).toContain('Quarterly Report');
    expect(await fs.readFile(path.join(store.root, 'exports', o['document-md']!), 'utf8')).toContain('Quarterly Report');
    expect((await head(o['document-html']!, 4096)).toString().toLowerCase()).toContain('<');
    expect((await head(o['document-odt']!)).subarray(0, 2).toString()).toBe('PK');
    expect((await head(o['document-rtf']!)).subarray(0, 5).toString()).toBe(String.raw`{\rtf`);
  }, 120000);

  it.skipIf(!installed('figcraft'))('UI designs: PNG, PNG at 2x, SVG and PDF of the first frame', async () => {
    const o = await run('login-screen.figcraft', 'ui');
    expect(sniffMedia('png', await head(o['ui-png']!, 4096))).toMatchObject({ width: 360, height: 640 });
    expect(sniffMedia('png', await head(o['ui-png2x']!, 4096))).toMatchObject({ width: 720, height: 1280 });
    expect((await head(o['ui-svg']!, 512)).toString().toLowerCase()).toContain('<svg');
    expect((await head(o['ui-pdf']!)).subarray(0, 5).toString()).toBe('%PDF-');
  }, 120000);

  it.skipIf(!installed('deckcraft'))('presentations: PDF, PPTX and a PNG of slide 1', async () => {
    const o = await run('northern-lights.deckcraft', 'deck');
    expect((await head(o['deck-pdf']!)).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await head(o['deck-pptx']!)).subarray(0, 2).toString()).toBe('PK');
    expect(sniffMedia('png', await head(o['deck-png']!, 4096))).toMatchObject({ width: 1920, height: 1080 });
  }, 120000);

  it.skipIf(!installed('gridcraft'))('spreadsheets: CSV, TSV, JSON and HTML', async () => {
    const o = await run('region-sales.xlsx', 'sheet');
    const text = (n: string) => fs.readFile(path.join(store.root, 'exports', o[n]!), 'utf8');
    expect(await text('sheet-csv')).toContain('East,20,1.5,30');
    expect((await text('sheet-tsv')).split(/\r?\n/)[0]).toBe('Region\tUnits\tPrice\tRevenue');
    expect(JSON.parse(await text('sheet-json'))).toBeTruthy();
    expect((await text('sheet-html')).toLowerCase()).toContain('<table');
  }, 120000);

  it.skipIf(!installed('pdfcraft'))('PDFs: PNG, text, DOCX, HTML, RTF and a smaller PDF', async () => {
    const o = await run('quarterly-summary.pdf', 'pdf');
    expect((await head(o['pdf-png']!, 4096)).subarray(1, 4).toString()).toBe('PNG');
    expect(await fs.readFile(path.join(store.root, 'exports', o['pdf-txt']!), 'utf8')).toContain('Quarterly Summary');
    expect((await head(o['pdf-docx']!)).subarray(0, 2).toString()).toBe('PK');
    expect((await head(o['pdf-html']!, 8192)).toString().toLowerCase()).toContain('<');
    expect((await head(o['pdf-rtf']!)).subarray(0, 5).toString()).toBe(String.raw`{\rtf`);
    expect((await head(o['pdf-small']!)).subarray(0, 5).toString()).toBe('%PDF-');
  }, 120000);

  it.skipIf(!installed('designcraft'))('layouts: PDF and a 2× PNG of page 1', async () => {
    const o = await run('sunset-flyer.designcraft', 'design');
    expect((await head(o['design-pdf']!)).subarray(0, 5).toString()).toBe('%PDF-');
    expect(sniffMedia('png', await head(o['design-png']!, 4096))).toMatchObject({ width: 1224, height: 1584 });
    const hist = await q.history();
    expect(hist.length).toBe(DELIVER_PRESETS.filter((p) => ['image', 'vector', 'audio', 'video', 'design', 'document', 'pdf', 'sheet', 'deck', 'ui'].includes(p.group) && (installed(p.app))).length);
  }, 120000);
});

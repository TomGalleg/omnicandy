// WordCraft <-> PdfCraft hand-off with the REAL apps: a Word document is exported as PDF, kept in the
// library, opened and edited in PdfCraft; a PDF is exported as .docx, kept in the library, opened and
// edited in WordCraft. Opens windows, so it only runs with CS_LIVE_TESTS=1.
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditorAppId } from '@shared/appEditors';
import { DeliverQueue } from './deliver';
import { LivePdfCraft, LiveWordCraft } from './liveApps';
import { LiveTaskController } from './liveTask';
import { ProjectStore } from './projectStore';

const PF = process.env.ProgramFiles ?? 'C:\\Program Files';
const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');
const on = process.env.CS_LIVE_TESTS === '1' && existsSync(path.join(PF, 'PdfCraft', 'pdfcraft.exe')) && existsSync(path.join(PF, 'WordCraft', 'wordcraft.exe'));

describe.skipIf(!on)('WordCraft <-> PdfCraft hand-off (real apps)', () => {
  let tmp: string;
  let store: ProjectStore;
  let ctl: LiveTaskController;
  let q: DeliverQueue;
  const drivers: Partial<Record<EditorAppId, LivePdfCraft | LiveWordCraft>> = {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const asset = async (id: string) => (await store.loadManifest()).assets.find((a) => a.id === id)!;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-handoff-'));
    store = new ProjectStore(path.join(tmp, 'proj'));
    await store.create('handoff');
    const work = async (n: string) => { const d = path.join(store.root, 'work', n); await fs.mkdir(d, { recursive: true }); return d; };
    const roots = { pdfcraft: await work('pdfcraft-live'), wordcraft: await work('wordcraft-live') };
    ctl = new LiveTaskController({
      connect: async (app) => {
        const o = { installDir: path.join(PF, app === 'pdfcraft' ? 'PdfCraft' : 'WordCraft'), readRoot: store.root, writeRoot: roots[app as 'pdfcraft' | 'wordcraft'] };
        drivers[app] ??= app === 'pdfcraft' ? new LivePdfCraft(o) : new LiveWordCraft(o);
        await drivers[app]!.ensureStarted();
        return drivers[app]!;
      },
      store, emit: () => {}, writeDir: async (app) => roots[app as 'pdfcraft' | 'wordcraft'],
    });
    q = new DeliverQueue({ store, emit: () => {}, installDir: (app) => path.join(PF, app === 'pdfcraft' ? 'PdfCraft' : 'WordCraft') });
  }, 60000);
  afterAll(async () => {
    for (const d of Object.values(drivers)) d?.killApp();
    await sleep(900);
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p); else await fs.chmod(p, 0o666).catch(() => {});
      }
    };
    await walk(tmp);
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  it('Word document -> PDF -> opened and edited in PdfCraft', async () => {
    const docx = (await store.importFile(path.join(FIXTURES, 'quarterly-report.docx'))).asset.id;
    const [job] = await q.enqueue(docx, ['document-pdf']);
    const [done] = await q.wait([job!.id]);
    expect(done!.status).toBe('done');
    const kept = await q.addToLibrary(done!.id);
    expect(kept).toMatchObject({ kind: 'document', sourceFormat: 'pdf', parentId: docx });
    expect(kept.provenance.source).toMatch(/hand-off/);
    // The export itself stays in exports/.
    expect(await fs.stat(path.join(await store.exportsDir(), done!.output!)).then((s) => s.size > 0)).toBe(true);

    const s = await ctl.open(kept.id); // .pdf opens in PdfCraft by default
    expect(s.status).toBe('ready');
    expect(s.appId).toBe('pdfcraft');
    const d = (await (drivers.pdfcraft as LivePdfCraft).describe()) as { pages: number; text: string[] };
    expect(d.text.join('\n')).toContain('Sunset Over the Sea');
    await ctl.quickEdit('replaceText', { find: 'Sunset Over the Sea', replace: 'Harbour Lights' });
    const saved = await ctl.saveVersion();
    expect(saved.savedVersionIds).toHaveLength(2);
    expect(await asset(saved.savedVersionIds[0]!)).toMatchObject({ sourceFormat: 'pdf', parentId: kept.id });
  }, 180000);

  it('PDF -> .docx -> opened and edited in WordCraft', async () => {
    const pdf = (await store.importFile(path.join(FIXTURES, 'quarterly-summary.pdf'))).asset.id;
    const [job] = await q.enqueue(pdf, ['pdf-docx']);
    const [done] = await q.wait([job!.id]);
    expect(done!.status, done!.error).toBe('done');
    const kept = await q.addToLibrary(done!.id);
    expect(kept).toMatchObject({ kind: 'document', sourceFormat: 'docx', parentId: pdf });

    const s = await ctl.open(kept.id); // .docx opens in WordCraft
    expect(s.status).toBe('ready');
    expect(s.appId).toBe('wordcraft');
    const d = (await (drivers.wordcraft as LiveWordCraft).describe()) as { text: string[] };
    expect(d.text.join('\n')).toContain('Quarterly Summary');
    expect(d.text.join('\n')).toContain('Sunset Over the Sea');
    await ctl.quickEdit('replaceText', { find: 'Sunset Over the Sea', replace: 'Harbour Lights' });
    const saved = await ctl.saveVersion();
    expect(saved.savedVersionIds.length).toBeGreaterThanOrEqual(1);
    expect(await asset(saved.savedVersionIds[0]!)).toMatchObject({ sourceFormat: 'docx', parentId: kept.id });
  }, 180000);

  it('refuses to hand on an export CreateCraft cannot open', async () => {
    const docx = (await store.importFile(path.join(FIXTURES, 'quarterly-report.docx'))).asset.id;
    const [job] = await q.enqueue(docx, ['document-odt']);
    const [done] = await q.wait([job!.id]);
    await expect(q.addToLibrary(done!.id)).rejects.toThrow(/can't be opened/);
  }, 60000);
});

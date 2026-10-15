// Real workflows with the installed ArtCraft apps, all in the background (no app window opens):
// batches across apps, approval of some files, a folder as input, and Deliver exports.
// Skipped when an app the workflow needs is not installed.
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDITOR_APPS, type EditorAppId } from '@shared/appEditors';
import { MockGenerationProvider } from '@shared/mocks';
import type { WorkflowGraph, WorkflowRunEvent } from '@shared/workflow';
import { WorkflowRunner } from '@shared/workflowRunner';
import { DeliverQueue } from './deliver';
import { ProjectStore, sha256File } from './projectStore';
import { WorkflowSteps } from './workflowSteps';

const PF = process.env.ProgramFiles ?? 'C:\\Program Files';
const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');
const dirOf = (app: EditorAppId) => path.join(PF, EDITOR_APPS[app].name);
const has = (...apps: EditorAppId[]) => apps.every((a) => existsSync(path.join(dirOf(a), `${a}-cli.exe`)));

/** Files → steps (app:opId:values JSON) → optional approval → export presets. */
function chain(files: Record<string, string>, steps: Array<[string, string, Record<string, unknown>?]>, presets: string, approval = false): WorkflowGraph {
  const nodes: WorkflowGraph['nodes'] = [{ id: 'files', type: 'import', position: { x: 0, y: 0 }, params: files }];
  steps.forEach(([appId, opId, values], i) => nodes.push({ id: `s${i}`, type: 'artcraftEdit', position: { x: 0, y: 0 }, params: { appId, opId, values: JSON.stringify(values ?? {}) } }));
  if (approval) nodes.push({ id: 'ok', type: 'approval', position: { x: 0, y: 0 }, params: { note: 'check' } });
  nodes.push({ id: 'out', type: 'export', position: { x: 0, y: 0 }, params: { presets } });
  const edges = nodes.slice(1).map((n, i) => ({
    id: `e${i}`, source: nodes[i]!.id, sourceHandle: nodes[i]!.type === 'approval' ? 'out' : 'image', target: n.id, targetHandle: n.type === 'artcraftEdit' ? 'image' : 'in',
  }));
  return { schemaVersion: 1, nodes, edges };
}

describe('real workflows across the ArtCraft apps (no windows)', () => {
  let tmp: string;
  let store: ProjectStore;
  let q: DeliverQueue;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-workflow-'));
    store = new ProjectStore(path.join(tmp, 'p'));
    await store.create('workflow');
    for (const f of ['sunset-still.jpg', 'photocraft-smoke.png', 'harbor-landscape.svg', 'tone-a440.wav', 'groove-loop.wav', 'sunset-clip.mp4', 'sunset-flyer.designcraft', 'quarterly-report.docx']) {
      ids[f] = (await store.importFile(path.join(FIXTURES, f))).asset.id;
    }
    q = new DeliverQueue({ store, emit: () => {}, installDir: dirOf });
  });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 }); });

  async function run(g: WorkflowGraph, approve: (items?: Array<{ item: number }>) => boolean | number[] = () => true) {
    const steps = new WorkflowSteps({ store, installDir: dirOf, deliver: async () => q });
    const events: WorkflowRunEvent[] = [];
    try {
      const r = await new WorkflowRunner({
        apps: {}, providers: { mock: new MockGenerationProvider() },
        resolveImport: (p) => steps.resolveImport(p),
        applyStep: (s, inputs) => steps.applyStep(s, inputs),
        deliver: (inputs, presets) => steps.deliver(inputs, presets),
      }).run(g, { onEvent: (e) => events.push(e), requestApproval: async (_n, _s, items) => approve(items) });
      const failures = events.filter((e) => e.kind === 'item-status' && e.status === 'failed').map((e) => (e.kind === 'item-status' ? `${e.name}@${e.nodeId}: ${e.message}` : ''));
      const exported = events.filter((e) => e.kind === 'item-status' && e.nodeId === 'out' && e.status === 'completed').flatMap((e) => (e.kind === 'item-status' ? (e.message ?? '').split(', ') : []));
      return { r, failures, exported, events };
    } finally {
      await steps.close();
    }
  }
  const lib = async () => (await store.loadManifest()).assets;

  it.skipIf(!has('photocraft', 'lightcraft'))('two photos: PhotoCraft warm → LightCraft look → approve → web JPEG + PNG', async () => {
    const before = await sha256File(await store.resolveAssetPath(ids['sunset-still.jpg']!));
    const { r, failures, exported } = await run(chain({ mode: 'files', assetIds: JSON.stringify([ids['sunset-still.jpg'], ids['photocraft-smoke.png']]) },
      [['photocraft', 'warm'], ['lightcraft', 'look', { preset: 'lc.golden-hour' }]], 'image-web,image-png', true));
    expect(failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(exported).toHaveLength(4);
    for (const base of ['sunset-still', 'photocraft-smoke']) {
      expect(exported.filter((x) => x.startsWith(`exports/${base}-`) && x.includes('apply-a-look')).map((x) => path.extname(x)).sort()).toEqual(['.jpg', '.png']);
    }
    const look = (await lib()).find((a) => /^sunset-still-.*-apply-a-look\.png$/.test(a.name))!;
    expect(look).toBeTruthy();
    expect(await sha256File(await store.resolveAssetPath(ids['sunset-still.jpg']!))).toBe(before); // original untouched
    // The export record keeps the whole chain: original → PhotoCraft version(s) → LightCraft version.
    const rec = (await q.history()).find((x) => x.source.assetId === look.id)!;
    expect(rec.source.versions[0]).toBe('sunset-still.jpg');
    expect(rec.source.versions.at(-1)).toBe(look.name);
    expect(rec.source.versions.length).toBeGreaterThanOrEqual(3);
  }, 300000);

  it.skipIf(!has('filmcraft', 'effectcraft'))('video: FilmCraft fades → EffectCraft title → MP4 + GIF', async () => {
    const { r, failures, exported } = await run(chain({ mode: 'files', assetIds: JSON.stringify([ids['sunset-clip.mp4']]) },
      [['filmcraft', 'fades', { fadeIn: 0.5, fadeOut: 0.5 }], ['effectcraft', 'title', { text: 'Evening' }]], 'video-mp4,video-gif'));
    expect(failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(exported).toHaveLength(2);
    expect(exported.some((e) => e.endsWith('.gif'))).toBe(true);
  }, 300000);

  it.skipIf(!has('soundcraft', 'vectorcraft', 'designcraft'))('audio, vector art and a layout in one batch: each app step only takes its own files', async () => {
    // Normalize (SoundCraft) for the sounds; the layout and the SVG are not sound, so they stop at that step.
    const sounds = await run(chain({ mode: 'files', assetIds: JSON.stringify([ids['tone-a440.wav'], ids['groove-loop.wav'], ids['harbor-landscape.svg']]) },
      [['soundcraft', 'normalize']], 'audio-flac'));
    expect(sounds.exported.sort()).toEqual(['exports/groove-loop-normalize.flac', 'exports/tone-a440-normalize.flac']);
    expect(sounds.failures).toEqual([expect.stringContaining("SoundCraft can't open SVG")]);
    expect(sounds.r.ok).toBe(false);
    const art = await run(chain({ mode: 'files', assetIds: JSON.stringify([ids['harbor-landscape.svg']]) }, [['vectorcraft', 'invertColors']], 'vector-pdf,vector-png'));
    expect(art.failures).toEqual([]);
    expect(art.exported).toHaveLength(2);
    const flyer = await run(chain({ mode: 'files', assetIds: JSON.stringify([ids['sunset-flyer.designcraft']]) },
      [['designcraft', 'replaceText', { find: 'Sunset Over the Sea', replace: 'Evening Tide' }]], 'design-pdf'));
    expect(flyer.failures).toEqual([]);
    expect(flyer.exported).toEqual(['exports/sunset-flyer-replace-text.pdf']);
  }, 300000);

  it.skipIf(!has('wordcraft'))('a Word document: replace text and add a paragraph in the background, then PDF + plain text', async () => {
    const r = await run(chain({ mode: 'files', assetIds: JSON.stringify([ids['quarterly-report.docx']]) },
      [['wordcraft', 'replaceText', { find: 'Sunset Over the Sea', replace: 'Evening Tide' }], ['wordcraft', 'addParagraph', { text: 'Closing remarks.' }]], 'document-pdf,document-txt'));
    expect(r.failures).toEqual([]);
    expect(r.exported.sort()).toEqual(['exports/quarterly-report-replace-text-add-a-paragraph-at-the-end.pdf', 'exports/quarterly-report-replace-text-add-a-paragraph-at-the-end.txt'].sort());
    const txt = await fs.readFile(path.join(store.root, r.exported.find((f) => f.endsWith('.txt'))!), 'utf8');
    expect(txt).toContain('Evening Tide');
    expect(txt).toContain('Closing remarks.');
    const versions = (await lib()).filter((a) => a.kind === 'document' && a.parentId);
    expect(versions.length).toBeGreaterThanOrEqual(2);
  }, 120000);

  it.skipIf(!has('photocraft'))('a folder as input: files are copied into the library; you approve one of two', async () => {
    const folder = path.join(tmp, 'shoot');
    await fs.mkdir(folder);
    await fs.copyFile(path.join(FIXTURES, 'sunset-still.jpg'), path.join(folder, 'beach.jpg'));
    await fs.copyFile(path.join(FIXTURES, 'photocraft-smoke.png'), path.join(folder, 'square.png'));
    await fs.writeFile(path.join(folder, 'notes.txt'), 'not media');
    const { r, exported, events } = await run(chain({ mode: 'folder', folder }, [['photocraft', 'blackWhite']], 'image-jpg', true), (items) => [items![1]!.item]);
    expect(events.find((e) => e.kind === 'run-items')).toMatchObject({ names: ['sunset-still.jpg', 'photocraft-smoke.png'] }); // same bytes as library files: reused
    expect(r.ok).toBe(true);
    expect(exported).toEqual(['exports/photocraft-smoke-black-white.jpg']);
    expect(existsSync(path.join(folder, 'beach.jpg'))).toBe(true); // the folder is only read
  }, 300000);
});

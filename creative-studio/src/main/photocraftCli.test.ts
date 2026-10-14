// Integration tests against the REAL installed photocraft-cli.exe. Skipped when PhotoCraft is absent.
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockGenerationProvider } from '@shared/mocks';
import { demoGraph, type WorkflowRunEvent } from '@shared/workflow';
import { WorkflowRunner } from '@shared/workflowRunner';
import { sniffMedia } from './media';
import { PhotoCraftCliAdapter } from './photocraftCli';
import { ProjectStore, sha256File } from './projectStore';

const PF = process.env.ProgramFiles ?? 'C:\\Program Files';
const installed = existsSync(path.join(PF, 'PhotoCraft', 'photocraft-cli.exe'));
const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');

describe.skipIf(!installed)('PhotoCraftCliAdapter (real photocraft-cli)', () => {
  let tmp: string;
  let store: ProjectStore;
  let pc: PhotoCraftCliAdapter;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-pc-'));
    store = new ProjectStore(path.join(tmp, 'proj'));
    await store.create('PC test');
    for (const f of ['photocraft-smoke.png', 'harbor-landscape.svg', 'tone-a440.wav']) ids[f] = (await store.importFile(path.join(FIXTURES, f))).asset.id;
    pc = (await PhotoCraftCliAdapter.create(store))!;
  });
  afterAll(async () => {
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p); else await fs.chmod(p, 0o666).catch(() => {});
      }
    };
    await walk(tmp);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('applies a real adjustment, producing a .pcraft + .png version and leaving the original untouched', async () => {
    const original = await store.resolveAssetPath(ids['photocraft-smoke.png']!);
    const before = await sha256File(original);
    const { documentId } = await pc.open(`asset:${ids['photocraft-smoke.png']}`);
    const r = await pc.execute(documentId, { command: 'image.adjustments.invert', params: {} });

    expect(await sha256File(original)).toBe(before);
    expect(r.outputAssetIds).toHaveLength(2);
    const m = await store.loadManifest();
    const doc = m.assets.find((a) => a.id === r.outputAssetIds[0])!;
    const png = m.assets.find((a) => a.id === r.outputAssetIds[1])!;
    expect(doc).toMatchObject({ sourceFormat: 'pcraft', parentId: ids['photocraft-smoke.png'], provenance: { origin: 'generated' } });
    expect(doc.provenance.source).toContain('image.adjustments.invert');
    expect(png).toMatchObject({ kind: 'image', sourceFormat: 'png', parentId: doc.id, width: 256, height: 256 });
    expect(png.sha256).not.toBe(before); // pixels actually changed
    await expect(fs.writeFile(await store.resolveAssetPath(png.id), 'x')).rejects.toThrow(); // versions are read-only
    expect(await fs.readdir(path.join(store.root, 'work'))).toEqual([]); // nothing left behind

    // Second operation chains from the layered document, not the original.
    const r2 = await pc.execute(documentId, { command: 'filter.blur.gaussianBlur', params: { radius: 3 } });
    expect((await store.loadManifest()).assets.find((a) => a.id === r2.outputAssetIds[0])!.parentId).toBe(doc.id);
  });

  it('flattens SVG input before pixel adjustments', async () => {
    const { documentId } = await pc.open(`asset:${ids['harbor-landscape.svg']}`);
    const r = await pc.execute(documentId, { command: 'image.adjustments.hueSaturation', params: { hue: 40, saturation: 20 } });
    const m = await store.loadManifest();
    const png = m.assets.find((a) => a.id === r.outputAssetIds[1])!;
    expect(png).toMatchObject({ width: 1600, height: 900 });
    expect(m.assets.find((a) => a.id === r.outputAssetIds[0])!.provenance.source).toContain('layer.flattenImage');
  });

  it('refuses disallowed commands and unsupported inputs before spawning, and surfaces PhotoCraft errors', async () => {
    const { documentId } = await pc.open(`asset:${ids['photocraft-smoke.png']}`);
    await expect(pc.execute(documentId, { command: 'file.saveAs', params: { path: 'C:\\x.png' } })).rejects.toThrow(/not on the allowed list/);
    await expect(pc.open(`asset:${ids['tone-a440.wav']}`)).rejects.toThrow(/can't edit WAV/);
    await expect(pc.open('C:\\Windows\\win.ini')).rejects.toThrow(/needs an asset/);
    await expect(pc.execute(documentId, { command: 'filter.blur.gaussianBlur', params: { radius: 'lots' } })).rejects.toThrow(/radius/);
    expect(await fs.readdir(path.join(store.root, 'work'))).toEqual([]);
  });

  it('exports to the project exports folder without overwriting earlier exports', async () => {
    const a = await pc.exportAsset(ids['photocraft-smoke.png']!, 'jpg');
    const b = await pc.exportAsset(ids['photocraft-smoke.png']!, 'jpg');
    expect(a).toBe('photocraft-smoke.jpg');
    expect(b).toBe('photocraft-smoke-2.jpg');
    const head = await fs.readFile(path.join(store.root, 'exports', a));
    expect(sniffMedia('jpg', head)).toEqual({ width: 256, height: 256 });
    await expect(pc.exportAsset(ids['photocraft-smoke.png']!, 'exe')).rejects.toThrow(/Unsupported export format/);
  });

  it('runs a whole workflow for real: Import → PhotoCraft edit → Approval → Export', async () => {
    const runner = new WorkflowRunner({
      apps: { photocraft: pc },
      providers: { mock: new MockGenerationProvider() },
      exportAsset: (id, f) => pc.exportAsset(id, f),
    });
    const graph = demoGraph(ids['harbor-landscape.svg']!);
    // The engine-command form of the App step (Other PhotoCraft command…), as older workflows store it.
    graph.nodes.find((n) => n.id === 'n-edit')!.params = { appId: 'photocraft', command: 'image.adjustments.photoFilter', commandParams: '{"filter":"warming85","density":40}' };
    const events: WorkflowRunEvent[] = [];
    const r = await runner.run(graph, { onEvent: (e) => events.push(e), requestApproval: async () => true });
    expect(r).toMatchObject({ ok: true, cancelled: false });
    expect(events[0]).toMatchObject({ kind: 'run-started', mock: true }); // AI Generate node is still mock
    const exp = events.find((e) => e.kind === 'node-status' && e.nodeId === 'n-export' && e.status === 'completed');
    expect(exp && 'message' in exp ? exp.message : '').toMatch(/^Exported exports\/harbor-landscape-photo-filter-warming.*\.png$/);
  });
});

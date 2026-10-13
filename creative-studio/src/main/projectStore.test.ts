import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demoGraph } from '@shared/workflow';
import { ProjectStore, sha256File } from './projectStore';
import { ensureSampleProject } from './sampleProject';

const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-project-')); });
afterEach(async () => {
  // originals are read-only; make them writable so cleanup works on Windows
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else await fs.chmod(p, 0o666).catch(() => {});
    }
  };
  await walk(tmp);
  await fs.rm(tmp, { recursive: true, force: true });
});

async function newStore() {
  const s = new ProjectStore(path.join(tmp, 'proj'));
  await s.create('Test');
  return s;
}

describe('ProjectStore', () => {
  it('imports without modifying the source and stores a read-only copy with correct metadata', async () => {
    const src = path.join(FIXTURES, 'photocraft-smoke.png');
    const before = await sha256File(src);
    const beforeStat = await fs.stat(src);
    const s = await newStore();
    const { asset } = await s.importFile(src);

    expect(await sha256File(src)).toBe(before);
    expect((await fs.stat(src)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(asset).toMatchObject({ kind: 'image', sourceFormat: 'png', width: 256, height: 256, sha256: before, approval: 'none' });
    expect(asset.relPath.startsWith('originals/')).toBe(true);

    const stored = await s.resolveAssetPath(asset.id);
    expect(await sha256File(stored)).toBe(before);
    await expect(fs.writeFile(stored, 'overwrite')).rejects.toThrow(); // read-only
  });

  it('persists the manifest and reloads it after restart', async () => {
    const s = await newStore();
    const { asset } = await s.importFile(path.join(FIXTURES, 'dune-poster.svg'));
    await s.setRating(asset.id, 4);
    const reopened = new ProjectStore(s.root);
    const m = await reopened.loadManifest();
    expect(m.name).toBe('Test');
    expect(m.assets).toHaveLength(1);
    expect(m.assets[0]).toMatchObject({ id: asset.id, kind: 'vector', width: 800, height: 1200, rating: 4 });
  });

  it('detects exact duplicates by hash and does not copy them again', async () => {
    const s = await newStore();
    const a = await s.importFile(path.join(FIXTURES, 'studio-mark.svg'));
    const copy = path.join(tmp, 'renamed-copy.svg');
    await fs.copyFile(path.join(FIXTURES, 'studio-mark.svg'), copy);
    const b = await s.importFile(copy);
    expect(b.duplicateOf).toBe(a.asset.id);
    expect((await s.loadManifest()).assets).toHaveLength(1);
    expect(await fs.readdir(path.join(s.root, 'originals'))).toHaveLength(1);
  });

  it('reads WAV duration and rejects unsupported types', async () => {
    const s = await newStore();
    const { asset } = await s.importFile(path.join(FIXTURES, 'tone-a440.wav'));
    expect(asset).toMatchObject({ kind: 'audio', durationSec: 2 });
    const bad = path.join(tmp, 'x.exe');
    await fs.writeFile(bad, 'MZ');
    await expect(s.importFile(bad)).rejects.toThrow(/Unsupported/);
  });

  it('refuses paths that escape the project root, including tampered manifests', async () => {
    const s = await newStore();
    expect(() => s.resolveInsideRoot('../outside.txt')).toThrow(/escapes/);
    expect(() => s.resolveInsideRoot('originals/../../x')).toThrow(/escapes/);
    const m = JSON.parse(await fs.readFile(path.join(s.root, 'project.json'), 'utf8'));
    m.assets.push({ ...(await s.importFile(path.join(FIXTURES, 'studio-mark.svg'))).asset, id: 'evil', relPath: '../../secrets.txt' });
    await fs.writeFile(path.join(s.root, 'project.json'), JSON.stringify(m));
    await expect(new ProjectStore(s.root).loadManifest()).rejects.toThrow();
  });

  it('round-trips a workflow graph and rejects malformed graphs', async () => {
    const s = await newStore();
    expect((await s.loadWorkflow()).nodes).toEqual([]);
    const g = demoGraph('asset-1');
    await s.saveWorkflow(g);
    expect(await new ProjectStore(s.root).loadWorkflow()).toEqual(g);
    await expect(s.saveWorkflow({ ...g, nodes: [{ ...g.nodes[0]!, type: 'shell' as never }] })).rejects.toThrow();
  });

  it('seeds the sample project from fixtures once, with provenance', async () => {
    const root = path.join(tmp, 'sample');
    const s = await ensureSampleProject(root, FIXTURES);
    const m = await s.loadManifest();
    expect(m.assets.map((a) => a.kind).sort()).toEqual(['audio', 'image', 'project', 'vector', 'vector', 'vector']);
    expect(m.assets.every((a) => a.provenance.origin === 'fixture')).toBe(true);
    const wf = await s.loadWorkflow();
    expect(wf.nodes.find((n) => n.type === 'import')?.params.assetId).toBe(m.assets.find((a) => a.name === 'harbor-landscape.svg')!.id);
    const again = await ensureSampleProject(root, FIXTURES);
    expect((await again.loadManifest()).assets).toHaveLength(m.assets.length);
  });
});

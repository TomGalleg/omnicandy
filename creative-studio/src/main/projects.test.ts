import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectManager, SAMPLE_KEY } from './projects';

const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');
let tmp: string;
let trashed: string[];
const make = () => new ProjectManager(path.join(tmp, 'projects'), FIXTURES, path.join(tmp, 'projects.json'), async (d) => { trashed.push(d); await fs.rm(d, { recursive: true, force: true }); });

beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-projects-')); trashed = []; });
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

describe('ProjectManager', () => {
  it('opens the Sample Project on first run', async () => {
    const pm = make();
    expect(await pm.currentKey()).toBe(SAMPLE_KEY);
    const list = await pm.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: SAMPLE_KEY, name: 'Sample Project', isOpen: true, isSample: true, originals: 11 });
    expect(list[0]!.thumbAssetId).toBeTruthy();
  });

  it('creates, opens and remembers projects across restarts; each has its own files and workflow', async () => {
    const pm = make();
    await pm.current();
    const key = await pm.create('  Poster series  ');
    expect((await pm.list()).find((p) => p.id === key)).toMatchObject({ name: 'Poster series', isOpen: false, assetCount: 0 });
    const store = await pm.open(key);
    await store.importFile(path.join(FIXTURES, 'dune-poster.svg'));
    expect((await store.loadWorkflow()).nodes).toEqual([]);

    const again = make(); // restart
    expect(await again.currentKey()).toBe(key);
    expect((await (await again.current()).loadManifest()).assets).toHaveLength(1);
    const list = await again.list();
    expect(list[0]).toMatchObject({ id: key, isOpen: true, originals: 1 });
    expect((await (await again.open(SAMPLE_KEY)).loadManifest()).assets).toHaveLength(11); // untouched
  });

  it('renames projects', async () => {
    const pm = make();
    const key = await pm.create('Draft');
    await pm.rename(key, 'Final');
    expect((await pm.list()).find((p) => p.id === key)?.name).toBe('Final');
    await expect(pm.rename(key, '   ')).rejects.toThrow(/name/);
  });

  it('removes to the Recycle Bin, but never the open project or the sample', async () => {
    const pm = make();
    await pm.current();
    const key = await pm.create('Temp');
    await pm.remove(key);
    expect(trashed).toEqual([path.join(tmp, 'projects', key)]);
    expect((await pm.list()).some((p) => p.id === key)).toBe(false);
    await expect(pm.remove(SAMPLE_KEY)).rejects.toThrow(/Open another project/);
    const other = await pm.create('Other');
    await pm.open(other);
    await expect(pm.remove(SAMPLE_KEY)).rejects.toThrow(/Sample Project stays/);
  });

  it('falls back to the sample if the remembered project is gone, and rejects bad keys', async () => {
    const pm = make();
    const key = await pm.create('Gone soon');
    await pm.open(key);
    await fs.rm(path.join(tmp, 'projects', key), { recursive: true, force: true });
    expect(await make().currentKey()).toBe(SAMPLE_KEY);
    await expect(pm.storeFor('../../etc')).rejects.toThrow(/Invalid project/);
    await expect(pm.open('nope')).rejects.toThrow(/No such project/);
  });

  it('puts new projects in the chosen default folder with the self-contained layout, and never moves old ones', async () => {
    const pm = make();
    const oldKey = await pm.create('Old');
    const oldDir = path.join(tmp, 'projects', oldKey);
    const dest = path.join(tmp, 'Big Drive', 'CreateCraft Projects');
    const info = await pm.setDefaultDir(dest);
    expect(info).toMatchObject({ defaultDir: dest, isCustom: true });
    const key = await pm.create('My: Project?');
    const dir = path.join(dest, 'My Project');
    expect(await pm.folder(key)).toBe(dir);
    const store = await pm.open(key);
    await store.importFile(path.join(FIXTURES, 'dune-poster.svg'));
    for (const f of ['Assets/Originals', 'Assets/Generated', 'Assets/Audio', 'Assets/Video', 'Assets/Documents', 'PhotoCraft', 'FilmCraft', 'Workflows', 'Previews', 'Versions', 'Exports', 'Checkpoints']) {
      expect((await fs.stat(path.join(dir, f))).isDirectory(), f).toBe(true);
    }
    expect((await store.loadManifest()).assets[0]!.relPath).toMatch(/^Assets\/Originals\//);
    expect((await fs.stat(path.join(dir, 'Workflows', 'workflow.json'))).isFile()).toBe(true);
    expect(await fs.access(oldDir).then(() => true, () => false)).toBe(true); // old project untouched
    expect((await pm.create('My Project')).length).toBeGreaterThan(0); // same name gets "My Project 2"
    expect((await fs.stat(path.join(dest, 'My Project 2'))).isDirectory()).toBe(true);

    const again = make(); // remembered across restarts
    expect((await again.list()).find((p) => p.id === key)).toMatchObject({ name: 'My: Project?', folder: dir });
    expect((await again.storageInfo()).defaultDir).toBe(dest);
    await again.setDefaultDir(null);
    expect((await again.storageInfo()).isCustom).toBe(false);
    expect(await again.folder(key)).toBe(dir); // old location still known
  });

  it('refuses a default folder it cannot write to', async () => {
    const pm = make();
    const blocker = path.join(tmp, 'a-file');
    await fs.writeFile(blocker, 'x');
    await expect(pm.setDefaultDir(path.join(blocker, 'sub'))).rejects.toThrow(/can't write/);
    await expect(pm.setDefaultDir('relative/path')).rejects.toThrow(/full folder path/);
  });

  it('creates a project in a per-project folder', async () => {
    const pm = make();
    const parent = path.join(tmp, 'Elsewhere');
    const key = await pm.create('One-off', parent);
    expect(await pm.folder(key)).toBe(path.join(parent, 'One-off'));
    expect((await pm.storageInfo()).isCustom).toBe(false);
  });
});

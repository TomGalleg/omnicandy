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
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// These tests copy whole sample projects; the 5 s default timeout was exceeded when the live-app suites ran in
// parallel on the same machine (intermittent failure, never a logic error).
describe('ProjectManager', { timeout: 30_000 }, () => {
  it('stores the project type, brief and objective, and remembers the view without changing "edited"', async () => {
    const pm = make();
    await pm.current();
    const key = await pm.create('Desert poster', undefined, { kind: 'design', brief: 'A cinematic poster', objective: 'Grade the photo' });
    const list = await pm.list();
    expect(list.find((p) => p.id === key)).toMatchObject({ kind: 'design', brief: 'A cinematic poster' });
    const store = await pm.open(key);
    const before = (await store.loadManifest()).updatedAt;
    await store.setMeta({ view: { workspace: 'edit' } });
    const m = await make().open(key).then((s) => s.loadManifest());
    expect(m).toMatchObject({ kind: 'design', objective: 'Grade the photo', view: { workspace: 'edit' }, updatedAt: before });
  });

  it('opens the Sample Project on first run', async () => {
    const pm = make();
    expect(await pm.currentKey()).toBe(SAMPLE_KEY);
    const list = await pm.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: SAMPLE_KEY, name: 'Sample Project', isOpen: true, isSample: true, originals: 17 });
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
    expect((await (await again.open(SAMPLE_KEY)).loadManifest()).assets).toHaveLength(17); // untouched
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

  it('opens an existing project from any folder, duplicates it, and locates a missing one', async () => {
    const pm = make();
    await pm.current();
    const elsewhere = path.join(tmp, 'USB');
    const k1 = await pm.create('Travel', elsewhere);
    const store = await pm.open(k1);
    await store.importFile(path.join(FIXTURES, 'dune-poster.svg'));
    const dir = await pm.folder(k1);

    const fresh = new ProjectManager(path.join(tmp, 'projects2'), FIXTURES, path.join(tmp, 'projects2.json'), async () => {});
    const k2 = await fresh.addExisting(dir);
    expect((await fresh.list()).find((p) => p.id === k2)).toMatchObject({ name: 'Travel', originals: 1, folder: dir });
    expect(await fresh.addExisting(dir)).toBe(k2); // same folder, same key
    await expect(fresh.addExisting(tmp)).rejects.toThrow(/not a CreateCraft project/);

    const dupKey = await pm.duplicate(k1, elsewhere);
    const dup = (await pm.list()).find((p) => p.id === dupKey)!;
    expect(dup).toMatchObject({ name: 'Travel copy', originals: 1 });
    expect(dup.folder).not.toBe(dir);
    const srcM = await (await pm.storeFor(k1)).loadManifest();
    const dupM = await (await pm.storeFor(dupKey)).loadManifest();
    expect(dupM.id).not.toBe(srcM.id);
    expect(dupM.assets[0]!.sha256).toBe(srcM.assets[0]!.sha256);

    // The folder goes missing (drive unplugged), then is found again elsewhere.
    await pm.open(SAMPLE_KEY);
    const moved = path.join(tmp, 'Elsewhere2', 'Travel');
    await fs.mkdir(path.dirname(moved), { recursive: true });
    await fs.rename(dir, moved);
    expect((await pm.list()).find((p) => p.id === k1)).toMatchObject({ missing: true });
    await pm.relocate(k1, moved);
    expect((await pm.list()).find((p) => p.id === k1)).toMatchObject({ name: 'Travel', originals: 1 });
  });

  it('moves a project with verification, leaving the original until the copy is registered', async () => {
    const pm = make();
    await pm.current();
    const key = await pm.create('Mover');
    const store = await pm.open(key);
    await store.importFile(path.join(FIXTURES, 'dune-poster.svg'));
    await expect(pm.move(key, path.join(tmp, 'X'))).rejects.toThrow(/Open another project/);
    await pm.open(SAMPLE_KEY);
    const src = await pm.folder(key);
    const dest = await pm.move(key, path.join(tmp, 'Archive'));
    expect(dest).toBe(path.join(tmp, 'Archive', key));
    expect(await pm.folder(key)).toBe(dest);
    expect(trashed).toContain(src);
    expect(await fs.access(`${dest}.moving`).then(() => true, () => false)).toBe(false);
    const m = await (await pm.storeFor(key)).loadManifest();
    expect(m.assets).toHaveLength(1);
    await expect(pm.move(key, path.join(tmp, 'Archive'))).rejects.toThrow(/already in that folder/);
  });
});

describe('arranging the project list', { timeout: 30_000 }, () => {
  const ids = async (pm: ProjectManager) => (await pm.list()).map((p) => p.id);

  it('is most recent first (open project first) until the owner arranges it', async () => {
    const pm = make();
    await pm.current();
    const a = await pm.create('A'); const b = await pm.create('B');
    await pm.open(a); await pm.open(b);
    const list = await pm.list();
    expect(list[0]!.id).toBe(b);
    expect(list.some((p) => p.arranged)).toBe(false);
  });

  it('keeps the order the owner set, even when another project is opened, and remembers it after a restart', async () => {
    const pm = make();
    await pm.current();
    const a = await pm.create('A'); const b = await pm.create('B'); const c = await pm.create('C');
    const order = [c, SAMPLE_KEY, a, b];
    await pm.setOrder(order);
    expect(await ids(pm)).toEqual(order);
    expect((await pm.list()).every((p) => p.arranged)).toBe(true);
    await pm.open(b); // opening does not shuffle an arranged list
    expect(await ids(pm)).toEqual(order);
    expect(await ids(make())).toEqual(order); // a new run of the app reads the saved order
  });

  it('puts a project made after arranging at the top, and forgets a removed one', async () => {
    const pm = make();
    await pm.current();
    const a = await pm.create('A'); const b = await pm.create('B');
    await pm.setOrder([b, SAMPLE_KEY, a]);
    const c = await pm.create('C');
    expect((await ids(pm))[0]).toBe(c);
    expect((await ids(pm)).slice(1)).toEqual([b, SAMPLE_KEY, a]);
    await pm.remove(a);
    expect(await ids(pm)).toEqual([c, b, SAMPLE_KEY]);
    const state = JSON.parse(await fs.readFile(path.join(tmp, 'projects.json'), 'utf8')) as { order?: string[] };
    expect(state.order).not.toContain(a);
  });

  it('ignores names that are not projects, and an empty list goes back to most recent first', async () => {
    const pm = make();
    await pm.current();
    const a = await pm.create('A'); const b = await pm.create('B');
    await pm.setOrder([a, 'not-a-project', '../../escape', b, a]);
    const state = JSON.parse(await fs.readFile(path.join(tmp, 'projects.json'), 'utf8')) as { order?: string[] };
    expect(state.order).toEqual([a, b]);
    await pm.open(b);
    await pm.setOrder([]);
    const list = await pm.list();
    expect(list.some((p) => p.arranged)).toBe(false);
    expect(list[0]!.id).toBe(b);
  });
});

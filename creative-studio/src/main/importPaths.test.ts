import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importPathsInto, MAX_DROPPED_FILES } from './importPaths';
import { testPattern } from './png';
import { ProjectStore } from './projectStore';

let tmp: string; let store: ProjectStore;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-drop-'));
  store = new ProjectStore(path.join(tmp, 'proj'));
  await store.create('Drop');
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const write = async (name: string, data: Buffer | string) => { const p = path.join(tmp, name); await fs.writeFile(p, data); return p; };

describe('importPathsInto (dropped files)', () => {
  it('copies pictures in as originals, leaves the source alone, and reports a repeat as a duplicate', async () => {
    const a = await write('fox.png', testPattern(16, 16, 1));
    const b = await write('owl.png', testPattern(16, 16, 2));
    const first = await importPathsInto(store, [a, b]);
    expect(first.imported.map((x) => x.name)).toEqual(['fox.png', 'owl.png']);
    expect(first.imported[0]).toMatchObject({ kind: 'image', provenance: { origin: 'imported' } });
    expect(await fs.readFile(a)).toEqual(testPattern(16, 16, 1)); // the source is untouched
    const again = await importPathsInto(store, [a]);
    expect(again.imported).toEqual([]);
    expect(again.duplicates).toEqual([{ name: 'fox.png', duplicateOf: first.imported[0]!.id }]);
    expect((await store.loadManifest()).assets).toHaveLength(2);
  });

  it('refuses what is not supported media, a folder or a missing file, with a plain reason, and still adds the good ones', async () => {
    const good = await write('ok.png', testPattern(16, 16, 3));
    const bad = await write('run.exe', 'MZ not media');
    const dir = path.join(tmp, 'a folder.png'); await fs.mkdir(dir);
    const r = await importPathsInto(store, [bad, dir, path.join(tmp, 'gone.png'), good]);
    expect(r.imported.map((x) => x.name)).toEqual(['ok.png']);
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toMatch(/^run\.exe: Unsupported file type/);
    expect(r.errors.join('|')).toMatch(/a folder\.png: /);
    expect(r.errors.join('|')).toMatch(/gone\.png: /);
    expect((await store.loadManifest()).assets).toHaveLength(1);
  });

  it('takes at most 50 files at once and says so', async () => {
    const files: string[] = [];
    for (let i = 0; i < MAX_DROPPED_FILES + 2; i++) files.push(path.join(tmp, `missing-${i}.png`));
    const r = await importPathsInto(store, files);
    expect(r.errors).toHaveLength(MAX_DROPPED_FILES + 1);
    expect(r.errors[MAX_DROPPED_FILES]).toMatch(/Only the first 50 files were added; 2 were left out/);
  });
});

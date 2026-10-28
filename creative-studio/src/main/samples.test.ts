import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STUDIO_MODELS } from '@shared/providerCapabilities';
import { testPattern } from './png';
import { ProjectStore } from './projectStore';
import { addSamples, inside, listSamples, loadSamples } from './samples';

let tmp: string; let store: ProjectStore; let pack: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-samples-'));
  store = new ProjectStore(path.join(tmp, 'proj'));
  await store.create('S');
  pack = path.join(tmp, 'samples');
  await fs.mkdir(path.join(pack, 'files'), { recursive: true });
  await fs.mkdir(path.join(pack, 'thumbs'), { recursive: true });
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const entry = (n: number, o: Record<string, unknown> = {}) => ({
  id: `sample-0${n}`, file: `files/sample-0${n}.png`, thumb: `thumbs/sample-0${n}.jpg`, name: `Fox ${n}: "the" fox?`, kind: 'image', format: 'png',
  blurb: 'Made with a model.', model: 'Recraft V4.1', prompt: 'a fox', bytes: 100, ...o,
});
async function writePack(entries: Array<ReturnType<typeof entry>>, files = true) {
  await fs.writeFile(path.join(pack, 'samples.json'), JSON.stringify({ version: 1, samples: entries }));
  if (files) for (const e of entries) { await fs.writeFile(path.join(pack, e.file), testPattern(16, 16, Number(e.id.slice(-1)))); await fs.writeFile(path.join(pack, e.thumb), Buffer.from('jpegbytes')); }
}

describe('sample pack', () => {
  it('lists samples with an inline thumbnail, and skips an entry whose file is not in this build', async () => {
    await writePack([entry(1), entry(2)]);
    await fs.rm(path.join(pack, 'files/sample-02.png'));
    const list = await listSamples(pack);
    expect(list.map((s) => s.id)).toEqual(['sample-01']);
    expect(list[0]!.thumb).toMatch(/^data:image\/jpeg;base64,/);
    expect(await loadSamples(path.join(tmp, 'nothing'))).toEqual([]); // no pack at all: an empty list, not an error
  });

  it('copies chosen samples into the project with a friendly name, a "Sample file" label, and never twice', async () => {
    await writePack([entry(1), entry(2)]);
    const r = await addSamples(store, pack, ['sample-01', 'sample-02', 'sample-01']);
    expect(r.imported).toHaveLength(2);
    expect(r.imported[0]).toMatchObject({ kind: 'image', provenance: { origin: 'fixture', source: 'Sample media shipped with OmniCandy', model: 'Recraft V4.1' } });
    expect(r.imported[0]!.name).toBe('Fox 1 the fox (Recraft V4.1).png'); // no characters Windows refuses
    const again = await addSamples(store, pack, ['sample-01']);
    expect(again.imported).toEqual([]);
    expect(again.duplicates).toHaveLength(1);
    expect((await store.loadManifest()).assets).toHaveLength(2);
    expect(await fs.readFile(path.join(pack, 'files/sample-01.png'))).toEqual(testPattern(16, 16, 1)); // the shipped file is only read
  });

  it('refuses an unknown id and a list that points outside the pack', async () => {
    await writePack([entry(1)]);
    const r = await addSamples(store, pack, ['sample-77']);
    expect(r.errors[0]).toMatch(/not in this version/);
    expect(() => inside(pack, '../secrets/providers/x.key')).toThrow(/outside/);
    await fs.writeFile(path.join(pack, 'samples.json'), JSON.stringify({ version: 1, samples: [entry(1, { file: 'files/../../x.png' })] }));
    await expect(loadSamples(pack)).rejects.toThrow(/damaged/);
    await fs.writeFile(path.join(pack, 'samples.json'), '{"version":2,"samples":[]}');
    await expect(loadSamples(pack)).rejects.toThrow(/damaged/);
  });
});

describe('the pack that ships', () => {
  const real = path.join(__dirname, '..', '..', 'resources', 'samples');

  it('is valid, small, complete on disk, and has one file per model', async () => {
    const list = await loadSamples(real);
    expect(list.length).toBeGreaterThanOrEqual(25);
    expect(new Set(list.map((s) => s.id)).size).toBe(list.length);
    expect(new Set(list.map((s) => s.model)).size).toBe(list.length); // one per AI model card
    let total = 0;
    for (const s of list) {
      const st = await fs.stat(inside(real, s.file));
      expect(st.size, s.id).toBe(s.bytes);
      expect(st.size, s.id).toBeLessThan(4 * 1024 * 1024);
      expect(path.extname(s.file).slice(1), s.id).toBe(s.format);
      expect((await fs.stat(inside(real, s.thumb))).size, `${s.id} thumb`).toBeGreaterThan(1000);
      total += st.size;
    }
    expect(total).toBeLessThan(30 * 1024 * 1024); // an installer-friendly pack
    const models = new Set(STUDIO_MODELS.map((m) => m.label));
    for (const s of list) expect(models.has(s.model), `${s.model} is a real model`).toBe(true);
  });

  it('keeps out the Dragon Burger branding set and trademark prompts', async () => {
    for (const s of await loadSamples(real)) {
      expect(`${s.name} ${s.prompt}`, s.id).not.toMatch(/dragon burger|\bnfl\b|star wars|jedi/i);
    }
  });
});

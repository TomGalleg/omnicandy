// Runs every quick edit against the REAL installed ArtCraft CLIs (skipped per app when absent).
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkEditValues, EDITOR_APPS, editorFor } from '@shared/appEditors';
import { AppEditors } from './appEditors';
import { sniffMedia } from './media';
import { ProjectStore, sha256File } from './projectStore';

const PF = process.env.ProgramFiles ?? 'C:\\Program Files';
const has = (name: string) => existsSync(path.join(PF, name, `${name.toLowerCase()}-cli.exe`));
const FIXTURES = path.resolve(__dirname, '../../fixtures/sample-project');

describe('editor table', () => {
  it('maps file types to the right app', () => {
    expect(editorFor('PNG')?.id).toBe('photocraft');
    expect(editorFor('pcraft')?.id).toBe('photocraft');
    expect(editorFor('svg')?.id).toBe('vectorcraft');
    expect(editorFor('wav')?.id).toBe('soundcraft');
    expect(editorFor('mp4')?.id).toBe('filmcraft');
    expect(editorFor('exe')).toBeNull();
  });
  it('validates values against ranges and options', () => {
    const gain = EDITOR_APPS.soundcraft.quickEdits.find((o) => o.id === 'gain')!;
    expect(checkEditValues(gain, { db: -3 })).toEqual({ ok: true, values: { db: -3 } });
    expect(checkEditValues(gain, {})).toEqual({ ok: true, values: { db: -6 } });
    expect(checkEditValues(gain, { db: 99 })).toMatchObject({ ok: false });
    expect(checkEditValues(gain, { db: 'loud' })).toMatchObject({ ok: false });
    expect(checkEditValues(gain, { db: 1, path: 'C:\\x' })).toMatchObject({ ok: false, reason: expect.stringContaining('Unknown') });
    const rot = EDITOR_APPS.photocraft.quickEdits.find((o) => o.id === 'rotate')!;
    expect(checkEditValues(rot, { turn: '45' })).toMatchObject({ ok: false });
  });
});

describe('AppEditors against the real apps', () => {
  let tmp: string;
  let store: ProjectStore;
  let ed: AppEditors;
  const ids: Record<string, string> = {};
  const launched: string[] = [];

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-editors-'));
    store = new ProjectStore(path.join(tmp, 'p'));
    await store.create('editors');
    for (const f of ['photocraft-smoke.png', 'harbor-landscape.svg', 'tone-a440.wav']) ids[f] = (await store.importFile(path.join(FIXTURES, f))).asset.id;
    ed = new AppEditors(store, (_exe, file) => { launched.push(file); }); // never opens a real window
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

  const asset = async (id: string) => (await store.loadManifest()).assets.find((a) => a.id === id)!;

  it.skipIf(!has('PhotoCraft'))('PhotoCraft: every quick edit runs and adds versions', async () => {
    const before = await sha256File(await store.resolveAssetPath(ids['photocraft-smoke.png']!));
    for (const op of EDITOR_APPS.photocraft.quickEdits) {
      const r = await ed.apply(ids['photocraft-smoke.png']!, op.id, {});
      expect(r.assetIds.length, op.id).toBe(2);
      expect((await asset(r.assetIds[1]!)).kind).toBe('image');
    }
    expect(await sha256File(await store.resolveAssetPath(ids['photocraft-smoke.png']!))).toBe(before);
  }, 120000);

  it.skipIf(!has('VectorCraft'))('VectorCraft: every quick edit produces an SVG version and a PNG preview', async () => {
    for (const op of EDITOR_APPS.vectorcraft.quickEdits) {
      const r = await ed.apply(ids['harbor-landscape.svg']!, op.id, {});
      const svg = await asset(r.assetIds[0]!);
      const png = await asset(r.assetIds[1]!);
      expect(svg, op.id).toMatchObject({ kind: 'vector', sourceFormat: 'svg', parentId: ids['harbor-landscape.svg'] });
      expect(png, op.id).toMatchObject({ kind: 'image', parentId: svg.id });
      expect(png.width, op.id).toBeGreaterThan(0);
    }
    const inv = await ed.apply(ids['harbor-landscape.svg']!, 'invertColors', {}).catch((e) => e);
    expect(inv).not.toBeInstanceOf(Error);
  }, 120000);

  it.skipIf(!has('SoundCraft'))('SoundCraft: every quick edit produces a WAV version', async () => {
    for (const op of EDITOR_APPS.soundcraft.quickEdits) {
      const r = await ed.apply(ids['tone-a440.wav']!, op.id, {});
      const wav = await asset(r.assetIds[0]!);
      expect(wav, op.id).toMatchObject({ kind: 'audio', sourceFormat: 'wav', parentId: ids['tone-a440.wav'] });
      expect(wav.durationSec, op.id).toBeCloseTo(2, 1);
    }
    const r = await ed.apply(ids['tone-a440.wav']!, 'resample', { rate: '44100' });
    const { execFileSync } = await import('node:child_process');
    const info = JSON.parse(execFileSync(path.join(PF, 'SoundCraft', 'soundcraft-cli.exe'), ['info', await store.resolveAssetPath(r.assetIds[0]!)], { encoding: 'utf8' }));
    expect(info.sample_rate).toBe(44100);
    expect(await fs.readdir(path.join(store.root, 'work', 'soundcraft'))).toEqual([]); // temp sessions cleaned up
  }, 120000);

  it('refuses ops that do not belong to the file type, and bad values, before running anything', async () => {
    await expect(ed.apply(ids['tone-a440.wav']!, 'invertColors', {})).rejects.toThrow(/no quick edit/);
    await expect(ed.apply(ids['photocraft-smoke.png']!, 'blur', { radius: 5000 })).rejects.toThrow(/between/);
    expect(await fs.readdir(path.join(store.root, 'work', 'photocraft')).catch(() => [])).toEqual([]);
  });

  it.skipIf(!has('VectorCraft'))('working copy round trip: unchanged copy is refused, a saved change comes back as a version', async () => {
    // Opening would launch the app window (stubbed here); simulate the app saving by editing the working copy.
    const edit = await (async () => {
      const e = await ed.openWorkingCopy(ids['harbor-landscape.svg']!);
      return e;
    })();
    expect(launched).toEqual([edit.workPath]);
    await expect(ed.bringBack(edit.id)).rejects.toThrow(/No saved changes/);
    const svg = await fs.readFile(edit.workPath, 'utf8');
    await fs.writeFile(edit.workPath, svg.replace('#1b1640', '#ff0000').replace('</svg>', '<rect width="10" height="10" fill="#f00"/></svg>'));
    const r = await ed.bringBack(edit.id);
    const v = await asset(r.assetIds[0]!);
    expect(v).toMatchObject({ sourceFormat: 'svg', parentId: ids['harbor-landscape.svg'] });
    expect(sniffMedia('png', await fs.readFile(await store.resolveAssetPath(r.assetIds[1]!)))).toMatchObject({ width: 1600 });
  }, 60000);
});

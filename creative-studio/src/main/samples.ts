// The Sample media pack that ships with OmniCandy: a few dozen pictures, real SVG drawings and short clips, one per AI model card,
// that people can add to a project and play with (open in PhotoCraft, VectorCraft, FilmCraft, or use as a source in AI Generate).
// The pack is a folder (resources/samples) with samples.json, files/ and thumbs/. Copying a sample into a project uses the same
// safe import as Upload: the shipped file is only read, a repeat is reported as a duplicate, and nothing leaves the project.

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ImportResult, SampleDto } from '@shared/ipc';
import type { ProjectStore } from './projectStore';

const entry = z.object({
  id: z.string().regex(/^sample-\d{2,3}$/),
  file: z.string().regex(/^files\/[A-Za-z0-9._-]+$/),
  thumb: z.string().regex(/^thumbs\/[A-Za-z0-9._-]+\.jpg$/),
  name: z.string().min(1).max(120),
  kind: z.enum(['image', 'vector', 'video']),
  format: z.string().regex(/^[a-z0-9]{2,5}$/),
  blurb: z.string().max(400),
  model: z.string().max(120),
  prompt: z.string().max(300),
  bytes: z.number().int().positive(),
});
const manifest = z.object({ version: z.literal(1), samples: z.array(entry).max(200) });
export type Sample = z.infer<typeof entry>;

export const MAX_THUMB_BYTES = 200 * 1024;

/** A path inside the pack only: never outside it, whatever the list says. */
export function inside(dir: string, rel: string): string {
  const root = path.resolve(dir);
  const abs = path.resolve(root, ...rel.split('/'));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('A sample points outside the sample folder.');
  return abs;
}

/** Reads and checks samples.json. A missing pack is an empty list; an entry whose file is missing is left out. */
export async function loadSamples(dir: string): Promise<Sample[]> {
  let raw: string;
  try { raw = await fs.readFile(path.join(dir, 'samples.json'), 'utf8'); } catch { return []; }
  const parsed = manifest.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('The sample list is damaged.');
  const out: Sample[] = [];
  for (const s of parsed.data.samples) {
    try { await fs.access(inside(dir, s.file)); out.push(s); } catch { /* the file is not in this build: skip it */ }
  }
  return out;
}

/** What the screen shows: each sample with its small thumbnail as an inline picture (the window cannot read the pack's folder). */
export async function listSamples(dir: string): Promise<SampleDto[]> {
  const out: SampleDto[] = [];
  for (const s of await loadSamples(dir)) {
    let thumb: string | null = null;
    try {
      const b = await fs.readFile(inside(dir, s.thumb));
      if (b.length <= MAX_THUMB_BYTES) thumb = `data:image/jpeg;base64,${b.toString('base64')}`;
    } catch { /* no thumbnail: the card shows its name only */ }
    out.push({ id: s.id, name: s.name, kind: s.kind, format: s.format, blurb: s.blurb, model: s.model, prompt: s.prompt, bytes: s.bytes, thumb });
  }
  return out;
}

const safeName = (s: string) => [...s].filter((c) => c.charCodeAt(0) >= 32).join('').replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').replace(/[. ]+$/, '').slice(0, 80) || 'Sample';

/** Copies the chosen samples into the open project. Unknown ids are reported, never guessed. */
export async function addSamples(store: Pick<ProjectStore, 'importFile'>, dir: string, ids: string[]): Promise<ImportResult> {
  const result: ImportResult = { imported: [], duplicates: [], errors: [] };
  const all = new Map((await loadSamples(dir)).map((s) => [s.id, s]));
  for (const id of [...new Set(ids)].slice(0, 200)) {
    const s = all.get(id);
    if (!s) { result.errors.push(`${id}: that sample is not in this version of OmniCandy`); continue; }
    try {
      const r = await store.importFile(inside(dir, s.file), {
        origin: 'fixture', source: 'Sample media shipped with OmniCandy', model: s.model, prompt: s.prompt,
        licensingNotes: 'Sample file made for OmniCandy. You can use it to try the tools.',
      }, `${safeName(s.name)} (${safeName(s.model)}).${s.format}`);
      if (r.duplicateOf) result.duplicates.push({ name: r.asset.name, duplicateOf: r.duplicateOf });
      else result.imported.push(r.asset);
    } catch (e) {
      result.errors.push(`${s.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

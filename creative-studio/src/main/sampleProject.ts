import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { demoGraph, NODE_SPECS } from '@shared/workflow';
import { ProjectStore } from './projectStore';

const fixtureList = z.array(z.object({ file: z.string(), source: z.string(), licensingNotes: z.string().optional(), workflowInput: z.boolean().optional(), since: z.number().int().optional() }));

const readFixtures = async (dir: string) => fixtureList.parse(JSON.parse(await fs.readFile(path.join(dir, 'fixtures.json'), 'utf8')));

/** Creates the sample project from repo fixtures on first run. Fixtures are copied, never modified. */
export async function ensureSampleProject(projectRoot: string, fixturesDir: string): Promise<ProjectStore> {
  const store = new ProjectStore(projectRoot);
  // A project file that looks missing for a moment (another instance is closing and rewriting it) must
  // never lead to a fresh project list over a folder that already holds files.
  let present = await store.exists();
  for (let i = 0; i < 10 && !present; i++) {
    await new Promise((r) => setTimeout(r, 200));
    present = await store.exists();
  }
  if (!present) {
    const files = await Promise.all(['originals', 'versions', 'Assets'].map((d) => fs.readdir(path.join(projectRoot, d)).catch(() => [] as string[])));
    if (files.some((f) => f.length)) throw new Error(`The Sample Project's project file is missing but its folder still has files (${projectRoot}). Nothing was changed. Restore project.json or move the folder aside.`);
  }
  if (present) {
    // v0.1 sample graphs used a parameterless edit.fill (fills with black); upgrade to the current default.
    const g = await store.loadWorkflow();
    let changed = false;
    for (const n of g.nodes) {
      if (n.type === 'artcraftEdit' && n.params.command === 'edit.fill' && !n.params.commandParams) {
        Object.assign(n.params, NODE_SPECS.artcraftEdit.defaultParams);
        changed = true;
      }
    }
    if (changed) await store.saveWorkflow(g);
    // Fixtures added in later versions (video, still, layout) join an existing Sample Project once.
    const have = new Set((await store.loadManifest()).assets.filter((a) => a.provenance.origin === 'fixture').map((a) => a.name));
    for (const f of (await readFixtures(fixturesDir)).filter((x) => x.since && !have.has(x.file))) {
      await store.importFile(path.join(fixturesDir, f.file), { origin: 'fixture', source: f.source, licensingNotes: f.licensingNotes });
    }
    return store;
  }
  await store.create('Sample Project');
  const list = await readFixtures(fixturesDir);
  let firstImage: string | null = null;
  let workflowInput: string | null = null;
  for (const f of list) {
    const { asset } = await store.importFile(path.join(fixturesDir, f.file), {
      origin: 'fixture',
      source: f.source,
      licensingNotes: f.licensingNotes,
    });
    if (!firstImage && asset.kind === 'image') firstImage = asset.id;
    if (f.workflowInput) workflowInput = asset.id;
  }
  await store.saveWorkflow(demoGraph(workflowInput ?? firstImage ?? ''));
  return store;
}

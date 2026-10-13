import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { demoGraph } from '@shared/workflow';
import { ProjectStore } from './projectStore';

const fixtureList = z.array(z.object({ file: z.string(), source: z.string(), licensingNotes: z.string().optional() }));

/** Creates the sample project from repo fixtures on first run. Fixtures are copied, never modified. */
export async function ensureSampleProject(projectRoot: string, fixturesDir: string): Promise<ProjectStore> {
  const store = new ProjectStore(projectRoot);
  if (await store.exists()) return store;
  await store.create('Sample Project');
  const list = fixtureList.parse(JSON.parse(await fs.readFile(path.join(fixturesDir, 'fixtures.json'), 'utf8')));
  let firstImage: string | null = null;
  for (const f of list) {
    const { asset } = await store.importFile(path.join(fixturesDir, f.file), {
      origin: 'fixture',
      source: f.source,
      licensingNotes: f.licensingNotes,
    });
    if (!firstImage && asset.kind === 'image') firstImage = asset.id;
  }
  await store.saveWorkflow(demoGraph(firstImage ?? ''));
  return store;
}

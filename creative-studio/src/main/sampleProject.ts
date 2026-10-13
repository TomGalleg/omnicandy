import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { demoGraph, NODE_SPECS } from '@shared/workflow';
import { ProjectStore } from './projectStore';

const fixtureList = z.array(z.object({ file: z.string(), source: z.string(), licensingNotes: z.string().optional(), workflowInput: z.boolean().optional() }));

/** Creates the sample project from repo fixtures on first run. Fixtures are copied, never modified. */
export async function ensureSampleProject(projectRoot: string, fixturesDir: string): Promise<ProjectStore> {
  const store = new ProjectStore(projectRoot);
  if (await store.exists()) {
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
    return store;
  }
  await store.create('Sample Project');
  const list = fixtureList.parse(JSON.parse(await fs.readFile(path.join(fixturesDir, 'fixtures.json'), 'utf8')));
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

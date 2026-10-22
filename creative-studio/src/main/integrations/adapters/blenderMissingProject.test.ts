// A batch asked about in a project file that does not exist: scene.build only changes EXISTING files, so the batch cannot have
// been saved. That must be an answer recovery can use (absent), not an error that leaves the lock stuck forever.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiscoveredApp } from '@shared/integrations';
import { blenderFactory, BLENDER_MANIFEST } from './blender';
import { assessBatchReadback, expectedBatchFromParams } from './blenderBatchSpec';

let dir: string;
beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-missing-')); });
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

async function run(command: string, params: Record<string, string | number | boolean>) {
  const adapter = blenderFactory.create();
  await adapter.connect({ key: 'k', name: 'Blender', exePath: path.join(dir, 'no-such-blender.exe') } as unknown as DiscoveredApp); // never launched on this path
  const cmd = BLENDER_MANIFEST.commands.find((c) => c.id === command)!;
  return adapter.execute(cmd, params, { app: {} as DiscoveredApp, workDir: dir, signal: new AbortController().signal, progress: () => undefined });
}
const spec = { batch_id: 'castle-1', objects: [{ id: 'keep', kind: 'box', loc: [0, 0, 1] }, { id: 'tower', kind: 'cylinder' }] };

describe('scene.inspect_detail for a batch in a project file that does not exist', () => {
  it('reports the batch as absent without starting Blender, and recovery accepts it as proof', async () => {
    const r = await run('scene.inspect_detail', { file_name: 'Castle.blend', batch_id: 'castle-1', chunk: 0, ids: 'keep,tower' });
    expect(r).toMatchObject({ verified: true, data: { project: { file: 'Castle.blend', exists: false }, batch: { state: 'absent', ids_missing: ['keep', 'tower'] } } });
    const expected = expectedBatchFromParams({ file_name: 'Castle.blend', spec })!;
    expect(assessBatchReadback({ ok: true, data: r.data }, expected)).toMatchObject({ outcome: 'absent', releasesLock: true });
    // the same answer about a DIFFERENT file proves nothing about this batch's project
    expect(assessBatchReadback({ ok: true, data: r.data }, { ...expected, file: 'Other.blend' })).toMatchObject({ outcome: 'ambiguous', releasesLock: false });
  });
  it('is still an error when no batch is asked about, and for unsafe names', async () => {
    await expect(run('scene.inspect_detail', { file_name: 'Castle.blend' })).rejects.toThrow(/is not in the Blender folder/);
    await expect(run('scene.inspect_detail', { file_name: '../../evil.blend', batch_id: 'castle-1' })).resolves.toBeDefined(); // reduced to a plain name inside the folder
    await expect(run('scene.inspect_detail', { file_name: 'Castle.blend', batch_id: 'Bad Id' })).rejects.toThrow(/valid batch id/);
  });
});

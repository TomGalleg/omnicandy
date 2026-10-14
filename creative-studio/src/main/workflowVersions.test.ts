import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demoGraph } from '@shared/workflow';
import { ProjectStore } from './projectStore';

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-wfver-')); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('workflow versions and templates', () => {
  it('keeps versions (deduplicated), restores them and stores templates', async () => {
    const s = new ProjectStore(path.join(tmp, 'proj'));
    await s.create('Test');
    const g1 = demoGraph('a1');
    await s.saveWorkflow(g1);
    expect(await s.snapshotWorkflow('first')).not.toBeNull();
    expect(await s.snapshotWorkflow('same again')).toBeNull();
    const g2 = structuredClone(g1);
    g2.nodes[2]!.params.opId = 'cool';
    await s.saveWorkflow(g2);
    expect(await s.snapshotWorkflow('second')).not.toBeNull();
    const list = await s.listWorkflowVersions();
    expect(list.map((v) => v.reason)).toEqual(['second', 'first']);
    expect((await s.readWorkflowVersion(list[1]!.id)).nodes[2]!.params.opId).toBe('warm');
    await expect(s.readWorkflowVersion('../../x')).rejects.toThrow();
    await s.saveWorkflowTemplate({ id: 't1', name: 'T', description: '', createdAt: new Date().toISOString(), graph: g1 });
    expect((await s.listWorkflowTemplates()).map((t) => t.id)).toEqual(['t1']);
  });
});

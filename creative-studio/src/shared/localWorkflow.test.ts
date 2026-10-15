// Local video as a workflow step: planner validation and the runner path. The generator is a fake;
// the real engine is covered by the manual real-clip runs recorded in CURRENT_PROGRESS.md.
import { describe, expect, it } from 'vitest';
import { MockArtCraftAdapter, MockGenerationProvider } from './mocks';
import { validateGraph, type WorkflowGraph } from './workflow';
import { buildWorkflowPlan } from './workflowPlan';
import { WorkflowRunner } from './workflowRunner';
import type { WorkflowRunEvent } from './workflow';

const ctx = { assets: [], configuredProviders: [] as string[] };

describe('local video workflow step', () => {
  it('plans a free local step with approval, no cost, and a download warning', () => {
    const r = buildWorkflowPlan({
      title: 'Local sea', explanation: 'x',
      steps: [
        { key: 'gen', type: 'aiGenerate', model_id: 'wan-2.1-t2v-1.3b', prompt: 'a calm sea', settings: { preset: 'low' } },
        { key: 'ok', type: 'approval', note: 'Look at it' },
      ],
      connections: [{ from: 'gen', to: 'ok' }],
    }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validateGraph(r.plan.graph)).toEqual([]);
    expect(r.plan.totalCostUsd).toBe(0);
    expect(r.plan.graph.nodes[0]!.params).toMatchObject({ providerId: 'local', modelId: 'wan-2.1-t2v-1.3b', preset: 'low' });
    expect(r.plan.warnings.join(' ')).toMatch(/free and runs on this PC/);
  });

  it('rejects an unknown preset', () => {
    const r = buildWorkflowPlan({ title: 't', explanation: 'x', steps: [{ key: 'gen', type: 'aiGenerate', model_id: 'wan-2.1-t2v-1.3b', prompt: 'p', settings: { preset: 'ultra' } }], connections: [] }, ctx);
    expect(r.ok).toBe(false);
  });

  it('runs through the local generator and never touches a paid provider', async () => {
    const calls: string[] = [];
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 'gen', type: 'aiGenerate', position: { x: 0, y: 0 }, params: { providerId: 'local', modelId: 'wan-2.1-t2v-1.3b', prompt: 'a calm sea', preset: 'experimental' } },
        { id: 'ok', type: 'approval', position: { x: 0, y: 0 }, params: { note: '' } },
      ],
      edges: [{ id: 'e', source: 'gen', sourceHandle: 'image', target: 'ok', targetHandle: 'in' }],
    };
    const events: WorkflowRunEvent[] = [];
    const runner = new WorkflowRunner({
      apps: { photocraft: new MockArtCraftAdapter('photocraft', 'PhotoCraft') }, providers: { mock: new MockGenerationProvider() },
      generateLocalVideo: async (j) => { calls.push(`${j.modelId}:${j.preset}`); return { assetId: 'vid1', name: 'sea.mp4', message: 'Local video ready.' }; },
      generateImage: async () => { calls.push('PAID IMAGE'); throw new Error('must not be called'); },
      newRunId: () => 'r',
    });
    const r = await runner.run(graph, { onEvent: (e) => events.push(e), requestApproval: async () => true });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['wan-2.1-t2v-1.3b:experimental']);
    expect(events.find((e) => e.kind === 'node-status' && e.nodeId === 'gen' && e.status === 'completed')).toMatchObject({ outputRef: 'asset:vid1' });
  });

  it('fails clearly when local video is not available', async () => {
    const graph: WorkflowGraph = { schemaVersion: 1, nodes: [{ id: 'gen', type: 'aiGenerate', position: { x: 0, y: 0 }, params: { providerId: 'local', modelId: 'wan-2.1-t2v-1.3b', prompt: 'p' } }], edges: [] };
    const events: WorkflowRunEvent[] = [];
    const r = await new WorkflowRunner({ apps: {}, providers: {}, newRunId: () => 'r' }).run(graph, { onEvent: (e) => events.push(e), requestApproval: async () => true });
    expect(r.ok).toBe(false);
    expect(events.find((e) => e.kind === 'node-status' && e.status === 'failed')).toMatchObject({ message: expect.stringContaining('not available') });
  });
});

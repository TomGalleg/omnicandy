import { describe, expect, it } from 'vitest';
import type { GenerationProvider } from './contracts';
import { exportPresetsOf, importAssetIds, WorkflowRunner } from './workflowRunner';
import { MockArtCraftAdapter, MockGenerationProvider } from './mocks';
import { demoGraph, type WorkflowGraph, type WorkflowRunEvent } from './workflow';

function setup(extraProviders: Record<string, GenerationProvider> = {}) {
  const photocraft = new MockArtCraftAdapter('photocraft', 'PhotoCraft');
  const mock = new MockGenerationProvider();
  const ex = new WorkflowRunner({ apps: { photocraft }, providers: { mock, ...extraProviders }, newRunId: () => 'r1' });
  return { ex, photocraft, mock };
}

const finalStatus = (events: WorkflowRunEvent[]) => {
  const out: Record<string, string> = {};
  for (const e of events) if (e.kind === 'node-status') out[e.nodeId] = e.status;
  return out;
};

describe('WorkflowRunner', () => {
  it('runs the demo graph through approval to completion, reporting itself as mock', async () => {
    const { ex, photocraft } = setup();
    const events: WorkflowRunEvent[] = [];
    const r = await ex.run(demoGraph('a1'), { onEvent: (e) => events.push(e), requestApproval: async () => true });
    expect(r).toEqual({ ok: true, cancelled: false });
    expect(events[0]).toEqual({ kind: 'run-started', runId: 'r1', mock: true });
    expect(finalStatus(events)).toEqual({ 'n-import': 'completed', 'n-gen': 'completed', 'n-edit': 'completed', 'n-approve': 'completed', 'n-export': 'completed' });
    expect(events.some((e) => e.kind === 'node-status' && e.nodeId === 'n-approve' && e.status === 'awaiting_approval')).toBe(true);
    expect(photocraft.log).toHaveLength(1);
    const editMsg = events.find((e) => e.kind === 'node-status' && e.nodeId === 'n-edit' && e.status === 'completed');
    expect(editMsg && 'message' in editMsg ? editMsg.message : '').toMatch(/MOCK/);
  });

  it('a rejected approval blocks everything downstream', async () => {
    const { ex } = setup();
    const events: WorkflowRunEvent[] = [];
    const r = await ex.run(demoGraph('a1'), { onEvent: (e) => events.push(e), requestApproval: async () => false });
    expect(r.ok).toBe(false);
    const s = finalStatus(events);
    expect(s['n-approve']).toBe('failed');
    expect(s['n-export']).toBe('blocked');
    expect(s['n-gen']).toBe('completed'); // independent branch unaffected
  });

  it('never submits to a billable provider without explicit consent', async () => {
    const submitted: unknown[] = [];
    const paid: GenerationProvider = {
      id: 'paid', isMock: false, billable: true,
      listModels: async () => [], estimate: async () => ({ amount: 0.04, currency: 'USD', approximate: true }),
      submit: async (j) => { submitted.push(j); return { jobId: 'x' }; }, status: async () => 'completed',
    };
    const { ex } = setup({ paid });
    const graph: WorkflowGraph = demoGraph('a1');
    graph.nodes.find((n) => n.id === 'n-gen')!.params.providerId = 'paid';
    const events: WorkflowRunEvent[] = [];
    await ex.run(graph, { onEvent: (e) => events.push(e), requestApproval: async () => true });
    expect(submitted).toHaveLength(0);
    expect(finalStatus(events)['n-gen']).toBe('blocked');

    const declined: WorkflowRunEvent[] = [];
    await ex.run(graph, { onEvent: (e) => declined.push(e), requestApproval: async () => true, consentToBillable: async () => false });
    expect(submitted).toHaveLength(0);
  });

  it('refuses invalid graphs before running anything', async () => {
    const { ex, photocraft } = setup();
    const graph = demoGraph('');
    const events: WorkflowRunEvent[] = [];
    const r = await ex.run(graph, { onEvent: (e) => events.push(e), requestApproval: async () => true });
    expect(r.ok).toBe(false);
    expect(photocraft.log).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ kind: 'run-finished', ok: false });
  });

  it('cancellation while awaiting approval stops the run and nothing continues silently', async () => {
    const { ex, photocraft } = setup();
    const abort = new AbortController();
    const events: WorkflowRunEvent[] = [];
    const r = await ex.run(demoGraph('a1'), {
      signal: abort.signal,
      onEvent: (e) => events.push(e),
      requestApproval: async () => { abort.abort(); return true; },
    });
    expect(r).toEqual({ ok: false, cancelled: true });
    expect(finalStatus(events)['n-export']).toBe('cancelled');
    expect(events.some((e) => e.kind === 'node-status' && e.nodeId === 'n-export' && e.status === 'completed')).toBe(false);
    expect(photocraft.log).toHaveLength(1);
  });
});

describe('WorkflowRunner batches', () => {
  const batchGraph = (ids: string[]): WorkflowGraph => ({
    schemaVersion: 1,
    nodes: [
      { id: 'f', type: 'import', position: { x: 0, y: 0 }, params: { mode: 'files', assetIds: JSON.stringify(ids) } },
      { id: 's1', type: 'artcraftEdit', position: { x: 0, y: 0 }, params: { appId: 'photocraft', opId: 'warm', values: '{}' } },
      { id: 's2', type: 'artcraftEdit', position: { x: 0, y: 0 }, params: { appId: 'lightcraft', opId: 'look', values: '{"preset":"lc.golden-hour"}' } },
      { id: 'ok', type: 'approval', position: { x: 0, y: 0 }, params: { note: 'Looks right?' } },
      { id: 'x', type: 'export', position: { x: 0, y: 0 }, params: { presets: 'image-web,image-png' } },
    ],
    edges: [
      { id: 'e1', source: 'f', sourceHandle: 'image', target: 's1', targetHandle: 'image' },
      { id: 'e2', source: 's1', sourceHandle: 'image', target: 's2', targetHandle: 'image' },
      { id: 'e3', source: 's2', sourceHandle: 'image', target: 'ok', targetHandle: 'in' },
      { id: 'e4', source: 'ok', sourceHandle: 'out', target: 'x', targetHandle: 'in' },
    ],
  });
  const fake = () => {
    const calls: string[] = [];
    const deps = {
      apps: {}, providers: {}, newRunId: () => 'b1',
      resolveImport: async (p: Record<string, string>) => (JSON.parse(p.assetIds!) as string[]).map((id) => ({ assetId: id, name: `${id}.jpg` })),
      applyStep: async (s: { appId: string; opId: string }, inputs: string[]) => {
        calls.push(`${s.appId}:${inputs[0]}`);
        if (inputs[0] === 'bad' && s.appId === 'photocraft') throw new Error('PhotoCraft can\'t open WAV files.');
        return { assetIds: [`${inputs[0]}+${s.opId}`], message: s.opId };
      },
      deliver: async (inputs: string[], presets: string[]) => { calls.push(`export:${inputs[0]}`); return presets.map((p) => `${inputs[0]}-${p}`); },
    };
    return { deps, calls };
  };

  it('runs every step for every file, step by step; a failing file stops alone', async () => {
    const { deps, calls } = fake();
    const events: WorkflowRunEvent[] = [];
    let seen: unknown;
    const r = await new WorkflowRunner(deps).run(batchGraph(['a', 'bad', 'c']), {
      onEvent: (e) => events.push(e),
      requestApproval: async (_id, _s, items) => { seen = items; return true; },
    });
    expect(r).toEqual({ ok: false, cancelled: false }); // one file failed
    expect(calls).toEqual(['photocraft:a', 'photocraft:bad', 'photocraft:c', 'lightcraft:a+warm', 'lightcraft:c+warm', 'export:a+warm+look', 'export:c+warm+look']);
    expect(seen).toEqual([{ item: 0, name: 'a.jpg', assetId: 'a+warm+look' }, { item: 2, name: 'c.jpg', assetId: 'c+warm+look' }]);
    expect(events.find((e) => e.kind === 'run-items')).toMatchObject({ names: ['a.jpg', 'bad.jpg', 'c.jpg'] });
    expect(events.find((e) => e.kind === 'item-status' && e.item === 1 && e.status === 'failed')).toMatchObject({ nodeId: 's1', message: expect.stringContaining('WAV') });
    expect(finalStatus(events)).toMatchObject({ s1: 'completed', s2: 'completed', x: 'completed' });
    expect(events.find((e) => e.kind === 'approval-request')).toMatchObject({ nodeId: 'ok', note: 'Looks right?' });
  });

  it('exports only the files you approve', async () => {
    const { deps, calls } = fake();
    const events: WorkflowRunEvent[] = [];
    const r = await new WorkflowRunner(deps).run(batchGraph(['a', 'c']), { onEvent: (e) => events.push(e), requestApproval: async () => [1] });
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.startsWith('export'))).toEqual(['export:c+warm+look']);
    expect(events.find((e) => e.kind === 'item-status' && e.nodeId === 'ok' && e.item === 0)).toMatchObject({ status: 'failed', message: 'Rejected.' });
  });

  it('reads old graphs: a single assetId and an export format', () => {
    expect(importAssetIds({ assetId: 'a1' })).toEqual(['a1']);
    expect(importAssetIds({ assetIds: '["a","b","a"]' })).toEqual(['a', 'b']);
    expect(exportPresetsOf({ format: 'png' })).toEqual(['image-png']);
    expect(exportPresetsOf({ presets: 'image-web, video-mp4' })).toEqual(['image-web', 'video-mp4']);
  });
});
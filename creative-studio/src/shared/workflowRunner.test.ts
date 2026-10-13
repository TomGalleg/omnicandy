import { describe, expect, it } from 'vitest';
import type { GenerationProvider } from './contracts';
import { WorkflowRunner } from './workflowRunner';
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

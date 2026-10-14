import { describe, expect, it } from 'vitest';
import { MockArtCraftAdapter, MockGenerationProvider } from './mocks';
import { demoGraph, type WorkflowRunEvent } from './workflow';
import { affectedNodes, changedNodes, reusableOutputs, RunMonitor, sameAsRun, templateGraph } from './workflowControl';
import { changeStep } from './workflowPlan';
import { WorkflowRunner } from './workflowRunner';

// demoGraph: n-import -> n-edit -> n-approve -> n-export, plus an independent n-gen
const chain = () => demoGraph('a1');

describe('rerun scope', () => {
  it('a changed step affects itself and what follows, nothing before or beside it', () => {
    const a = chain();
    const b = structuredClone(a);
    b.nodes.find((n) => n.id === 'n-edit')!.params.opId = 'cool';
    expect([...changedNodes(a, b)]).toEqual(['n-edit']);
    expect([...affectedNodes(a, b)].sort()).toEqual(['n-approve', 'n-edit', 'n-export']);
  });
  it('moving a step changes nothing; reconnecting does', () => {
    const a = chain();
    const moved = structuredClone(a);
    moved.nodes[0]!.position = { x: 999, y: 5 };
    expect(changedNodes(a, moved).size).toBe(0);
    expect(sameAsRun(a, moved)).toBe(true);
    const rewired = structuredClone(a);
    rewired.edges = rewired.edges.filter((e) => e.id !== 'e3');
    expect([...changedNodes(a, rewired)]).toEqual(['n-export']);
  });
  it('reuse keeps only unaffected steps whose whole upstream is kept', () => {
    const g = chain();
    const last = { 'n-import': [{ name: 'a', refs: ['a1'] }], 'n-edit': [{ name: 'a', refs: ['v1'] }], 'n-approve': [{ name: 'a', refs: ['v1'] }], 'n-gen': [{ name: 'Generated', refs: null }] };
    expect(Object.keys(reusableOutputs(g, last, new Set(['n-edit', 'n-approve', 'n-export']))).sort()).toEqual(['n-gen', 'n-import']);
    expect(Object.keys(reusableOutputs(g, { 'n-approve': last['n-approve'] }, new Set()))).toEqual([]);
  });
});

describe('runner: rerun, pause, approved results', () => {
  const make = () => {
    const counter = { applied: 0 };
    const ex = new WorkflowRunner({
      apps: { photocraft: new MockArtCraftAdapter('photocraft', 'PhotoCraft') },
      providers: { mock: new MockGenerationProvider() },
      newRunId: () => 'r',
      resolveImport: async () => [{ assetId: 'a1', name: 'one.jpg' }],
      applyStep: async (_s, inputs) => { counter.applied++; return { assetIds: [`${inputs[0]}-v${counter.applied}`], message: 'ok' }; },
    });
    return { ex, counter };
  };
  it('reruns only affected steps and keeps earlier results', async () => {
    const { ex, counter } = make();
    const g = chain();
    const first = await ex.run(g, { onEvent: () => {}, requestApproval: async () => true });
    expect(first.ok).toBe(true);
    expect(counter.applied).toBe(1);
    expect(Object.keys(first.outputs!).sort()).toEqual(['n-approve', 'n-edit', 'n-gen', 'n-import']);
    const g2 = structuredClone(g);
    g2.nodes.find((n) => n.id === 'n-export')!.params.presets = 'image-jpg';
    const reuse = reusableOutputs(g2, first.outputs!, affectedNodes(g, g2));
    expect(Object.keys(reuse).sort()).toEqual(['n-approve', 'n-edit', 'n-gen', 'n-import']);
    const events: WorkflowRunEvent[] = [];
    let asked = 0;
    const second = await ex.run(g2, { onEvent: (e) => events.push(e), requestApproval: async () => { asked++; return true; }, reuse });
    expect(counter.applied).toBe(1);
    expect(asked).toBe(0);
    expect(second.ok).toBe(true);
    expect(events.some((e) => e.kind === 'node-status' && e.nodeId === 'n-edit' && e.status === 'completed' && /Kept/.test(e.message ?? ''))).toBe(true);
  });
  it('pauses between steps and continues when resumed', async () => {
    const { ex } = make();
    let paused = true;
    let release: () => void = () => {};
    const events: WorkflowRunEvent[] = [];
    const p = ex.run(chain(), {
      onEvent: (e) => events.push(e), requestApproval: async () => true,
      pause: { isPaused: () => paused, wait: () => new Promise<void>((r) => { release = r; }) },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.some((e) => e.kind === 'run-paused' && e.paused)).toBe(true);
    expect(events.some((e) => e.kind === 'node-status' && e.status === 'running')).toBe(false);
    paused = false;
    release();
    expect((await p).ok).toBe(true);
    expect(events.some((e) => e.kind === 'run-paused' && !e.paused)).toBe(true);
  });
  it('does not ask again about results the user already approved', async () => {
    const { ex } = make();
    let asked = 0;
    const r = await ex.run(chain(), { onEvent: () => {}, requestApproval: async () => { asked++; return true; }, isApproved: (id) => id === 'a1-v1' });
    expect(asked).toBe(0);
    expect(r.ok).toBe(true);
  });
});

describe('RunMonitor', () => {
  it('follows a run, collects problems and the wait for the user', () => {
    const m = new RunMonitor();
    m.begin(chain(), 'claude', (id) => `Step ${id}`);
    m.event({ kind: 'run-started', runId: 'r', mock: false });
    m.event({ kind: 'node-status', runId: 'r', nodeId: 'n-edit', status: 'running' });
    m.event({ kind: 'item-status', runId: 'r', nodeId: 'n-edit', item: 0, name: 'x.jpg', status: 'failed', message: 'cannot open' });
    expect(m.snapshot().state).toBe('running');
    m.event({ kind: 'node-status', runId: 'r', nodeId: 'n-approve', status: 'awaiting_approval', message: 'Check' });
    expect(m.snapshot().state).toBe('waiting-for-you');
    expect(m.snapshot().waitingFor).toMatch(/Check/);
    m.event({ kind: 'node-status', runId: 'r', nodeId: 'n-approve', status: 'completed' });
    m.event({ kind: 'run-paused', runId: 'r', paused: true });
    expect(m.snapshot().state).toBe('paused');
    m.event({ kind: 'run-finished', runId: 'r', ok: false, cancelled: false });
    const s = m.snapshot();
    expect(s.state).toBe('finished');
    expect(s.problems[0]).toMatch(/x.jpg: cannot open/);
    expect(s.startedBy).toBe('claude');
  });
});

describe('templates and step changes', () => {
  it('a template keeps the steps but drops the file choices', () => {
    const t = templateGraph(chain());
    expect(t.nodes.find((n) => n.type === 'import')!.params.assetId).toBe('');
    expect(t.nodes.find((n) => n.id === 'n-edit')!.params.opId).toBe('warm');
  });
  it('changeStep validates like planning and leaves other steps alone', () => {
    const ctx = { assets: [{ id: 'a1', name: 'beach.jpg', sourceFormat: 'jpg' }], configuredProviders: [] };
    const g = chain();
    const ok = changeStep(g, 'n-edit', { edit: 'blackWhite' }, ctx);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.graph.nodes.find((n) => n.id === 'n-edit')!.params.opId).toBe('blackWhite');
      expect([...affectedNodes(g, ok.graph)].sort()).toEqual(['n-approve', 'n-edit', 'n-export']);
    }
    expect(changeStep(g, 'n-edit', { edit: 'nope' }, ctx).ok).toBe(false);
    expect(changeStep(g, 'n-export', { prompt: 'x' }, ctx).ok).toBe(false);
    expect(changeStep(g, 'zzz', { note: 'x' }, ctx).ok).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { buildWorkflowPlan, workflowCatalog, type PlanInput } from './workflowPlan';
import { validateGraph } from './workflow';

const ctx = {
  assets: [{ id: 'a1', name: 'beach.jpg', sourceFormat: 'jpg' }, { id: 'a2', name: 'tone.wav', sourceFormat: 'wav' }],
  configuredProviders: [] as string[],
};
const base: PlanInput = {
  title: 'Warm beach',
  explanation: 'Warm the photo, check it, export.',
  steps: [
    { key: 'src', type: 'import', files: ['beach.jpg'] },
    { key: 'edit', type: 'artcraftEdit', app: 'photocraft', edit: 'blackWhite' },
    { key: 'ok', type: 'approval', note: 'Check tones' },
    { key: 'out', type: 'export', presets: ['image-png'] },
  ],
  connections: [{ from: 'src', to: 'edit' }, { from: 'edit', to: 'ok' }, { from: 'ok', to: 'out' }],
};

describe('buildWorkflowPlan', () => {
  it('builds a valid engine graph with approval points and no cost', () => {
    const r = buildWorkflowPlan(base, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validateGraph(r.plan.graph)).toEqual([]);
    expect(r.plan.graph.nodes).toHaveLength(4);
    expect(r.plan.totalCostUsd).toBe(0);
    expect(r.plan.approvals.join(' ')).toMatch(/Check tones/);
    expect(JSON.parse(r.plan.graph.nodes[0]!.params.assetIds!)).toEqual(['a1']);
  });
  it('rejects unknown files, edits, presets and invalid connections with plain reasons', () => {
    const r = buildWorkflowPlan({
      ...base,
      steps: [
        { key: 'src', type: 'import', files: ['nope.jpg'] },
        { key: 'edit', type: 'artcraftEdit', app: 'photocraft', edit: 'nonsense' },
        { key: 'out', type: 'export', presets: ['zzz'] },
      ],
      connections: [{ from: 'out', to: 'src' }, { from: 'edit', to: 'edit' }],
    }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const t = r.issues.join('\n');
    expect(t).toMatch(/no library file named "nope.jpg"/);
    expect(t).toMatch(/no edit "nonsense"/);
    expect(t).toMatch(/unknown export preset zzz/);
    expect(t).toMatch(/Connection edit → edit/);
  });
  it('rejects cycles and unconnected required inputs', () => {
    const r = buildWorkflowPlan({ ...base, connections: [{ from: 'src', to: 'edit' }] }, ctx);
    expect(r.ok).toBe(false);
  });
  it('estimates paid generation, flags approval and the not-yet-runnable warning', () => {
    const r = buildWorkflowPlan({
      title: 't', explanation: 'e',
      steps: [
        { key: 'gen', type: 'aiGenerate', model_id: 'gpt-image-2.5-flare', prompt: 'a red fox', count: 2 },
        { key: 'ok', type: 'approval' },
        { key: 'out', type: 'export' },
      ],
      connections: [{ from: 'gen', to: 'ok' }, { from: 'ok', to: 'out' }],
    }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.totalCostUsd).toBeGreaterThan(0);
    expect(r.plan.approvals.some((a) => /approve the price/.test(a))).toBe(true);
    expect(r.plan.warnings.join(' ')).toMatch(/no API key/);
    expect(r.plan.warnings.join(' ')).toMatch(/approve the price/);
  });
  it('catalogue lists every app edit', () => {
    expect(workflowCatalog().apps.find((a) => a.app === 'photocraft')!.edits.length).toBeGreaterThan(3);
  });
});

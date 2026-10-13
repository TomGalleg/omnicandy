import { describe, expect, it } from 'vitest';
import { demoGraph, invalidatedBy, topologicalOrder, validateConnection, validateGraph, type WorkflowGraph } from './workflow';

const g = (): WorkflowGraph => demoGraph('asset-1');

describe('validateConnection', () => {
  it('accepts compatible typed ports', () => {
    const graph = g();
    expect(validateConnection(graph, { source: 'n-gen', sourceHandle: 'image', target: 'n-export', targetHandle: 'in' }).ok).toBe(false); // export.in already connected
    expect(validateConnection({ ...graph, edges: [] }, { source: 'n-gen', sourceHandle: 'image', target: 'n-export', targetHandle: 'in' })).toEqual({ ok: true });
  });

  it('rejects self-loops, unknown ports, type mismatches, doubled inputs and cycles', () => {
    const graph = g();
    expect(validateConnection(graph, { source: 'n-edit', sourceHandle: 'image', target: 'n-edit', targetHandle: 'image' }).ok).toBe(false);
    expect(validateConnection(graph, { source: 'n-import', sourceHandle: 'nope', target: 'n-edit', targetHandle: 'image' })).toMatchObject({ ok: false, reason: expect.stringContaining('no output') });
    // aiGenerate.reference only accepts image; artcraftEdit.document is a document
    const r = validateConnection(graph, { source: 'n-edit', sourceHandle: 'document', target: 'n-gen', targetHandle: 'reference' });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('accepts image') });
    expect(validateConnection(graph, { source: 'n-gen', sourceHandle: 'image', target: 'n-edit', targetHandle: 'image' })).toMatchObject({ ok: false, reason: expect.stringContaining('already connected') });
    // export has no outputs, so build a cycle via approval -> edit
    const cyc = { ...graph, edges: graph.edges.filter((e) => e.id !== 'e1') };
    expect(validateConnection(cyc, { source: 'n-approve', sourceHandle: 'out', target: 'n-edit', targetHandle: 'image' })).toMatchObject({ ok: false, reason: expect.stringContaining('cycle') });
  });
});

describe('validateGraph', () => {
  it('passes the demo graph', () => {
    expect(validateGraph(g())).toEqual([]);
  });
  it('reports missing required inputs, missing asset, and bad edges from untrusted JSON', () => {
    const graph = g();
    graph.edges = graph.edges.filter((e) => e.id !== 'e2');
    graph.nodes[0]!.params.assetId = '';
    graph.edges.push({ id: 'bad', source: 'n-export', sourceHandle: 'x', target: 'n-edit', targetHandle: 'image' });
    const msgs = validateGraph(graph).map((i) => i.message).join('\n');
    expect(msgs).toContain('Approval: required input');
    expect(msgs).toContain('Import: choose an asset');
    expect(msgs).toContain('no output');
  });
});

describe('ordering and invalidation', () => {
  it('orders nodes topologically', () => {
    const order = topologicalOrder(g());
    expect(order.indexOf('n-import')).toBeLessThan(order.indexOf('n-edit'));
    expect(order.indexOf('n-edit')).toBeLessThan(order.indexOf('n-approve'));
    expect(order.indexOf('n-approve')).toBeLessThan(order.indexOf('n-export'));
  });
  it('invalidates only the edited node and its descendants, not independent branches', () => {
    const inv = invalidatedBy(g(), 'n-edit');
    expect([...inv].sort()).toEqual(['n-approve', 'n-edit', 'n-export']);
    expect(inv.has('n-import')).toBe(false);
    expect(inv.has('n-gen')).toBe(false);
  });
});

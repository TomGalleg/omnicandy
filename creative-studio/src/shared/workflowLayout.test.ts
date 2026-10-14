import { describe, expect, it } from 'vitest';
import { demoGraph, type WorkflowGraph } from './workflow';
import { autoLayout, LAYOUT_GAP } from './workflowLayout';

describe('autoLayout', () => {
  it('puts each step one column after the steps feeding it', () => {
    const g = demoGraph('asset-1');
    const pos = autoLayout(g);
    expect(Object.keys(pos).sort()).toEqual(g.nodes.map((n) => n.id).sort());
    for (const e of g.edges) expect(pos[e.target]!.x).toBeGreaterThan(pos[e.source]!.x);
  });

  it('stacks steps of one column without overlap and keeps unconnected steps in column 0', () => {
    const g: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: 'a', type: 'import', position: { x: 500, y: 300 }, params: {} },
        { id: 'b', type: 'approval', position: { x: 0, y: 0 }, params: {} },
        { id: 'c', type: 'export', position: { x: 10, y: 50 }, params: {} },
      ],
      edges: [{ id: 'e', source: 'a', sourceHandle: 'image', target: 'c', targetHandle: 'in' }],
    };
    expect(autoLayout(g)).toEqual({ b: { x: 0, y: 0 }, a: { x: 0, y: LAYOUT_GAP.y }, c: { x: LAYOUT_GAP.x, y: 0 } });
  });

  it('survives a cycle', () => {
    const g: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [{ id: 'a', type: 'approval', position: { x: 0, y: 0 }, params: {} }, { id: 'b', type: 'approval', position: { x: 0, y: 0 }, params: {} }],
      edges: [{ id: 'e1', source: 'a', sourceHandle: 'o', target: 'b', targetHandle: 'i' }, { id: 'e2', source: 'b', sourceHandle: 'o', target: 'a', targetHandle: 'i' }],
    };
    expect(Object.keys(autoLayout(g))).toHaveLength(2);
  });
});

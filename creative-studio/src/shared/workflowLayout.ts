import type { WorkflowGraph } from './workflow';

/** Horizontal and vertical distance between laid-out steps, in canvas pixels. */
export const LAYOUT_GAP = { x: 300, y: 240 };

/**
 * Tidy positions for a workflow: each step sits one column right of the furthest step feeding it,
 * steps in the same column are stacked in their current top-to-bottom order. Cycles (never valid)
 * and unconnected steps fall back to column 0.
 */
export function autoLayout(graph: WorkflowGraph): Record<string, { x: number; y: number }> {
  const ids = graph.nodes.map((n) => n.id);
  const inputs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of graph.edges) if (inputs.has(e.target) && inputs.has(e.source)) inputs.get(e.target)!.push(e.source);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = Math.max(-1, ...inputs.get(id)!.map(depthOf)) + 1;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  const columns = new Map<number, typeof graph.nodes>();
  for (const n of graph.nodes) {
    const d = depthOf(n.id);
    columns.set(d, [...(columns.get(d) ?? []), n]);
  }
  const out: Record<string, { x: number; y: number }> = {};
  for (const [d, col] of columns) {
    [...col].sort((a, b) => a.position.y - b.position.y || a.id.localeCompare(b.id))
      .forEach((n, i) => { out[n.id] = { x: d * LAYOUT_GAP.x, y: i * LAYOUT_GAP.y }; });
  }
  return out;
}

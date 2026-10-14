// Typed workflow graph: node catalogue, edge validation, graph validation and invalidation.
// Shape is compatible with React Flow (nodes/edges with handles) but has no UI dependency.

export type PortType = 'image' | 'document';

export type WorkflowNodeType = 'import' | 'aiGenerate' | 'artcraftEdit' | 'approval' | 'export';

export interface PortSpec {
  id: string;
  label: string;
  accepts: PortType[];
  required: boolean;
}

export interface OutputSpec {
  id: string;
  label: string;
  type: PortType;
}

export interface NodeSpec {
  type: WorkflowNodeType;
  label: string;
  description: string;
  inputs: PortSpec[];
  outputs: OutputSpec[];
  defaultParams: Record<string, string>;
}

export const NODE_SPECS: Record<WorkflowNodeType, NodeSpec> = {
  import: {
    type: 'import',
    label: 'Files',
    description: 'Library files to work on (one, several, or a folder); originals stay read-only.',
    inputs: [],
    outputs: [{ id: 'image', label: 'Files', type: 'image' }],
    defaultParams: { mode: 'files', assetIds: '[]', assetId: '', folder: '' },
  },
  aiGenerate: {
    type: 'aiGenerate',
    label: 'AI Generate',
    description: 'Image generation through a configured provider.',
    inputs: [{ id: 'reference', label: 'Reference', accepts: ['image'], required: false }],
    outputs: [{ id: 'image', label: 'Image', type: 'image' }],
    defaultParams: { providerId: 'mock', prompt: '' },
  },
  artcraftEdit: {
    type: 'artcraftEdit',
    label: 'App step',
    description: 'An edit in an ArtCraft app, run in the background (no window); results are new versions.',
    inputs: [{ id: 'image', label: 'Image', accepts: ['image', 'document'], required: true }],
    outputs: [
      { id: 'image', label: 'Image', type: 'image' },
      { id: 'document', label: 'Editable doc', type: 'document' },
    ],
    defaultParams: { appId: 'photocraft', opId: 'blackWhite', values: '{}', command: '', commandParams: '' },
  },
  approval: {
    type: 'approval',
    label: 'Approval',
    description: 'Pauses so you can look at every file and approve or reject them.',
    inputs: [{ id: 'in', label: 'Input', accepts: ['image', 'document'], required: true }],
    outputs: [{ id: 'out', label: 'Approved', type: 'image' }],
    defaultParams: { note: '' },
  },
  export: {
    type: 'export',
    label: 'Export',
    description: 'Writes finished files with Deliver presets into the exports folder.',
    inputs: [{ id: 'in', label: 'Input', accepts: ['image', 'document'], required: true }],
    outputs: [],
    defaultParams: { presets: 'image-jpg' },
  },
};

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  params: Record<string, string>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface WorkflowGraph {
  schemaVersion: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface ConnectionCandidate {
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function isNodeType(v: unknown): v is WorkflowNodeType {
  return typeof v === 'string' && v in NODE_SPECS;
}

function wouldCreateCycle(graph: WorkflowGraph, source: string, target: string): boolean {
  // Adding source -> target creates a cycle if source is reachable from target.
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n === source) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const e of graph.edges) if (e.source === n) stack.push(e.target);
  }
  return false;
}

export function validateConnection(graph: WorkflowGraph, c: ConnectionCandidate): ValidationResult {
  if (c.source === c.target) return { ok: false, reason: 'A node cannot connect to itself.' };
  const src = graph.nodes.find((n) => n.id === c.source);
  const tgt = graph.nodes.find((n) => n.id === c.target);
  if (!src || !tgt) return { ok: false, reason: 'Unknown node.' };
  const out = NODE_SPECS[src.type].outputs.find((o) => o.id === c.sourceHandle);
  if (!out) return { ok: false, reason: `${NODE_SPECS[src.type].label} has no output "${c.sourceHandle}".` };
  const inp = NODE_SPECS[tgt.type].inputs.find((i) => i.id === c.targetHandle);
  if (!inp) return { ok: false, reason: `${NODE_SPECS[tgt.type].label} has no input "${c.targetHandle}".` };
  if (!inp.accepts.includes(out.type)) {
    return { ok: false, reason: `${inp.label} accepts ${inp.accepts.join('/')}, not ${out.type}.` };
  }
  if (graph.edges.some((e) => e.target === c.target && e.targetHandle === c.targetHandle)) {
    return { ok: false, reason: `${inp.label} is already connected.` };
  }
  if (wouldCreateCycle(graph, c.source, c.target)) return { ok: false, reason: 'That connection would create a cycle.' };
  return { ok: true };
}

export interface GraphIssue {
  nodeId?: string;
  edgeId?: string;
  message: string;
}

/** Whole-graph validation run before execution and after loading untrusted JSON. */
export function validateGraph(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (ids.has(n.id)) issues.push({ nodeId: n.id, message: 'Duplicate node id.' });
    ids.add(n.id);
    if (!isNodeType(n.type)) issues.push({ nodeId: n.id, message: `Unknown node type "${String(n.type)}".` });
  }
  // Re-validate every edge against the graph without itself, so duplicates/cycles are caught.
  graph.edges.forEach((e, i) => {
    const rest: WorkflowGraph = { ...graph, edges: graph.edges.slice(0, i) };
    const r = validateConnection(rest, e);
    if (!r.ok) issues.push({ edgeId: e.id, message: r.reason });
  });
  for (const n of graph.nodes) {
    if (!isNodeType(n.type)) continue;
    for (const inp of NODE_SPECS[n.type].inputs) {
      if (inp.required && !graph.edges.some((e) => e.target === n.id && e.targetHandle === inp.id)) {
        issues.push({ nodeId: n.id, message: `${NODE_SPECS[n.type].label}: required input "${inp.label}" is not connected.` });
      }
    }
    if (n.type === 'import' && (n.params.mode === 'folder' ? !n.params.folder : !n.params.assetId && !/"[^"]+"/.test(n.params.assetIds ?? ''))) {
      issues.push({ nodeId: n.id, message: n.params.mode === 'folder' ? 'Files: choose a folder.' : 'Files: choose at least one file.' });
    }
    if (n.type === 'artcraftEdit' && !n.params.opId && !n.params.command) issues.push({ nodeId: n.id, message: 'App step: choose an edit.' });
  }
  return issues;
}

/** Kahn topological order; throws on cycles (validateGraph should run first). */
export function topologicalOrder(graph: WorkflowGraph): string[] {
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = graph.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of graph.edges) {
      if (e.source !== id) continue;
      const d = (indeg.get(e.target) ?? 0) - 1;
      indeg.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  if (order.length !== graph.nodes.length) throw new Error('Graph contains a cycle.');
  return order;
}

/** Nodes whose cached outputs become stale when `changedNodeId` changes: the node and its descendants only. */
export function invalidatedBy(graph: WorkflowGraph, changedNodeId: string): Set<string> {
  const out = new Set<string>([changedNodeId]);
  const stack = [changedNodeId];
  while (stack.length) {
    const n = stack.pop()!;
    for (const e of graph.edges) {
      if (e.source === n && !out.has(e.target)) {
        out.add(e.target);
        stack.push(e.target);
      }
    }
  }
  return out;
}

export type NodeRunStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export type WorkflowRunEvent =
  | { kind: 'run-started'; runId: string; mock: boolean }
  | { kind: 'node-status'; runId: string; nodeId: string; status: NodeRunStatus; message?: string; outputRef?: string }
  /** The files this run works on (a batch), in order. */
  | { kind: 'run-items'; runId: string; names: string[] }
  /** One file at one step. */
  /** An Approval step is waiting: these files (with their latest version) need your decision. */
  | { kind: 'approval-request'; runId: string; nodeId: string; note: string; items: Array<{ item: number; name: string; assetId: string }> }
  | { kind: 'item-status'; runId: string; nodeId: string; item: number; name: string; status: NodeRunStatus; message?: string; assetId?: string }
  /** The run reached a pause point (or continued): it waits between steps, never in the middle of one. */
  | { kind: 'run-paused'; runId: string; paused: boolean }
  | { kind: 'run-finished'; runId: string; ok: boolean; cancelled: boolean };

export function emptyGraph(): WorkflowGraph {
  return { schemaVersion: 1, nodes: [], edges: [] };
}

/** Starter graph for a new project: Files → App step → Approval → Export, plus an AI branch. */
export function demoGraph(assetId: string): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'n-import', type: 'import', position: { x: 0, y: 80 }, params: { assetId } },
      { id: 'n-gen', type: 'aiGenerate', position: { x: 0, y: 340 }, params: { providerId: 'mock', prompt: 'Warm sunset variation' } },
      { id: 'n-edit', type: 'artcraftEdit', position: { x: 280, y: 80 }, params: { appId: 'photocraft', opId: 'warm', values: '{}', command: '', commandParams: '' } },
      { id: 'n-approve', type: 'approval', position: { x: 560, y: 80 }, params: { note: 'Check colour balance' } },
      { id: 'n-export', type: 'export', position: { x: 840, y: 80 }, params: { presets: 'image-png' } },
    ],
    edges: [
      { id: 'e1', source: 'n-import', sourceHandle: 'image', target: 'n-edit', targetHandle: 'image' },
      { id: 'e2', source: 'n-edit', sourceHandle: 'image', target: 'n-approve', targetHandle: 'in' },
      { id: 'e3', source: 'n-approve', sourceHandle: 'out', target: 'n-export', targetHandle: 'in' },
    ],
  };
}

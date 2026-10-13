import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge, applyEdgeChanges, applyNodeChanges, Background, Controls, Handle, MiniMap, Position, ReactFlow,
  type Connection, type Edge, type EdgeChange, type IsValidConnection, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import type { ProjectManifest } from '@shared/types';
import {
  NODE_SPECS, validateConnection, validateGraph, type NodeRunStatus, type WorkflowGraph, type WorkflowNodeType,
} from '@shared/workflow';

type StudioNodeData = {
  kind: WorkflowNodeType;
  params: Record<string, string>;
  status?: NodeRunStatus;
  message?: string;
  assetName?: string;
  onApprove?: (approved: boolean) => void;
};
type StudioNode = Node<StudioNodeData, 'studio'>;

const toGraph = (nodes: StudioNode[], edges: Edge[]): WorkflowGraph => ({
  schemaVersion: 1,
  nodes: nodes.map((n) => ({ id: n.id, type: n.data.kind, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, params: n.data.params })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? '', target: e.target, targetHandle: e.targetHandle ?? '' })),
});

function StudioNodeView({ data, selected }: NodeProps<StudioNode>) {
  const spec = NODE_SPECS[data.kind];
  const mock = data.kind === 'aiGenerate' || data.kind === 'artcraftEdit' || data.kind === 'export';
  return (
    <div className={`node${selected ? ' selected' : ''}`}>
      <div className="node-head">
        <span>{spec.label} {mock && <span className="badge-mock">MOCK</span>}</span>
        <span className={`node-status ${data.status ?? 'idle'}`}>{(data.status ?? 'idle').replace('_', ' ')}</span>
      </div>
      <div className="node-body">
        {data.kind === 'import' && <span>{data.assetName ?? 'No asset chosen'}</span>}
        {data.kind === 'aiGenerate' && <span>“{data.params.prompt || 'No prompt'}” · {data.params.providerId}</span>}
        {data.kind === 'artcraftEdit' && <span>{data.params.appId} · <code>{data.params.command}</code></span>}
        {data.kind === 'approval' && <span>{data.params.note || 'Review gate'}</span>}
        {data.kind === 'export' && <span>Format: {data.params.format}</span>}
        {data.message && <small>{data.message}</small>}
      </div>
      <div className="node-ports">
        <span>{spec.inputs.map((i) => i.label).join(' · ')}</span>
        <span>{spec.outputs.map((o) => o.label).join(' · ')}</span>
      </div>
      {data.status === 'awaiting_approval' && data.onApprove && (
        <div className="node-approve">
          <button className="btn small primary nodrag" onClick={() => data.onApprove!(true)}>Approve</button>
          <button className="btn small danger nodrag" onClick={() => data.onApprove!(false)}>Reject</button>
        </div>
      )}
      {spec.inputs.map((inp, i) => (
        <Handle key={inp.id} id={inp.id} type="target" position={Position.Left} className={`port-${inp.accepts[0]}`}
          style={{ top: 22 + i * 18 }} title={`${inp.label}: accepts ${inp.accepts.join('/')}${inp.required ? ' (required)' : ''}`} />
      ))}
      {spec.outputs.map((out, i) => (
        <Handle key={out.id} id={out.id} type="source" position={Position.Right} className={`port-${out.type}`}
          style={{ top: 22 + i * 18 }} title={`${out.label}: ${out.type}`} />
      ))}
    </div>
  );
}

const nodeTypes = { studio: StudioNodeView };

interface Props {
  manifest: ProjectManifest | null;
  colorMode: 'dark' | 'light';
  log: (source: string, msg: string) => void;
}

export function WorkflowEditor({ manifest, colorMode, log }: Props) {
  const [nodes, setNodes] = useState<StudioNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const assetName = useCallback((id: string) => manifest?.assets.find((a) => a.id === id)?.name, [manifest]);

  useEffect(() => {
    void window.studio.loadWorkflow().then((g) => {
      setNodes(g.nodes.map((n) => ({ id: n.id, type: 'studio', position: n.position, data: { kind: n.type, params: n.params } })));
      setEdges(g.edges.map((e) => ({ ...e })));
      setLoaded(true);
    });
  }, []);

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);

  // Debounced autosave of structure/positions (run status is not persisted).
  const structureKey = JSON.stringify(graph);
  useEffect(() => {
    if (!loaded) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      window.studio.saveWorkflow(graph).catch((e: unknown) => setMessage({ text: `Save failed: ${String(e)}`, error: true }));
    }, 400);
    return () => clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, loaded]);

  useEffect(() => window.studio.onWorkflowEvent((ev) => {
    if (ev.kind === 'run-started') log('workflow', `Run ${ev.runId} started${ev.mock ? ' (MOCK executor)' : ''}.`);
    if (ev.kind === 'run-finished') {
      const outcome = ev.cancelled ? 'cancelled' : ev.ok ? 'completed' : 'stopped';
      log('workflow', `Run ${ev.runId} ${outcome}.`);
      setMessage({ text: `MOCK run ${outcome}. No paid calls were made and no files were written.`, error: !ev.ok && !ev.cancelled });
      setRunning(false);
    }
    if (ev.kind === 'node-status') {
      if (ev.message) log('workflow', `${ev.nodeId}: ${ev.status}. ${ev.message}`);
      setNodes((ns) => ns.map((n) => n.id === ev.nodeId ? {
        ...n,
        data: {
          ...n.data,
          status: ev.status,
          message: ev.message,
          onApprove: ev.status === 'awaiting_approval' ? (ok: boolean) => void window.studio.answerApproval(ev.nodeId, ok) : undefined,
        },
      } : n));
    }
  }), [log]);

  const decorated = useMemo(() => nodes.map((n) => n.data.kind === 'import' ? { ...n, data: { ...n.data, assetName: assetName(n.data.params.assetId ?? '') } } : n), [nodes, assetName]);

  const onNodesChange = useCallback((c: NodeChange<StudioNode>[]) => setNodes((ns) => applyNodeChanges(c, ns)), []);
  const onEdgesChange = useCallback((c: EdgeChange[]) => setEdges((es) => applyEdgeChanges(c, es)), []);

  const isValidConnection: IsValidConnection = useCallback((c) =>
    validateConnection(graph, { source: c.source, sourceHandle: c.sourceHandle ?? null, target: c.target, targetHandle: c.targetHandle ?? null }).ok, [graph]);

  const onConnect = useCallback((c: Connection) => {
    const r = validateConnection(graph, c);
    if (!r.ok) { setMessage({ text: r.reason, error: true }); return; }
    setEdges((es) => addEdge({ ...c, id: `e-${crypto.randomUUID().slice(0, 8)}` }, es));
    setMessage(null);
  }, [graph]);

  const addNode = (kind: WorkflowNodeType) => {
    const id = `n-${crypto.randomUUID().slice(0, 8)}`;
    const params = { ...NODE_SPECS[kind].defaultParams };
    if (kind === 'import') params.assetId = manifest?.assets.find((a) => a.kind === 'image')?.id ?? '';
    setNodes((ns) => [...ns, { id, type: 'studio', position: { x: 80 + ns.length * 30, y: 380 + ns.length * 20 }, data: { kind, params } }]);
  };

  const run = async () => {
    const issues = validateGraph(graph);
    if (issues.length) { setMessage({ text: issues.map((i) => i.message).join(' · '), error: true }); return; }
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: 'idle', message: undefined } })));
    setMessage({ text: 'Running with the MOCK executor: no paid calls, no files written, no app driven.' });
    setRunning(true);
    try { await window.studio.runWorkflow(graph); } catch (e) { setMessage({ text: String(e), error: true }); setRunning(false); }
  };

  const issues = validateGraph(graph);

  return (
    <div className="wf">
      <div className="wf-toolbar">
        {(Object.keys(NODE_SPECS) as WorkflowNodeType[]).map((k) => (
          <button key={k} className="btn small" onClick={() => addNode(k)} disabled={running}>+ {NODE_SPECS[k].label}</button>
        ))}
        <span className="spacer" />
        <span className={`wf-msg${message?.error ? ' error' : ''}`} role="status">
          {message?.text ?? (issues.length ? `${issues.length} issue${issues.length > 1 ? 's' : ''}: ${issues[0]!.message}` : 'Graph valid · autosaved')}
        </span>
        {running
          ? <button className="btn small danger" onClick={() => void window.studio.cancelWorkflow()}>Cancel run</button>
          : <button className="btn small primary" onClick={() => void run()} disabled={!nodes.length}>Run demo <span className="badge-mock">MOCK</span></button>}
      </div>
      <div className="wf-canvas">
        <ReactFlow<StudioNode>
          nodes={decorated}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          colorMode={colorMode}
          fitView
          deleteKeyCode={['Delete', 'Backspace']}
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={18} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge, applyEdgeChanges, applyNodeChanges, Background, Controls, Handle, MiniMap, Position, ReactFlow,
  type Connection, type Edge, type EdgeChange, type IsValidConnection, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import type { IntegrationSnapshot } from '@shared/ipc';
import { checkPhotoCraftOp, PHOTOCRAFT_PRESETS, presetLabel } from '@shared/photocraftOps';
import type { Asset, ProjectManifest } from '@shared/types';
import {
  NODE_SPECS, validateConnection, validateGraph, type NodeRunStatus, type WorkflowGraph, type WorkflowNodeType,
} from '@shared/workflow';

type StudioNodeData = {
  kind: WorkflowNodeType;
  params: Record<string, string>;
  status?: NodeRunStatus;
  message?: string;
  outputRef?: string;
  // Derived for display only (not persisted):
  assetName?: string;
  mock?: boolean;
  previewAssetId?: string;
  onApprove?: (approved: boolean) => void;
};
type StudioNode = Node<StudioNodeData, 'studio'>;

const toGraph = (nodes: StudioNode[], edges: Edge[]): WorkflowGraph => ({
  schemaVersion: 1,
  nodes: nodes.map((n) => ({ id: n.id, type: n.data.kind, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, params: n.data.params })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? '', target: e.target, targetHandle: e.targetHandle ?? '' })),
});

/** The viewable image for an asset: itself if raster/vector, else its derived PNG (PhotoCraft writes one per version). */
function previewFor(assets: Asset[], assetId: string | undefined): string | undefined {
  if (!assetId) return undefined;
  const a = assets.find((x) => x.id === assetId);
  if (!a) return undefined;
  if (a.kind === 'image' || a.kind === 'vector') return a.id;
  return assets.find((x) => x.parentId === a.id && x.kind === 'image')?.id;
}

function StudioNodeView({ data, selected }: NodeProps<StudioNode>) {
  const spec = NODE_SPECS[data.kind];
  return (
    <div className={`node${selected ? ' selected' : ''}`}>
      <div className="node-head">
        <span>{spec.label} {data.mock && <span className="badge-mock">MOCK</span>}</span>
        <span className={`node-status ${data.status ?? 'idle'}`}>{(data.status ?? 'idle').replace('_', ' ')}</span>
      </div>
      <div className="node-body">
        {data.kind === 'import' && <span>{data.assetName ?? 'No asset chosen'}</span>}
        {data.kind === 'aiGenerate' && <span>“{data.params.prompt || 'No prompt'}” · {data.params.providerId}</span>}
        {data.kind === 'artcraftEdit' && <span>PhotoCraft · {presetLabel(data.params.command ?? '')}</span>}
        {data.kind === 'approval' && <span>{data.params.note || 'Review gate'}</span>}
        {data.kind === 'export' && <span>Format: {data.params.format}</span>}
        {data.previewAssetId && <img className="node-preview" src={window.studio.assetUrl(data.previewAssetId)} alt="" draggable={false} />}
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
  integrations: IntegrationSnapshot | null;
  colorMode: 'dark' | 'light';
  log: (source: string, msg: string) => void;
  onProjectChanged: () => void;
}

export function WorkflowEditor({ manifest, integrations, colorMode, log, onProjectChanged }: Props) {
  const [nodes, setNodes] = useState<StudioNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const assets = useMemo(() => manifest?.assets ?? [], [manifest]);
  const photocraftReal = integrations?.appAdapters.some((a) => a.id === 'photocraft' && !a.isMock) ?? false;
  const isMockNode = useCallback((kind: WorkflowNodeType) =>
    kind === 'aiGenerate' || (kind === 'artcraftEdit' && !photocraftReal) || (kind === 'export' && !integrations?.realExport),
  [photocraftReal, integrations]);

  useEffect(() => {
    void window.studio.loadWorkflow().then((g) => {
      setNodes(g.nodes.map((n) => ({ id: n.id, type: 'studio', position: n.position, data: { kind: n.type, params: n.params } })));
      setEdges(g.edges.map((e) => ({ ...e })));
      setLoaded(true);
    });
  }, []);

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);

  // Debounced autosave of structure/params/positions (run status is not persisted).
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
    if (ev.kind === 'run-started') log('workflow', `Run ${ev.runId} started${ev.mock ? ' (some steps are MOCK)' : ''}.`);
    if (ev.kind === 'run-finished') {
      const outcome = ev.cancelled ? 'cancelled' : ev.ok ? 'completed' : 'stopped';
      log('workflow', `Run ${ev.runId} ${outcome}.`);
      setMessage({ text: `Run ${outcome}.${ev.ok ? ' New versions are in the media library.' : ''}`, error: !ev.ok && !ev.cancelled });
      setRunning(false);
      onProjectChanged();
    }
    if (ev.kind === 'node-status') {
      if (ev.message) log('workflow', `${ev.nodeId}: ${ev.status}. ${ev.message}`);
      setNodes((ns) => ns.map((n) => n.id === ev.nodeId ? {
        ...n,
        data: {
          ...n.data,
          status: ev.status,
          message: ev.message,
          outputRef: ev.outputRef ?? (ev.status === 'queued' ? undefined : n.data.outputRef),
          onApprove: ev.status === 'awaiting_approval' ? (ok: boolean) => void window.studio.answerApproval(ev.nodeId, ok) : undefined,
        },
      } : n));
    }
  }), [log, onProjectChanged]);

  const decorated = useMemo(() => nodes.map((n) => {
    const out = n.data.outputRef?.startsWith('asset:') ? n.data.outputRef.slice(6) : undefined;
    return {
      ...n,
      data: {
        ...n.data,
        mock: isMockNode(n.data.kind),
        assetName: n.data.kind === 'import' ? assets.find((a) => a.id === n.data.params.assetId)?.name : undefined,
        previewAssetId: n.data.kind === 'import' ? previewFor(assets, n.data.params.assetId) : n.data.kind === 'artcraftEdit' ? previewFor(assets, out) : undefined,
      },
    };
  }), [nodes, assets, isMockNode]);

  const selectedNode = nodes.find((n) => n.selected) ?? null;
  const updateParams = (id: string, patch: Record<string, string>) =>
    setNodes((ns) => ns.map((n) => n.id === id ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } } : n));

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
    if (kind === 'import') params.assetId = assets.find((a) => a.kind === 'image')?.id ?? '';
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id, type: 'studio', selected: true, position: { x: 80 + ns.length * 30, y: 380 + ns.length * 20 }, data: { kind, params } }]);
  };

  // Validation the runner will apply, surfaced before running.
  const opIssues = nodes.flatMap((n) => {
    if (n.data.kind !== 'artcraftEdit') return [];
    const r = checkPhotoCraftOp(n.data.params.command ?? '', n.data.params.commandParams ?? '{}');
    return r.ok ? [] : [`ArtCraft Edit: ${r.reason}`];
  });
  const issues = [...validateGraph(graph).map((i) => i.message), ...opIssues];

  const run = async () => {
    if (issues.length) { setMessage({ text: issues.join(' · '), error: true }); return; }
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: 'idle', message: undefined, outputRef: undefined } })));
    setMessage({ text: photocraftReal ? 'Running: PhotoCraft edits are real and add new versions; originals are untouched.' : 'Running with MOCK steps only.' });
    setRunning(true);
    try { await window.studio.runWorkflow(graph); } catch (e) { setMessage({ text: String(e), error: true }); setRunning(false); }
  };

  const anyMock = nodes.some((n) => isMockNode(n.data.kind));

  return (
    <div className="wf">
      <div className="wf-toolbar">
        {(Object.keys(NODE_SPECS) as WorkflowNodeType[]).map((k) => (
          <button key={k} className="btn small" onClick={() => addNode(k)} disabled={running}>+ {NODE_SPECS[k].label}</button>
        ))}
        <span className="spacer" />
        <span className={`wf-msg${message?.error ? ' error' : ''}`} role="status">
          {message?.text ?? (issues.length ? `${issues.length} issue${issues.length > 1 ? 's' : ''}: ${issues[0]}` : 'Graph valid · autosaved')}
        </span>
        {running
          ? <button className="btn small danger" onClick={() => void window.studio.cancelWorkflow()}>Cancel run</button>
          : <button className="btn small primary" onClick={() => void run()} disabled={!nodes.length}>Run {anyMock && <span className="badge-mock">PARTLY MOCK</span>}</button>}
      </div>
      <div className="wf-body">
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
            deleteKeyCode={['Delete']}
          >
            <Background gap={18} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
        {selectedNode && (
          <NodeInspector key={selectedNode.id} node={selectedNode} assets={assets} disabled={running} mock={isMockNode(selectedNode.data.kind)}
            onChange={(patch) => updateParams(selectedNode.id, patch)} />
        )}
      </div>
    </div>
  );
}

function NodeInspector({ node, assets, disabled, mock, onChange }: {
  node: StudioNode; assets: Asset[]; disabled: boolean; mock: boolean; onChange: (patch: Record<string, string>) => void;
}) {
  const p = node.data.params;
  const [paramsText, setParamsText] = useState(p.commandParams ?? '{}');
  const check = node.data.kind === 'artcraftEdit' ? checkPhotoCraftOp(p.command ?? '', paramsText) : null;
  const isPreset = PHOTOCRAFT_PRESETS.some((x) => x.id === p.command);
  const editable = assets.filter((a) => a.kind === 'image' || a.kind === 'vector' || a.sourceFormat === 'pcraft' || a.sourceFormat === 'psd');

  return (
    <aside className="wf-inspector" aria-label="Node settings">
      <div className="pane-header">{NODE_SPECS[node.data.kind].label} settings {mock && <span className="badge-mock">MOCK</span>}</div>
      <div className="wf-inspector-body">
        {node.data.kind === 'import' && (
          <label className="field">Asset
            <select value={p.assetId ?? ''} disabled={disabled} onChange={(e) => onChange({ assetId: e.target.value })}>
              <option value="">Choose…</option>
              {editable.map((a) => <option key={a.id} value={a.id}>{a.name}{a.parentId ? ' (version)' : ''}</option>)}
            </select>
          </label>
        )}

        {node.data.kind === 'artcraftEdit' && (
          <>
            <label className="field">App
              <select value="photocraft" disabled><option value="photocraft">PhotoCraft</option></select>
            </label>
            <label className="field">Operation
              <select value={isPreset ? p.command : '__custom'} disabled={disabled} onChange={(e) => {
                if (e.target.value === '__custom') { onChange({ command: '' }); return; }
                const preset = PHOTOCRAFT_PRESETS.find((x) => x.id === e.target.value)!;
                const text = JSON.stringify(preset.params);
                setParamsText(text);
                onChange({ command: preset.id, commandParams: text });
              }}>
                {PHOTOCRAFT_PRESETS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                <option value="__custom">Other PhotoCraft command…</option>
              </select>
            </label>
            {!isPreset && (
              <label className="field">Command id
                <input value={p.command ?? ''} disabled={disabled} placeholder="e.g. filter.blur.motionBlur" spellCheck={false} onChange={(e) => onChange({ command: e.target.value.trim() })} />
              </label>
            )}
            <label className="field">Parameters (JSON)
              <textarea className="mono" value={paramsText} disabled={disabled} spellCheck={false} onChange={(e) => {
                setParamsText(e.target.value);
                onChange({ commandParams: e.target.value });
              }} />
            </label>
            <small className={check?.ok ? 'asset-meta' : 'wf-msg error'}>
              {check?.ok
                ? 'Allowed. PhotoCraft checks value ranges when it runs.'
                : check?.reason}
            </small>
            <small className="asset-meta">Only adjustments, filters, rotations and fills are allowed: no commands that open, save or reference other files. Vector inputs (SVG) are flattened first.</small>
          </>
        )}

        {node.data.kind === 'approval' && (
          <label className="field">What to check
            <input value={p.note ?? ''} disabled={disabled} onChange={(e) => onChange({ note: e.target.value })} />
          </label>
        )}

        {node.data.kind === 'export' && (
          <label className="field">Format
            <select value={p.format ?? 'png'} disabled={disabled} onChange={(e) => onChange({ format: e.target.value })}>
              {['png', 'jpg', 'webp', 'tif', 'psd', 'pcraft'].map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </select>
            <small className="asset-meta">Written to the project's exports folder by PhotoCraft.</small>
          </label>
        )}

        {node.data.kind === 'aiGenerate' && (
          <>
            <label className="field">Prompt
              <textarea value={p.prompt ?? ''} disabled={disabled} onChange={(e) => onChange({ prompt: e.target.value })} />
            </label>
            <small className="asset-meta">Only the MOCK provider exists: nothing is generated, no network call, $0.</small>
          </>
        )}
        <small className="asset-meta">Delete key removes the selected node or connection.</small>
      </div>
    </aside>
  );
}

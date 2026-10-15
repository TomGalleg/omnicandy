import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge, applyEdgeChanges, applyNodeChanges, Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow,
  type Connection, type Edge, type EdgeChange, type IsValidConnection, type Node, type NodeChange, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react';
import { EDITOR_APPS, type EditorAppId, type QuickEdit } from '@shared/appEditors';
import { DELIVER_PRESETS, type DeliverGroup } from '@shared/deliver';
import type { IntegrationSnapshot } from '@shared/ipc';
import { checkPhotoCraftOp, PHOTOCRAFT_PRESETS, presetLabel } from '@shared/photocraftOps';
import type { Asset, ProjectManifest } from '@shared/types';
import {
  NODE_SPECS, validateConnection, validateGraph, type NodeRunStatus, type WorkflowGraph, type WorkflowNodeType,
} from '@shared/workflow';
import { autoLayout } from '@shared/workflowLayout';
import type { RunSnapshot, WorkflowTemplate } from '@shared/workflowControl';
import type { WorkflowPlan } from '@shared/workflowPlan';
import { exportPresetsOf, importAssetIds } from '@shared/workflowRunner';
import { AssetThumb } from './AssetBrowser';

type StudioNodeData = {
  kind: WorkflowNodeType;
  params: Record<string, string>;
  status?: NodeRunStatus;
  message?: string;
  outputRef?: string;
  // Derived for display only (not persisted):
  summary?: string;
  mock?: boolean;
  previewAssetId?: string;
  onApprove?: (approved: boolean) => void;
  /** The result of this step is approved by the user (kept as is by reruns). */
  approvedOut?: boolean;
  /** The step would run again with the next rerun. */
  stale?: boolean;
};
type StudioNode = Node<StudioNodeData, 'studio'>;

const APP_IDS = Object.keys(EDITOR_APPS) as EditorAppId[];
const STATUS_LABEL: Record<NodeRunStatus, string> = {
  idle: 'ready', queued: 'waiting', running: 'running', awaiting_approval: 'needs you', completed: 'done', failed: 'failed', blocked: 'blocked', cancelled: 'cancelled',
};
const edgeStyle = { strokeWidth: 2 };
const edgeMarker = { type: MarkerType.ArrowClosed, width: 16, height: 16 };

const readKey = (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } };
const writeKey = (k: string, v: string) => { try { window.localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
const GROUP_LABEL: Record<DeliverGroup, string> = { image: 'Pictures', vector: 'Vector art', audio: 'Audio', video: 'Video', design: 'Layouts', document: 'Documents', pdf: 'PDF', sheet: 'Spreadsheets', deck: 'Presentations', ui: 'UI designs' };

const toGraph = (nodes: StudioNode[], edges: Edge[]): WorkflowGraph => ({
  schemaVersion: 1,
  nodes: nodes.map((n) => ({ id: n.id, type: n.data.kind, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, params: n.data.params })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? '', target: e.target, targetHandle: e.targetHandle ?? '' })),
});

/** The viewable image for an asset: itself if raster/vector, else its derived PNG (PhotoCraft/DesignCraft write one per version). */
function previewFor(assets: Asset[], assetId: string | undefined): string | undefined {
  if (!assetId) return undefined;
  const a = assets.find((x) => x.id === assetId);
  if (!a) return undefined;
  if (a.kind === 'image' || a.kind === 'vector') return a.id;
  return assets.find((x) => x.parentId === a.id && x.kind === 'image')?.id;
}

const stepOp = (p: Record<string, string>): QuickEdit | undefined => EDITOR_APPS[p.appId as EditorAppId]?.quickEdits.find((o) => o.id === p.opId);

/** One line describing what a node does, for the canvas. */
function summarize(kind: WorkflowNodeType, p: Record<string, string>, assets: Asset[]): string {
  switch (kind) {
    case 'import': {
      if (p.mode === 'folder') return p.folder ? `Folder: ${p.folder.split(/[\\/]/).pop()}` : 'No folder chosen';
      const ids = importAssetIds(p);
      if (!ids.length) return 'No files chosen';
      const first = assets.find((a) => a.id === ids[0])?.name ?? 'missing file';
      return ids.length === 1 ? first : `${ids.length} files (${first}, …)`;
    }
    case 'artcraftEdit': {
      const app = EDITOR_APPS[p.appId as EditorAppId];
      if (!p.opId) return `PhotoCraft · ${presetLabel(p.command ?? '')}`;
      return `${app?.name ?? p.appId} · ${stepOp(p)?.label ?? p.opId}`;
    }
    case 'export': {
      const ps = exportPresetsOf(p).map((id) => DELIVER_PRESETS.find((x) => x.id === id)?.label ?? id);
      return ps.length ? ps.join(', ') : 'No format chosen';
    }
    case 'approval': return p.note || 'Review gate';
    case 'aiGenerate': return `“${p.prompt || 'No prompt'}” · ${p.providerId}`;
  }
}

function StudioNodeView({ data, selected }: NodeProps<StudioNode>) {
  const spec = NODE_SPECS[data.kind];
  return (
    <div className={`node${selected ? ' selected' : ''} is-${data.status ?? 'idle'}${data.stale ? ' stale' : ''}`} aria-current={data.status === 'running' ? 'step' : undefined}>
      <div className="node-head">
        <span>{spec.label} {data.mock && <span className="badge-mock">MOCK</span>}{data.approvedOut && <span className="badge-ok" title="You approved this result. Reruns keep it and do not ask again.">approved</span>}{data.stale && <span className="badge-stale" title="Changed since the last run: it runs again with the next rerun.">will rerun</span>}</span>
        <span className={`node-status ${data.status ?? 'idle'}`}>{STATUS_LABEL[data.status ?? 'idle'] ?? data.status}</span>
      </div>
      <div className="node-body">
        <span>{data.summary}</span>
        {data.previewAssetId && <img className="node-preview" src={window.studio.assetUrl(data.previewAssetId)} alt="" draggable={false} />}
        {data.message && <small>{data.message}</small>}
      </div>
      <div className="node-ports">
        <span>{spec.inputs.map((i) => i.label).join(' · ')}</span>
        <span>{spec.outputs.map((o) => o.label).join(' · ')}</span>
      </div>
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

interface RunFiles { names: string[]; cells: Record<string, Record<number, { status: NodeRunStatus; message?: string }>> }
interface Approval { nodeId: string; note: string; items: Array<{ item: number; name: string; assetId: string }> }

export function WorkflowEditor({ manifest, integrations, colorMode, log, onProjectChanged }: Props) {
  const [nodes, setNodes] = useState<StudioNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const [files, setFiles] = useState<RunFiles | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [plan, setPlan] = useState<WorkflowPlan | null>(null);
  // Run control shared with Claude: the run as the engine reports it, what a rerun would redo, versions and templates.
  const [runState, setRunState] = useState<RunSnapshot | null>(null);
  const [aff, setAff] = useState<{ hasRun: boolean; affected: string[]; templateReady: boolean }>({ hasRun: false, affected: [], templateReady: false });
  const [panel, setPanel] = useState<null | 'versions' | 'templates'>(null);
  const [versions, setVersions] = useState<Array<{ id: string; savedAt: string; reason: string; steps: number }>>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [tplName, setTplName] = useState('');
  const runPromise = useRef<Promise<unknown> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [flow, setFlow] = useState<ReactFlowInstance<StudioNode> | null>(null);
  // Panels that can fold away to give the graph room; remembered.
  const [showSettings, setShowSettings] = useState(() => readKey('cs-wf-settings') !== '0');
  const [showFiles, setShowFiles] = useState(() => readKey('cs-wf-files') !== '0');
  const [showMap, setShowMap] = useState(() => readKey('cs-wf-map') === '1');
  useEffect(() => { writeKey('cs-wf-settings', showSettings ? '1' : '0'); writeKey('cs-wf-files', showFiles ? '1' : '0'); writeKey('cs-wf-map', showMap ? '1' : '0'); }, [showSettings, showFiles, showMap]);
  // Readable names for log lines (the runner reports node ids).
  const names = useRef<Record<string, string>>({});

  const assets = useMemo(() => manifest?.assets ?? [], [manifest]);
  const photocraftReal = integrations?.appAdapters.some((a) => a.id === 'photocraft' && !a.isMock) ?? false;
  const isMockNode = useCallback((kind: WorkflowNodeType, p: Record<string, string>) =>
    (kind === 'aiGenerate' && (!p.modelId || p.providerId === 'mock')) || (kind === 'artcraftEdit' && !p.opId && !photocraftReal),
  [photocraftReal]);

  useEffect(() => {
    void window.studio.loadWorkflow().then((g) => {
      setNodes(g.nodes.map((n) => ({ id: n.id, type: 'studio', position: n.position, data: { kind: n.type, params: n.params } })));
      setEdges(g.edges.map((e) => ({ ...e })));
      setLoaded(true);
    });
  }, []);

  // Claude's proposed workflow: shown for a decision; nothing changes until the user applies it.
  useEffect(() => {
    void window.studio.getWorkflowPlan().then(setPlan);
    return window.studio.onWorkflowPlan(setPlan);
  }, []);
  const applyPlan = () => {
    clearTimeout(saveTimer.current);
    window.studio.applyWorkflowPlan().then((g) => {
      setNodes(g.nodes.map((n) => ({ id: n.id, type: 'studio', position: n.position, data: { kind: n.type, params: n.params } })));
      setEdges(g.edges.map((e) => ({ ...e })));
      setFiles(null);
      setMessage({ text: "Claude's workflow is in place. Your previous workflow, if any, was kept as a backup in the project's Workflows folder." });
      setTimeout(() => flow?.fitView({ padding: 0.2 }), 50);
    }).catch((e: unknown) => setMessage({ text: String(e instanceof Error ? e.message : e), error: true }));
  };

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const loadGraph = useCallback((g: WorkflowGraph) => {
    clearTimeout(saveTimer.current);
    setNodes(g.nodes.map((n) => ({ id: n.id, type: 'studio', position: n.position, data: { kind: n.type, params: n.params } })));
    setEdges(g.edges.map((e) => ({ ...e })));
    setFiles(null);
    setTimeout(() => flow?.fitView({ padding: 0.2 }), 50);
  }, [flow]);
  const refreshRun = useCallback(() => { void window.studio.workflowRunState().then(setRunState); }, []);
  useEffect(() => { refreshRun(); }, [refreshRun]);
  // Claude (or a restored version) changed the saved workflow: show it.
  useEffect(() => window.studio.onWorkflowChanged((g) => { loadGraph(g); setMessage({ text: 'The workflow was changed (by Claude or by restoring a version). Your previous workflow is kept under Versions.' }); }), [loadGraph]);
  const busy = running || (!!runState && ['running', 'paused', 'waiting-for-you'].includes(runState.state));
  const paused = runState?.state === 'paused';
  const control = runState?.control ?? 'claude';

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
    if (ev.kind === 'run-started') {
      log('workflow', `Run ${ev.runId} started${ev.mock ? ' (some steps are MOCK)' : ''}.`);
      setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: 'idle', message: undefined, outputRef: undefined } })));
      setFiles(null);
    }
    if (ev.kind === 'run-started' || ev.kind === 'run-paused' || ev.kind === 'approval-request' || ev.kind === 'run-finished') refreshRun();
    if (ev.kind === 'run-items') setFiles({ names: ev.names, cells: {} });
    if (ev.kind === 'item-status') {
      setFiles((f) => f && { ...f, cells: { ...f.cells, [ev.nodeId]: { ...f.cells[ev.nodeId], [ev.item]: { status: ev.status, message: ev.message } } } });
      if (ev.status === 'completed' || ev.status === 'failed') onProjectChanged();
    }
    if (ev.kind === 'approval-request') setApproval({ nodeId: ev.nodeId, note: ev.note, items: ev.items });
    if (ev.kind === 'run-finished') {
      const outcome = ev.cancelled ? 'cancelled' : ev.ok ? 'completed' : 'finished with problems';
      log('workflow', `Run ${ev.runId} ${outcome}.`);
      setMessage({ text: `Run ${outcome}.${ev.ok ? ' New versions are in the library; exports are in the Deliver tab.' : ''}`, error: !ev.ok && !ev.cancelled });
      setRunning(false);
      setApproval(null);
      onProjectChanged();
    }
    if (ev.kind === 'node-status') {
      if (ev.message) log('workflow', `${names.current[ev.nodeId] ?? 'Step'}: ${STATUS_LABEL[ev.status] ?? ev.status}. ${ev.message}`);
      if (ev.status !== 'awaiting_approval') setApproval((a) => (a?.nodeId === ev.nodeId ? null : a));
      setNodes((ns) => ns.map((n) => n.id === ev.nodeId ? {
        ...n,
        data: { ...n.data, status: ev.status, message: ev.message, outputRef: ev.outputRef ?? (ev.status === 'queued' ? undefined : n.data.outputRef) },
      } : n));
    }
  }), [log, onProjectChanged, refreshRun]);

  const decorated = useMemo(() => nodes.map((n) => {
    const out = n.data.outputRef?.startsWith('asset:') ? n.data.outputRef.slice(6) : undefined;
    const first = n.data.kind === 'import' ? importAssetIds(n.data.params)[0] : undefined;
    return {
      ...n,
      data: {
        ...n.data,
        mock: isMockNode(n.data.kind, n.data.params),
        approvedOut: !!out && assets.find((a) => a.id === out)?.approval === 'approved' && (n.data.kind === 'approval' || n.data.kind === 'artcraftEdit'),
        stale: !busy && aff.hasRun && aff.affected.includes(n.id) && aff.affected.length < nodes.length,
        summary: summarize(n.data.kind, n.data.params, assets),
        previewAssetId: n.data.kind === 'import' ? previewFor(assets, out ?? first) : n.data.kind === 'artcraftEdit' ? previewFor(assets, out) : undefined,
      },
    };
  }), [nodes, assets, isMockNode, aff, busy]);

  useEffect(() => { names.current = Object.fromEntries(decorated.map((n) => [n.id, `${NODE_SPECS[n.data.kind].label} (${n.data.summary})`])); }, [decorated]);

  // Connections into the running step move, so it is clear where the work is.
  const shownEdges = useMemo(() => {
    const status = new Map(nodes.map((n) => [n.id, n.data.status]));
    return edges.map((e) => {
      const into = status.get(e.target);
      const active = into === 'running' || into === 'awaiting_approval';
      return { ...e, animated: active, style: edgeStyle, markerEnd: edgeMarker, className: active ? 'active' : status.get(e.source) === 'completed' ? 'done' : undefined };
    });
  }, [edges, nodes]);

  const fit = useCallback(() => void flow?.fitView({ padding: 0.15, duration: 250 }), [flow]);
  const tidy = () => {
    const pos = autoLayout(graph);
    setNodes((ns) => ns.map((n) => (pos[n.id] ? { ...n, position: pos[n.id]! } : n)));
    setTimeout(fit, 30);
  };

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
    if (kind === 'import') { const a = assets.find((x) => x.kind === 'image'); if (a) params.assetIds = JSON.stringify([a.id]); }
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id, type: 'studio', selected: true, position: { x: 80 + ns.length * 30, y: 380 + ns.length * 20 }, data: { kind, params } }]);
  };

  // Validation the runner will apply, surfaced before running.
  const opIssues = nodes.flatMap((n) => {
    if (n.data.kind !== 'artcraftEdit' || n.data.params.opId) return [];
    const r = checkPhotoCraftOp(n.data.params.command ?? '', n.data.params.commandParams ?? '{}');
    return r.ok ? [] : [`App step: ${r.reason}`];
  });
  const issues = [...validateGraph(graph).map((i) => i.message), ...opIssues];

  // What a rerun would redo (the steps changed since the last run and what follows them).
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => { void window.studio.workflowAffected(graph).then(setAff).catch(() => undefined); }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, loaded, runState?.state]);

  const start = async (kind: 'run' | 'rerun', from?: string) => {
    if (issues.length) { setMessage({ text: issues.join(' · '), error: true }); return; }
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: 'idle', message: undefined, outputRef: undefined } })));
    setFiles(null);
    setMessage({ text: kind === 'rerun' ? 'Running again only what changed; the other steps keep their results.' : 'Running in the background: app steps add new versions, exports go to the Deliver tab. No app windows open.' });
    setRunning(true);
    try {
      await window.studio.saveWorkflow(graph);
      const p = kind === 'rerun' ? window.studio.rerunWorkflow(graph, from) : window.studio.runWorkflow(graph);
      runPromise.current = p;
      await p;
    } catch (e) { setMessage({ text: String(e), error: true }); setRunning(false); }
  };
  const run = () => start('run');
  /** While paused with edits: stop here (finished steps keep their results), then run only what the edits affect. */
  const applyAndContinue = async () => {
    const p = runPromise.current;
    await window.studio.cancelWorkflow();
    await Promise.resolve(p).catch(() => undefined);
    await start('rerun');
  };
  const takeControl = (who: 'user' | 'claude') => { void window.studio.setWorkflowControl(who).then(setRunState); };
  const openPanel = (which: 'versions' | 'templates') => {
    setPanel((cur) => (cur === which ? null : which));
    void window.studio.listWorkflowVersions().then(setVersions);
    void window.studio.listWorkflowTemplates().then(setTemplates);
  };
  const flash = (text: string, error = false) => setMessage({ text, error });

  const rerunnable = aff.hasRun && aff.affected.length > 0 && aff.affected.length < nodes.length;
  const anyMock = nodes.some((n) => isMockNode(n.data.kind, n.data.params));
  const order = nodes.map((n) => n.id).filter((id) => files?.cells[id]);

  return (
    <div className="wf">
      <div className="wf-toolbar">
        <span className="wf-add" role="group" aria-label="Add a step">
          {(Object.keys(NODE_SPECS) as WorkflowNodeType[]).map((k) => (
            <button key={k} className="btn small" onClick={() => addNode(k)} disabled={busy && !paused}>+ {NODE_SPECS[k].label}</button>
          ))}
        </span>
        <span className="wf-view" role="group" aria-label="View">
          <button className="btn small ghost" onClick={fit} disabled={!nodes.length} title="Zoom to show the whole workflow">Fit workflow</button>
          <button className="btn small ghost" onClick={tidy} disabled={!nodes.length || busy} title="Line the steps up from left to right in the order they run">Tidy layout</button>
          <button className="btn small ghost" aria-pressed={showSettings} onClick={() => setShowSettings((v) => !v)} title="Show or hide the settings of the selected step">Step settings</button>
          <button className="btn small ghost" aria-pressed={showFiles} onClick={() => setShowFiles((v) => !v)} title="Show or hide the per-file results of the last run">File results</button>
          <button className="btn small ghost" aria-pressed={showMap} onClick={() => setShowMap((v) => !v)} title="Show or hide the overview map">Map</button>
        </span>
        <span className="spacer" />
        <span className={`wf-msg${message?.error ? ' error' : ''}`} role="status">
          {message?.text ?? (issues.length ? `${issues.length} issue${issues.length > 1 ? 's' : ''}: ${issues[0]}` : 'Workflow valid · autosaved')}
        </span>
        <button className="btn small ghost" aria-pressed={panel === 'versions'} onClick={() => openPanel('versions')} disabled={busy && !paused} title="Earlier versions of this workflow">Versions</button>
        <button className="btn small ghost" aria-pressed={panel === 'templates'} onClick={() => openPanel('templates')} disabled={busy && !paused} title="Save this workflow as a template, or start from one">Templates</button>
        <button className="btn small ghost" aria-pressed={control === 'user'} onClick={() => takeControl(control === 'user' ? 'claude' : 'user')}
          title={control === 'user' ? 'Let Claude change and run the workflow again (with your approval)' : 'Pause and stop Claude from changing or running anything'}>
          {control === 'user' ? 'Give control back to Claude' : 'Take manual control'}
        </button>
        {busy ? (
          <>
            {paused
              ? <button className="btn small" onClick={() => void window.studio.resumeWorkflow()}>Resume</button>
              : <button className="btn small" onClick={() => void window.studio.pauseWorkflow()} title="Stops before the next step; the step in progress finishes first">Pause</button>}
            <button className="btn small danger" onClick={() => void window.studio.cancelWorkflow()}>Cancel run</button>
          </>
        ) : (
          <>
            {rerunnable && <button className="btn small" onClick={() => void start('rerun')} title="Runs again only the changed steps and what follows; the rest keeps its results">Rerun {aff.affected.length} changed step{aff.affected.length === 1 ? '' : 's'}</button>}
            <button className="btn small primary" onClick={() => void run()} disabled={!nodes.length}>Run {anyMock && <span className="badge-mock">PARTLY MOCK</span>}</button>
          </>
        )}
      </div>
      {(runState?.startedBy === 'claude' && busy) || paused || control === 'user' ? (
        <div className="wf-banner" role="status">
          {runState?.startedBy === 'claude' && busy && !paused && <span>Claude is running this workflow. You can pause it or take control at any time.</span>}
          {paused && <span>Paused before the next step. You can change steps now, then <button className="btn small" onClick={() => void applyAndContinue()}>Apply changes and continue</button> (only affected steps run again) or <button className="btn small" onClick={() => void window.studio.resumeWorkflow()}>Resume as it was</button>.</span>}
          {control === 'user' && <span>You have manual control: Claude will not change or run anything until you give it back.</span>}
        </div>
      ) : null}
      {panel === 'versions' && (
        <section className="wf-plan" aria-label="Workflow versions">
          <header><strong>Earlier versions of this workflow</strong></header>
          {versions.length === 0 ? <p className="muted">None yet. A version is kept before each run, change by Claude, template and restore.</p> : (
            <ul>{versions.map((v) => (
              <li key={v.id}>{new Date(v.savedAt).toLocaleString()} · {v.reason} · {v.steps} step{v.steps === 1 ? '' : 's'}{' '}
                <button className="btn small" disabled={busy} onClick={() => void window.studio.restoreWorkflowVersion(v.id).then(() => { setPanel(null); flash('Restored. The version it replaced is kept under Versions.'); }).catch((e: unknown) => flash(String(e instanceof Error ? e.message : e), true))}>Restore</button>
              </li>
            ))}</ul>
          )}
        </section>
      )}
      {panel === 'templates' && (
        <section className="wf-plan" aria-label="Workflow templates">
          <header><strong>Templates</strong></header>
          <p className="btn-row">
            <input aria-label="Template name" placeholder="Template name" value={tplName} onChange={(e) => setTplName(e.target.value)} maxLength={80} />
            <button className="btn small primary" disabled={!tplName.trim() || !aff.templateReady}
              onClick={() => void window.studio.saveWorkflowTemplate(tplName.trim(), '').then((t) => { setTplName(''); setTemplates((x) => [t, ...x]); flash(`Saved the template "${t.name}".`); }).catch((e: unknown) => flash(String(e instanceof Error ? e.message : e), true))}>Save this workflow as a template</button>
          </p>
          {!aff.templateReady && <p className="muted">A template can be saved after this workflow has run successfully and not changed since.</p>}
          {templates.length > 0 && <ul>{templates.map((t) => (
            <li key={t.id}><b>{t.name}</b>{t.description ? ` — ${t.description}` : ''} · {t.graph.nodes.length} steps{' '}
              <button className="btn small" disabled={busy} onClick={() => void window.studio.useWorkflowTemplate(t.id).then(() => { setPanel(null); flash('Template in place: choose the files in the Files step. Your previous workflow is kept under Versions.'); }).catch((e: unknown) => flash(String(e instanceof Error ? e.message : e), true))}>Use</button>
            </li>
          ))}</ul>}
        </section>
      )}
      {plan && (
        <section className="wf-plan" aria-label="Claude's proposed workflow">
          <header><strong>Claude proposes: {plan.title}</strong></header>
          <p>{plan.explanation}</p>
          <ol>{plan.steps.map((st) => <li key={st.id}><b>{st.title}</b>{st.detail ? ` — ${st.detail}` : ''}</li>)}</ol>
          <p className="wf-plan-cost"><b>Cost:</b> {plan.costNote}</p>
          {plan.approvals.length > 0 && <p><b>You will be asked:</b> {plan.approvals.join(' ')}</p>}
          {plan.warnings.length > 0 && <ul className="wf-plan-warn">{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          <footer>
            <button className="btn small primary" onClick={applyPlan} disabled={busy}>{nodes.length ? 'Replace my workflow with this' : 'Use this workflow'}</button>
            <button className="btn small ghost" onClick={() => void window.studio.dismissWorkflowPlan()}>Dismiss</button>
            <span className="muted">Nothing runs or is charged until you press Run.</span>
          </footer>
        </section>
      )}
      <div className="wf-body">
        <div className="wf-main">
          <div className="wf-canvas">
            <ReactFlow<StudioNode>
              nodes={decorated}
              edges={shownEdges}
              onInit={setFlow}
              fitViewOptions={{ padding: 0.15 }}
              minZoom={0.2}
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
              {showMap && <MiniMap pannable zoomable />}
            </ReactFlow>
          </div>
          {approval && <ApprovalPanel approval={approval} assets={assets} />}
          {/* While a decision is waiting, the approval panel gets the room; the results table comes back afterwards. */}
          {!approval && showFiles && files && files.names.length > 0 && (
            <div className="wf-files" aria-label="Files in this run">
              <table>
                <thead><tr><th>File</th>{order.map((id) => <th key={id}>{decorated.find((n) => n.id === id)?.data.summary}</th>)}</tr></thead>
                <tbody>
                  {files.names.map((name, i) => (
                    <tr key={i}>
                      <td title={name}>{name}</td>
                      {order.map((id) => {
                        const c = files.cells[id]?.[i];
                        return <td key={id} className={`cell ${c?.status ?? 'idle'}`} title={c?.message}>{c ? (c.status === 'completed' ? '✓' : c.status === 'failed' ? '✕' : c.status === 'running' ? '…' : STATUS_LABEL[c.status]) : '·'}{c?.status === 'failed' && c.message ? ` ${c.message}` : ''}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {selectedNode && showSettings && !approval && (
          <NodeInspector key={selectedNode.id} node={selectedNode} assets={assets} disabled={busy && !paused} canRerun={!busy && aff.hasRun} onRerunFrom={() => void start('rerun', selectedNode.id)} mock={isMockNode(selectedNode.data.kind, selectedNode.data.params)}
            onChange={(patch) => updateParams(selectedNode.id, patch)} />
        )}
      </div>
    </div>
  );
}

/** The Approval step: every file's latest version, each with a tick; approve the ticked ones or reject all. */
function ApprovalPanel({ approval, assets }: { approval: Approval; assets: Asset[] }) {
  const [ok, setOk] = useState<Set<number>>(() => new Set(approval.items.map((x) => x.item)));
  return (
    <div className="wf-approval" role="region" aria-label="Approval">
      <div className="row-between">
        <strong>Approve: {approval.note || 'check the results'}</strong>
        <span className="btn-row">
          <button className="btn small primary" disabled={!ok.size} onClick={() => void window.studio.answerApproval(approval.nodeId, [...ok])}>Approve {ok.size === approval.items.length ? 'all' : `${ok.size} of ${approval.items.length}`}</button>
          <button className="btn small danger" onClick={() => void window.studio.answerApproval(approval.nodeId, false)}>Reject all</button>
        </span>
      </div>
      <div className="wf-approval-grid">
        {approval.items.map((x) => {
          const a = assets.find((y) => y.id === x.assetId);
          return (
            <label key={x.item} className={`wf-approval-item${ok.has(x.item) ? ' on' : ''}`}>
              {a ? <AssetThumb asset={a} rendition={a.kind === 'image' ? undefined : assets.find((y) => y.parentId === a.id && y.kind === 'image')} /> : <div className="thumb" />}
              <span className="asset-name" title={a?.name ?? x.name}><input type="checkbox" checked={ok.has(x.item)} onChange={(e) => setOk((s) => { const n = new Set(s); if (e.target.checked) n.add(x.item); else n.delete(x.item); return n; })} /> {a?.name ?? x.name}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function NodeInspector({ node, assets, disabled, mock, onChange, canRerun, onRerunFrom }: {
  node: StudioNode; assets: Asset[]; disabled: boolean; mock: boolean; onChange: (patch: Record<string, string>) => void; canRerun: boolean; onRerunFrom: () => void;
}) {
  const p = node.data.params;
  return (
    <aside className="wf-inspector" aria-label="Node settings">
      <div className="pane-header">{NODE_SPECS[node.data.kind].label} settings {mock && <span className="badge-mock">MOCK</span>}</div>
      <div className="wf-inspector-body">
        {node.data.kind === 'import' && <FilesSettings p={p} assets={assets} disabled={disabled} onChange={onChange} />}
        {node.data.kind === 'artcraftEdit' && <StepSettings p={p} disabled={disabled} onChange={onChange} />}
        {node.data.kind === 'approval' && (
          <label className="field">What to check
            <input value={p.note ?? ''} disabled={disabled} onChange={(e) => onChange({ note: e.target.value })} />
          </label>
        )}
        {node.data.kind === 'export' && <ExportSettings p={p} disabled={disabled} onChange={onChange} />}
        {node.data.kind === 'aiGenerate' && (
          <>
            <label className="field">Prompt
              <textarea value={p.prompt ?? ''} disabled={disabled} onChange={(e) => onChange({ prompt: e.target.value })} />
            </label>
            <small className="asset-meta">{p.modelId && p.providerId !== 'mock' ? `${p.modelId}: you approve the price in a dialog when the workflow reaches this step. Charges go to your own provider account.` : 'Offline test pattern: nothing is generated, no network call, $0.'}</small>
          </>
        )}
        {canRerun && node.data.kind !== 'import' && <button className="btn small" onClick={onRerunFrom} title="Runs this step and what follows again; earlier steps keep their results">Rerun from this step</button>}
        <small className="asset-meta">Delete key removes the selected node or connection.</small>
      </div>
    </aside>
  );
}

function FilesSettings({ p, assets, disabled, onChange }: { p: Record<string, string>; assets: Asset[]; disabled: boolean; onChange: (patch: Record<string, string>) => void }) {
  const ids = new Set(importAssetIds(p));
  const setIds = (s: Set<string>) => onChange({ assetIds: JSON.stringify([...s]), assetId: '' });
  return (
    <>
      <div className="field" role="radiogroup" aria-label="Where the files come from">
        <label><input type="radio" checked={p.mode !== 'folder'} disabled={disabled} onChange={() => onChange({ mode: 'files' })} /> Files from the library</label>
        <label><input type="radio" checked={p.mode === 'folder'} disabled={disabled} onChange={() => onChange({ mode: 'folder' })} /> Every file in a folder</label>
      </div>
      {p.mode === 'folder' ? (
        <>
          <div className="btn-row">
            <button className="btn small" disabled={disabled} onClick={() => void window.studio.pickWorkflowFolder().then((f) => { if (f) onChange({ folder: f }); })}>Choose folder…</button>
          </div>
          <small className="asset-meta">{p.folder ? p.folder : 'No folder chosen.'} Files are copied into the library when the run starts; the folder itself is only read.</small>
        </>
      ) : (
        <>
          <div className="btn-row">
            <button className="btn small ghost" disabled={disabled} onClick={() => setIds(new Set(assets.map((a) => a.id)))}>All</button>
            <button className="btn small ghost" disabled={disabled} onClick={() => setIds(new Set())}>None</button>
            <span className="asset-meta">{ids.size} chosen</span>
          </div>
          <div className="wf-file-list" aria-label="Files">
            {assets.map((a) => (
              <label key={a.id}>
                <input type="checkbox" checked={ids.has(a.id)} disabled={disabled} onChange={(e) => { const s = new Set(ids); if (e.target.checked) s.add(a.id); else s.delete(a.id); setIds(s); }} />
                {' '}{a.name} <span className="asset-meta">{a.kind}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function StepSettings({ p, disabled, onChange }: { p: Record<string, string>; disabled: boolean; onChange: (patch: Record<string, string>) => void }) {
  const appId = (p.appId as EditorAppId) || 'photocraft';
  const app = EDITOR_APPS[appId];
  const legacy = !p.opId && appId === 'photocraft' && !!p.command;
  const op = stepOp(p);
  let values: Record<string, unknown> = {};
  try { values = JSON.parse(p.values || '{}') as Record<string, unknown>; } catch { /* reset below */ }
  const setValue = (k: string, v: unknown) => onChange({ values: JSON.stringify({ ...values, [k]: v }) });
  const [paramsText, setParamsText] = useState(p.commandParams ?? '{}');
  const check = legacy ? checkPhotoCraftOp(p.command ?? '', paramsText) : null;
  return (
    <>
      <label className="field">App
        <select aria-label="App" value={appId} disabled={disabled} onChange={(e) => {
          const a = EDITOR_APPS[e.target.value as EditorAppId];
          onChange({ appId: a.id, opId: a.quickEdits[0]?.id ?? '', values: '{}', command: '', commandParams: '' });
        }}>
          {APP_IDS.map((id) => <option key={id} value={id}>{EDITOR_APPS[id].name}: {EDITOR_APPS[id].blurb}</option>)}
        </select>
      </label>
      <label className="field">Edit
        <select aria-label="Edit" value={legacy ? '__command' : p.opId ?? ''} disabled={disabled} onChange={(e) => {
          if (e.target.value === '__command') { const pr = PHOTOCRAFT_PRESETS[0]!; setParamsText(JSON.stringify(pr.params)); onChange({ opId: '', command: pr.id, commandParams: JSON.stringify(pr.params) }); return; }
          onChange({ opId: e.target.value, values: '{}', command: '', commandParams: '' });
        }}>
          {app.quickEdits.map((o) => <option key={o.id} value={o.id}>{o.group}: {o.label}</option>)}
          {appId === 'photocraft' && <option value="__command">Other PhotoCraft command…</option>}
        </select>
      </label>
      {!legacy && op?.params.map((q) => (
        <label className="field" key={q.key}>{q.label}{q.type === 'number' && q.unit ? ` (${q.unit})` : ''}
          {q.type === 'number' && <input type="number" min={q.min} max={q.max} step={q.step} value={String(values[q.key] ?? q.default)} disabled={disabled} onChange={(e) => setValue(q.key, Number(e.target.value))} />}
          {q.type === 'select' && <select value={String(values[q.key] ?? q.default)} disabled={disabled} onChange={(e) => setValue(q.key, e.target.value)}>{q.options.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>}
          {q.type === 'text' && <input value={String(values[q.key] ?? q.default)} maxLength={q.maxLength} disabled={disabled} onChange={(e) => setValue(q.key, e.target.value)} />}
        </label>
      ))}
      {legacy && (
        <>
          <label className="field">PhotoCraft command
            <select value={PHOTOCRAFT_PRESETS.some((x) => x.id === p.command) ? p.command : ''} disabled={disabled} onChange={(e) => {
              const pr = PHOTOCRAFT_PRESETS.find((x) => x.id === e.target.value);
              if (pr) { setParamsText(JSON.stringify(pr.params)); onChange({ command: pr.id, commandParams: JSON.stringify(pr.params) }); }
            }}>
              {PHOTOCRAFT_PRESETS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </label>
          <label className="field">Parameters (JSON)
            <textarea className="mono" value={paramsText} disabled={disabled} spellCheck={false} onChange={(e) => { setParamsText(e.target.value); onChange({ commandParams: e.target.value }); }} />
          </label>
          <small className={check?.ok ? 'asset-meta' : 'wf-msg error'}>{check?.ok ? 'Allowed. PhotoCraft checks value ranges when it runs.' : check?.reason}</small>
        </>
      )}
      <small className="asset-meta">{app.name} opens {app.formats.map((f) => f.toUpperCase()).join(', ')}. Runs in the background without a window; each file gets a new version (originals are never changed). Files the app can't open stop at this step; the others carry on.</small>
    </>
  );
}

function ExportSettings({ p, disabled, onChange }: { p: Record<string, string>; disabled: boolean; onChange: (patch: Record<string, string>) => void }) {
  const chosen = new Set(exportPresetsOf(p));
  const toggle = (id: string, on: boolean) => { const s = new Set(chosen); if (on) s.add(id); else s.delete(id); onChange({ presets: [...s].join(','), format: '' }); };
  return (
    <>
      {(Object.keys(GROUP_LABEL) as DeliverGroup[]).map((g) => (
        <fieldset key={g} className="wf-presets">
          <legend>{GROUP_LABEL[g]}</legend>
          {DELIVER_PRESETS.filter((x) => x.group === g).map((x) => (
            <label key={x.id} title={x.note}><input type="checkbox" checked={chosen.has(x.id)} disabled={disabled} onChange={(e) => toggle(x.id, e.target.checked)} /> {x.label}</label>
          ))}
        </fieldset>
      ))}
      <small className="asset-meta">Each file gets the formats that fit it (a picture can't become a WAV). Exports go to the Deliver tab, with the source version and a checksum.</small>
    </>
  );
}

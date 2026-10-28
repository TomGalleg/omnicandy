import { useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Edge, type ReactFlowInstance, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import { CARD_H, CARD_W, type CanvasLayout, type CanvasNodePos, type CanvasPatch, type ViewMode } from '@shared/plannerCanvas';
import type { ProjectView, ViewNode } from '@shared/projectView';
import { SIMPLE_STATUSES } from '@shared/plannerView';

/** The presentations offered today. The data behind each is identical; only how it is drawn differs. */
export const MODES: Array<[ViewMode, string]> = [['canvas', 'Canvas'], ['board', 'Board'], ['list', 'List']];

const KIND_LABEL: Record<ViewNode['kind'], string> = {
  project: 'Project', idea: 'Idea', question: 'Question', requirement: 'Rule', decision: 'Decision', reference: 'Reference', milestone: 'Stage',
  chunk: 'Chunk', task: 'Task', resource: 'File', result: 'Result', ghost: 'Suggested',
};

type CardData = { vn: ViewNode; selected: boolean; left: boolean; onToggle: (ghostId: string) => void } & Record<string, unknown>;

function Card({ data }: NodeProps<Node<CardData, 'card'>>) {
  const { vn, selected, left, onToggle } = data;
  const tone = vn.status?.tone ?? 'off';
  return (
    <div className={`pc-card kind-${vn.kind}${vn.ghost ? ' ghost' : ''}${left ? ' left-out' : ''}${selected ? ' selected' : ''}${vn.flags.removed ? ' removed' : ''}`} style={{ width: CARD_W, minHeight: CARD_H }}>
      <Handle type="target" position={Position.Left} />
      <div className="pc-top"><span className="pc-kind">{KIND_LABEL[vn.kind]}</span>{vn.status && <span className={`chip pc-status ${tone}`}><span className="dot" />{vn.status.label}</span>}</div>
      <strong className="pc-title" title={vn.title}>{vn.title}</strong>
      {vn.summary && <p className="pc-summary">{vn.summary}</p>}
      {vn.status?.chip && <small className="pl-hint">{vn.status.chip}</small>}
      {vn.progress && vn.progress.total > 0 && <div className="pc-progress" title={`${vn.progress.done} of ${vn.progress.total} done`}><span style={{ width: `${vn.progress.percent}%` }} /></div>}
      {vn.ghost && (
        <div className="pc-ghost nodrag">
          <small>{left ? 'Left out' : `${vn.ghost.by} suggests this`}</small>
          <button className="btn small" onClick={() => onToggle(vn.id)}>{left ? 'Keep it' : 'Leave out'}</button>
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { card: Card };

interface Props {
  view: ProjectView;
  layout: CanvasLayout;
  positions: Record<string, CanvasNodePos>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onPatch: (p: CanvasPatch) => void;
  onArrange: () => void;
  /** Suggested cards the owner has chosen to leave out of what gets added. */
  excluded: ReadonlySet<string>;
  onToggle: (ghostId: string) => void;
}

/** The project as a free canvas (movable cards, dependencies as arrows), a board by status, or a list. All three read the same view. */
export function ProjectCanvas({ view, layout, positions, selectedId, onSelect, onPatch, onArrange, excluded, onToggle }: Props) {
  const mode: ViewMode = MODES.some(([m]) => m === layout.mode) ? layout.mode : 'canvas';
  return (
    <div className="pc">
      <div className="pc-bar" role="toolbar" aria-label="How to show the plan">
        <div className="mode-strip" role="group" aria-label="View">
          {MODES.map(([m, label]) => <button key={m} className="btn small" aria-pressed={mode === m} onClick={() => onPatch({ mode: m })}>{label}</button>)}
        </div>
        <span className="spacer" />
        {mode === 'canvas' && <button className="btn small" title="Put every card back where it would go automatically" onClick={onArrange}>Tidy up</button>}
        <small className="pl-hint">{view.progress.done} of {view.progress.total} done</small>
      </div>
      {mode === 'canvas' && <Flow view={view} positions={positions} selectedId={selectedId} onSelect={onSelect} onPatch={onPatch} excluded={excluded} onToggle={onToggle} />}
      {mode === 'board' && <Board view={view} selectedId={selectedId} onSelect={onSelect} excluded={excluded} onToggle={onToggle} />}
      {mode === 'list' && <List view={view} selectedId={selectedId} onSelect={onSelect} excluded={excluded} onToggle={onToggle} />}
    </div>
  );
}

function Flow({ view, positions, selectedId, onSelect, onPatch, excluded, onToggle }: Pick<Props, 'view' | 'positions' | 'selectedId' | 'onSelect' | 'onPatch' | 'excluded' | 'onToggle'>) {
  const build = useMemo<Array<Node<CardData, 'card'>>>(() => view.nodes.map((vn) => ({
    id: vn.id, type: 'card', position: { x: positions[vn.id]?.x ?? 0, y: positions[vn.id]?.y ?? 0 }, data: { vn, selected: vn.id === selectedId, left: excluded.has(vn.id), onToggle },
  })), [view, positions, selectedId, excluded, onToggle]);
  const [nodes, setNodes] = useState(build);
  useEffect(() => setNodes(build), [build]);
  // Show everything when cards appear or go (not on every move, so the owner's own panning and zooming is left alone).
  const flow = useRef<ReactFlowInstance<Node<CardData, 'card'>> | null>(null);
  useEffect(() => { const t = setTimeout(() => { void flow.current?.fitView({ padding: 0.25, duration: 200 }); }, 60); return () => clearTimeout(t); }, [view.nodes.length]);
  const edges = useMemo<Edge[]>(() => view.edges.filter((e) => e.kind !== 'contains').map((e) => ({
    id: e.id, source: e.from, target: e.to, markerEnd: { type: MarkerType.ArrowClosed }, animated: e.kind === 'ghostDependsOn',
    style: e.kind === 'ghostDependsOn' ? { strokeDasharray: '5 4' } : undefined,
  })), [view]);
  const onNodesChange = (changes: NodeChange<Node<CardData, 'card'>>[]) => setNodes((ns) => applyNodeChanges(changes, ns));
  return (
    <div className="pc-flow">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onInit={(i) => { flow.current = i; }} nodesConnectable={false} fitView minZoom={0.1} maxZoom={2}
        onNodeClick={(_e, n) => onSelect(n.id)} onPaneClick={() => onSelect(null)}
        onNodeDragStop={(_e, n) => onPatch({ upsertNodes: { [n.id]: { x: Math.round(n.position.x), y: Math.round(n.position.y), w: CARD_W, h: CARD_H } } })}>
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}


function Board({ view, selectedId, onSelect, excluded, onToggle }: Pick<Props, 'view' | 'selectedId' | 'onSelect' | 'excluded' | 'onToggle'>) {
  const cols: Array<[string, ViewNode[]]> = [
    ['Suggested', view.nodes.filter((n) => n.kind === 'ghost')],
    ...SIMPLE_STATUSES.map((s): [string, ViewNode[]] => [s, view.nodes.filter((n) => (n.kind === 'chunk' || n.kind === 'task') && !n.flags.removed && n.status?.label === s)]),
  ];
  return (
    <div className="pc-board">
      {cols.map(([name, items]) => (
        <section key={name} className="pc-col" aria-label={name}>
          <h4>{name} <span className="pl-count">{items.length}</span></h4>
          {items.map((n) => (
            <div key={n.id} className={`pc-mini${n.id === selectedId ? ' selected' : ''}${n.ghost ? ' ghost' : ''}${excluded.has(n.id) ? ' left-out' : ''}`}>
              <button className="pc-mini-main" onClick={() => onSelect(n.id)}><strong>{n.title}</strong>{n.status?.chip && <small className="pl-hint">{n.status.chip}</small>}</button>
              {n.ghost && <button className="btn small" onClick={() => onToggle(n.id)}>{excluded.has(n.id) ? 'Keep it' : 'Leave out'}</button>}
            </div>
          ))}
          {!items.length && <p className="pl-hint">Nothing here.</p>}
        </section>
      ))}
    </div>
  );
}

function List({ view, selectedId, onSelect, excluded, onToggle }: Pick<Props, 'view' | 'selectedId' | 'onSelect' | 'excluded' | 'onToggle'>) {
  const byParent = new Map<string, ViewNode[]>();
  for (const n of view.nodes) if (n.parentId) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n]);
  const rows: Array<{ n: ViewNode; depth: number }> = [];
  const walk = (id: string, depth: number) => { for (const n of byParent.get(id) ?? []) { if (n.kind === 'result') continue; rows.push({ n, depth }); walk(n.id, depth + 1); } };
  const root = view.nodes[0];
  if (root) { rows.push({ n: root, depth: 0 }); walk(root.id, 1); }
  return (
    <ul className="pc-list">
      {rows.filter(({ n }) => !n.flags.removed).map(({ n, depth }) => (
        <li key={n.id} className={n.id === selectedId ? 'selected' : ''} style={{ paddingLeft: 8 + depth * 18 }}>
          <button className="pc-row" onClick={() => onSelect(n.id)}>
            <span className="pc-kind">{KIND_LABEL[n.kind]}</span><strong>{n.title}</strong>
            {n.status && <span className={`chip pc-status ${n.status.tone}`}><span className="dot" />{n.status.label}</span>}
            {n.progress && n.progress.total > 0 && <small className="pl-hint">{n.progress.done}/{n.progress.total}</small>}
          </button>
          {n.ghost && <button className="btn small" onClick={() => onToggle(n.id)}>{excluded.has(n.id) ? 'Keep it' : 'Leave out'}</button>}
        </li>
      ))}
    </ul>
  );
}

/** What is known about the selected card, with the one action that makes sense for it. */
export function CardDetails({ node, onWork, onClose }: { node: ViewNode | null; onWork: (taskId: string) => void; onClose: () => void }) {
  if (!node) return null;
  return (
    <aside className="pc-details" aria-label="Details">
      <header><span className="pc-kind">{KIND_LABEL[node.kind]}</span><button className="btn small ghost" onClick={onClose} aria-label="Close details">×</button></header>
      <h3>{node.title}</h3>
      {node.status && <p><span className={`chip pc-status ${node.status.tone}`}><span className="dot" />{node.status.label}</span> {node.status.chip && <small className="pl-hint">{node.status.chip}</small>}</p>}
      {node.summary && <p>{node.summary}</p>}
      {node.progress && node.progress.total > 0 && <p className="pl-hint">{node.progress.done} of {node.progress.total} finished</p>}
      {node.resourceHint && <p className="pl-hint">Uses: {node.resourceHint.id}{node.resourceHint.note ? ` (${node.resourceHint.note})` : ''}</p>}
      {node.ghost && <p className="pl-hint">{node.ghost.by} suggested this. It is not part of your plan until you add it.</p>}
      {(node.kind === 'chunk' || node.kind === 'task') && !node.flags.removed && node.status?.label !== 'Done' && <button className="btn primary" onClick={() => onWork(node.id)}>Work on this</button>}
    </aside>
  );
}

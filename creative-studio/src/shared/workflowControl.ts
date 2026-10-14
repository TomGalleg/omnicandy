// Run control shared by the visual editor and Claude: which steps a change affects (so a rerun only
// does that work), what can be reused from the last run, a plain snapshot of a run for Claude to
// monitor, and how a successful workflow becomes a reusable template. Pure; no side effects.

import type { NodeRunStatus, WorkflowGraph, WorkflowRunEvent } from './workflow';
import { invalidatedBy, NODE_SPECS, topologicalOrder } from './workflow';

/** One file going through a workflow: its current versions (main first), or null once it stopped. */
export interface RunItem { name: string; refs: string[] | null }
export type RunOutputs = Record<string, RunItem[]>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Steps that are new, changed (type or settings) or reconnected compared with `prev`. Positions don't count. */
export function changedNodes(prev: WorkflowGraph, cur: WorkflowGraph): Set<string> {
  const out = new Set<string>();
  const before = new Map(prev.nodes.map((n) => [n.id, n]));
  const feeds = (g: WorkflowGraph, id: string) => g.edges.filter((e) => e.target === id)
    .map((e) => `${e.source}.${e.sourceHandle}>${e.targetHandle}`).sort();
  for (const n of cur.nodes) {
    const p = before.get(n.id);
    if (!p || p.type !== n.type || !same(p.params, n.params) || !same(feeds(prev, n.id), feeds(cur, n.id))) out.add(n.id);
  }
  return out;
}

/** Everything that must run again: the changed steps (or `from`) and what comes after them. */
export function affectedNodes(prev: WorkflowGraph | null, cur: WorkflowGraph, from?: string): Set<string> {
  if (!prev) return new Set(cur.nodes.map((n) => n.id));
  const seeds = from ? [from] : [...changedNodes(prev, cur)];
  const out = new Set<string>();
  for (const s of seeds) if (cur.nodes.some((n) => n.id === s)) for (const id of invalidatedBy(cur, s)) out.add(id);
  return out;
}

/** Outputs kept from the last run for steps that are not affected (and that finished there). */
export function reusableOutputs(cur: WorkflowGraph, last: RunOutputs, affected: Set<string>): RunOutputs {
  const out: RunOutputs = {};
  // In run order, so a step is only kept when everything feeding it is kept too.
  for (const id of topologicalOrder(cur)) {
    if (affected.has(id) || !last[id]) continue;
    if (cur.edges.some((e) => e.target === id && !out[e.source])) continue;
    out[id] = last[id]!;
  }
  return out;
}

/** True when the graph is exactly what the last run used (so its result still describes it). */
export const sameAsRun = (prev: WorkflowGraph | null, cur: WorkflowGraph): boolean =>
  !!prev && changedNodes(prev, cur).size === 0 && prev.nodes.length === cur.nodes.length && prev.edges.length === cur.edges.length;

// ---- Monitoring ----

export interface StepSnapshot { id: string; type: string; label: string; status: NodeRunStatus; message?: string }
export interface RunSnapshot {
  runId: string | null;
  state: 'idle' | 'running' | 'paused' | 'waiting-for-you' | 'finished';
  /** Who started the run and who may change it now. */
  startedBy: 'user' | 'claude' | null;
  control: 'user' | 'claude';
  ok: boolean | null;
  cancelled: boolean;
  files: string[];
  steps: StepSnapshot[];
  /** Per-file problems (what failed and why). */
  problems: string[];
  waitingFor: string | null;
  /** Last few things that happened, oldest first. */
  recent: string[];
}

export class RunMonitor {
  private s: RunSnapshot = RunMonitor.blank();
  private labels = new Map<string, { type: string; label: string }>();
  private paused = false;
  static blank(): RunSnapshot {
    return { runId: null, state: 'idle', startedBy: null, control: 'claude', ok: null, cancelled: false, files: [], steps: [], problems: [], waitingFor: null, recent: [] };
  }
  /** Starts watching a run of `graph`; `describe` gives each step a readable label. */
  begin(graph: WorkflowGraph, startedBy: 'user' | 'claude', describe: (id: string) => string, control: 'user' | 'claude' = startedBy) {
    this.paused = false;
    this.labels = new Map(graph.nodes.map((n) => [n.id, { type: n.type, label: describe(n.id) || NODE_SPECS[n.type].label }]));
    this.s = {
      ...RunMonitor.blank(), state: 'running', startedBy, control,
      steps: graph.nodes.map((n) => ({ id: n.id, type: n.type, label: this.labels.get(n.id)!.label, status: 'idle' })),
    };
  }
  setControl(c: 'user' | 'claude') { this.s.control = c; }
  reset() { this.s = RunMonitor.blank(); this.paused = false; this.labels.clear(); }
  setState(state: RunSnapshot['state']) { this.s.state = state; }
  private note(t: string) { this.s.recent = [...this.s.recent, t].slice(-20); }
  event(ev: WorkflowRunEvent) {
    const s = this.s;
    switch (ev.kind) {
      case 'run-started': s.runId = ev.runId; break;
      case 'run-items': s.files = ev.names; break;
      case 'node-status': {
        const st = s.steps.find((x) => x.id === ev.nodeId);
        if (!st) break;
        st.status = ev.status;
        st.message = ev.message;
        if (ev.status === 'awaiting_approval') { s.state = 'waiting-for-you'; s.waitingFor = `${st.label}: ${ev.message ?? 'approve or reject the results'}`; }
        else if (s.state === 'waiting-for-you') { s.state = this.paused ? 'paused' : 'running'; s.waitingFor = null; }
        if (ev.status === 'failed' || ev.status === 'blocked' || ev.status === 'completed') this.note(`${st.label}: ${ev.status}${ev.message ? ` (${ev.message})` : ''}`);
        break;
      }
      case 'item-status':
        if (ev.status === 'failed') {
          const t = `${this.labels.get(ev.nodeId)?.label ?? 'Step'}, ${ev.name}: ${ev.message ?? 'failed'}`;
          if (!s.problems.includes(t)) s.problems.push(t);
        }
        break;
      case 'run-paused':
        this.paused = ev.paused;
        if (s.state !== 'waiting-for-you') s.state = ev.paused ? 'paused' : 'running';
        this.note(ev.paused ? 'Paused before the next step.' : 'Resumed.');
        break;
      case 'run-finished':
        s.state = 'finished'; s.ok = ev.ok; s.cancelled = ev.cancelled; s.waitingFor = null;
        for (const st of s.steps) if (st.status === 'running' || st.status === 'queued') st.status = ev.cancelled ? 'cancelled' : st.status;
        this.note(ev.cancelled ? 'Cancelled.' : ev.ok ? 'Finished.' : 'Finished with problems.');
        break;
      default: break;
    }
  }
  snapshot(): RunSnapshot { return JSON.parse(JSON.stringify(this.s)) as RunSnapshot; }
}

// ---- Templates ----

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  /** The graph with the file choices removed: a template says what to do, not to which files. */
  graph: WorkflowGraph;
}

export function templateGraph(g: WorkflowGraph): WorkflowGraph {
  return {
    ...g,
    nodes: g.nodes.map((n) => n.type === 'import'
      ? { ...n, params: { ...n.params, mode: 'files', assetIds: '[]', assetId: '', folder: '' } }
      : { ...n, params: { ...n.params } }),
    edges: g.edges.map((e) => ({ ...e })),
  };
}

export const templateSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workflow';

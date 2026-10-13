// Workflow runner. Walks the graph in topological order and reports node states. All side
// effects go through injected adapters: real ones (PhotoCraft CLI) or explicitly labelled mocks.
// Billable providers are refused without explicit consent.

import type { AppAdapter, GenerationProvider, WorkflowExecutor, WorkflowRunOptions } from './contracts';
import { topologicalOrder, validateGraph, type NodeRunStatus, type WorkflowGraph } from './workflow';

export interface RunnerDeps {
  apps: Record<string, AppAdapter>;
  providers: Record<string, GenerationProvider>;
  /** Writes a deliverable for an asset; returns a display name. Absent → export is simulated. */
  exportAsset?: (assetId: string, format: string) => Promise<string>;
  /** Delay per node so the UI can show progress; 0 in tests. */
  stepMs?: number;
  newRunId?: () => string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** True when any node in the graph would run against a mock adapter/provider or simulated export. */
export function graphUsesMocks(graph: WorkflowGraph, deps: RunnerDeps): boolean {
  return graph.nodes.some((n) =>
    (n.type === 'aiGenerate' && (deps.providers[n.params.providerId ?? '']?.isMock ?? true)) ||
    (n.type === 'artcraftEdit' && (deps.apps[n.params.appId ?? '']?.isMock ?? true)) ||
    (n.type === 'export' && !deps.exportAsset));
}

export class WorkflowRunner implements WorkflowExecutor {
  readonly isMock = false;
  constructor(private readonly deps: RunnerDeps) {}

  async run(graph: WorkflowGraph, o: WorkflowRunOptions): Promise<{ ok: boolean; cancelled: boolean }> {
    const runId = this.deps.newRunId?.() ?? `run-${Date.now()}`;
    const emit = (nodeId: string, status: NodeRunStatus, message?: string, outputRef?: string) =>
      o.onEvent({ kind: 'node-status', runId, nodeId, status, message, outputRef });
    const finish = (ok: boolean, cancelled: boolean) => {
      o.onEvent({ kind: 'run-finished', runId, ok, cancelled });
      return { ok, cancelled };
    };

    o.onEvent({ kind: 'run-started', runId, mock: graphUsesMocks(graph, this.deps) });
    const issues = validateGraph(graph);
    if (issues.length) {
      for (const i of issues) if (i.nodeId) emit(i.nodeId, 'failed', i.message);
      return finish(false, false);
    }

    const order = topologicalOrder(graph);
    for (const id of order) emit(id, 'queued');

    const outputs = new Map<string, string>();
    const halted = new Set<string>(); // nodes that did not complete; their descendants are blocked
    for (const id of order) {
      if (o.signal?.aborted) {
        for (const rest of order.slice(order.indexOf(id))) emit(rest, 'cancelled');
        return finish(false, true);
      }
      const node = graph.nodes.find((n) => n.id === id)!;
      const upstream = graph.edges.filter((e) => e.target === id).map((e) => e.source);
      if (upstream.some((u) => halted.has(u))) {
        halted.add(id);
        emit(id, 'blocked', 'An upstream node did not complete.');
        continue;
      }
      emit(id, 'running');
      await sleep(this.deps.stepMs ?? 0, o.signal);
      try {
        const input = upstream.map((u) => outputs.get(u)).find(Boolean);
        switch (node.type) {
          case 'import':
            outputs.set(id, `asset:${node.params.assetId}`);
            emit(id, 'completed', 'Original referenced (read-only).', outputs.get(id));
            break;
          case 'aiGenerate': {
            const p = this.deps.providers[node.params.providerId ?? ''];
            if (!p) throw new Error(`Provider "${node.params.providerId}" is not configured.`);
            if (p.billable) {
              const est = await p.estimate({ modelId: '', prompt: node.params.prompt ?? '', referenceAssetIds: [] });
              const consent = o.consentToBillable ? await o.consentToBillable(id, `${est.amount} ${est.currency}`) : false;
              if (!consent) {
                halted.add(id);
                emit(id, 'blocked', 'Billable call needs your explicit consent; nothing was sent.');
                continue;
              }
            }
            const { jobId } = await p.submit({ modelId: 'mock-image', prompt: node.params.prompt ?? '', referenceAssetIds: [] }, null);
            outputs.set(id, `mock-generation:${jobId}`);
            emit(id, 'completed', p.isMock ? 'MOCK provider: no image generated, no network call.' : 'Generated.', outputs.get(id));
            break;
          }
          case 'artcraftEdit': {
            const app = this.deps.apps[node.params.appId ?? ''];
            if (!app) throw new Error(`App adapter "${node.params.appId}" is not available.`);
            let params: Record<string, unknown> = {};
            try { params = JSON.parse(node.params.commandParams || '{}'); } catch { throw new Error('Command parameters are not valid JSON.'); }
            const { documentId } = await app.open(input ?? '');
            const r = await app.execute(documentId, { command: node.params.command ?? '', params });
            const out = r.outputAssetIds[0] ? `asset:${r.outputAssetIds[0]}` : r.checkpointId;
            outputs.set(id, out);
            emit(id, 'completed', app.isMock
              ? `MOCK ${node.params.appId}: no real app was driven.`
              : `${node.params.command} applied by PhotoCraft; ${r.outputAssetIds.length} new version(s) added to the library.`, out);
            break;
          }
          case 'approval': {
            emit(id, 'awaiting_approval', node.params.note || 'Waiting for your approval.');
            const approved = await o.requestApproval(id, node.params.note || 'Approve to continue');
            if (o.signal?.aborted) {
              for (const rest of order.slice(order.indexOf(id))) emit(rest, 'cancelled');
              return finish(false, true);
            }
            if (!approved) {
              halted.add(id);
              emit(id, 'failed', 'Rejected. Downstream nodes will not run.');
              continue;
            }
            outputs.set(id, input ?? '');
            emit(id, 'completed', 'Approved.', input);
            break;
          }
          case 'export': {
            const format = node.params.format || 'png';
            if (!this.deps.exportAsset) {
              emit(id, 'completed', `MOCK export (${format}): no file written.`);
              break;
            }
            if (!input?.startsWith('asset:')) throw new Error('Nothing real to export: the upstream node produced no file.');
            const name = await this.deps.exportAsset(input.slice('asset:'.length), format);
            emit(id, 'completed', `Exported exports/${name}`, `export:${name}`);
            break;
          }
        }
      } catch (err) {
        halted.add(id);
        emit(id, 'failed', err instanceof Error ? err.message : String(err));
      }
    }
    return finish(halted.size === 0, false);
  }
}

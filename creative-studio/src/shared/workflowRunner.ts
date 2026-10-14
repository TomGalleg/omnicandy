// Workflow runner. Walks the graph in topological order; an Import node can bring in many files
// (a batch), and every later step runs once per file, step by step (so an Approval step sees all
// files at once). All side effects go through injected adapters: real ones (the ArtCraft apps'
// command-line engines, the Deliver queue) or explicitly labelled mocks. A file that fails a step
// stops there; the other files carry on. Billable providers are refused without explicit consent.

import type { AppAdapter, GenerationProvider, WorkflowExecutor, WorkflowRunOptions, WorkflowRunResult } from './contracts';
import { modelById, type ImageJob } from './generation';
import { topologicalOrder, validateGraph, type NodeRunStatus, type WorkflowGraph } from './workflow';

export interface StepRequest { appId: string; opId: string; values: Record<string, unknown> }

export interface RunnerDeps {
  apps: Record<string, AppAdapter>;
  providers: Record<string, GenerationProvider>;
  /** Library files for an Import node: chosen files, or a folder imported into the library first. */
  resolveImport?: (params: Record<string, string>, signal?: AbortSignal) => Promise<Array<{ assetId: string; name: string }>>;
  /**
   * Runs one app edit on a file in the background (no window) and adds the result as new versions.
   * `inputs` are the file's current versions, main first; the step picks the one the app can open.
   */
  applyStep?: (step: StepRequest, inputs: string[], signal?: AbortSignal) => Promise<{ assetIds: string[]; message: string }>;
  /** Exports a file with Deliver presets (exports folder + manifest); returns the file names. */
  deliver?: (inputs: string[], presetIds: string[], signal?: AbortSignal) => Promise<string[]>;
  /** Legacy single-format export (PhotoCraft convert). Absent with no `deliver` → export is simulated. */
  exportAsset?: (assetId: string, format: string) => Promise<string>;
  /** Real image generation for AI Generate steps with a model (approval, spending limit and ledger live behind it). */
  generateImage?: (job: ImageJob, signal?: AbortSignal) => Promise<{ assetIds: string[]; names: string[]; message: string }>;
  /** Delay per node so the UI can show progress; 0 in tests. */
  stepMs?: number;
  newRunId?: () => string;
}

/** Old graphs stored one export format; Deliver presets replace it. */
const LEGACY_FORMAT: Record<string, string> = { png: 'image-png', jpg: 'image-jpg', webp: 'image-webp', tif: 'image-tiff', psd: 'image-psd' };
export function exportPresetsOf(params: Record<string, string>): string[] {
  const list = (params.presets ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  return params.format && LEGACY_FORMAT[params.format] ? [LEGACY_FORMAT[params.format]!] : [];
}

/** The files an Import node names (JSON list in `assetIds`, or the single legacy `assetId`). */
export function importAssetIds(params: Record<string, string>): string[] {
  let ids: string[] = [];
  try { const v = JSON.parse(params.assetIds || '[]') as unknown; if (Array.isArray(v)) ids = v.filter((x): x is string => typeof x === 'string'); } catch { /* invalid → none */ }
  if (!ids.length && params.assetId) ids = [params.assetId];
  return [...new Set(ids)];
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
    (n.type === 'aiGenerate' && !(n.params.modelId && deps.generateImage) && (deps.providers[n.params.providerId ?? '']?.isMock ?? true)) ||
    (n.type === 'artcraftEdit' && !(n.params.opId && deps.applyStep) && (deps.apps[n.params.appId ?? '']?.isMock ?? true)) ||
    (n.type === 'export' && !deps.deliver && !deps.exportAsset));
}

/** One file going through the workflow: its current versions (main first), or null once it stopped. */
interface Item { name: string; refs: string[] | null }

export class WorkflowRunner implements WorkflowExecutor {
  readonly isMock = false;
  constructor(private readonly deps: RunnerDeps) {}

  async run(graph: WorkflowGraph, o: WorkflowRunOptions): Promise<WorkflowRunResult> {
    const runId = this.deps.newRunId?.() ?? `run-${Date.now()}`;
    const emit = (nodeId: string, status: NodeRunStatus, message?: string, outputRef?: string) =>
      o.onEvent({ kind: 'node-status', runId, nodeId, status, message, outputRef });
    const emitItem = (nodeId: string, item: number, name: string, status: NodeRunStatus, message?: string, assetId?: string) =>
      o.onEvent({ kind: 'item-status', runId, nodeId, item, name, status, message, assetId });
    const outputs = new Map<string, Item[]>();
    const halted = new Set<string>(); // nodes that did not complete; their descendants are blocked
    const finish = (ok: boolean, cancelled: boolean): WorkflowRunResult => {
      o.onEvent({ kind: 'run-finished', runId, ok, cancelled });
      const kept: Record<string, Item[]> = {};
      for (const [k, v] of outputs) if (!halted.has(k)) kept[k] = v;
      return { ok, cancelled, outputs: kept };
    };

    o.onEvent({ kind: 'run-started', runId, mock: graphUsesMocks(graph, this.deps) });
    const issues = validateGraph(graph);
    if (issues.length) {
      for (const i of issues) if (i.nodeId) emit(i.nodeId, 'failed', i.message);
      return finish(false, false);
    }

    const order = topologicalOrder(graph);
    for (const id of order) emit(id, 'queued');

    let anyFailed = false;
    const cancelFrom = (id: string) => { for (const rest of order.slice(order.indexOf(id))) emit(rest, 'cancelled'); return finish(false, true); };

    for (const id of order) {
      if (o.signal?.aborted) return cancelFrom(id);
      if (o.pause?.isPaused()) {
        o.onEvent({ kind: 'run-paused', runId, paused: true });
        await o.pause.wait(o.signal);
        if (o.signal?.aborted) return cancelFrom(id);
        o.onEvent({ kind: 'run-paused', runId, paused: false });
      }
      const node = graph.nodes.find((n) => n.id === id)!;
      const kept = o.reuse?.[id];
      if (kept) {
        // Not affected by the change: keep what the earlier run produced.
        outputs.set(id, kept.map((k) => ({ name: k.name, refs: k.refs ? [...k.refs] : null })));
        if (node.type === 'import') o.onEvent({ kind: 'run-items', runId, names: kept.map((k) => k.name) });
        emit(id, 'completed', 'Kept from the earlier run (nothing upstream changed).', kept.find((k) => k.refs)?.refs?.[0] ? `asset:${kept.find((k) => k.refs)!.refs![0]}` : undefined);
        continue;
      }
      const upstream = graph.edges.filter((e) => e.target === id).map((e) => e.source);
      if (upstream.some((u) => halted.has(u))) {
        halted.add(id);
        emit(id, 'blocked', 'An upstream step did not complete.');
        continue;
      }
      emit(id, 'running');
      await sleep(this.deps.stepMs ?? 0, o.signal);
      const input = upstream.map((u) => outputs.get(u)).find(Boolean) ?? [];
      const live = input.map((it, i) => ({ it, i })).filter((x) => x.it.refs);

      /** Runs `fn` for every file still going; per-file failures stop only that file. */
      const perItem = async (fn: (it: Item, i: number) => Promise<{ refs: string[]; message?: string }>) => {
        const out: Item[] = input.map((it) => ({ name: it.name, refs: null }));
        let done = 0, failed = 0;
        for (const { it, i } of live) {
          if (o.signal?.aborted) return null;
          emitItem(id, i, it.name, 'running');
          try {
            const r = await fn(it, i);
            out[i] = { name: it.name, refs: r.refs };
            done++;
            emitItem(id, i, it.name, 'completed', r.message, r.refs[0]);
          } catch (err) {
            failed++;
            emitItem(id, i, it.name, 'failed', err instanceof Error ? err.message : String(err));
          }
          if (live.length > 1) emit(id, 'running', `${done + failed} of ${live.length} files`);
        }
        if (failed) anyFailed = true;
        return { out, done, failed };
      };
      const summary = (done: number, failed: number, what: string) =>
        live.length === 1 && !failed ? what : `${what}: ${done} of ${live.length} file${live.length === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.`;

      try {
        switch (node.type) {
          case 'import': {
            const files = this.deps.resolveImport
              ? await this.deps.resolveImport(node.params, o.signal)
              : importAssetIds(node.params).map((assetId) => ({ assetId, name: assetId }));
            if (!files.length) throw new Error('No files to work on.');
            const items = files.map((f) => ({ name: f.name, refs: [f.assetId] }));
            outputs.set(id, items);
            o.onEvent({ kind: 'run-items', runId, names: items.map((x) => x.name) });
            items.forEach((it, i) => emitItem(id, i, it.name, 'completed', 'Original (read-only).', it.refs[0]));
            emit(id, 'completed', files.length === 1 ? 'Original referenced (read-only).' : `${files.length} files (originals stay read-only).`, `asset:${files[0]!.assetId}`);
            break;
          }
          case 'aiGenerate': {
            if (node.params.modelId && this.deps.generateImage) {
              // A real (or offline Mock) model: the same approval, spending limit and provenance as AI Generate.
              const m = modelById(node.params.modelId);
              if (!m) throw new Error(`Unknown image model "${node.params.modelId}".`);
              let settings: Record<string, string> = {};
              try { settings = JSON.parse(node.params.settings || '{}') as Record<string, string>; } catch { throw new Error('Image settings are not valid JSON.'); }
              const ref = live[0]?.it.refs?.[0];
              const r = await this.deps.generateImage({
                modelId: m.id, prompt: node.params.prompt ?? '', settings, count: Math.max(1, Number(node.params.count) || 1),
                referenceAssetIds: ref && m.capabilities.includes('image-edit') ? [ref] : [],
              }, o.signal);
              const items: Item[] = r.assetIds.map((assetId, i) => ({ name: r.names[i] ?? `Image ${i + 1}`, refs: [assetId] }));
              outputs.set(id, items);
              if (!graph.nodes.some((n) => n.type === 'import')) o.onEvent({ kind: 'run-items', runId, names: items.map((x) => x.name) });
              items.forEach((it, i) => emitItem(id, i, it.name, 'completed', 'Generated.', it.refs![0]));
              emit(id, 'completed', r.message, `asset:${r.assetIds[0]}`);
              break;
            }
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
            outputs.set(id, [{ name: 'Generated', refs: null }]);
            emit(id, 'completed', p.isMock ? 'MOCK provider: no image generated, no network call.' : 'Generated.', `mock-generation:${jobId}`);
            break;
          }
          case 'artcraftEdit': {
            const appId = node.params.appId ?? '';
            const opId = node.params.opId ?? '';
            let r;
            if (opId && this.deps.applyStep) {
              let values: Record<string, unknown> = {};
              try { values = JSON.parse(node.params.values || '{}') as Record<string, unknown>; } catch { throw new Error('Step settings are not valid JSON.'); }
              r = await perItem(async (it) => {
                const res = await this.deps.applyStep!({ appId, opId, values }, it.refs!, o.signal);
                return { refs: res.assetIds, message: res.message };
              });
            } else {
              const app = this.deps.apps[appId];
              if (!app) throw new Error(`App adapter "${appId}" is not available.`);
              let params: Record<string, unknown> = {};
              try { params = JSON.parse(node.params.commandParams || '{}'); } catch { throw new Error('Command parameters are not valid JSON.'); }
              r = await perItem(async (it) => {
                const { documentId } = await app.open(`asset:${it.refs![0]}`);
                const res = await app.execute(documentId, { command: node.params.command ?? '', params });
                return { refs: res.outputAssetIds.length ? res.outputAssetIds : [res.checkpointId], message: app.isMock ? `MOCK ${appId}` : undefined };
              });
            }
            if (!r) return cancelFrom(id);
            outputs.set(id, r.out);
            const first = r.out.find((x) => x.refs)?.refs?.[0];
            if (!r.done) { halted.add(id); emit(id, 'failed', summary(0, r.failed, 'Failed')); break; }
            const what = opId && this.deps.applyStep ? 'Done; new versions are in the library'
              : this.deps.apps[appId]?.isMock ? `MOCK ${appId}: no real app was driven` : `${node.params.command} applied by PhotoCraft; new versions are in the library`;
            emit(id, 'completed', summary(r.done, r.failed, what), first ? `asset:${first}` : undefined);
            break;
          }
          case 'approval': {
            const all = live.map(({ it, i }) => ({ item: i, name: it.name, assetId: it.refs![0]! }));
            // A result the user already approved stays approved; they are only asked about the rest.
            const before = all.filter((w) => o.isApproved?.(w.assetId));
            const waiting = all.filter((w) => !before.includes(w));
            const approved = new Set<number>(before.map((w) => w.item));
            if (waiting.length) {
              emit(id, 'awaiting_approval', node.params.note || 'Waiting for your approval.');
              o.onEvent({ kind: 'approval-request', runId, nodeId: id, note: node.params.note || '', items: waiting });
              const answer = await o.requestApproval(id, node.params.note || 'Approve to continue', waiting);
              if (o.signal?.aborted) return cancelFrom(id);
              for (const n of answer === true ? waiting.map((w) => w.item) : Array.isArray(answer) ? answer : []) approved.add(n);
            }
            const out = input.map((it, i) => ({ name: it.name, refs: approved.has(i) ? it.refs : null }));
            for (const w of before) emitItem(id, w.item, w.name, 'completed', 'Already approved; kept.', w.assetId);
            for (const w of waiting) emitItem(id, w.item, w.name, approved.has(w.item) ? 'completed' : 'failed', approved.has(w.item) ? 'Approved.' : 'Rejected.', w.assetId);
            outputs.set(id, out);
            if (!approved.size) {
              halted.add(id);
              emit(id, 'failed', 'Rejected. Downstream steps will not run.');
              continue;
            }
            emit(id, 'completed', approved.size === all.length ? 'Approved.' : `Approved ${approved.size} of ${all.length} files.`, all[0] ? `asset:${all[0].assetId}` : undefined);
            break;
          }
          case 'export': {
            const presets = exportPresetsOf(node.params);
            if (!this.deps.deliver && !this.deps.exportAsset) {
              emit(id, 'completed', `MOCK export (${presets.join(', ') || node.params.format}): no file written.`);
              break;
            }
            if (!live.length) throw new Error('Nothing real to export: the upstream step produced no file.');
            if (!presets.length && !this.deps.exportAsset) throw new Error('Pick at least one export format.');
            const files: string[] = [];
            const r = await perItem(async (it) => {
              const names = this.deps.deliver && presets.length
                ? await this.deps.deliver(it.refs!, presets, o.signal)
                : [await this.deps.exportAsset!(it.refs![0]!, node.params.format || 'png')];
              files.push(...names);
              return { refs: it.refs!, message: names.map((n) => `exports/${n}`).join(', ') };
            });
            if (!r) return cancelFrom(id);
            outputs.set(id, r.out);
            if (!r.done) { halted.add(id); emit(id, 'failed', summary(0, r.failed, 'Export failed')); break; }
            emit(id, 'completed', files.length === 1 ? `Exported exports/${files[0]}` : summary(r.done, r.failed, `Exported ${files.length} files`), `export:${files[0]}`);
            break;
          }
        }
      } catch (err) {
        halted.add(id);
        emit(id, 'failed', err instanceof Error ? err.message : String(err));
      }
    }
    return finish(halted.size === 0 && !anyFailed, false);
  }
}

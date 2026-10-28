import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlannerProject } from '@shared/planner';
import { applyCanvasPatch, autoLayout, emptyCanvas, pruneOrphans, type CanvasLayout, type CanvasNodePos, type CanvasPatch } from '@shared/plannerCanvas';
import { buildProjectView, type ProjectView } from '@shared/projectView';

const api = () => window.studio.planner;

/** Folds a second patch into a first, so a burst of drags becomes one write. */
function mergePatch(a: CanvasPatch, b: CanvasPatch): CanvasPatch {
  const out: CanvasPatch = { ...a, ...(b.mode ? { mode: b.mode } : {}), ...(b.viewport !== undefined ? { viewport: b.viewport } : {}) };
  for (const k of ['Nodes', 'Groups', 'Notes', 'Links'] as const) {
    const up = `upsert${k}` as const, rm = `remove${k}` as const;
    const upserts = { ...(a[up] ?? {}), ...(b[up] ?? {}) } as Record<string, unknown>;
    for (const id of b[rm] ?? []) delete upserts[id];
    const removes = [...new Set([...(a[rm] ?? []).filter((id) => !(id in (b[up] ?? {}))), ...(b[rm] ?? [])])];
    (out as Record<string, unknown>)[up] = upserts;
    (out as Record<string, unknown>)[rm] = removes;
  }
  return out;
}

/**
 * The shared view of a plan plus where its cards sit. The view is computed here from the plan (nothing is stored); the layout is a separate
 * file. Moving a card updates the screen at once and is written a moment later, in one go.
 */
export function useCanvas(plan: PlannerProject) {
  const view: ProjectView = useMemo(() => buildProjectView(plan), [plan]);
  const [layout, setLayout] = useState<CanvasLayout>(() => emptyCanvas(new Date()));
  const [note, setNote] = useState<string | null>(null);
  const pending = useRef<CanvasPatch | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const planId = plan.id;

  useEffect(() => {
    let live = true;
    void api().canvasLoad(planId).then((r) => { if (live) { setLayout(r.layout); if (r.recovered) setNote('The saved layout could not be read, so the cards were arranged again.'); } }).catch(() => {});
    const off = api().onEvent((e) => {
      if (e.type === 'canvas.changed' && e.planId === planId) void api().canvasLoad(planId).then((r) => { if (live) setLayout((cur) => (r.layout.layoutRev > cur.layoutRev ? r.layout : cur)); }).catch(() => {});
    });
    return () => { live = false; off(); };
  }, [planId]);

  const flush = useCallback(() => {
    const patch = pending.current;
    pending.current = null;
    timer.current = null;
    if (patch) void api().canvasPatch(planId, patch).catch((e) => setNote(e instanceof Error ? e.message : 'The layout could not be saved.'));
  }, [planId]);
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); flush(); } }, [flush]);

  const patch = useCallback((p: CanvasPatch) => {
    setLayout((cur) => { try { return applyCanvasPatch(cur, p, new Date()); } catch { return cur; } });
    pending.current = pending.current ? mergePatch(pending.current, p) : p;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 300);
  }, [flush]);

  /** A position for every card: the saved one, else the automatic arrangement. */
  const auto = useMemo(() => autoLayout(view), [view]);
  const positions = useMemo(() => {
    const kept = pruneOrphans(layout, view).nodes;
    const out: Record<string, CanvasNodePos> = {};
    for (const n of view.nodes) out[n.id] = kept[n.id] ?? auto[n.id] ?? { x: 0, y: 0 };
    return out;
  }, [layout, view, auto]);

  const arrange = useCallback(() => patch({ removeNodes: Object.keys(layout.nodes) }), [layout.nodes, patch]);
  return { view, layout, positions, patch, arrange, note, clearNote: () => setNote(null) };
}

// Turns Claude's proposed workflow (steps + connections, by readable names) into a real WorkflowGraph
// for the existing engine: every connection goes through validateConnection, the whole graph through
// validateGraph, apps/edits/presets/models are checked against the same catalogues the UI uses.
// Pure: nothing is saved, run or billed here.

import { EDITOR_APPS, checkEditValues, type EditorAppId } from './appEditors';
import { presetById } from './deliver';
import { estimateCost, formatUsd, modelById, providerById } from './generation';
import { autoLayout } from './workflowLayout';
import {
  NODE_SPECS, isNodeType, validateConnection, validateGraph,
  type WorkflowEdge, type WorkflowGraph, type WorkflowNode, type WorkflowNodeType,
} from './workflow';

export interface PlanStepInput {
  key: string;
  type: WorkflowNodeType;
  /** import: library file names. */
  files?: string[];
  /** aiGenerate */
  model_id?: string;
  prompt?: string;
  count?: number;
  settings?: Record<string, string>;
  /** artcraftEdit */
  app?: string;
  edit?: string;
  edit_settings?: Record<string, unknown>;
  /** approval */
  note?: string;
  /** export: Deliver preset ids */
  presets?: string[];
}
export interface PlanConnectionInput { from: string; to: string; from_port?: string; to_port?: string }
export interface PlanInput { title: string; explanation: string; steps: PlanStepInput[]; connections: PlanConnectionInput[] }

export interface PlanContext {
  /** Library files by exact name. */
  assets: Array<{ id: string; name: string; sourceFormat: string }>;
  /** Provider ids that have a saved key (status only). */
  configuredProviders: string[];
}

export interface PlanStep { id: string; key: string; type: WorkflowNodeType; title: string; detail: string; costUsd?: number }
export interface WorkflowPlan {
  title: string;
  explanation: string;
  graph: WorkflowGraph;
  steps: PlanStep[];
  /** Estimated paid generation for one run (USD); 0 when nothing is billable. */
  totalCostUsd: number;
  costNote: string;
  /** What will stop and wait for the user. */
  approvals: string[];
  /** Things that will not work yet or deserve a look; the plan is still usable. */
  warnings: string[];
}
export type PlanResult = { ok: true; plan: WorkflowPlan } | { ok: false; issues: string[] };

export function buildWorkflowPlan(input: PlanInput, ctx: PlanContext): PlanResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const approvals: string[] = [];
  const nodes: WorkflowNode[] = [];
  const steps: PlanStep[] = [];
  const idByKey = new Map<string, string>();
  const fmts = new Set<string>();
  let total = 0;
  let anyPaid = false;

  if (!input.steps.length) issues.push('The workflow has no steps.');
  if (input.steps.length > 30) issues.push('Too many steps (30 at most).');

  input.steps.forEach((s, i) => {
    const where = `Step "${s.key}"`;
    if (idByKey.has(s.key)) { issues.push(`${where}: key used twice.`); return; }
    if (!isNodeType(s.type)) { issues.push(`${where}: unknown type "${String(s.type)}". Use import, aiGenerate, artcraftEdit, approval or export.`); return; }
    const id = `n${i + 1}-${s.type}`;
    idByKey.set(s.key, id);
    const params: Record<string, string> = { ...NODE_SPECS[s.type].defaultParams };
    let title: string = NODE_SPECS[s.type].label;
    let detail = '';
    let cost: number | undefined;

    switch (s.type) {
      case 'import': {
        const names = s.files ?? [];
        const found = names.map((n) => ({ n, a: ctx.assets.find((x) => x.name === n) }));
        for (const f of found) if (!f.a) issues.push(`${where}: no library file named "${f.n}".`);
        const ok = found.filter((f) => f.a).map((f) => f.a!);
        if (!names.length) issues.push(`${where}: list the library files to work on (see list_files).`);
        params.mode = 'files';
        params.assetIds = JSON.stringify(ok.map((a) => a.id));
        params.assetId = '';
        ok.forEach((a) => fmts.add(a.sourceFormat.toLowerCase()));
        detail = `${ok.length} file${ok.length === 1 ? '' : 's'}: ${ok.map((a) => a.name).slice(0, 3).join(', ')}${ok.length > 3 ? ', …' : ''}. Originals stay read-only.`;
        title = 'Pick files';
        break;
      }
      case 'aiGenerate': {
        const m = modelById(s.model_id ?? '');
        if (!m) { issues.push(`${where}: unknown model "${s.model_id ?? ''}". Use a model_id from list_image_models.`); break; }
        const prov = providerById(m.provider)!;
        const count = s.count ?? 1;
        if (!Number.isInteger(count) || count < 1 || count > m.maxCount) { issues.push(`${where}: count must be 1–${m.maxCount}.`); break; }
        const prompt = (s.prompt ?? '').trim();
        if (!prompt) { issues.push(`${where}: a prompt is needed.`); break; }
        const settings: Record<string, string> = {};
        for (const ms of m.settings) {
          const v = s.settings?.[ms.key] ?? ms.default;
          if (!ms.options.some((o) => o.value === v)) { issues.push(`${where}: "${v}" is not a choice for ${ms.label} (${ms.options.map((o) => o.value).join(', ')}).`); }
          settings[ms.key] = v;
        }
        for (const k of Object.keys(s.settings ?? {})) if (!m.settings.some((x) => x.key === k)) issues.push(`${where}: unknown setting "${k}".`);
        params.providerId = m.provider;
        params.modelId = m.id;
        params.prompt = prompt;
        params.count = String(count);
        params.settings = JSON.stringify(settings);
        title = `Generate with ${m.label}`;
        if (prov.billable) {
          anyPaid = true;
          try { cost = estimateCost({ modelId: m.id, prompt, referenceAssetIds: [], settings, count }).amount; } catch (e) { issues.push(`${where}: ${(e as Error).message}`); }
          total += cost ?? 0;
          approvals.push(`${title}: you approve the price before any paid call is sent.`);
          if (!ctx.configuredProviders.includes(m.provider)) warnings.push(`${title}: ${prov.label} has no API key yet (add it in Settings).`);
          warnings.push(`${title}: running paid generation inside workflows is not enabled yet, so this step will stop and send nothing.`);
        } else {
          warnings.push(`${title}: the Mock provider draws a test pattern; no real image is made.`);
        }
        detail = `${count} image${count === 1 ? '' : 's'}, “${prompt.length > 70 ? `${prompt.slice(0, 70)}…` : prompt}”${cost !== undefined ? `, about ${formatUsd(cost)}` : ', free'}.`;
        break;
      }
      case 'artcraftEdit': {
        const app = EDITOR_APPS[(s.app ?? '') as EditorAppId];
        if (!app) { issues.push(`${where}: unknown app "${s.app ?? ''}".`); break; }
        const op = app.quickEdits.find((q) => q.id === s.edit);
        if (!op) { issues.push(`${where}: ${app.name} has no edit "${s.edit ?? ''}". Choose from: ${app.quickEdits.map((q) => q.id).join(', ')}.`); break; }
        const chk = checkEditValues(op, s.edit_settings ?? {});
        if (!chk.ok) { issues.push(`${where}: ${chk.reason}`); break; }
        params.appId = app.id;
        params.opId = op.id;
        params.values = JSON.stringify(chk.values);
        params.command = '';
        params.commandParams = '';
        title = `${app.name}: ${op.label}`;
        detail = `Runs in the background in ${app.name}; each file gets a new version.`;
        break;
      }
      case 'approval':
        params.note = (s.note ?? '').slice(0, 300);
        title = 'Your approval';
        detail = params.note || 'You look at every result and approve or reject.';
        approvals.push(`Your approval: ${params.note || 'review every result before continuing'}.`);
        break;
      case 'export': {
        const ids = s.presets?.length ? s.presets : ['image-jpg'];
        const bad = ids.filter((p) => !presetById(p));
        if (bad.length) { issues.push(`${where}: unknown export preset ${bad.join(', ')} (see list_export_formats).`); break; }
        params.presets = ids.join(',');
        title = 'Export';
        detail = ids.map((p) => presetById(p)!.label).join(', ');
        break;
      }
    }
    nodes.push({ id, type: s.type, position: { x: 0, y: 0 }, params });
    steps.push({ id, key: s.key, type: s.type, title, detail, costUsd: cost });
  });

  // Connections, one by one through the engine's own rule.
  const edges: WorkflowEdge[] = [];
  const draft: WorkflowGraph = { schemaVersion: 1, nodes, edges };
  input.connections.forEach((c, i) => {
    const src = idByKey.get(c.from);
    const tgt = idByKey.get(c.to);
    if (!src || !tgt) { issues.push(`Connection ${c.from} → ${c.to}: unknown step key.`); return; }
    const sn = nodes.find((n) => n.id === src)!;
    const tn = nodes.find((n) => n.id === tgt)!;
    // Default ports: first output; first input that is still free.
    const sh = c.from_port ?? NODE_SPECS[sn.type].outputs[0]?.id;
    const th = c.to_port ?? NODE_SPECS[tn.type].inputs.find((p) => !edges.some((e) => e.target === tgt && e.targetHandle === p.id))?.id ?? NODE_SPECS[tn.type].inputs[0]?.id;
    if (!sh || !th) { issues.push(`Connection ${c.from} → ${c.to}: ${NODE_SPECS[sn.type].label} has no output or ${NODE_SPECS[tn.type].label} has no input.`); return; }
    const r = validateConnection(draft, { source: src, sourceHandle: sh, target: tgt, targetHandle: th });
    if (!r.ok) { issues.push(`Connection ${c.from} → ${c.to}: ${r.reason}`); return; }
    edges.push({ id: `e${i + 1}`, source: src, sourceHandle: sh, target: tgt, targetHandle: th });
  });

  if (!issues.length) for (const g of validateGraph(draft)) issues.push(g.message);
  if (issues.length) return { ok: false, issues };

  const pos = autoLayout(draft);
  for (const n of nodes) n.position = pos[n.id] ?? n.position;

  // Edits whose app cannot open the picked files: a warning only (the runner reports per file).
  for (const s of input.steps) {
    if (s.type !== 'artcraftEdit' || !fmts.size) continue;
    const app = EDITOR_APPS[(s.app ?? '') as EditorAppId];
    const bad = [...fmts].filter((f) => !app.formats.includes(f));
    if (bad.length) warnings.push(`${app.name} may not open .${bad.join(', .')} files; those files would stop at that step.`);
  }
  if (!nodes.some((n) => n.type === 'approval')) warnings.push('There is no approval step, so results flow to the end without you looking at them.');

  return {
    ok: true,
    plan: {
      title: input.title.slice(0, 120),
      explanation: input.explanation.slice(0, 2000),
      graph: draft,
      steps,
      totalCostUsd: Math.round(total * 10000) / 10000,
      costNote: anyPaid
        ? `About ${formatUsd(total)} of paid image generation per run (estimate). Nothing is sent without your approval.`
        : 'No paid generation: running this costs nothing.',
      approvals,
      warnings,
    },
  };
}

/** Compact catalogue Claude reads before planning (same data the editor offers). */
export function workflowCatalog() {
  return {
    step_types: {
      import: 'Pick library files to work on. Fields: files (exact names from list_files). Output: files.',
      aiGenerate: 'Make new pictures with an image model. Fields: model_id (list_image_models), prompt, count, settings. Output: images. Paid models need user approval.',
      artcraftEdit: 'One quick edit in an ArtCraft app, in the background. Fields: app, edit, edit_settings. Input: files. Output: files.',
      approval: 'Pauses for the user to approve or reject each result. Fields: note. Input: files. Output: approved files.',
      export: 'Writes finished files with Deliver presets. Fields: presets. Input: files.',
    },
    apps: Object.values(EDITOR_APPS).map((a) => ({
      app: a.id, name: a.name, formats: a.formats,
      edits: a.quickEdits.map((q) => ({
        edit: q.id, label: q.label,
        settings: Object.fromEntries(q.params.map((p) => [p.key, p.type === 'select' ? { options: p.options.map((o) => o.value), default: p.default } : p.type === 'number' ? { min: p.min, max: p.max, default: p.default } : { text: true, default: p.default }])),
      })),
    })),
    connection_rules: 'Connect steps with from/to keys. A step has one input; approval and export accept anything; import and aiGenerate (reference) have no required input. No cycles.',
  };
}

// ---- Changing one step of an existing workflow (same checks as planning) ----

export interface StepChange {
  /** import: exact library file names. */
  files?: string[];
  app?: string;
  edit?: string;
  edit_settings?: Record<string, unknown>;
  note?: string;
  presets?: string[];
  /** aiGenerate: the prompt only (paid generation stays blocked in workflows). */
  prompt?: string;
}

export type StepChangeResult = { ok: true; graph: WorkflowGraph; summary: string } | { ok: false; issue: string };

export function changeStep(graph: WorkflowGraph, nodeId: string, c: StepChange, ctx: PlanContext): StepChangeResult {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, issue: `There is no step "${nodeId}". Use the step ids from workflow_status.` };
  const params = { ...node.params };
  const allowed: Record<WorkflowNodeType, Array<keyof StepChange>> = {
    import: ['files'], artcraftEdit: ['app', 'edit', 'edit_settings'], approval: ['note'], export: ['presets'], aiGenerate: ['prompt'],
  };
  const given = (Object.keys(c) as Array<keyof StepChange>).filter((k) => c[k] !== undefined);
  if (!given.length) return { ok: false, issue: 'Nothing to change was given.' };
  const wrong = given.filter((k) => !allowed[node.type].includes(k));
  if (wrong.length) return { ok: false, issue: `A ${NODE_SPECS[node.type].label} step can't take ${wrong.join(', ')}. It accepts: ${allowed[node.type].join(', ')}.` };
  let summary = '';
  switch (node.type) {
    case 'import': {
      const found = (c.files ?? []).map((n) => ({ n, a: ctx.assets.find((x) => x.name === n) }));
      const missing = found.filter((f) => !f.a).map((f) => f.n);
      if (missing.length) return { ok: false, issue: `No library file named ${missing.map((m) => `"${m}"`).join(', ')}.` };
      if (!found.length) return { ok: false, issue: 'List at least one library file.' };
      params.mode = 'files'; params.assetIds = JSON.stringify(found.map((f) => f.a!.id)); params.assetId = '';
      summary = `Files: ${found.length} file${found.length === 1 ? '' : 's'}`;
      break;
    }
    case 'artcraftEdit': {
      const appId = (c.app ?? params.appId ?? '') as EditorAppId;
      const app = EDITOR_APPS[appId];
      if (!app) return { ok: false, issue: `Unknown app "${appId}".` };
      const editChanged = c.edit !== undefined || c.app !== undefined;
      const opId = c.edit ?? (c.app !== undefined && c.app !== params.appId ? '' : params.opId ?? '');
      const op = app.quickEdits.find((q) => q.id === opId);
      if (!op) return { ok: false, issue: `${app.name} has no edit "${opId}". Choose from: ${app.quickEdits.map((q) => q.id).join(', ')}.` };
      let current: Record<string, unknown> = {};
      try { current = JSON.parse(params.values || '{}') as Record<string, unknown>; } catch { /* defaults */ }
      const chk = checkEditValues(op, c.edit_settings ?? (editChanged ? {} : current));
      if (!chk.ok) return { ok: false, issue: chk.reason };
      params.appId = app.id; params.opId = op.id; params.values = JSON.stringify(chk.values); params.command = ''; params.commandParams = '';
      summary = `${app.name}: ${op.label}`;
      break;
    }
    case 'approval': params.note = (c.note ?? '').slice(0, 300); summary = `Approval note: ${params.note || '(none)'}`; break;
    case 'export': {
      const ids = c.presets ?? [];
      const bad = ids.filter((p) => !presetById(p));
      if (!ids.length || bad.length) return { ok: false, issue: bad.length ? `Unknown export preset ${bad.join(', ')} (see list_export_formats).` : 'List at least one export preset.' };
      params.presets = ids.join(','); params.format = '';
      summary = `Export: ${ids.map((p) => presetById(p)!.label).join(', ')}`;
      break;
    }
    case 'aiGenerate': {
      const prompt = (c.prompt ?? '').trim();
      if (!prompt) return { ok: false, issue: 'A prompt is needed.' };
      params.prompt = prompt.slice(0, 4000); summary = 'Prompt changed';
      break;
    }
  }
  const next: WorkflowGraph = { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, params } : n)) };
  const issues = validateGraph(next);
  if (issues.length) return { ok: false, issue: issues.map((i) => i.message).join(' ') };
  return { ok: true, graph: next, summary };
}

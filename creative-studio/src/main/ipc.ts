// Narrow IPC surface. Every handler validates its arguments and checks the sender frame.

import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC, type GenerateResultDto, type ImportResult, type IntegrationSnapshot, type ProviderStatusDto } from '@shared/ipc';
import { formatUsd, MAX_PROMPT, PROVIDERS } from '@shared/generation';
import { resolveTheme } from '@shared/theme';
import type { AppearanceSettings } from '@shared/types';
import { MockArtCraftAdapter, MockGenerationProvider } from '@shared/mocks';
import { validateGraph, type WorkflowGraph, type WorkflowRunEvent } from '@shared/workflow';
import { builtinTemplates } from '@shared/templates';
import { affectedNodes, reusableOutputs, RunMonitor, sameAsRun, templateGraph, templateSlug, type RunOutputs, type WorkflowTemplate } from '@shared/workflowControl';
import { changeStep, type StepChange, type WorkflowPlan } from '@shared/workflowPlan';
import { exportPresetsOf, importAssetIds, WorkflowRunner, type RunnerDeps } from '@shared/workflowRunner';
import { probeAllArtCraftApps } from './artcraftProbe';
import { IMPORTABLE_EXTENSIONS, kindForExtension } from './media';
import { AppEditors } from './appEditors';
import { randomUUID } from 'node:crypto';
import { ClaudePartner, defaultClaudeCli, type PlanReference } from './claudePartner';
import { LiveTaskController } from './liveTask';
import { PhotoCraftCliAdapter } from './photocraftCli';
import type { ProjectManager } from './projects';
import { EDITOR_APPS, type EditorAppId } from '@shared/appEditors';
import { DeliverQueue } from './deliver';
import { WorkflowSteps } from './workflowSteps';
import type { EmbeddedApp } from './embeddedApp';
import { LiveDesignCraft, LiveEffectCraft, LiveFilmCraft, LiveLightCraft, LiveSoundCraft, LiveVectorCraft, LiveWordCraft, LivePdfCraft, LiveGridCraft, LiveDeckCraft } from './liveApps';
import { LivePhotoCraft } from './photocraftLive';
import type { ProjectStore } from './projectStore';
import { parseWorkflow } from './schemas';
import { UnavailableWindowCapture } from './services';
import { SafeStorageVault } from './credentialVault';
import { GenerationService, type ApprovalRequest } from './generation';
import { VideoService } from './videoGeneration';
import { MotionService } from './motionEffects';
import { detectHardware } from './hardware';
import { ModelDownloads } from './modelDownloads';
import { LocalVideoService } from './localVideo';
import { LOCAL_PRESETS, MAX_LOCAL_PROMPT } from '@shared/localVideo';
import fsp from 'node:fs/promises';
import { LOCAL_MODELS, modelFit, SDCPP_RUNTIME, tierFor, TIER_LABEL, totalBytes, warningsFor } from '@shared/localAi';
import { MOTION_ASPECTS, MOTION_FPS, MOTION_INTENSITIES, MOTION_PRESETS, MOTION_RESOLUTIONS } from '@shared/motionEffects';
import { MAX_VIDEO_PROMPT } from '@shared/video';
import type { SettingsStore } from './settingsStore';

export interface IpcDeps {
  window: () => BrowserWindow | null;
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean;
  settings: SettingsStore;
  onAppearanceChanged: (s: AppearanceSettings) => void;
  project: () => Promise<ProjectStore>;
  projects: ProjectManager;
  /** Private per-user directory for secrets such as control tokens. Never exposed to the renderer. */
  secretsDir: string;
  /** Pop-out control panel docked to an external app window. */
  panel: { open(pid: number): Promise<void>; close(): void; readonly isOpen: boolean; onClosed(cb: () => void): void };
  /** The live app window shown inside the Edit area. */
  embedded: EmbeddedApp;
}

const strip = (e: { id: string; app: string; assetId: string; assetName: string; workPath: string; openedAt: string }) =>
  ({ id: e.id, app: e.app, assetId: e.assetId, assetName: e.assetName, workPath: e.workPath, openedAt: e.openedAt });

export function registerIpc(d: IpcDeps): void {
  const handle = <A extends unknown[]>(channel: string, schema: z.ZodType<A>, fn: (...args: A) => unknown) => {
    ipcMain.handle(channel, (e, ...raw) => {
      if (!d.isTrustedSender(e)) throw new Error('Untrusted sender.');
      return fn(...schema.parse(raw));
    });
  };
  const none = z.tuple([]);
  /** Per-project singletons register here; switching projects clears them. */
  const resetters: Array<() => void> = [];

  const capture = new UnavailableWindowCapture();
  const vault = new SafeStorageVault(path.join(d.secretsDir, 'providers'), safeStorage);
  const mockProvider = new MockGenerationProvider();
  // PhotoCraft is REAL when photocraft-cli.exe is installed; otherwise a labelled mock stands in.
  let depsPromise: Promise<RunnerDeps> | null = null;
  resetters.push(() => { depsPromise = null; });
  const runnerDeps = () => (depsPromise ??= (async () => {
    const store = await d.project();
    const photocraft = await PhotoCraftCliAdapter.create(store);
    return {
      apps: { photocraft: photocraft ?? new MockArtCraftAdapter('photocraft', 'PhotoCraft') },
      providers: { mock: mockProvider },
      exportAsset: photocraft ? (assetId: string, format: string) => photocraft.exportAsset(assetId, format) : undefined,
      stepMs: 250,
    };
  })());

  interface RunCtl { abort: AbortController; approvals: Map<string, (ok: boolean | number[]) => void>; resumers: Array<() => void>; paused: boolean; by: 'user' | 'claude'; items: Map<string, Array<{ item: number; name: string; assetId: string }>> }
  let running: RunCtl | null = null;
  /** The last finished run: what each step produced, so a change only reruns what it affects. */
  let lastRun: { graph: WorkflowGraph; outputs: RunOutputs; ok: boolean } | null = null;
  let control: 'user' | 'claude' = 'claude';
  const monitor = new RunMonitor();
  const watchers = new Set<() => void>();

  handle(IPC.getAppearance, none, () => d.settings.load());
  handle(IPC.setAppearance, z.tuple([z.unknown()]), async (raw) => {
    const s = await d.settings.save(raw);
    d.onAppearanceChanged(s);
    void syncAppTheme();
    return s;
  });
  /** Matches the open ArtCraft app to CreateCraft's current look (if the user allows it). */
  const syncAppTheme = async () => {
    if (!livePromise) return;
    const s = await d.settings.load();
    if (!s.syncApps) return;
    await (await live()).applyAppTheme(resolveTheme(s, nativeTheme.shouldUseDarkColors));
  };
  nativeTheme.on('updated', () => { void syncAppTheme(); });

  handle(IPC.loadProject, none, async () => (await d.project()).loadManifest());

  handle(IPC.importAssets, none, async (): Promise<ImportResult> => {
    const win = d.window();
    const pick = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    const result: ImportResult = { imported: [], duplicates: [], errors: [] };
    if (pick.canceled) return result;
    const store = await d.project();
    for (const p of pick.filePaths) {
      try {
        const r = await store.importFile(p);
        if (r.duplicateOf) result.duplicates.push({ name: r.asset.name, duplicateOf: r.duplicateOf });
        else result.imported.push(r.asset);
      } catch (err) {
        result.errors.push(`${p.split(/[\\/]/).pop()}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  });
  const opts: Electron.OpenDialogOptions = {
    title: 'Import into project (originals are copied, never modified)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Supported media', extensions: IMPORTABLE_EXTENSIONS }],
  };

  handle(IPC.setAssetRating, z.tuple([z.string().max(128), z.number().int().min(0).max(5)]), async (id, rating) =>
    (await d.project()).setRating(id, rating),
  );

  handle(IPC.loadWorkflow, none, async () => (await d.project()).loadWorkflow());
  handle(IPC.saveWorkflow, z.tuple([z.unknown()]), async (raw) => {
    const g = parseWorkflow(raw);
    await (await d.project()).saveWorkflow(g);
    return { ok: true as const };
  });

  // ---- Workflow run control: one engine, shared by the visual editor and Claude ----
  const emitWf = (ev: WorkflowRunEvent) => {
    if (ev.kind === 'approval-request' && running) running.items.set(ev.nodeId, ev.items);
    monitor.event(ev);
    d.window()?.webContents.send(IPC.workflowEvent, ev);
    for (const w of [...watchers]) w();
  };
  const sendWfChanged = (g: WorkflowGraph) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.workflowChanged, g); };
  const describeNode = (n: WorkflowGraph['nodes'][number], assets: Array<{ id: string; name: string }>): string => {
    const p = n.params;
    switch (n.type) {
      case 'import': { const ids = importAssetIds(p); return ids.length ? `Files (${ids.length === 1 ? assets.find((a) => a.id === ids[0])?.name ?? '1 file' : `${ids.length} files`})` : 'Files'; }
      case 'artcraftEdit': { const app = EDITOR_APPS[p.appId as EditorAppId]; return `${app?.name ?? 'App'}: ${app?.quickEdits.find((o) => o.id === p.opId)?.label ?? p.command ?? 'edit'}`; }
      case 'approval': return `Approval${p.note ? ` (${p.note})` : ''}`;
      case 'export': return `Export (${exportPresetsOf(p).join(', ') || 'no format'})`;
      case 'aiGenerate': return 'AI Generate';
    }
  };
  const startRun = async (g: WorkflowGraph, by: 'user' | 'claude', opts: { changedOnly?: boolean; from?: string } = {}) => {
    if (running) throw new Error('A run is already in progress.');
    const issues = validateGraph(g);
    if (issues.length) throw new Error(issues.map((i) => i.message).join('\n'));
    const store = await d.project();
    const assets = (await store.loadManifest()).assets;
    const approvedIds = new Set(assets.filter((a) => a.approval === 'approved').map((a) => a.id));
    let reuse: RunOutputs | undefined;
    if (opts.changedOnly && lastRun) reuse = reusableOutputs(g, lastRun.outputs, affectedNodes(lastRun.graph, g, opts.from));
    await store.snapshotWorkflow(by === 'claude' ? 'Before a run Claude started' : 'Before a run', g);
    const abort = new AbortController();
    const approvals = new Map<string, (ok: boolean | number[]) => void>();
    const ctl: RunCtl = { abort, approvals, resumers: [], paused: false, by, items: new Map() };
    running = ctl;
    abort.signal.addEventListener('abort', () => { for (const r of approvals.values()) r(false); for (const r of ctl.resumers.splice(0)) r(); });
    monitor.begin(g, by, (id) => describeNode(g.nodes.find((n) => n.id === id)!, assets), control);
    // Real side effects for this run: app edits in the background (no windows) and Deliver exports.
    const steps = new WorkflowSteps({ store, installDir: (app) => PFdir(EDITOR_APPS[app].name), deliver: () => deliver() });
    try {
      const base = await runnerDeps();
      const r = await new WorkflowRunner({
        ...base,
        resolveImport: (p) => steps.resolveImport(p),
        applyStep: (s, inputs) => steps.applyStep(s, inputs),
        deliver: (inputs, presets) => steps.deliver(inputs, presets),
        // Free local video: same project store, no approval or ledger (nothing is paid).
        generateLocalVideo: async (job, signal) => {
          const onAbort = () => localVideo.cancel();
          signal?.addEventListener('abort', onAbort, { once: true });
          try {
            const r = await localVideo.render({ modelId: job.modelId, prompt: job.prompt, preset: job.preset as 'experimental', width: 0, height: 0, frames: 0, steps: 0 });
            return { assetId: r.asset.id, name: r.asset.name, message: r.message };
          } finally { signal?.removeEventListener('abort', onAbort); }
        },
        // Paid steps go through the same approval dialog, spending limit and ledger as AI Generate.
        generateImage: async (job) => {
          const r = await runGeneration(job, by);
          const names = (await store.loadManifest()).assets;
          return { assetIds: r.assetIds, names: r.assetIds.map((id) => names.find((a) => a.id === id)?.name ?? 'Generated image'), message: r.message };
        },
      }).run(g, {
        signal: abort.signal,
        onEvent: emitWf,
        requestApproval: (nodeId) => new Promise<boolean | number[]>((resolve) => approvals.set(nodeId, resolve)),
        reuse,
        isApproved: (id) => approvedIds.has(id),
        pause: {
          isPaused: () => ctl.paused,
          wait: (signal) => new Promise<void>((res) => { ctl.resumers.push(res); signal?.addEventListener('abort', () => res(), { once: true }); }),
        },
      });
      lastRun = { graph: g, outputs: r.outputs ?? {}, ok: r.ok && !r.cancelled };
      return { ok: r.ok, cancelled: r.cancelled };
    } finally {
      running = null;
      await steps.close();
      for (const w of [...watchers]) w();
    }
  };
  handle(IPC.runWorkflow, z.tuple([z.unknown()]), async (raw) => startRun(parseWorkflow(raw), 'user'));
  /** Runs again only the steps a change affects (or `from` and what follows); the rest keeps its earlier results. */
  handle(IPC.rerunWorkflow, z.tuple([z.unknown(), z.string().max(128).nullable()]), async (raw, from) => startRun(parseWorkflow(raw), 'user', { changedOnly: true, from: from ?? undefined }));
  handle(IPC.workflowAffected, z.tuple([z.unknown()]), async (raw) => {
    const g = parseWorkflow(raw);
    if (!lastRun) return { hasRun: false, affected: [] as string[], templateReady: false };
    return { hasRun: true, affected: [...affectedNodes(lastRun.graph, g)].filter((id) => g.nodes.some((n) => n.id === id)), templateReady: lastRun.ok && sameAsRun(lastRun.graph, g) };
  });
  const setPaused = (paused: boolean) => {
    if (!running) throw new Error('No workflow is running.');
    if (running.paused === paused) return;
    running.paused = paused;
    if (!paused) for (const r of running.resumers.splice(0)) r();
    emitWf({ kind: 'run-paused', runId: monitor.snapshot().runId ?? '', paused });
  };
  handle(IPC.pauseWorkflow, none, () => setPaused(true));
  handle(IPC.resumeWorkflow, none, () => setPaused(false));
  /** Manual control: the run pauses between steps and Claude may not change or start anything until it is given back. */
  handle(IPC.setWorkflowControl, z.tuple([z.enum(['user', 'claude'])]), (who) => {
    control = who;
    monitor.setControl(who);
    if (who === 'user' && running && !running.paused) setPaused(true);
    for (const w of [...watchers]) w();
    return monitor.snapshot();
  });
  handle(IPC.workflowRunState, none, async () => monitor.snapshot());
  handle(IPC.workflowVersions, none, async () => (await d.project()).listWorkflowVersions());
  const restoreVersion = async (id: string) => {
    if (running) throw new Error('A workflow is running. Pause or cancel it first.');
    const store = await d.project();
    const g = await store.readWorkflowVersion(id);
    await store.snapshotWorkflow('Before restoring an earlier version');
    await store.saveWorkflow(g);
    sendWfChanged(g);
    return g;
  };
  handle(IPC.workflowRestore, z.tuple([z.string().max(128)]), (id) => restoreVersion(id));
  const makeTemplate = async (name: string, description: string) => {
    const store = await d.project();
    const g = await store.loadWorkflow();
    if (!lastRun?.ok || !sameAsRun(lastRun.graph, g)) throw new Error('Only a workflow that has run successfully (and not changed since) can be saved as a template. Run it first.');
    const base = templateSlug(name);
    const have = new Set((await store.listWorkflowTemplates()).map((t) => t.id));
    let id = base;
    for (let i = 2; have.has(id); i++) id = `${base}-${i}`;
    const t: WorkflowTemplate = { id, name: name.trim().slice(0, 80), description: description.trim().slice(0, 400), createdAt: new Date().toISOString(), graph: templateGraph(g) };
    await store.saveWorkflowTemplate(t);
    return t;
  };
  handle(IPC.workflowTemplates, none, async () => [...(await (await d.project()).listWorkflowTemplates()), ...builtinTemplates()]);
  handle(IPC.workflowTemplateSave, z.tuple([z.string().min(1).max(80), z.string().max(400)]), (name, desc) => makeTemplate(name, desc));
  handle(IPC.workflowTemplateUse, z.tuple([z.string().max(128)]), async (id) => {
    if (running) throw new Error('A workflow is running. Cancel it first.');
    const store = await d.project();
    const t = [...(await store.listWorkflowTemplates()), ...builtinTemplates()].find((x) => x.id === id);
    if (!t) throw new Error('That template no longer exists.');
    await store.snapshotWorkflow('Before using a template');
    await store.saveWorkflow(t.graph);
    sendWfChanged(t.graph);
    return t.graph;
  });
  handle(IPC.workflowPickFolder, none, async () => {
    const win = d.window();
    const o: Electron.OpenDialogOptions = { title: 'Folder of files for the workflow (they are copied into the library)', properties: ['openDirectory'] };
    const r = await (win ? dialog.showOpenDialog(win, o) : dialog.showOpenDialog(o));
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  handle(IPC.answerApproval, z.tuple([z.string().max(128), z.union([z.boolean(), z.array(z.number().int().min(0).max(10_000)).max(10_000)])]), async (nodeId, approved) => {
    const r = running?.approvals.get(nodeId);
    if (!r) throw new Error('No approval pending for that node.');
    // The decision is kept on the files themselves: approved results are not asked about again.
    const items = running!.items.get(nodeId) ?? [];
    const yes = new Set(approved === true ? items.map((i) => i.item) : Array.isArray(approved) ? approved : []);
    const store = await d.project();
    await store.setAssetApproval(items.filter((i) => yes.has(i.item)).map((i) => i.assetId), 'approved');
    await store.setAssetApproval(items.filter((i) => !yes.has(i.item)).map((i) => i.assetId), 'rejected');
    running!.approvals.delete(nodeId);
    r(approved);
  });
  handle(IPC.cancelWorkflow, none, () => { running?.abort.abort(); });

  // ---- Live apps (PhotoCraft: token + roots; VectorCraft: roots; SoundCraft: loopback port) ----
  const PFdir = (name: string) => path.join(process.env.ProgramFiles ?? 'C:\\Program Files', name);
  let livePromise: Promise<LiveTaskController> | null = null;
  type Driver = LivePhotoCraft | LiveVectorCraft | LiveSoundCraft | LiveFilmCraft | LiveLightCraft | LiveEffectCraft | LiveDesignCraft | LiveWordCraft | LivePdfCraft | LiveGridCraft | LiveDeckCraft;
  const drivers: Partial<Record<EditorAppId, Driver>> = {};
  resetters.push(() => {
    // App windows stay open (no unsaved work is lost); they are just no longer controlled.
    for (const k of Object.keys(drivers) as EditorAppId[]) { drivers[k]?.stop(); delete drivers[k]; }
    livePromise = null;
  });
  const live = () => (livePromise ??= (async () => {
    const store = await d.project();
    // Each app writes only into its own work folder; the library itself is only ever read.
    const roots: Record<EditorAppId, string> = {
      photocraft: await store.appWorkDir('photocraft', 'live'),
      vectorcraft: await store.appWorkDir('vectorcraft', 'vectorcraft-live'),
      soundcraft: await store.appWorkDir('soundcraft', 'soundcraft-live'),
      filmcraft: await store.appWorkDir('filmcraft', 'filmcraft-live'),
      lightcraft: await store.appWorkDir('lightcraft', 'lightcraft-live'),
      effectcraft: await store.appWorkDir('effectcraft', 'effectcraft-live'),
      designcraft: await store.appWorkDir('designcraft', 'designcraft-live'),
      wordcraft: await store.appWorkDir('wordcraft', 'wordcraft-live'),
      gridcraft: await store.appWorkDir('gridcraft', 'gridcraft-live'),
      deckcraft: await store.appWorkDir('deckcraft', 'deckcraft-live'),
      pdfcraft: await store.appWorkDir('pdfcraft', 'pdfcraft-live'),
    };
    // Catch each app's window the moment it appears so it never flashes up on its own.
    const onSpawn = (pid: number) => d.embedded.prepare(pid);
    const driver = (app: EditorAppId) => {
      if (drivers[app]) return drivers[app]!;
      if (app === 'photocraft') drivers[app] = new LivePhotoCraft({ installDir: PFdir('PhotoCraft'), secretsDir: d.secretsDir, readRoot: store.root, writeRoot: roots.photocraft, onSpawn });
      else if (app === 'vectorcraft') drivers[app] = new LiveVectorCraft({ installDir: PFdir('VectorCraft'), readRoot: store.root, writeRoot: roots.vectorcraft, onSpawn });
      else if (app === 'soundcraft') drivers[app] = new LiveSoundCraft({ installDir: PFdir('SoundCraft'), readRoot: store.root, writeRoot: roots.soundcraft, onSpawn });
      else if (app === 'filmcraft') drivers[app] = new LiveFilmCraft({ installDir: PFdir('FilmCraft'), readRoot: store.root, writeRoot: roots.filmcraft, onSpawn });
      else if (app === 'lightcraft') drivers[app] = new LiveLightCraft({ installDir: PFdir('LightCraft'), readRoot: store.root, writeRoot: roots.lightcraft, onSpawn });
      else if (app === 'effectcraft') drivers[app] = new LiveEffectCraft({ installDir: PFdir('EffectCraft'), readRoot: store.root, writeRoot: roots.effectcraft, onSpawn });
      else if (app === 'designcraft') drivers[app] = new LiveDesignCraft({ installDir: PFdir('DesignCraft'), readRoot: store.root, writeRoot: roots.designcraft, onSpawn });
      else if (app === 'wordcraft') drivers[app] = new LiveWordCraft({ installDir: PFdir('WordCraft'), readRoot: store.root, writeRoot: roots.wordcraft, onSpawn });
      else if (app === 'pdfcraft') drivers[app] = new LivePdfCraft({ installDir: PFdir('PdfCraft'), readRoot: store.root, writeRoot: roots.pdfcraft, onSpawn });
      else if (app === 'gridcraft') drivers[app] = new LiveGridCraft({ installDir: PFdir('GridCraft'), readRoot: store.root, writeRoot: roots.gridcraft, onSpawn });
      else if (app === 'deckcraft') drivers[app] = new LiveDeckCraft({ installDir: PFdir('DeckCraft'), readRoot: store.root, writeRoot: roots.deckcraft, onSpawn });
      else throw new Error(`${app} can't be opened live.`);
      return drivers[app]!;
    };
    const ctl = new LiveTaskController({
      connect: async (app) => { const drv = driver(app); await drv.ensureStarted(); return drv; },
      store,
      emit: (s) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.liveEvent, s); },
      writeDir: async (app) => { const dir = roots[app]; if (!dir) throw new Error('No write folder.'); await fs.mkdir(dir, { recursive: true }); return dir; },
    });
    d.panel.onClosed(() => {
      if (d.embedded.mode === 'window') { d.embedded.popIn(); }
      ctl.setPoppedOut(false);
      const w = d.window(); if (w && !w.isDestroyed()) w.show();
    });
    return ctl;
  })());
  const currentPid = async () => {
    const ctl = await live();
    return drivers[ctl.snapshot().appId]?.pid ?? null;
  };
  /** Shows the app in its own window with the controls panel docked beside it. */
  const popOut = async () => {
    const ctl = await live();
    const pid = await currentPid();
    if (!pid) throw new Error('The app is not running.');
    d.embedded.popOut();
    await d.panel.open(pid);
    ctl.setPoppedOut(true);
    return ctl.snapshot();
  };
  /** Puts the app back inside CreateCraft's Edit area. */
  const popIn = async () => {
    const ctl = await live();
    d.panel.close();
    d.embedded.popIn();
    ctl.setPoppedOut(false);
    return ctl.snapshot();
  };
  handle(IPC.liveState, none, async () => (await live()).snapshot());
  /** Opens a library file in its app and shows it in the Edit area (or its own window). */
  const openLive = async (id: string, app?: EditorAppId, by: 'user' | 'claude' = 'user') => {
    const ctl = await live();
    const s = await ctl.open(id, app, by);
    await syncAppTheme();
    const pid = await currentPid();
    if (pid) {
      d.embedded.attach(pid);
      if (d.embedded.mode === 'window') { d.embedded.popOut(); d.panel.close(); await d.panel.open(pid); ctl.setPoppedOut(true); return ctl.snapshot(); }
    }
    return s;
  };
  const appId = z.enum(['photocraft', 'vectorcraft', 'soundcraft', 'filmcraft', 'lightcraft', 'effectcraft', 'designcraft', 'wordcraft', 'pdfcraft', 'gridcraft', 'deckcraft']);
  handle(IPC.liveOpen, z.union([z.tuple([z.string().min(1).max(128)]), z.tuple([z.string().min(1).max(128), appId])]), (id, app?: EditorAppId) => openLive(id, app));
  handle(IPC.liveTimeline, none, async () => (livePromise ? (await live()).timeline() : null));
  handle(IPC.livePlayhead, z.tuple([z.number().finite().min(0).max(36_000)]), async (s) => (await live()).setPlayhead(s));
  handle(IPC.liveSelectClip, z.tuple([z.number().int().min(0)]), async (c) => (await live()).selectClip(c));
  const timelineEdit = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('add'), assetId: z.string().min(1).max(128), as: z.enum(['clip', 'music']) }),
    z.object({ kind: z.literal('move'), clip: z.number().int().min(0), to: z.number().int().min(0).max(1000) }),
    z.object({ kind: z.literal('remove'), clip: z.number().int().min(0) }),
  ]);
  handle(IPC.liveTimelineEdit, z.tuple([timelineEdit]), async (edit) => (await live()).editTimeline(edit));

  // ---- AI Generate (BYOK: keys in Windows protected storage, approval before every paid call) ----
  /** Native dialog in main: neither the renderer nor Claude can answer it. Cancel is the default. */
  const approveGeneration = async (r: ApprovalRequest): Promise<boolean> => {
    const win = d.window();
    const isVideo = r.kind === 'video';
    const many = isVideo ? 'video' : r.count === 1 ? 'image' : 'images';
    const prompt = r.prompt.length > 300 ? `${r.prompt.slice(0, 300)}…` : r.prompt;
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: isVideo ? 'Approve paid video generation' : 'Approve paid image generation',
      message: `${r.requestedBy === 'claude' ? 'Claude is asking to generate' : 'Generate'} ${isVideo ? 'a' : r.count} ${many} with ${r.provider} · ${r.model}?`,
      detail: [
        `Estimated cost: ${r.estimate.approximate ? 'about ' : ''}${formatUsd(r.estimate.amount)} USD, charged to your ${r.provider} account.`,
        r.estimate.basis,
        '',
        `Prompt: "${prompt}"`,
        `Settings: ${Object.entries(r.settings).map(([k, v]) => `${k} ${v}`).join(', ')}`,
        r.references.length ? `Reference images sent to ${r.provider}: ${r.references.join(', ')}` : '',
        '',
        r.limitUsd != null ? `Project spending limit: $${r.limitUsd.toFixed(2)} (about $${(r.spentUsd ?? 0).toFixed(2)} estimated so far).` : '',
        isVideo ? 'Nothing is sent until you click Make video. Video can take several minutes and cannot be cancelled once Google has it.' : 'Nothing is sent until you click Generate.',
      ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'),
      buttons: ['Cancel', `${isVideo ? 'Make video' : 'Generate'} (${r.estimate.approximate ? '~' : ''}${formatUsd(r.estimate.amount)})`],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const res = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return res.response === 1;
  };
  const generation = new GenerationService({ vault, store: d.project, approve: approveGeneration, fetch: globalThis.fetch.bind(globalThis) });
  const emitGenerated = (r: GenerateResultDto) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.genEvent, r); };
  const providerStatus = async (): Promise<ProviderStatusDto[]> => {
    const st = await generation.providerStatus();
    return PROVIDERS.map((p) => {
      const s = st.find((x) => x.id === p.id);
      return {
        id: p.id, label: p.label, billable: p.billable,
        configured: p.id === 'mock' ? true : !!s?.configured,
        savedAt: s?.meta?.savedAt ?? null,
        lastTest: s?.meta?.lastTest ?? null,
        encryptionAvailable: vault.available,
        keyHint: p.keyHint,
      };
    });
  };
  const keyProvider = z.enum(['openai', 'gemini', 'runway']);
  handle(IPC.genProviders, none, () => providerStatus());
  handle(IPC.genPasteKey, z.tuple([keyProvider]), async (providerId) => {
    const copied = await clipboard.readText();
    await vault.save(providerId, copied);
    if ((await clipboard.readText()) === copied) await clipboard.clear(); // don't leave the key on the clipboard
    await generation.testConnection(providerId); // free: lists models only
    return providerStatus();
  });
  handle(IPC.genRemoveKey, z.tuple([keyProvider]), async (providerId) => { await vault.remove(providerId); return providerStatus(); });
  handle(IPC.genTest, z.tuple([keyProvider]), async (providerId) => { await generation.testConnection(providerId); return providerStatus(); });
  handle(IPC.genKeyPage, z.tuple([keyProvider]), async (providerId) => {
    const url = PROVIDERS.find((p) => p.id === providerId)?.keyUrl;
    if (url) await shell.openExternal(url);
  });
  const jobSchema = z.object({
    modelId: z.string().min(1).max(64),
    prompt: z.string().min(1).max(MAX_PROMPT),
    referenceAssetIds: z.array(z.string().min(1).max(128)).max(4),
    settings: z.record(z.string().max(64), z.string().max(64)),
    count: z.number().int().min(1).max(4),
  });
  const runGeneration = async (job: z.infer<typeof jobSchema>, requestedBy: 'user' | 'claude'): Promise<GenerateResultDto> => {
    const r = await generation.generate(job, requestedBy);
    const dto = { assetIds: r.assets.map((a) => a.id), message: r.message, estimate: r.estimate, requestedBy };
    emitGenerated(dto);
    return dto;
  };
  handle(IPC.genRun, z.tuple([jobSchema]), (job) => runGeneration(job, 'user'));
  const video = new VideoService({
    vault, store: d.project, approve: approveGeneration, fetch: globalThis.fetch.bind(globalThis),
    onChange: (r) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.videoEvent, r);
      // A finished video is a new library asset: same event as a finished image so the Media list refreshes.
      if (r.state === 'done' && r.assetId) emitGenerated({ assetIds: [r.assetId], message: r.message, estimate: { amount: r.estimateUsd, perImage: r.estimateUsd, currency: 'USD', approximate: true, basis: 'Veo price per second' }, requestedBy: r.requestedBy });
    },
  });
  const videoJobSchema = z.object({
    modelId: z.string().min(1).max(64),
    prompt: z.string().min(1).max(MAX_VIDEO_PROMPT),
    referenceAssetId: z.string().min(1).max(128).nullable(),
    aspectRatio: z.string().max(16),
    durationSeconds: z.number().int().min(1).max(60),
    resolution: z.string().max(16),
  });
  handle(IPC.videoList, none, () => video.list());
  handle(IPC.videoSubmit, z.tuple([videoJobSchema]), (job) => video.submit(job, 'user'));
  handle(IPC.videoCancel, z.tuple([z.string().min(1).max(64)]), (id) => video.cancel(id));
  // Motion Effects: free, local, not AI. No key, no approval dialog, no ledger entry.
  const motion = new MotionService({ store: d.project, filmcraftDir: () => PFdir('FilmCraft') });
  const motionSchema = z.object({
    assetId: z.string().min(1).max(128),
    preset: z.enum(MOTION_PRESETS.map((p) => p.id) as [string, ...string[]]),
    intensity: z.enum(MOTION_INTENSITIES.map((p) => p.id) as [string, ...string[]]),
    aspectRatio: z.enum(MOTION_ASPECTS),
    resolution: z.enum(MOTION_RESOLUTIONS),
    fps: z.union([z.literal(MOTION_FPS[0]), z.literal(MOTION_FPS[1])]),
    durationSeconds: z.number().min(1).max(60),
  });
  handle(IPC.motionRender, z.tuple([motionSchema]), async (job) => {
    const r = await motion.render(job as Parameters<MotionService['render']>[0]);
    emitGenerated({ assetIds: [r.asset.id], message: r.message, estimate: { amount: 0, perImage: 0, currency: 'USD', approximate: false, basis: 'Free: local camera move, no AI.' }, requestedBy: 'user' });
    return { assetId: r.asset.id, message: r.message };
  });
  handle(IPC.motionCancel, none, async () => { motion.cancel(); });
  // Free local AI (Stage C): hardware check and the model download manager. No generation yet.
  const aiSettingsFile = path.join(d.secretsDir, '..', 'local-ai.json');
  const defaultModelDir = path.join(d.secretsDir, '..', 'models');
  const getModelDir = async () => {
    try { const j = JSON.parse(await fsp.readFile(aiSettingsFile, 'utf8')) as { modelDir?: string }; if (j.modelDir && path.isAbsolute(j.modelDir)) return j.modelDir; } catch { /* default */ }
    return defaultModelDir;
  };
  const downloads = new ModelDownloads({
    modelDir: getModelDir,
    fetch: (url, init) => globalThis.fetch(url, { ...init, redirect: 'follow' }),
    freeBytes: async (dir) => { await fsp.mkdir(dir, { recursive: true }); const s = await fsp.statfs(dir); return s.bavail * s.bsize; },
    onChange: (s) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.localAiEvent, s); },
  });
  const modelById = (id: string) => { const m = [...LOCAL_MODELS, SDCPP_RUNTIME].find((x) => x.id === id); if (!m) throw new Error('Unknown model.'); return m; };
  handle(IPC.localAiStatus, none, async () => {
    const report = await detectHardware(await getModelDir());
    const tier = tierFor(report);
    return {
      report, tier, tierLabel: TIER_LABEL[tier], warnings: warningsFor(report),
      models: [SDCPP_RUNTIME, ...LOCAL_MODELS].map((m) => modelFit(m, report)),
      generationAvailable: await downloads.isInstalled('sdcpp-vulkan-runtime'),
      note: 'Free and local. Nothing here has been tested on this PC until a clip has been made; downloads can be removed at any time.',
    };
  });
  const localVideo = new LocalVideoService({
    store: d.project, modelDir: getModelDir, downloads,
    onProgress: (p) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.localVideoProgress, p); },
  });
  const localJobSchema = z.object({
    modelId: z.string().min(1).max(80), prompt: z.string().min(1).max(MAX_LOCAL_PROMPT), negativePrompt: z.string().max(500).optional(),
    preset: z.enum(['experimental', 'low', 'balanced', 'higher', 'custom']),
    width: z.number().int(), height: z.number().int(), frames: z.number().int(), steps: z.number().int(), seed: z.number().int().optional(),
  });
  handle(IPC.localVideoRender, z.tuple([localJobSchema]), async (job) => {
    const r = await localVideo.render(job);
    emitGenerated({ assetIds: [r.asset.id], message: r.message, estimate: { amount: 0, perImage: 0, currency: 'USD', approximate: false, basis: 'Free: generated on this PC.' }, requestedBy: 'user' });
    return { assetId: r.asset.id, message: r.message };
  });
  handle(IPC.localVideoCancel, none, async () => { localVideo.cancel(); });
  handle(IPC.localAiDownloads, none, () => downloads.status());
  const requestModelDownload = async (id: string) => {
    const m = modelById(id);
    const dir = await getModelDir();
    const gb = totalBytes(m) / 1024 ** 3;
    const win = d.window();
    const options: Electron.MessageBoxOptions = {
      type: 'question', title: 'Download a local AI model',
      message: `Download ${m.name} (${gb.toFixed(1)} GB)?`,
      detail: [
        `Source: ${m.sourceUrl}`,
        `License: ${m.license}. ${m.licenseNote}`,
        `Saved to: ${path.join(dir, m.id)}`,
        'The download is free, but it uses about this much disk space and bandwidth. It can be cancelled and resumed.',
        'Downloading does not mean the model works on this PC: it has not been tested here.',
      ].join('\n'),
      buttons: ['Cancel', `Accept license and download ${gb.toFixed(1)} GB`], defaultId: 0, cancelId: 0, noLink: true,
    };
    const res = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (res.response !== 1) return null;
    return downloads.start(id, true);
  };
  handle(IPC.localAiDownload, z.tuple([z.string().min(1).max(80)]), (id) => requestModelDownload(id));
  handle(IPC.localAiCancel, z.tuple([z.string().min(1).max(80)]), async (id) => { modelById(id); downloads.cancel(id); });
  handle(IPC.localAiRemove, z.tuple([z.string().min(1).max(80)]), async (id) => {
    const m = modelById(id);
    const win = d.window();
    const options: Electron.MessageBoxOptions = { type: 'warning', title: 'Remove model', message: `Remove ${m.name} from this PC?`, detail: 'The downloaded files are deleted. You can download it again later.', buttons: ['Cancel', 'Remove'], defaultId: 0, cancelId: 0, noLink: true };
    const res = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (res.response === 1) await downloads.remove(id);
  });
  handle(IPC.localAiPickDir, none, async () => {
    const win = d.window();
    const o: Electron.OpenDialogOptions = { title: 'Where should AI models be stored?', properties: ['openDirectory', 'createDirectory'] };
    const pick = await (win ? dialog.showOpenDialog(win, o) : dialog.showOpenDialog(o));
    const dir = pick.canceled ? null : pick.filePaths[0] ?? null;
    if (!dir) return null;
    // Real write test, as for the project folder.
    const probe = path.join(dir, `.createcraft-write-test-${process.pid}`);
    try { await fsp.writeFile(probe, 'x'); await fsp.rm(probe, { force: true }); } catch { throw new Error('CreateCraft cannot write to that folder. Pick another one.'); }
    await fsp.writeFile(aiSettingsFile, JSON.stringify({ modelDir: dir }, null, 2), 'utf8');
    return dir;
  });
  const spendingDto = async () => { const s = await (await d.project()).spending(); return { limitUsd: s.limitUsd, spentUsd: s.spentUsd, count: s.entries.length }; };
  handle(IPC.genSpending, none, spendingDto);
  handle(IPC.genSpendingSet, z.tuple([z.number().min(0).max(100000).nullable()]), async (limit) => { await (await d.project()).setSpendingLimit(limit); return spendingDto(); });

  // ---- Claude Creative Partner (Claude Agent SDK, this PC's Claude Code sign-in) ----
  // Claude's proposed workflow: held here, shown in the Workflow tab, only saved when the user applies it.
  let pendingPlan: WorkflowPlan | null = null;
  resetters.push(() => { pendingPlan = null; lastRun = null; control = 'claude'; monitor.reset(); });
  const sendPlan = (p: WorkflowPlan | null) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.workflowPlan, p); };
  handle(IPC.workflowPlanGet, none, async () => pendingPlan);
  handle(IPC.workflowPlanDismiss, none, async () => { pendingPlan = null; sendPlan(null); });
  handle(IPC.workflowPlanApply, none, async () => {
    if (!pendingPlan) throw new Error('There is no proposed workflow.');
    if (running) throw new Error('A workflow is running. Wait for it or cancel it first.');
    const g = parseWorkflow(pendingPlan.graph);
    const issues = validateGraph(g);
    if (issues.length) throw new Error(issues.map((i) => i.message).join('\n'));
    await (await d.project()).snapshotWorkflow('Before using the plan Claude proposed');
    await (await d.project()).replaceWorkflow(g);
    pendingPlan = null;
    sendPlan(null);
    return g;
  });
  let partner: ClaudePartner | null = null;
  resetters.push(() => { partner = null; });
  const claude = () => (partner ??= new ClaudePartner({
    live,
    store: d.project,
    openAsset: async (id, app) => { await openLive(id, app, 'claude'); },
    emit: (st) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.claudeEvent, st); },
    cliPath: defaultClaudeCli(),
    generate: (job) => runGeneration(job, 'claude'),
    generateVideo: (job) => video.submit(job, 'claude'),
    localAi: {
      status: async () => {
        const report = await detectHardware(await getModelDir());
        const inst = await downloads.status();
        const has = (id: string) => inst.find((x) => x.modelId === id)?.state === 'installed';
        return JSON.stringify({
          tier: TIER_LABEL[tierFor(report)], gpus: report.gpus, ramGb: report.ramGb, freeDiskGb: report.freeDiskGb, warnings: warningsFor(report),
          engine_installed: has('sdcpp-vulkan-runtime'),
          models: LOCAL_MODELS.map((m) => ({ id: m.id, name: m.name, installed: has(m.id), download_gb: Math.round(totalBytes(m) / 1e8) / 10, downloadable: m.files.length > 0, verified_on: m.verified, offered_here: modelFit(m, report).offered })),
          presets: LOCAL_PRESETS,
          note: 'Only entries under verified_on have really generated a clip. Local video is free; never switch to a paid provider without asking the user.',
        }, null, 2);
      },
      startVideo: async (prompt, preset) => {
        if (localVideo.busy) throw new Error('A local video is already being made.');
        void localVideo.render({ modelId: 'wan-2.1-t2v-1.3b', prompt, preset, width: 0, height: 0, frames: 0, steps: 0 })
          .then((r) => emitGenerated({ assetIds: [r.asset.id], message: r.message, estimate: { amount: 0, perImage: 0, currency: 'USD', approximate: false, basis: 'Free: generated on this PC.' }, requestedBy: 'claude' }))
          .catch(() => undefined);
        return `Local video started (${preset} preset, free, on this PC). It takes a minute or more; it will appear in the library. Do not wait; tell the user.`;
      },
      motion: async (j) => {
        const a = (await (await d.project()).loadManifest()).assets.find((x) => x.name === j.fileName);
        if (!a) throw new Error(`No file named "${j.fileName}". Use list_files.`);
        const r = await motion.render({ assetId: a.id, preset: j.preset, intensity: j.intensity, aspectRatio: j.aspect, resolution: '720p', fps: 24, durationSeconds: j.seconds } as Parameters<MotionService['render']>[0]);
        emitGenerated({ assetIds: [r.asset.id], message: r.message, estimate: { amount: 0, perImage: 0, currency: 'USD', approximate: false, basis: 'Free: local camera move, no AI.' }, requestedBy: 'claude' });
        return `${r.message} File: ${r.asset.name}`;
      },
      requestDownload: async (id) => {
        const s = await requestModelDownload(id);
        return s ? `The user accepted; downloading ${id} (${s.state}).` : 'The user declined the download. Do not ask again unless they bring it up.';
      },
    },
    deliver: async () => deliver(),
    imageModels: async () => (await providerStatus()).filter((p) => p.configured),
    workDir: async () => (await d.project()).workDir('claude'),
    workflowPlan: {
      context: async () => {
        const m = await (await d.project()).loadManifest();
        return {
          assets: m.assets.map((a) => ({ id: a.id, name: a.name, sourceFormat: a.sourceFormat })),
          configuredProviders: (await providerStatus()).filter((p) => p.configured).map((p) => p.id),
        };
      },
      propose: (p) => { pendingPlan = p; sendPlan(p); },
    },
    workflowControl: {
      status: async (waitSeconds) => {
        const deadline = Date.now() + waitSeconds * 1000;
        const settled = () => { const st = monitor.snapshot().state; return st !== 'running'; };
        while (waitSeconds > 0 && !settled() && Date.now() < deadline) {
          await new Promise<void>((res) => { const t = setTimeout(done, Math.min(2000, deadline - Date.now())); function done() { clearTimeout(t); watchers.delete(done); res(); } watchers.add(done); });
        }
        const store = await d.project();
        const g = await store.loadWorkflow();
        const assets = (await store.loadManifest()).assets;
        return {
          run: monitor.snapshot(),
          steps: g.nodes.map((n) => ({ id: n.id, label: describeNode(n, assets) })),
          changedSinceRun: lastRun ? [...affectedNodes(lastRun.graph, g)].filter((id) => g.nodes.some((n) => n.id === id)) : null,
          templateReady: !!lastRun && lastRun.ok && sameAsRun(lastRun.graph, g),
        };
      },
      start: async (mode, from) => {
        if (control === 'user') throw new Error('The user has taken manual control of the workflow. Do not start runs until they give it back.');
        if (running) throw new Error('A run is already in progress.');
        const store = await d.project();
        const g = await store.loadWorkflow();
        if (!g.nodes.length) throw new Error('There is no workflow yet. Propose one with plan_workflow and let the user apply it.');
        const issues = validateGraph(g);
        if (issues.length) throw new Error(`The workflow has problems: ${issues.map((i) => i.message).join(' ')}`);
        const assets = (await store.loadManifest()).assets;
        let rerunSteps: string[] = [];
        if (mode === 'rerun') {
          if (!lastRun) throw new Error('There is no earlier run to build on. Use run_workflow.');
          rerunSteps = [...affectedNodes(lastRun.graph, g, from)].filter((id) => g.nodes.some((n) => n.id === id));
          if (!rerunSteps.length) throw new Error('Nothing has changed since the last run, so there is nothing to rerun.');
        }
        const list = (mode === 'rerun' ? g.nodes.filter((n) => rerunSteps.includes(n.id)) : g.nodes).map((n) => `• ${describeNode(n, assets)}`);
        const paid = g.nodes.filter((n) => n.type === 'aiGenerate' && (PROVIDERS.find((p) => p.id === n.params.providerId)?.billable ?? false));
        const options: Electron.MessageBoxOptions = {
          type: 'question',
          title: 'Claude wants to run the workflow',
          message: mode === 'rerun' ? 'Claude is asking to run again only the steps that changed.' : 'Claude is asking to run your workflow.',
          detail: [
            list.join('\n'),
            '',
            'App steps run in the background and add new versions; originals are never changed. You can pause, take control or cancel at any time, and you approve results in the Workflow tab.',
            paid.length ? 'Paid image generation steps will not run (they stay blocked until paid generation is enabled); nothing is charged.' : 'No paid generation is involved.',
          ].join('\n'),
          buttons: ['Cancel', 'Run'],
          defaultId: 0, cancelId: 0, noLink: true,
        };
        const win = d.window();
        const res = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
        if (res.response !== 1) throw new Error('The user did not approve the run. Nothing was started.');
        void startRun(g, 'claude', { changedOnly: mode === 'rerun', from }).catch((e: unknown) => {
          emitWf({ kind: 'run-finished', runId: monitor.snapshot().runId ?? '', ok: false, cancelled: false });
          console.error('Workflow run failed to start:', e);
        });
        // startRun registers `running` after a few awaits; wait until the run is visible to status.
        for (let i = 0; i < 50 && !running; i++) await new Promise((r) => setTimeout(r, 20));
        return mode === 'rerun' ? `Started: rerunning ${rerunSteps.length} step${rerunSteps.length === 1 ? '' : 's'}; the rest keeps its earlier results. Follow it with workflow_status.` : 'Started. Follow it with workflow_status; tell the user when a step needs their approval.';
      },
      pause: async () => {
        if (control === 'user') throw new Error('The user has manual control.');
        setPaused(true);
        return 'Paused: it stops before the next step.';
      },
      resume: async () => {
        if (control === 'user') throw new Error('The user has manual control; they decide when it continues.');
        setPaused(false);
        return 'Continuing.';
      },
      cancel: async () => {
        if (!running) throw new Error('No workflow is running.');
        running.abort.abort();
        return 'Cancelled. Finished steps keep their results.';
      },
      changeStep: async (nodeId, change) => {
        if (control === 'user') throw new Error('The user has taken manual control of the workflow. Do not change it until they give it back.');
        if (running && !running.paused) throw new Error('The workflow is running. Pause it first.');
        const store = await d.project();
        const g = await store.loadWorkflow();
        const m = await store.loadManifest();
        const r = changeStep(g, nodeId, change as StepChange, { assets: m.assets.map((a) => ({ id: a.id, name: a.name, sourceFormat: a.sourceFormat })), configuredProviders: [] });
        if (!r.ok) throw new Error(r.issue);
        await store.snapshotWorkflow('Before Claude changed a step', g);
        await store.saveWorkflow(r.graph);
        sendWfChanged(r.graph);
        const stale = lastRun ? [...affectedNodes(lastRun.graph, r.graph)].filter((id) => r.graph.nodes.some((n) => n.id === id)) : [];
        return `Changed. ${r.summary}. ${stale.length ? `${stale.length} step${stale.length === 1 ? '' : 's'} would need to run again (rerun_workflow).` : 'Run the workflow to use it.'}`;
      },
      versions: async () => (await d.project()).listWorkflowVersions(),
      restore: async (id) => {
        if (control === 'user') throw new Error('The user has taken manual control of the workflow.');
        const g = await restoreVersion(id);
        return `Restored (${g.nodes.length} steps). The version it replaced was kept.`;
      },
      saveTemplate: async (name, description) => {
        const t = await makeTemplate(name, description);
        return `Saved the template "${t.name}" in the project's Workflows/templates folder (file choices are left out).`;
      },
    },
    // Bound to the project open when this partner is created, so a late save never lands in another project.
    history: (() => {
      const s = d.project();
      return { load: async () => (await s).readClaudeHistory(), save: async (items) => (await s).writeClaudeHistory(items) };
    })(),
  }));
  handle(IPC.claudeState, none, async () => { await claude().ready(); return claude().state(); });
  handle(IPC.claudeSend, z.tuple([z.string().min(1).max(4000)]), (msg) => claude().send(msg));

  // ---- Reference files chosen on Home: held as paths in main, copied only after the plan is approved ----
  const pendingRefs = new Map<string, { path: string; name: string; kind: string; bytes: number }>();
  const IMAGE_TYPES: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  const refList = () => [...pendingRefs.entries()].map(([id, r]) => ({ id, name: r.name, kind: r.kind, bytes: r.bytes }));
  handle(IPC.refsPick, none, async () => {
    const win = d.window();
    const o: Electron.OpenDialogOptions = {
      title: 'Choose reference files (nothing is copied until you approve the plan)',
      properties: ['openFile', 'multiSelections'], filters: [{ name: 'Supported media', extensions: IMPORTABLE_EXTENSIONS }],
    };
    const pick = await (win ? dialog.showOpenDialog(win, o) : dialog.showOpenDialog(o));
    if (pick.canceled) return refList();
    for (const p of pick.filePaths) {
      if (pendingRefs.size >= 12) break;
      if ([...pendingRefs.values()].some((r) => r.path === p)) continue;
      const ext = path.extname(p).slice(1).toLowerCase();
      const kind = kindForExtension(ext);
      const st = await fs.stat(p).catch(() => null);
      if (!kind || !st?.isFile()) continue;
      pendingRefs.set(randomUUID(), { path: p, name: path.basename(p), kind, bytes: st.size });
    }
    return refList();
  });
  handle(IPC.refsRemove, z.tuple([z.string().max(64)]), (rid) => { pendingRefs.delete(rid); return refList(); });
  handle(IPC.refsClear, none, () => { pendingRefs.clear(); });
  handle(IPC.refsImport, none, async (): Promise<ImportResult> => {
    const result: ImportResult = { imported: [], duplicates: [], errors: [] };
    const store = await d.project();
    for (const r of pendingRefs.values()) {
      try {
        const x = await store.importFile(r.path, { source: 'Reference file attached on Home before planning', role: 'reference', originalPath: r.path });
        if (x.duplicateOf) result.duplicates.push({ name: x.asset.name, duplicateOf: x.duplicateOf });
        else result.imported.push(x.asset);
      } catch (err) { result.errors.push(`${r.name}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    pendingRefs.clear();
    return result;
  });
  handle(IPC.claudePlanProject, z.tuple([z.string().trim().min(3).max(4000)]), async (req) => {
    const refs: PlanReference[] = [];
    let shown = 0;
    for (const r of pendingRefs.values()) {
      const ref: PlanReference = { name: r.name, kind: r.kind, bytes: r.bytes };
      const mt = IMAGE_TYPES[path.extname(r.name).slice(1).toLowerCase()];
      if (mt && shown < 3 && r.bytes <= 3 * 1024 * 1024) {
        try { ref.image = { mediaType: mt, data: (await fs.readFile(r.path)).toString('base64') }; shown++; } catch { /* described by name only */ }
      }
      refs.push(ref);
    }
    return claude().planProject(req, refs);
  });
  handle(IPC.claudeSeed, z.tuple([z.string().max(4000), z.string().max(4000)]), (u, c) => claude().seed(u, c));
  handle(IPC.setProjectMeta, z.tuple([z.object({
    objective: z.string().max(600).optional(),
    view: z.object({ workspace: z.enum(['home', 'media', 'edit', 'generate', 'workflow', 'effects', 'color', 'audio', 'deliver']), assetId: z.string().max(128).optional() }).optional(),
  })]), async (patch) => (await d.project()).setMeta(patch));
  handle(IPC.claudeStop, none, () => claude().stop());
  handle(IPC.claudeReset, none, () => { claude().reset(); return claude().state(); });
  handle(IPC.claudeModel, z.tuple([z.string().max(64)]), (m) => { claude().setModel(m); return claude().state(); });
  handle(IPC.claudeAuth, none, () => claude().checkAuth());
  handle(IPC.claudeSignIn, none, () => claude().signIn());
  handle(IPC.claudeCancelSignIn, none, () => claude().cancelSignIn());
  handle(IPC.livePopOut, none, () => popOut());
  handle(IPC.liveDock, none, () => popIn());
  handle(IPC.liveViewport, z.tuple([z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0), visible: z.boolean() }).nullable()]),
    (v) => { d.embedded.setViewport(v); });
  handle(IPC.liveQuickEdit, z.tuple([z.string().min(1).max(64), z.record(z.string().max(64), z.union([z.number(), z.string().max(200)]))]),
    async (opId, values) => (await live()).quickEdit(opId, values));
  handle(IPC.liveUndo, none, async () => (await live()).undo());
  const stepSchema = z.object({ command: z.string().min(1).max(128), params: z.record(z.string().max(64), z.unknown()) });
  handle(IPC.liveRun, z.tuple([z.array(stepSchema).min(1).max(50)]), async (steps) => (await live()).run(steps));
  handle(IPC.livePause, none, async () => (await live()).pause());
  handle(IPC.liveTakeControl, none, async () => (await live()).takeControl());
  handle(IPC.liveRelease, none, async () => (await live()).releaseControl());
  handle(IPC.liveResume, none, async () => (await live()).resume());
  handle(IPC.liveConfirm, none, async () => (await live()).confirmReplan());
  handle(IPC.liveCancel, none, async () => (await live()).cancel());
  handle(IPC.liveSave, none, async () => (await live()).saveVersion());
  handle(IPC.liveRefresh, none, async () => (await live()).refresh());

  // ---- Per-file-type editing with the matching ArtCraft app ----
  let editorsPromise: Promise<AppEditors> | null = null;
  resetters.push(() => { editorsPromise = null; });
  const editors = () => (editorsPromise ??= d.project().then((s) => new AppEditors(s)));
  const id = z.string().min(1).max(128);
  handle(IPC.editApply, z.tuple([id, z.string().min(1).max(64), z.record(z.string().max(64), z.union([z.number(), z.string().max(200)]))]),
    async (assetId, opId, values) => (await editors()).apply(assetId, opId, values));
  handle(IPC.editOpenCopy, z.tuple([id]), async (assetId) => strip(await (await editors()).openWorkingCopy(assetId)));
  handle(IPC.editList, none, async () => (await editors()).list().map(strip));
  handle(IPC.editBringBack, z.tuple([id]), async (editId) => (await editors()).bringBack(editId));

  handle(IPC.listExports, none, async () => (await d.project()).listExports());
  handle(IPC.revealExport, z.tuple([z.string().min(1).max(255)]), async (name) => {
    if (name !== path.basename(name)) throw new Error('Invalid export name.');
    const file = path.join(await (await d.project()).exportsDir(), name);
    shell.showItemInFolder(file);
  });

  // ---- Deliver: export queue (headless ArtCraft command-line tools, no app windows) ----
  let deliverPromise: Promise<DeliverQueue> | null = null;
  resetters.push(() => { deliverPromise = null; });
  const deliver = () => (deliverPromise ??= d.project().then((store) => new DeliverQueue({
    store,
    installDir: (app) => PFdir(EDITOR_APPS[app].name),
    emit: (jobs) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.deliverEvent, jobs); },
  })));
  handle(IPC.deliverJobs, none, async () => (await deliver()).list());
  handle(IPC.deliverEnqueue, z.tuple([id, z.array(z.string().min(1).max(64)).min(1).max(30)]), async (assetId, presets) => (await deliver()).enqueue(assetId, presets, 'user'));
  handle(IPC.deliverKeep, z.tuple([id]), async (jobId) => (await (await deliver()).addToLibrary(jobId)).id);
  handle(IPC.deliverCancel, z.tuple([id]), async (jobId) => (await deliver()).cancel(jobId));
  handle(IPC.deliverClear, none, async () => (await deliver()).clearFinished());
  handle(IPC.deliverHistory, z.union([z.tuple([]), z.tuple([id])]), async (assetId?: string) => (await deliver()).history(assetId));
  handle(IPC.deliverOpenFolder, none, async () => { await shell.openPath(await (await d.project()).exportsDir()); });

  // ---- Projects ----
  const projectKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
  handle(IPC.projectsList, none, () => d.projects.list());
  handle(IPC.projectsCurrent, none, () => d.projects.currentKey());
  const folderPath = z.string().min(3).max(1024);
  const projectKeyRe = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
  const metaSchema = z.object({ kind: z.enum(['image', 'design', 'video', 'audio', 'mixed']).optional(), brief: z.string().max(2000).optional(), objective: z.string().max(600).optional() });
  handle(IPC.projectsCreate, z.tuple([z.string().max(80), folderPath.nullable(), metaSchema.nullable()]), (name, parentDir, meta) => d.projects.create(name, parentDir ?? undefined, meta ?? undefined));
  handle(IPC.projectsStorage, none, () => d.projects.storageInfo());
  const pickFolder = async (title: string): Promise<string | null> => {
    const win = d.window();
    const start = (await d.projects.storageInfo()).defaultDir;
    const o: Electron.OpenDialogOptions = { title, defaultPath: start, properties: ['openDirectory', 'createDirectory'] };
    const r = await (win ? dialog.showOpenDialog(win, o) : dialog.showOpenDialog(o));
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  };
  handle(IPC.projectsPickFolder, none, () => pickFolder('Choose a folder for projects'));
  handle(IPC.projectsAddExisting, none, async () => {
    const dir = await pickFolder('Choose a CreateCraft project folder (it contains project.json)');
    return dir ? d.projects.addExisting(dir) : null;
  });
  handle(IPC.projectsLocate, z.tuple([projectKeyRe]), async (key) => {
    const dir = await pickFolder('Choose the project\'s folder');
    if (!dir) return false;
    await d.projects.relocate(key, dir);
    return true;
  });
  handle(IPC.projectsDuplicate, z.tuple([projectKeyRe]), async (key) => {
    const dir = await pickFolder('Choose where to put the copy');
    return dir ? d.projects.duplicate(key, dir) : null;
  });
  handle(IPC.projectsMove, z.tuple([projectKeyRe]), async (key) => {
    const dir = await pickFolder('Choose the folder to move the project into');
    if (!dir) return false;
    await d.projects.move(key, dir);
    return true;
  });
  handle(IPC.projectsSetDefaultDir, z.tuple([folderPath.nullable()]), (dir) => d.projects.setDefaultDir(dir));
  handle(IPC.projectsRevealDefault, none, async () => { await shell.openPath((await d.projects.storageInfo()).defaultDir); });
  handle(IPC.projectsRename, z.tuple([projectKey, z.string().min(1).max(80)]), (key, name) => d.projects.rename(key, name));
  handle(IPC.projectsRemove, z.tuple([projectKey]), (key) => d.projects.remove(key));
  handle(IPC.projectsReveal, z.tuple([projectKey]), async (key) => { await shell.openPath(await d.projects.folder(key)); });
  handle(IPC.projectsOpen, z.tuple([projectKey]), async (key) => {
    if (key === (await d.projects.currentKey())) return;
    if (running) throw new Error('A workflow is running. Cancel it before switching projects.');
    if (livePromise) {
      const st = (await livePromise).snapshot().collab;
      if (st.activeOperation || ['running', 'pausing', 'manual'].includes(st.phase)) throw new Error('Finish or cancel the current editing task before switching projects.');
    }
    if (partner?.state().status === 'working') throw new Error('Claude is still working. Stop it before switching projects.');
    if (generation.isBusy) throw new Error('An image is being generated. Wait for it to finish before switching projects.');
    d.panel.close();
    d.embedded.release(true);
    for (const r of resetters) r();
    await d.projects.open(key);
  });

  handle(IPC.probeApps, none, () => probeAllArtCraftApps());
  handle(IPC.integrationStatus, none, async (): Promise<IntegrationSnapshot> => ({
    appAdapters: Object.values((await runnerDeps()).apps).map((a) => ({ id: a.id, isMock: a.isMock })),
    realExport: !!(await runnerDeps()).exportAsset,
    windowCapture: { available: capture.available, reason: capture.unavailableReason() },
    credentialVault: { available: vault.available },
    claude: { connected: false, reason: 'Claude integration is not configured in this build.' },
    providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label, isMock: p.id === 'mock', billable: p.billable })),
  }));
}

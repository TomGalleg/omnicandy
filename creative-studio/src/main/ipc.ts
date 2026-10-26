// Narrow IPC surface. Every handler validates its arguments and checks the sender frame.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
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
import { BuildSession } from './devSession';
import { EditWorkspace } from './editWorkspace';
import { fetchPlanUsage } from './planUsage';
import { showApprovalCard } from './approvalWindow';
import { randomUUID } from 'node:crypto';
import { ClaudePartner, defaultClaudeCli, type PlanReference } from './claudePartner';
import { ANTHROPIC_VAULT_ID, ClaudeAuth } from './claudeAuth';
import { LiveTaskController } from './liveTask';
import { runAgent } from './agentHarness/loop';
import { prepareNewTask } from './agentHarness/startGuard';
import { TaskCheckpointStore } from './agentHarness/taskCheckpoint';
import { EditIntentJournal } from './agentHarness/editIntentJournal';
import { restoreRecoveryState, resumeFailureNotice } from './agentHarness/crashRecovery';
import { recoveryPresentation } from './agentHarness/recoveryPresentation';
import { recoveryIpcState } from './agentHarness/recoveryIpcState';
import { agentBudgetSchema } from './agentHarness/executionBudget';
import { agentProviderSchema, sumUsage, withAgentProvider } from './agentHarness/providerFactory';
import { addExportTools } from './agentHarness/exportTools';
import { DEFAULT_AGENT_PROVIDER, validateProviderSelection } from '@shared/agentProvider';
import type { PausedAgent } from './agentHarness/recoveryIpcState';
import { AgentJobLedger } from './agentHarness/jobLedger';
import { SHARED_CLAUDE_TOOL_NAMES } from './agentHarness/sharedClaudeTools';
import { familiesUsedIn, registerSharedTools } from './agentHarness/toolFamilies';
import type { JournaledTool } from './agentHarness/editIntentJournal';
import { stepSchema as planStepSchema, validatePlanEdit } from './agentHarness/taskPlan';
import { nativeToolRegistry } from './agentHarness/nativeTools';
import { addExternalTools, describeAppForModel } from './agentHarness/externalTools';
import type { AgentUiEvent, AgentUiState } from '@shared/agentHarness';
import { appendChat, chatItemFromEvent, userChatItem } from '@shared/agentChat';
import { PhotoCraftCliAdapter } from './photocraftCli';
import type { ProjectManager } from './projects';
import { setBlenderLiveHooks } from './integrations/adapters/blenderLive';
import { setUnrealLiveHooks } from './integrations/adapters/unrealLive';
import { setResolveLiveHooks } from './integrations/adapters/resolveLive';
import { BLANK_FILES, EDITOR_APPS, type EditorAppId } from '@shared/appEditors';
import { DeliverQueue } from './deliver';
import { RecraftService } from './recraft';
import { StudioJobStore } from './studioJobs';
import { WorkflowSteps } from './workflowSteps';
import type { EmbeddedApp } from './embeddedApp';
import { LiveDesignCraft, LiveEffectCraft, LiveFilmCraft, LiveLightCraft, LiveSoundCraft, LiveVectorCraft, LiveWordCraft, LivePdfCraft, LiveGridCraft, LiveDeckCraft, LiveFigCraft, LiveCadCraft } from './liveApps';
import { LivePhotoCraft } from './photocraftLive';
import type { ProjectStore } from './projectStore';
import { parseWorkflow } from './schemas';
import { UnavailableWindowCapture } from './services';
import { SafeStorageVault } from './credentialVault';
import { secureEncryptor, secureStorageStatus } from './platform/secureStorage';
import { GenerationService, approvalAsker, type ApprovalRequest, type Requester } from './generation';
import { VideoService } from './videoGeneration';
import { MotionService } from './motionEffects';
import { detectHardware } from './hardware';
import { ModelDownloads } from './modelDownloads';
import { LocalVideoService } from './localVideo';
import { LOCAL_PRESETS, MAX_LOCAL_PROMPT } from '@shared/localVideo';
import fsp from 'node:fs/promises';
import { currentOs } from '@shared/platform';
import { LOCAL_MODELS, modelFit, sdcppRuntime, tierFor, TIER_LABEL, totalBytes, warningsFor } from '@shared/localAi';
import { MOTION_ASPECTS, MOTION_FPS, MOTION_INTENSITIES, MOTION_PRESETS, MOTION_RESOLUTIONS } from '@shared/motionEffects';
import { MAX_VIDEO_PROMPT } from '@shared/video';
import type { SettingsStore } from './settingsStore';
import { AdapterPackages, createIntegrationManager } from './integrations';
import { ConnectService } from './integrations/connect';
import { createPlanner, registerPlannerIpc } from './planner/ipc';
import { McpSession } from './planner/mcp';
import { BuilderService } from './integrations/builder/service';
import { ClaudeAuthor, ScriptedAuthor } from './integrations/builder/author';
import { parseBlueprint } from './integrations/builder/blueprint';
import { readFileSync } from 'node:fs';
import { BUILDER_CONSENT, type BuilderRequest, type InstalledProgram } from '@shared/builder';
import { programFromPath } from './integrations/builder/programPath';
import { bundledPaths, loadBundledPublishers } from './integrations/bundled';
import { approvalDetail, INSTALL_CANCELLED_MESSAGE, integrationLines, type BrowseResult, type ConnectOutcome, type ConnectOverview, type ForgetResult } from '@shared/connect';
import { ExternalState } from './integrations/state';
import { PERMISSION_LABEL, type ApprovalAnswer, type ExternalAppInfo, type PackageApproval, type PackageListing, type Permission } from '@shared/integrations';
import { craftBin, craftInstallDir } from './platform/craftApps';
import { runBounded } from './shutdown';

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
  const planner = createPlanner(path.dirname(d.secretsDir));
  const plannerSession = new McpSession(planner.service, ['read', 'propose', 'execute'], { kind: 'createcraft', name: 'OmniCandy Claude' });
  registerPlannerIpc({
    service: planner.service, store: planner.store, dir: planner.dir, isTrustedSender: d.isTrustedSender, window: d.window,
    project: async () => { const store = await d.project(); const m = await store.loadManifest().catch(() => null); return m ? { id: m.id, name: m.name, root: store.root, store } : null; },
    // Lazy: the key vault and Claude are created further down. Keys are lent per call and never returned to the page.
    chat: { vault: { status: (id) => vault.status(id as never), withKey: (id, fn) => vault.withKey(id, fn) }, fetch: globalThis.fetch.bind(globalThis), claude: () => claude() },
  });
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
  const vault = new SafeStorageVault(path.join(d.secretsDir, 'providers'), secureEncryptor(safeStorage));
  const claudeAuth = new ClaudeAuth(path.join(path.dirname(d.secretsDir), 'claudeAuth.json'), vault);
  const storageStatus = () => secureStorageStatus(safeStorage);
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
  /** Matches the open ArtCraft app to OmniCandy's current look (if the user allows it). */
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
  const PFdir = (name: string) => craftInstallDir(name);
  let livePromise: Promise<LiveTaskController> | null = null;
  type Driver = LivePhotoCraft | LiveVectorCraft | LiveSoundCraft | LiveFilmCraft | LiveLightCraft | LiveEffectCraft | LiveDesignCraft | LiveWordCraft | LivePdfCraft | LiveGridCraft | LiveDeckCraft | LiveFigCraft | LiveCadCraft;
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
      figcraft: await store.appWorkDir('figcraft', 'figcraft-live'),
      cadcraft: await store.appWorkDir('cadcraft', 'cadcraft-live'),
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
      else if (app === 'figcraft') drivers[app] = new LiveFigCraft({ installDir: PFdir('FigCraft'), readRoot: store.root, writeRoot: roots.figcraft, onSpawn });
      else if (app === 'cadcraft') drivers[app] = new LiveCadCraft({ installDir: PFdir('CADCraft'), readRoot: store.root, writeRoot: roots.cadcraft, onSpawn });
      else throw new Error(`${app} can't be opened live.`);
      return drivers[app]!;
    };
    const ctl = new LiveTaskController({
      connect: async (app) => { const drv = driver(app); await drv.ensureStarted(); return drv; },
      store,
      emit: (s) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.liveEvent, s); },
      approveCommand: async (r) => {
        const win = d.window();
        const text = JSON.stringify(r.params);
        return showApprovalCard(win, {
          title: `Approve ${r.appName} command`,
          heading: `Claude wants to run "${r.command}" in ${r.appName}`,
          tone: 'warn',
          intro: 'This command reaches outside the open picture (a file, an action, a script or a plugin).',
          code: text.length > 1200 ? `${text.slice(0, 1200)}…` : text,
          rows: [],
          footnote: `${r.appName} still refuses any file outside this project. Nothing runs unless you click Run.`,
          confirmLabel: 'Run',
        });
      },
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
    if (!d.embedded.supported) { ctl.setPoppedOut(true); return ctl.snapshot(); } // no embedding here: the app already has its own window
    d.embedded.popOut();
    await d.panel.open(pid);
    ctl.setPoppedOut(true);
    return ctl.snapshot();
  };
  /** Puts the app back inside OmniCandy's Edit area. */
  const popIn = async () => {
    const ctl = await live();
    if (!d.embedded.supported) return ctl.snapshot(); // nothing to put back: the app keeps its own window
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
    if (pid && !d.embedded.supported) { ctl.setPoppedOut(true); return ctl.snapshot(); } // Linux: the app opens in its own window
    if (pid) {
      d.embedded.attach(pid);
      if (d.embedded.mode === 'window') { d.embedded.popOut(); d.panel.close(); await d.panel.open(pid); ctl.setPoppedOut(true); return ctl.snapshot(); }
    }
    return s;
  };
  const appId = z.enum(['photocraft', 'vectorcraft', 'soundcraft', 'filmcraft', 'lightcraft', 'effectcraft', 'designcraft', 'wordcraft', 'pdfcraft', 'gridcraft', 'deckcraft', 'figcraft', 'cadcraft']);
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
    return showApprovalCard(win, {
      title: isVideo ? 'Approve paid video generation' : 'Approve paid image generation',
      heading: `${approvalAsker(r)} ${isVideo ? 'a' : r.count} ${many} with ${r.provider} · ${r.model}?`,
      cost: `${r.estimate.approximate ? '≈ ' : ''}${formatUsd(r.estimate.amount)} USD`,
      costNote: `${r.estimate.basis} Charged to your ${r.provider} account.`,
      rows: [
        ['Prompt', prompt],
        ['Settings', Object.entries(r.settings).map(([k, v]) => `${k} ${v}`).join(', ')],
        ['References', r.references.length ? `Sent to ${r.provider}: ${r.references.join(', ')}` : ''],
        ['Limit', r.limitUsd != null ? `Project spending limit $${r.limitUsd.toFixed(2)} (about $${(r.spentUsd ?? 0).toFixed(2)} estimated so far).` : ''],
      ],
      footnote: isVideo ? 'Nothing is sent until you click Make video. Video can take several minutes and cannot be cancelled once Google has it.' : 'Nothing is sent until you click Generate.',
      confirmLabel: `${isVideo ? 'Make video' : 'Generate'} (${r.estimate.approximate ? '~' : ''}${formatUsd(r.estimate.amount)})`,
    });
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
        ...(s?.unreadable ? { unreadable: true } : {}),
        savedAt: s?.meta?.savedAt ?? null,
        lastTest: s?.meta?.lastTest ?? null,
        encryptionAvailable: vault.available,
        encryptionProblem: storageStatus().problem ? `${storageStatus().problem} ${storageStatus().help ?? ''}`.trim() : null,
        keyHint: p.keyHint,
      };
    });
  };
  const recraft = new RecraftService({ vault, store: d.project, approve: approveGeneration, fetch: globalThis.fetch.bind(globalThis) });
  const studioJobs = new StudioJobStore(async () => (await d.project()).root);
  const keyProvider = z.enum(['openai', 'gemini', 'runway', 'recraft']);
  handle(IPC.genProviders, none, () => providerStatus());
  handle(IPC.genPasteKey, z.tuple([keyProvider]), async (providerId) => {
    const copied = await clipboard.readText();
    await vault.save(providerId, copied);
    if ((await clipboard.readText()) === copied) await clipboard.clear(); // don't leave the key on the clipboard
    await generation.testConnection(providerId); // free: lists models only
    return providerStatus();
  });
  const recraftJobSchema = z.object({
    modelId: z.string().min(1).max(64), prompt: z.string().min(1).max(10_000), count: z.number().int().min(1).max(4),
    aspect: z.string().max(16), colors: z.array(z.string().max(7)).max(10), background: z.string().max(7),
  });
  handle(IPC.recraftRun, z.tuple([recraftJobSchema]), async (job) => {
    const r = await recraft.generate(job, 'user');
    const dto: GenerateResultDto = { assetIds: r.assets.map((a) => a.id), message: r.message, estimate: r.estimate, requestedBy: 'user' };
    emitGenerated(dto);
    return dto;
  });
  const studioJobSchema = z.object({
    id: z.string().min(1).max(64), at: z.string().max(40), providerId: z.string().max(40), modelId: z.string().max(120), modelLabel: z.string().max(160),
    prompt: z.string().max(10_000), settings: z.record(z.string().max(64), z.string().max(200)), count: z.number().int().min(1).max(6),
    referenceAssetIds: z.array(z.string().max(128)).max(4), state: z.enum(['running', 'done', 'failed', 'canceled']),
    message: z.string().max(2000).optional(), assetIds: z.array(z.string().max(128)).max(6).optional(), estimateUsd: z.number().optional(),
  });
  handle(IPC.studioJobs, none, () => studioJobs.list());
  handle(IPC.studioJobsSave, z.tuple([z.array(studioJobSchema).max(50)]), (jobs) => studioJobs.save(jobs));
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
  const runGeneration = async (job: z.infer<typeof jobSchema>, requestedBy: 'user' | 'claude', requester?: Requester): Promise<GenerateResultDto> => {
    const r = await generation.generate(job, requestedBy, requester);
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
  const runtimeHere = sdcppRuntime(currentOs());
  const modelById = (id: string) => { const m = [...LOCAL_MODELS, ...(runtimeHere ? [runtimeHere] : [])].find((x) => x.id === id); if (!m) throw new Error('Unknown model.'); return m; };
  handle(IPC.localAiStatus, none, async () => {
    const report = await detectHardware(await getModelDir());
    const tier = tierFor(report);
    return {
      report, tier, tierLabel: TIER_LABEL[tier], warnings: warningsFor(report),
      models: [...(runtimeHere ? [runtimeHere] : []), ...LOCAL_MODELS].map((m) => modelFit(m, report)),
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
    try { await fsp.writeFile(probe, 'x'); await fsp.rm(probe, { force: true }); } catch { throw new Error('OmniCandy cannot write to that folder. Pick another one.'); }
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
  // External third-party applications: one engine for discovery, adapters, permissions and execution.
  // The 13 native Craft apps are NOT routed through it.
  const extStore = new ExternalState(path.join(d.secretsDir, 'external-apps.json'));
  // Connectors that ship with OmniCandy are only LISTED as available; installing one goes through the same review and native confirmation as any package.
  const bundled = bundledPaths({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  const catalogDirs = [bundled.adaptersDir];
  let connect: ConnectService | null = null;
  // Destructive commands (such as deleting an object) the user allowed for this session: memory only, cleared when the project changes or a chat is reset.
  const sessionAllowed = new Set<string>();
  const sessionKey = (appKey: string, commandId: string) => `${appKey}\u0000${commandId}`;
  resetters.push(() => sessionAllowed.clear());
  const external = createIntegrationManager({
    sessionAllowed: { has: (k, c) => sessionAllowed.has(sessionKey(k, c)), add: (k, c) => { sessionAllowed.add(sessionKey(k, c)); } },
    workDir: async (id) => (await d.project()).workDir('external', id),
    // Hand-off by library item: the same names list_files shows. The newest file wins when versions share a name.
    libraryFile: async (ref) => {
      const store = await d.project();
      const m = await store.loadManifest();
      const want = ref.trim().toLowerCase();
      if (!want) return null;
      const hit = m.assets.filter((a) => a.id === ref.trim() || a.name.toLowerCase() === want).at(-1)
        ?? (() => { const c = m.assets.filter((a) => a.name.toLowerCase().replace(/\.[^.]+$/, '') === want); return c.length === 1 ? c[0] : undefined; })();
      return hit ? { id: hit.id, name: hit.name, kind: hit.kind, path: await store.resolveAssetPath(hit.id) } : null;
    },
    permissions: { load: async () => (await extStore.read()).grants, save: async (grants) => { await extStore.update((st) => { st.grants = grants; }); } },
    userPaths: async () => (await extStore.read()).paths,
    connected: { load: async () => (await extStore.read()).connected, save: async (connected) => { await extStore.update((st) => { st.connected = connected; }); } },
    extraTargets: async () => (await connect?.extraTargets()) ?? [],
    remembered: { load: async () => (await extStore.read()).remembered, save: async (remembered) => { await extStore.update((st) => { st.remembered = remembered; }); } },
    approve: async (r): Promise<ApprovalAnswer> => {
      const win = d.window();
      const canSession = r.destructive && !r.untrusted && !r.command.confirmEveryTime && r.needed.length === 0;
      const buttons = canSession ? ['Cancel', 'Allow once', 'Allow for this session'] : r.destructive || r.untrusted ? ['Cancel', 'Allow once'] : ['Cancel', 'Allow once', `Always allow for ${r.app.adapterName ?? r.app.name}`];
      const options: Electron.MessageBoxOptions = { type: 'question', title: 'External application', message: `Run "${r.command.label}" in ${r.app.adapterName ?? r.app.name}?`, detail: approvalDetail(r), buttons, defaultId: 0, cancelId: 0, noLink: true };
      const res = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      return res.response === 1 ? 'once' : res.response === 2 ? (canSession ? 'session' : 'always') : 'deny';
    },
  });
  // A third-party program's own window (Blender) opened for Claude: it is docked into the Software tab like the ArtCraft apps.
  let liveExternal: { name: string; pid: number | null } = { name: 'Blender', pid: null };
  const emitLiveExternal = () => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.extLive, liveExternal); };
  setBlenderLiveHooks({
    onSpawn: (pid) => { liveExternal = { name: 'Blender', pid }; d.embedded.prepare(pid); emitLiveExternal(); },
    onExit: () => { liveExternal = { name: 'Blender', pid: null }; emitLiveExternal(); },
  });
  app.on('will-quit', () => setBlenderLiveHooks(null));
  // The same for Unreal Editor: started by editor.launch, or an open one picked by editor.show. Docked into the Software tab.
  setUnrealLiveHooks({
    onSpawn: (pid) => { liveExternal = { name: 'Unreal Engine', pid }; d.embedded.prepare(pid); emitLiveExternal(); },
    onShow: (pid) => { liveExternal = { name: 'Unreal Engine', pid }; d.embedded.attach(pid); emitLiveExternal(); },
    onExit: (pid) => { if (liveExternal.pid === pid) { liveExternal = { name: 'Unreal Engine', pid: null }; emitLiveExternal(); } },
  });
  app.on('will-quit', () => setUnrealLiveHooks(null));
  // And DaVinci Resolve: app.launch / app.show hand over the running Resolve, docked into the Software tab.
  setResolveLiveHooks({
    onShow: (pid) => { liveExternal = { name: 'DaVinci Resolve', pid }; d.embedded.attach(pid); emitLiveExternal(); },
    onExit: (pid) => { if (liveExternal.pid === pid) { liveExternal = { name: 'DaVinci Resolve', pid: null }; emitLiveExternal(); } },
  });
  app.on('will-quit', () => setResolveLiveHooks(null));
  /**
   * Pictures, video and audio that an external program wrote (a Blender render, an exported clip) are added to the
   * library (Media tab) and the first picture or video opens in PhotoCraft / FilmCraft inside OmniCandy, ready to edit.
   * Each file is added once, however often the result is read. Returns the names added.
   */
  const broughtIn = new Set<string>();
  const bringIntoLibrary = async (appName: string, outputs: Array<{ path: string }> | undefined): Promise<string[] | null> => {
    const fresh = (outputs ?? []).filter((o) => o?.path && !broughtIn.has(o.path.toLowerCase()) && kindForExtension(path.extname(o.path)));
    if (!fresh.length) return null;
    const store = await d.project();
    const names: string[] = [];
    let first: string | null = null;
    for (const o of fresh) {
      broughtIn.add(o.path.toLowerCase());
      try {
        const { asset } = await store.importFile(o.path, { origin: 'generated', source: `Made in ${appName}` });
        names.push(asset.name);
        if (!first && (asset.kind === 'image' || asset.kind === 'video')) first = asset.id;
      } catch { /* a file that cannot be added is simply not listed */ }
    }
    if (first) { try { await openLive(first, undefined, 'claude'); } catch { /* it is in the library even if the app could not open it yet */ } }
    return names.length ? names : null;
  };
  /** Status, progress, result and cancellation of a background external job; one implementation for Claude and Independent AI. */
  const externalJobReport = async (id: string, cancel: boolean): Promise<string> => {
    if (cancel) external.cancelJob(id);
    const j = external.job(id);
    if (!j) return JSON.stringify({ error: 'No such job (jobs do not survive an application restart). Jobs: ' + external.jobs().map((x) => x.id).join(', ') });
    if (j.status === 'succeeded') await bringIntoLibrary(j.appName, (j.result as { outputs?: Array<{ path: string }> } | null)?.outputs);
    return JSON.stringify({ job_id: j.id, app: j.appName, command: j.commandId, status: j.status, stage: j.stage, progress: j.fraction, started: j.startedAt, finished: j.finishedAt, result: j.result }, null, 2);
  };
  // Installable adapter packages: verified on disk, run in their own restricted process (integrations/packageRunner.ts).
  const packages = new AdapterPackages(path.join(path.dirname(d.secretsDir), 'integrations'), external, undefined, { bundledPublishers: () => loadBundledPublishers(bundled.publishersFile) });
  // Quit waits (at most 4 s) for the adapters and the plugin bridge to close, so no helper process is left behind.
  let cleaned = false;
  app.on('will-quit', (e) => {
    if (cleaned) return;
    cleaned = true;
    e.preventDefault();
    void runBounded([() => external.shutdown(), () => packages.shutdown()], 4000).finally(() => app.quit());
  });
  const packagesReady = packages.load().catch(() => undefined);
  // Applications connected last time are connected again now (quietly), so Software shows them as connected after a restart.
  const restored = packagesReady.then(() => external.autoConnect()).catch(() => undefined);
  const connectSvc = new ConnectService({ manager: external, packages, state: extStore, catalogDirs });
  connect = connectSvc;
  /** Only paths the user picked or the inbox listed can be reviewed or installed: the renderer cannot name arbitrary files. */
  const allowedPackagePaths = new Set<string>();
  const listing = async (): Promise<PackageListing> => {
    await packagesReady;
    const l = await packages.listing();
    for (const r of l.inbox) allowedPackagePaths.add(r.path);
    return l;
  };
  const allowedPackage = (p: string): string => {
    if (!allowedPackagePaths.has(p)) throw new Error('That package was not chosen from the picker or the inbox. Choose it again.');
    return p;
  };
  // Universal Connect (guided setup): the same manager, packages and trust system, in plain language.
  const pickProgram = async (kind: 'file' | 'folder'): Promise<string | null> => {
    const win = d.window();
    const o: Electron.OpenDialogOptions = kind === 'file'
      ? { title: 'Choose the program (.exe)', properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe'] }] }
      : { title: 'Choose the folder the program lives in', properties: ['openDirectory'] };
    const r = await (win ? dialog.showOpenDialog(win, o) : dialog.showOpenDialog(o));
    return r.canceled ? null : r.filePaths[0] ?? null;
  };
  handle(IPC.connectOverview, z.tuple([z.boolean()]), async (rescan): Promise<ConnectOverview> => {
    await packagesReady;
    const o = await connectSvc.overview({ rescan });
    for (const p of connectSvc.offerPaths()) allowedPackagePaths.add(p);
    return o;
  });
  handle(IPC.connectApp, z.tuple([z.string().min(1).max(600)]), async (k): Promise<ConnectOutcome> => { await packagesReady; return connectSvc.connectAndVerify(k); });
  handle(IPC.connectBrowse, z.tuple([z.enum(['file', 'folder'])]), async (kind): Promise<BrowseResult> => {
    await packagesReady;
    const p = await pickProgram(kind);
    return p ? connectSvc.browse(p) : { kind: 'cancelled' };
  });
  handle(IPC.connectForget, z.tuple([z.string().min(1).max(600)]), async (k): Promise<ForgetResult> => { await packagesReady; return connectSvc.forget(k); });
  handle(IPC.connectDone, none, async () => { await connectSvc.markOnboarded(); });
  handle(IPC.extScan, none, async () => { await restored; return external.scan(); });
  handle(IPC.extLiveState, none, async () => liveExternal);
  handle(IPC.extLiveShow, none, async () => { if (liveExternal.pid) d.embedded.attach(liveExternal.pid); });
  handle(IPC.extList, none, async () => { await restored; return external.list(); });
  handle(IPC.extConnect, z.tuple([z.string().min(1).max(600)]), (k) => external.connect(k));
  handle(IPC.extDisconnect, z.tuple([z.string().min(1).max(600)]), (k) => external.disconnect(k));
  handle(IPC.extRepair, z.tuple([z.string().min(1).max(600)]), (k) => external.repair(k));
  handle(IPC.extRevoke, z.tuple([z.string().min(1).max(600)]), async (k) => { await external.revoke(k); return external.list(); });
  handle(IPC.extPkgList, none, () => listing());
  handle(IPC.extPkgPick, z.tuple([z.enum(['file', 'folder'])]), async (kind) => {
    const win = d.window();
    const o: Electron.OpenDialogOptions = kind === 'file'
      ? { title: 'Choose an integration package', properties: ['openFile'], filters: [{ name: 'OmniCandy integration package', extensions: ['ccadapter'] }] }
      : { title: 'Choose an integration package folder', properties: ['openDirectory'] };
    const r = await (win ? dialog.showOpenDialog(win, o) : dialog.showOpenDialog(o));
    const p = r.canceled ? null : r.filePaths[0];
    if (!p) return null;
    allowedPackagePaths.add(p);
    await packagesReady;
    return packages.review(p);
  });
  handle(IPC.extPkgReview, z.tuple([z.string().min(1).max(1000)]), async (p) => { await listing(); return packages.review(allowedPackage(p)); });
  // installPlugin / elevate are NOT taken from the screen: main decides them from the native confirmation below.
  const approvalSchema = z.object({ permissions: z.array(z.string()).max(20), allowUnsigned: z.boolean().optional(), trustPublisher: z.boolean().optional() });
  handle(IPC.extPkgInstall, z.tuple([z.string().min(1).max(1000), approvalSchema]), async (p, approval) => {
    await packagesReady;
    const src = allowedPackage(p);
    const rev = await packages.review(src);
    if (rev.problems.length) throw new Error('This package cannot be installed: ' + rev.problems.join('; '));
    // A native dialog the renderer and Claude cannot answer: installing adds code that will run on this PC.
    const win = d.window();
    const asked = approval.permissions.map((x) => PERMISSION_LABEL[x as Permission]?.toLowerCase() ?? x);
    const options: Electron.MessageBoxOptions = {
      type: 'warning', title: 'Install integration', noLink: true, buttons: ['Cancel', rev.action === 'update' ? 'Update' : 'Install'], defaultId: 0, cancelId: 0,
      message: (rev.action === 'update' ? 'Update ' : 'Install ') + rev.name + ' ' + rev.version + '?',
      detail: [
        'Publisher: ' + rev.publisherName + (rev.signature === 'valid' ? ' (signed, key ' + rev.fingerprint + ')' : ' (NOT signed)'),
        'It may: ' + (asked.length ? asked.join('; ') : 'nothing beyond reading its own files'),
        ...integrationLines(rev),
        'It runs in a separate restricted process. You are still asked before commands that change anything.',
      ].join(String.fromCharCode(10)),
    };
    const res = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (res.response !== 1) throw new Error(INSTALL_CANCELLED_MESSAGE);
    await packages.install(src, { ...(approval as PackageApproval), installPlugin: !!rev.integration, elevate: false });
    return listing();
  });
  handle(IPC.extPkgEnable, z.tuple([z.string().min(1).max(100), z.boolean()]), async (id, on) => { await packagesReady; await packages.setEnabled(id, on); return listing(); });
  handle(IPC.extPkgUninstall, z.tuple([z.string().min(1).max(100)]), async (id) => {
    await packagesReady;
    const win = d.window();
    const options: Electron.MessageBoxOptions = { type: 'question', title: 'Remove integration', message: 'Remove ' + id + '?', detail: 'Its files and stored data are deleted. Programs it controlled and your projects are not changed.', buttons: ['Cancel', 'Remove'], defaultId: 0, cancelId: 0, noLink: true };
    const res = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (res.response !== 1) throw new Error('Removal was cancelled.');
    await packages.uninstall(id);
    return listing();
  });
  handle(IPC.extPkgRepair, z.tuple([z.string().min(1).max(100)]), async (id) => { await packagesReady; await packages.repair(id); return listing(); });
  handle(IPC.extJobs, none, async () => external.jobs());
  handle(IPC.extJobCancel, z.tuple([z.string().min(1).max(100)]), async (id) => { external.cancelJob(id); return external.jobs(); });
  handle(IPC.extAddLocation, none, async () => {
    const win = d.window();
    const o: Electron.OpenDialogOptions = { title: 'Choose the application (.exe) or its folder', properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['exe'] }] };
    const r = await (win ? dialog.showOpenDialog(win, o) : dialog.showOpenDialog(o));
    const p = r.canceled ? null : r.filePaths[0];
    if (!p) return null;
    await extStore.addPath(p);
    return external.scan();
  });

  // AI Adapter Builder: private, local integrations. The AI writes data (a blueprint); OmniCandy's templates and validators decide
  // whether a package exists; installing still goes through the review + native confirmation above. Nothing is shared or uploaded.
  const builderRoot = path.join(path.dirname(d.secretsDir), 'integrations', 'builder');
  const pickedDocs = new Set<string>();
  const offeredPrograms = new Set<string>();
  const projectId = z.string().regex(/^p[a-z0-9]{6,30}$/);
  const ask = async (o: Electron.MessageBoxOptions) => {
    const win = d.window();
    return (win && !win.isDestroyed() ? await dialog.showMessageBox(win, o) : await dialog.showMessageBox(o)).response;
  };
  const builder: BuilderService = new BuilderService({
    root: builderRoot, packages, manager: external,
    claude: () => { const s = claude().state(); return s.signedIn === false ? { ready: false, reason: 'Claude is not signed in. Open the Claude panel and sign in first.' } : { ready: true, reason: '' }; },
    author: () => {
      // Test hook for the smoke scripts only (they run in a scratch profile, never against a real Claude): a blueprint authored beforehand.
      if (process.env.CS_BUILDER_BLUEPRINT && process.env.CS_USER_DATA_DIR) {
        const read = (f: string) => parseBlueprint(JSON.parse(readFileSync(f, 'utf8')));
        const repairFile = process.env.CS_BUILDER_REPAIR_BLUEPRINT;
        return new ScriptedAuthor({ blueprint: read(process.env.CS_BUILDER_BLUEPRINT), note: 'blueprint supplied by a smoke script', ...(repairFile ? { repair: () => ({ blueprint: read(repairFile), changes: ['Applied the supplied corrected blueprint.'] }) } : {}) });
      }
      if (claude().state().signedIn === false) return { error: 'Claude is not signed in. Open the Claude panel, click "Sign in to Claude", then try again.' };
      return new ClaudeAuthor({ model: claude().state().model, cwd: builderRoot, web: true, env: () => claudeAuth.env() });
    },
    skipDocs: !!(process.env.CS_BUILDER_BLUEPRINT && process.env.CS_USER_DATA_DIR), // smoke scripts do not download documentation
    confirm: async (title, detail, ok) => (await ask({ type: 'question', title, message: title, detail, buttons: ['Cancel', ok], defaultId: 0, cancelId: 0, noLink: true })) === 1,
    emit: (p) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.builderProgress, p); },
  });
  const allowPackagesOf = async (id: string) => {
    const rec = await builder.store.get(id);
    const sum = rec ? await builder.summary(rec) : null;
    if (sum?.packagePath) allowedPackagePaths.add(sum.packagePath);
    if (rec?.proposal?.packagePath) allowedPackagePaths.add(rec.proposal.packagePath);
    for (const v of rec?.versions ?? []) allowedPackagePaths.add(builder.store.packagePath(id, v.version));
  };
  const requestSchema = z.object({ appName: z.string().min(1).max(80), exePath: z.string().max(600).nullable().optional(), documentation: z.array(z.string().max(600)).max(40).optional(), documentationUrls: z.array(z.string().max(600)).max(10).optional(), goal: z.string().max(500).optional() });
  const startBuild = async (req: BuilderRequest) => {
    if (req.exePath && !offeredPrograms.has(req.exePath.toLowerCase())) throw new Error('Choose the program from the list so OmniCandy knows it is the right one.');
    for (const u of req.documentationUrls ?? []) { let ok = false; try { ok = new URL(u).protocol === 'https:'; } catch { /* not an address */ } if (!ok) throw new Error(`${u} is not a secure web address. Links must start with https://`); }
    for (const p of req.documentation ?? []) if (!pickedDocs.has(p)) throw new Error('Documentation must be chosen with "Add documentation".');
    return builder.create(req);
  };
  handle(IPC.builderOverview, none, async () => {
    await packagesReady;
    await listing();
    const o = await builder.overview();
    for (const p of o.programs) if (p.exePath) offeredPrograms.add(p.exePath.toLowerCase());
    for (const p of o.projects) await allowPackagesOf(p.id);
    return o;
  });
  handle(IPC.builderCreate, z.tuple([requestSchema]), async (req) => { await packagesReady; return startBuild({ ...req, exePath: req.exePath ?? null }); });
  handle(IPC.builderDetail, z.tuple([projectId]), async (id) => { await allowPackagesOf(id); return builder.detail(id); });
  handle(IPC.builderPickDocs, z.tuple([z.enum(['files', 'folder'])]), async (kind) => {
    const win = d.window();
    const o: Electron.OpenDialogOptions = kind === 'files'
      ? { title: 'Choose documentation or SDK files', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Documentation (text, HTML, source)', extensions: ['md', 'txt', 'html', 'htm', 'json', 'xml', 'py', 'cs', 'js', 'ts', 'h', 'hpp', 'rst'] }] }
      : { title: 'Choose a documentation or SDK folder', properties: ['openDirectory'] };
    const r = await (win ? dialog.showOpenDialog(win, o) : dialog.showOpenDialog(o));
    if (r.canceled) return [];
    for (const p of r.filePaths) pickedDocs.add(p);
    return r.filePaths;
  });
  handle(IPC.builderPickProgram, none, async (): Promise<InstalledProgram | null> => {
    const win = d.window();
    const o: Electron.OpenDialogOptions = { title: 'Choose the program file', properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: 'Programs', extensions: ['exe'] }] } : {}) };
    const r = await (win ? dialog.showOpenDialog(win, o) : dialog.showOpenDialog(o));
    if (r.canceled || !r.filePaths[0]) return null;
    const program = await programFromPath(r.filePaths[0]);
    offeredPrograms.add(r.filePaths[0].toLowerCase()); // chosen by the user in the file picker, so Create Integration accepts it
    return program;
  });
  handle(IPC.builderCancel, z.tuple([projectId]), async (id) => { builder.cancel(id); });
  handle(IPC.builderSync, z.tuple([projectId]), async (id) => { await packagesReady; return builder.syncInstalled(id); });
  handle(IPC.builderVerify, z.tuple([projectId, z.string().max(400).optional()]) as unknown as z.ZodType<[string, string | undefined]>, async (id, project) => { await packagesReady; return builder.verifyLive(id, project ? { project } : {}); });
  handle(IPC.builderPropose, z.tuple([projectId, z.object({ commandId: z.string().max(80).optional(), error: z.string().max(1000).optional() })]), async (id, why) => {
    await packagesReady;
    const p = await builder.propose(id, why);
    await allowPackagesOf(id);
    return p;
  });
  handle(IPC.builderDiscard, z.tuple([projectId]), async (id) => builder.discardProposal(id));
  handle(IPC.builderRollback, z.tuple([projectId, z.string().regex(/^\d+(\.\d+){0,2}$/)]), async (id, v) => { await packagesReady; await allowPackagesOf(id); return builder.rollback(id, v); });
  handle(IPC.builderRemove, z.tuple([projectId]), async (id) => {
    await packagesReady;
    if ((await ask({ type: 'question', title: 'Remove integration', message: 'Remove this custom integration?', detail: 'It is uninstalled and its permissions are forgotten. The saved versions stay so you can install it again. The program is not touched.', buttons: ['Cancel', 'Remove'], defaultId: 0, cancelId: 0, noLink: true })) !== 1) throw new Error('Removal was cancelled.');
    return builder.removeIntegration(id);
  });
  handle(IPC.builderDelete, z.tuple([projectId]), async (id) => {
    if ((await ask({ type: 'warning', title: 'Delete integration project', message: 'Delete this project and all saved versions?', detail: 'The generated files are deleted from this computer.', buttons: ['Cancel', 'Delete'], defaultId: 0, cancelId: 0, noLink: true })) !== 1) throw new Error('Deletion was cancelled.');
    await builder.deleteProject(id);
  });
  handle(IPC.builderMine, none, async () => { await packagesReady; return builder.mine(); });
  handle(IPC.builderCompat, z.tuple([projectId]), async (id) => builder.compatibility(id));
  handle(IPC.builderRefreshDocs, z.tuple([projectId]), async (id) => builder.refreshDocs(id));

  // Shared blank-file implementation for both Claude and the independent agent.
  const createAgentBlank = async (appId: EditorAppId, name?: string): Promise<{id:string;name:string}> => {
    const ext = BLANK_FILES[appId];
    if (!ext) throw new Error(`${EDITOR_APPS[appId].name} has no blank starter file.`);
    const src = app.isPackaged ? path.join(process.resourcesPath, 'sample-project', 'blank', `blank.${ext}`) : path.join(app.getAppPath(), 'fixtures', 'sample-project', 'blank', `blank.${ext}`);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-blank-'));
    try {
      const file = path.join(dir, `${(name || 'New document').replace(/[^\w\- ]/g, '').trim().slice(0, 60) || 'New document'}.${ext}`);
      await fs.copyFile(src, file);
      const {asset} = await (await d.project()).importFile(file,{origin:'fixture',source:`Blank starter file made with ${EDITOR_APPS[appId].name}.`});
      return {id:asset.id,name:asset.name};
    } finally {await fs.rm(dir,{recursive:true,force:true});}
  };
  let partner: ClaudePartner | null = null;
  resetters.push(() => { partner = null; });
  const claude = (): ClaudePartner => (partner ??= new ClaudePartner({
    live,
    store: d.project,
    openAsset: async (id, app) => { await openLive(id, app, 'claude'); },
    newBlankFile: createAgentBlank,
    emit: (st) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.claudeEvent, st); },
    cliPath: defaultClaudeCli(),
    auth: claudeAuth,
    generate: (job, requester) => runGeneration(job, 'claude', requester),
    generateVideo: (job, requester) => video.submit(job, 'claude', requester),
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
    external: {
      // Short by default (a program's whole command list can be tens of thousands of characters, more than a model can be shown);
      // one program's commands in full when it is asked for by name.
      list: async (app) => {
        const s = await external.scan();
        if (app) {
          const want = app.trim().toLowerCase();
          const a = s.apps.find((x) => x.key === app || x.adapterId === app || x.name.toLowerCase() === want)
            ?? s.apps.find((x) => x.adapterId && ((x.adapterName ?? x.name).toLowerCase() === want || x.name.toLowerCase().startsWith(want)));
          if (!a) throw new Error(`No detected application "${app}". Use external_apps with no app to see the names.`);
          return describeAppForModel(a);
        }
        const brief = (a: ExternalAppInfo) => ({
          app_key: a.key, name: a.name, version: a.version, status: a.status, detail: a.statusDetail.slice(0, 160), adapter: a.adapterId, maturity: a.maturity,
          commands: a.commands.map((c) => c.id),
        });
        return JSON.stringify({ applications: s.apps.map(brief), not_found: s.missing.map((m) => `${m.name} (${m.maturity})`), note: 'Only commands listed here exist. status connected/available means usable; unsupported means detected only. To see one program\'s commands and their settings call external_apps again with app set to its app_key or name.' }, null, 2);
      },
      run: async (app, command, params, background) => {
        await packagesReady;
        const s = await external.list();
        const a = s.find((x) => x.key === app || x.adapterId === app || x.name.toLowerCase() === app.toLowerCase());
        if (!a) throw new Error(`No detected application "${app}". Use external_apps.`);
        const r = await external.execute(a.key, command, params, background === undefined ? {} : { background });
        const added = await bringIntoLibrary(a.name, (r as { outputs?: Array<{ path: string }> }).outputs);
        return JSON.stringify(added ? { ...r, added_to_library: added } : r, null, 2);
      },
      job: externalJobReport,
    },
    planner: {
      call: async (tool, args) => {
        const out = await plannerSession.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
        const r = out?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
        const t = r?.content?.[0]?.text ?? out?.error?.message ?? 'No answer.';
        if (r?.isError) throw new Error(t);
        return t;
      },
    },
    builder: {
      start: async (appName, goal) => {
        const r = await ask({ type: 'question', title: 'Create a custom integration', message: `Claude wants OmniCandy to build an integration for ${appName}.`, detail: `${BUILDER_CONSENT}\n\nNothing is installed from this: you review and approve the result in Settings > Integrations.`, buttons: ['Cancel', 'Start building'], defaultId: 0, cancelId: 0, noLink: true });
        if (r !== 1) return JSON.stringify({ started: false, reason: 'The user declined. Do not ask again unless they bring it up.' });
        const s = await builder.create({ appName, goal });
        return JSON.stringify({ started: true, project_id: s.id, note: 'Research and building run in the background. The user reviews and approves the result in Settings > Integrations > Create Custom Integration. You cannot install it.' });
      },
      status: async () => JSON.stringify((await builder.overview()).projects.map((p) => ({ project_id: p.id, app: p.appName, status: p.statusLabel, headline: p.headline, installed: p.installed, tested_commands: p.verification.verified })), null, 2),
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
  // Independent model harness. Project-scoped; existing Claude path remains unchanged.
  let agentAbort: AbortController | null = null;
  // Budget, provider selection (non-secret) and usage ride in pausedAgent and the encrypted checkpoint, so Continue Task
  // keeps them, also after an app restart. Credentials never do: keys are lent by the vault per request.
  let pausedAgent: PausedAgent | null = null;
  // The conversation of the last task, kept in memory so a chat message after it finished (or was stopped) continues it with its context.
  let conversation: PausedAgent | null = null;
  // Background jobs this task started. Cancelled on stop or takeover; a job that is missing after a restart stays blocked from relaunch.
  const jobLedger = new AgentJobLedger(external, async (jobs) => {
    const store = await taskStore();
    const current = await store.load();
    if (current) await store.save({ ...current, jobs });
  });
  let interruptNote = '';
  const cancelAgentJobs = (): string[] => { const ids = jobLedger.cancelRunning(); if (ids.length) interruptNote = ` Background job${ids.length > 1 ? 's' : ''} ${ids.join(', ')} ${ids.length > 1 ? 'were' : 'was'} cancelled.`; return ids; };
  const takeInterruptNote = (): string => { const n = interruptNote; interruptNote = ''; return n; };
  const buildAgentRegistry = async (ctl: Awaited<ReturnType<typeof live>>, provider: { supportsVision: boolean }, resumeMessages?: import('./agentHarness/types').Message[], claudeStyle = false) => {
    const store = await d.project();
    jobLedger.reconcile();
    const registry = addExternalTools(nativeToolRegistry(ctl, store, { supportsVision: provider.supportsVision, createBlank: createAgentBlank }), external, {
      onJobStarted: (job) => jobLedger.started({ id: job.jobId, appKey: job.appKey, commandId: job.commandId }),
      jobGuard: (appKey, commandId) => jobLedger.guard(appKey, commandId),
      supportsVision: provider.supportsVision,
      claudeStyle,
      describeJob: async (id, cancel) => { const report = await externalJobReport(id, cancel); jobLedger.reconcile(); return report; },
    });
    addExportTools(registry, { ctl, store, deliver });
    // Timeline, workflow, planner, generation and PhotoCraft tools are Claude's own handlers (approvals and path rules included).
    // Planner / workflow / generation / local-media tools are advertised on request (enable_tools); a resumed task gets back the ones it used.
    registerSharedTools(registry, await claude().agentToolDefs(SHARED_CLAUDE_TOOL_NAMES), familiesUsedIn(resumeMessages));
    return registry;
  };
  let agentState: AgentUiState = { status: 'idle', model: 'gpt-4.1-mini', goal: '', result: '', events: [] };
  const taskStore = async () => new TaskCheckpointStore((await d.project()).root, safeStorage);
  const editJournal = async () => new EditIntentJournal((await d.project()).root, safeStorage);
  const journalHooks = {
    onEditBegin: async (tool:JournaledTool, command:string, args:unknown) => {
      await (await editJournal()).begin(agentState.goal,tool,command,args);
    },
    onEditSettled: async (safe:boolean) => { if(safe)await (await editJournal()).clear(); },
    onRecoveryResolved: async () => {await (await editJournal()).clear();},
  };
  const restoreAgent = async () => {
    if (agentAbort || pausedAgent || agentState.status !== 'idle') return;
    const restored = await restoreRecoveryState(await taskStore(), await editJournal());
    if (restored.kind === 'empty') return;
    const result = recoveryIpcState(restored, agentState);
    pausedAgent = result.paused;
    jobLedger.restore(result.paused?.jobs);
    agentState = result.state;
    publishAgent();
  };
  const refreshRecoveryPresentation = async () => {
    try { agentState = {...agentState, recovery: recoveryPresentation(await (await editJournal()).load())}; }
    catch { agentState = {...agentState, recovery: recoveryPresentation(null, true)}; }
  };
  const checkpoint = async () => {
    const store = await taskStore();
    if (pausedAgent && (agentState.status === 'limit' || agentState.status === 'paused')) {
      const jobs = jobLedger.snapshot();
      const ok = await store.save({ ...pausedAgent, status: agentState.status, ...(jobs.length ? { jobs } : {}) });
      if (!ok) agentState = {...agentState,result:agentState.result + ' Note: checkpoint not saved (encryption unavailable or task too large).'};
    } else await store.clear();
  };
  const publishAgent = () => { const w = d.window(); if (w && !w.isDestroyed()) w.webContents.send(IPC.agentEvent, agentState); };
  const endAgent = () => { pausedAgent = null; conversation = null; cancelAgentJobs(); jobLedger.clear(); agentAbort?.abort(); agentAbort = null; agentState = { status: 'idle', model: 'gpt-4.1-mini', goal: '', result: '', events: [] }; publishAgent(); };
  resetters.push(endAgent);
  handle(IPC.agentState, none, async () => { await restoreAgent(); return agentState; });
  handle(IPC.agentPlanUpdate, z.tuple([z.array(planStepSchema).max(20)]), async (steps) => {
    await restoreAgent();
    if (agentAbort || !pausedAgent || !['paused', 'limit'].includes(agentState.status))
      throw new Error('The plan can only be edited while a saved task is paused or turn-limited.');
    const plan = validatePlanEdit(pausedAgent.goal, steps);
    const saved = { ...pausedAgent, status:agentState.status as 'paused'|'limit', plan };
    if (!await (await taskStore()).save(saved))
      throw new Error('Could not securely save this plan. No changes were applied.');
    pausedAgent = { ...pausedAgent, plan };
    agentState = { ...agentState, plan }; publishAgent();
    return agentState;
  });
  handle(IPC.agentStop, none, async () => { if (await (await editJournal()).load()) throw new Error('An unresolved edit journal exists. Continue Task to resolve it before discarding the session.'); pausedAgent = null; cancelAgentJobs(); jobLedger.clear(); agentAbort?.abort(); await (await taskStore()).clear(); conversation = null; sessionAllowed.clear(); agentState = { status: 'idle', model: agentState.model, goal: '', result: '', events: [], chat: [] }; publishAgent(); return agentState; });
  handle(IPC.agentInterrupt, none, async () => { agentAbort?.abort(); return agentState; });
  // Every event updates both the raw event list and the chat view the panel shows.
  const onAgentEvent = (event: AgentUiEvent) => { agentState = { ...agentState, events: [...agentState.events, event].slice(-100), chat: appendChat(agentState.chat, chatItemFromEvent(event)) }; publishAgent(); };
  type AgentBudgetIn = z.infer<typeof agentBudgetSchema>;
  type AgentProviderIn = z.infer<typeof agentProviderSchema>;
  const runAgentTask = async (goal: string, model: string, budget: AgentBudgetIn, selection: AgentProviderIn): Promise<AgentUiState> => {
    const ctl = await live();
    // Every rejection happens BEFORE anything is reset: a refused Run must never delete or replace the saved task or its checkpoint.
    await prepareNewTask({
      busy: !!agentAbort || agentState.status === 'working',
      loadJournal: async () => (await editJournal()).load(),
      claudeWorking: partner?.state().status === 'working',
      ctl, hasPausedTask: !!pausedAgent,
      reset: async () => { pausedAgent = null; conversation = null; jobLedger.resetForNewTask(); await (await taskStore()).clear().catch(() => undefined); },
    });
    const abort = new AbortController();
    agentAbort = abort;
    agentState = { status: 'working', model, goal, result: '', events: [], chat: appendChat([], userChatItem(goal)), provider: selection, budget };
    publishAgent();
    let started = false;
    try {
      // Borrow the key only for this request. It never enters renderer state or the checkpoint.
      const outcome = await withAgentProvider(selection, model, vault, async (provider) => {
        started = true;
        // Persist a minimal resumable seed before model/tool execution begins. A
        // crash in the first run must not strand the write-ahead journal alone.
        const seedSaved = await (await taskStore()).save({goal,model,status:'limit',messages:[{role:'user',content:goal}],provider:selection,budget});
        if (!seedSaved) throw new Error('Secure task checkpoint unavailable. Editing was not started.');
        return runAgent({ goal, provider, registry: await buildAgentRegistry(ctl, provider, undefined, !budget.strictVerification), ctl, signal: abort.signal, ...budget, relaxed: !budget.strictVerification, onInterrupted: () => { cancelAgentJobs(); },
          ...journalHooks,
          onPlan: (plan) => { agentState = { ...agentState, plan }; publishAgent(); },
          onEvent: onAgentEvent });
      });
      const usage = sumUsage(undefined, outcome.usage);
      pausedAgent = (outcome.status === 'paused' || outcome.status === 'limit') ? { goal, model, messages: outcome.messages, plan:outcome.plan, uncertainEdit:outcome.uncertainEdit, provider:selection, budget, ...(usage ? { usage } : {}) } : null;
      conversation = { goal, model, messages: outcome.messages, plan: outcome.plan, provider: selection, budget, ...(usage ? { usage } : {}) };
      agentState = { ...agentState, status: outcome.status, result: outcome.text + takeInterruptNote(), plan: outcome.plan, ...(usage ? { usage } : {}) };
      await checkpoint().catch(() => { agentState = {...agentState, result: agentState.result + ' Note: local checkpoint could not be saved.'}; }); await refreshRecoveryPresentation(); publishAgent();
      return agentState;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The agent failed.';
      // Nothing ran (for example no API key): do not leave a resumable seed behind.
      if (!started) await (await taskStore()).clear().catch(() => undefined);
      agentState = { ...agentState, status: abort.signal.aborted ? 'cancelled' : 'failed', result: message }; publishAgent();
      return agentState;
    } finally { if (agentAbort === abort) agentAbort = null; }
  };
  handle(IPC.agentRun, z.tuple([z.string().min(1).max(4000), z.string().min(1).max(80), agentBudgetSchema.default({}), agentProviderSchema.default(DEFAULT_AGENT_PROVIDER)]), runAgentTask);

  /** Continue Task (no text) or a chat follow-up (text): the same conversation, the same safety checks, the same journal. */
  const resumeAgentTask = async (followUp?: string): Promise<AgentUiState> => {
    await restoreAgent();
    const resumable = !!pausedAgent && ['paused', 'limit'].includes(agentState.status);
    if (!resumable && !(followUp && conversation)) throw new Error(followUp ? 'Nothing to continue yet: describe what you want.' : 'No paused or turn-limited task is available to resume.');
    // A chat message after the AI finished continues that conversation.
    let saved: PausedAgent = resumable ? (pausedAgent as PausedAgent) : (conversation as PausedAgent);
    pausedAgent = saved;
    // Check journal again even if the task was already restored in memory.
    const unresolvedJournal = await (await editJournal()).load();
    if (unresolvedJournal) { saved = {...saved, uncertainEdit:`${unresolvedJournal.tool} (${unresolvedJournal.command})`}; pausedAgent = saved; }
    agentState = { ...agentState, recovery: recoveryPresentation(unresolvedJournal) };
    if (agentAbort || partner?.state().status === 'working') throw new Error('Another AI task is running.');
    const ctl = await live();
    const c = ctl.snapshot().collab;
    if (c.lockOwner === 'user' || ['manual','pausing','awaiting_approval','running'].includes(c.phase) || c.activeOperation)
      throw new Error('Release manual control and finish any active operation before resuming.');
    // releaseControl() moves manual ownership to 'paused'. Clear only that dormant
    // collaboration state, never an active task, so claudeGate can acquire a new
    // lock against the document's current version on the next edit.
    if (c.phase === 'paused') ctl.cancel();
    // A checkpoint written before Package B has no provider: it ran on OpenAI with the default budget.
    const selection = saved.provider ?? DEFAULT_AGENT_PROVIDER;
    const budget = saved.budget ?? {};
    const abort = new AbortController();
    agentAbort = abort;
    agentState = { ...agentState, status: 'working', result: '', provider: selection, budget, ...(followUp ? { chat: appendChat(agentState.chat, userChatItem(followUp)) } : {}) }; publishAgent();
    try {
      const outcome = await withAgentProvider(selection, saved.model, vault, (provider) =>
        buildAgentRegistry(ctl, provider, saved.messages, !budget.strictVerification).then((registry) => runAgent({ goal: saved.goal, resumeMessages: saved.messages, resumePlan:saved.plan, resumeUncertainEdit:saved.uncertainEdit, resumeExpectedEdit:unresolvedJournal?.expected, ...(followUp ? { followUp } : {}), provider,
          registry, ctl, signal: abort.signal, ...budget, relaxed: !budget.strictVerification, onInterrupted: () => { cancelAgentJobs(); },
          ...journalHooks,
          onPlan: (plan) => { agentState = { ...agentState, plan }; publishAgent(); },
          onEvent: onAgentEvent })));
      const usage = sumUsage(saved.usage, outcome.usage);
      pausedAgent = (outcome.status === 'paused' || outcome.status === 'limit') ? { ...saved, messages: outcome.messages, plan:outcome.plan, uncertainEdit:outcome.uncertainEdit, ...(usage ? { usage } : {}) } : null;
      conversation = { ...saved, messages: outcome.messages, plan: outcome.plan, uncertainEdit: outcome.uncertainEdit, ...(usage ? { usage } : {}) };
      agentState = { ...agentState, status: outcome.status, result: outcome.text + takeInterruptNote(), plan: outcome.plan, ...(usage ? { usage } : {}) };
      await checkpoint().catch(() => { agentState = {...agentState, result: agentState.result + ' Note: local checkpoint could not be saved.'}; }); await refreshRecoveryPresentation(); publishAgent();
      return agentState;
    } catch (error) {
      // A resume can fail after an application edit was dispatched. Never
      // discard the last good checkpoint or the write-ahead edit journal.
      // The old transcript may lag behind the edit; state must be inspected.
      let journalPresent = Boolean(unresolvedJournal);
      try { journalPresent = Boolean(await (await editJournal()).load()); }
      catch { journalPresent = true; } // unreadable journal must fail closed
      pausedAgent = { ...saved, uncertainEdit: journalPresent
        ? (saved.uncertainEdit ?? 'Unresolved edit journal') : saved.uncertainEdit };
      agentState = { ...agentState, status: 'limit',
        result: resumeFailureNotice(error instanceof Error ? error.message : 'Resume failed', journalPresent) };
      // Existing encrypted checkpoint stays on disk. Refresh only if safe.
      await checkpoint().catch(() => undefined);
      await refreshRecoveryPresentation();
      publishAgent();
      return agentState;
    } finally { if (agentAbort === abort) agentAbort = null; }
  };
  handle(IPC.agentResume, none, () => resumeAgentTask());
  // Chat: the user's words continue the conversation if there is one (paused, limited or finished), otherwise they start a task.
  handle(IPC.agentSend, z.tuple([z.string().min(1).max(4000), z.string().min(1).max(80), agentBudgetSchema.default({}), agentProviderSchema.default(DEFAULT_AGENT_PROVIDER)]), async (text, model, budget, selection) => {
    await restoreAgent();
    if (agentAbort || agentState.status === 'working') throw new Error('The AI is still working. Wait for it, or press Stop.');
    if ((pausedAgent && ['paused', 'limit'].includes(agentState.status)) || conversation) return resumeAgentTask(text);
    return runAgentTask(text, model, budget, selection);
  });

  handle(IPC.claudeState, none, async () => { await claude().ready(); return claude().state(); });
  handle(IPC.claudeSend, z.tuple([z.string().min(1).max(4000)]), (msg) => {
    if (agentAbort) throw new Error('Stop the independent agent before starting Claude.');
    return claude().send(msg);
  });

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
  handle(IPC.claudePlanProject, z.tuple([z.string().trim().min(3).max(4000), z.object({ selection: agentProviderSchema, model: z.string().min(1).max(80) }).strict().nullable().default(null)]), async (req, via) => {
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
    if (!via) return claude().planProject(req, refs);
    const problem = validateProviderSelection(via.selection, via.model);
    if (problem) throw new Error(problem);
    // Same planning prompt and parser as Claude; the key is lent by the vault for this one request only.
    return claude().planProject(req, refs, (input) => withAgentProvider(via.selection, via.model, vault, async (provider) => {
      const messages: import('./agentHarness/types').Message[] = [{ role: 'user', content: input.intro }];
      for (const img of input.images) messages.push({ role: 'user', content: `Reference picture: ${img.name}`, imageDataUrl: img.dataUrl });
      const reply = await provider.complete({ system: input.system, messages, tools: [], signal: input.signal });
      if (!reply.text?.trim()) throw new Error('The AI returned no plan. Try again or pick another AI.');
      return reply.text;
    }));
  });
  handle(IPC.claudeSeed, z.tuple([z.string().max(4000), z.string().max(4000)]), (u, c) => claude().seed(u, c));
  handle(IPC.setProjectMeta, z.tuple([z.object({
    objective: z.string().max(600).optional(),
    view: z.object({ workspace: z.enum(['home', 'media', 'edit', 'generate', 'workflow', 'effects', 'color', 'audio', 'deliver', 'planner', 'software']), assetId: z.string().max(128).optional() }).optional(),
  })]), async (patch) => (await d.project()).setMeta(patch));
  handle(IPC.claudeStop, none, () => claude().stop());
  handle(IPC.claudeReset, none, () => { claude().reset(); return claude().state(); });
  handle(IPC.claudeModel, z.tuple([z.string().max(64)]), (m) => { claude().setModel(m); return claude().state(); });
  handle(IPC.claudeAuth, none, () => claude().checkAuth());
  // Claude's credentials: the Claude sign-in (default) or an Anthropic API key saved with the credential vault (see claudeAuth.ts).
  const changeClaudeAuth = async (change: () => Promise<void>) => {
    if (claude().state().status === 'working') throw new Error('Claude is working. Wait for it to finish or stop it, then change this.');
    await change();
    return claude().authChanged();
  };
  handle(IPC.claudeAuthGet, none, () => claude().refreshAuth());
  handle(IPC.claudeAuthMode, z.tuple([z.enum(['sign-in', 'api-key'])]), (mode) => changeClaudeAuth(() => claudeAuth.setMode(mode)));
  handle(IPC.claudeAuthPasteKey, none, () => changeClaudeAuth(async () => {
    const copied = await clipboard.readText();
    await vault.save(ANTHROPIC_VAULT_ID, copied);
    if ((await clipboard.readText()) === copied) await clipboard.clear(); // don't leave the key on the clipboard
  }));
  handle(IPC.claudeAuthRemoveKey, none, () => changeClaudeAuth(async () => {
    await vault.remove(ANTHROPIC_VAULT_ID);
    if ((await claudeAuth.mode()) === 'api-key') await claudeAuth.setMode('sign-in'); // no key left: back to the sign-in
  }));
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
  handle(IPC.projectsSetOrder, z.tuple([z.array(projectKey).max(1000)]), (keys) => d.projects.setOrder(keys));
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
    const dir = await pickFolder('Choose an OmniCandy project folder (it contains project.json)');
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
  const emitBuild = (st: import('@shared/buildSession').BuildState) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.buildEvent, st); };
  const editWorkspace = new EditWorkspace({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    bundleDir: app.isPackaged ? path.join(process.resourcesPath, 'source') : null,
    workspaceDir: path.join(app.getPath('home'), 'OmniCandy Source'),
    fallbackCommand: app.isPackaged ? { cmd: process.execPath, args: [] } : { cmd: process.execPath, args: [app.getAppPath()] },
    emit: () => { void build.refresh(); },
    quit: () => app.quit(),
  });
  const build: BuildSession = new BuildSession({
    workspace: editWorkspace,
    env: () => claudeAuth.env(),
    scrub: (t) => claudeAuth.scrub(t),
    emit: emitBuild,
  });
  handle(IPC.buildState, none, async () => { await build.refresh(); return build.state(); });
  handle(IPC.buildSetup, none, () => editWorkspace.setup());
  handle(IPC.buildRebuild, none, () => editWorkspace.rebuildAndRestart());
  handle(IPC.buildRestore, none, () => editWorkspace.restoreOriginal());
  handle(IPC.buildInstallNode, none, () => editWorkspace.installNode());
  handle(IPC.buildSend, z.tuple([z.string().min(1).max(20000)]), (message) => build.send(message));
  handle(IPC.buildStop, none, () => build.stop());
  handle(IPC.buildReset, none, () => build.reset());
  handle(IPC.buildPlanUsage, none, async () => ((await claudeAuth.mode()) === 'api-key' ? { plan: null, fetchedAt: Date.now(), error: 'Plan limits only apply when Claude is signed in with a Claude subscription, not an API key.', session: null, weekly: null, weeklyOpus: null, weeklySonnet: null, credits: null } : fetchPlanUsage()));
  handle(IPC.buildAnswer, z.tuple([z.string().max(40), z.boolean()]), (id, allow) => build.answer(id, allow));
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
    if (agentAbort) throw new Error('The independent AI is still working. Stop it before switching projects.');
    if (generation.isBusy) throw new Error('An image is being generated. Wait for it to finish before switching projects.');
    d.panel.close();
    d.embedded.release(true);
    for (const r of resetters) r();
    await d.projects.open(key);
  });

  handle(IPC.probeApps, none, () => probeAllArtCraftApps());
  /** Opens an installed ArtCraft app by itself. Only the known apps' own executables from their install folders can start. */
  handle(IPC.launchApp, z.tuple([z.enum(Object.keys(EDITOR_APPS) as [EditorAppId, ...EditorAppId[]])]), async (appId) => {
    const folder = EDITOR_APPS[appId].name;
    const file = craftBin(craftInstallDir(folder), folder.toLowerCase());
    try { await fs.access(file); } catch { throw new Error(`${folder} is not installed on this PC.`); }
    const child = spawn(file, [], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  });
  handle(IPC.integrationStatus, none, async (): Promise<IntegrationSnapshot> => ({
    appAdapters: Object.values((await runnerDeps()).apps).map((a) => ({ id: a.id, isMock: a.isMock })),
    realExport: !!(await runnerDeps()).exportAsset,
    windowCapture: { available: capture.available, reason: capture.unavailableReason() },
    credentialVault: { available: vault.available, label: storageStatus().label, problem: storageStatus().problem, help: storageStatus().help },
    claude: { connected: false, reason: 'Claude integration is not configured in this build.' },
    providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label, isMock: p.id === 'mock', billable: p.billable })),
  }));
}

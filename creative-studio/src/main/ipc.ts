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
import { validateGraph } from '@shared/workflow';
import { WorkflowRunner, type RunnerDeps } from '@shared/workflowRunner';
import { probeAllArtCraftApps } from './artcraftProbe';
import { IMPORTABLE_EXTENSIONS } from './media';
import { AppEditors } from './appEditors';
import { ClaudePartner, defaultClaudeCli } from './claudePartner';
import { LiveTaskController } from './liveTask';
import { PhotoCraftCliAdapter } from './photocraftCli';
import type { ProjectManager } from './projects';
import type { EditorAppId } from '@shared/appEditors';
import type { EmbeddedApp } from './embeddedApp';
import { LiveDesignCraft, LiveEffectCraft, LiveFilmCraft, LiveLightCraft, LiveSoundCraft, LiveVectorCraft } from './liveApps';
import { LivePhotoCraft } from './photocraftLive';
import type { ProjectStore } from './projectStore';
import { parseWorkflow } from './schemas';
import { UnavailableWindowCapture } from './services';
import { SafeStorageVault } from './credentialVault';
import { GenerationService, type ApprovalRequest } from './generation';
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

  let running: { abort: AbortController; approvals: Map<string, (ok: boolean) => void> } | null = null;

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

  handle(IPC.runWorkflow, z.tuple([z.unknown()]), async (raw) => {
    if (running) throw new Error('A run is already in progress.');
    const g = parseWorkflow(raw);
    const issues = validateGraph(g);
    if (issues.length) throw new Error(issues.map((i) => i.message).join('\n'));
    const abort = new AbortController();
    const approvals = new Map<string, (ok: boolean) => void>();
    running = { abort, approvals };
    abort.signal.addEventListener('abort', () => { for (const r of approvals.values()) r(false); });
    try {
      return await new WorkflowRunner(await runnerDeps()).run(g, {
        signal: abort.signal,
        onEvent: (ev) => d.window()?.webContents.send(IPC.workflowEvent, ev),
        requestApproval: (nodeId) => new Promise<boolean>((resolve) => approvals.set(nodeId, resolve)),
        // No consent path in Phase 1: any billable provider is refused.
        consentToBillable: undefined,
      });
    } finally {
      running = null;
    }
  });
  handle(IPC.answerApproval, z.tuple([z.string().max(128), z.boolean()]), (nodeId, approved) => {
    const r = running?.approvals.get(nodeId);
    if (!r) throw new Error('No approval pending for that node.');
    running!.approvals.delete(nodeId);
    r(approved);
  });
  handle(IPC.cancelWorkflow, none, () => { running?.abort.abort(); });

  // ---- Live apps (PhotoCraft: token + roots; VectorCraft: roots; SoundCraft: loopback port) ----
  const PFdir = (name: string) => path.join(process.env.ProgramFiles ?? 'C:\\Program Files', name);
  let livePromise: Promise<LiveTaskController> | null = null;
  type Driver = LivePhotoCraft | LiveVectorCraft | LiveSoundCraft | LiveFilmCraft | LiveLightCraft | LiveEffectCraft | LiveDesignCraft;
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
      photocraft: path.join(store.root, 'work', 'live'),
      vectorcraft: path.join(store.root, 'work', 'vectorcraft-live'),
      soundcraft: path.join(store.root, 'work', 'soundcraft-live'),
      filmcraft: path.join(store.root, 'work', 'filmcraft-live'),
      lightcraft: path.join(store.root, 'work', 'lightcraft-live'),
      effectcraft: path.join(store.root, 'work', 'effectcraft-live'),
      designcraft: path.join(store.root, 'work', 'designcraft-live'),
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
  const appId = z.enum(['photocraft', 'vectorcraft', 'soundcraft', 'filmcraft', 'lightcraft', 'effectcraft', 'designcraft']);
  handle(IPC.liveOpen, z.union([z.tuple([z.string().min(1).max(128)]), z.tuple([z.string().min(1).max(128), appId])]), (id, app?: EditorAppId) => openLive(id, app));
  handle(IPC.liveTimeline, none, async () => (livePromise ? (await live()).timeline() : null));
  handle(IPC.livePlayhead, z.tuple([z.number().finite().min(0).max(36_000)]), async (s) => (await live()).setPlayhead(s));
  handle(IPC.liveSelectClip, z.tuple([z.number().int().min(0)]), async (c) => (await live()).selectClip(c));

  // ---- AI Generate (BYOK: keys in Windows protected storage, approval before every paid call) ----
  /** Native dialog in main: neither the renderer nor Claude can answer it. Cancel is the default. */
  const approveGeneration = async (r: ApprovalRequest): Promise<boolean> => {
    const win = d.window();
    const many = r.count === 1 ? 'image' : 'images';
    const prompt = r.prompt.length > 300 ? `${r.prompt.slice(0, 300)}…` : r.prompt;
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Approve paid image generation',
      message: `${r.requestedBy === 'claude' ? 'Claude is asking to generate' : 'Generate'} ${r.count} ${many} with ${r.provider} · ${r.model}?`,
      detail: [
        `Estimated cost: ${r.estimate.approximate ? 'about ' : ''}${formatUsd(r.estimate.amount)} USD, charged to your ${r.provider} account.`,
        r.estimate.basis,
        '',
        `Prompt: "${prompt}"`,
        `Settings: ${Object.entries(r.settings).map(([k, v]) => `${k} ${v}`).join(', ')}`,
        r.references.length ? `Reference images sent to ${r.provider}: ${r.references.join(', ')}` : '',
        '',
        'Nothing is sent until you click Generate.',
      ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'),
      buttons: ['Cancel', `Generate (${r.estimate.approximate ? '~' : ''}${formatUsd(r.estimate.amount)})`],
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
  const keyProvider = z.enum(['openai', 'gemini']);
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

  // ---- Claude Creative Partner (Claude Agent SDK, this PC's Claude Code sign-in) ----
  let partner: ClaudePartner | null = null;
  resetters.push(() => { partner = null; });
  const claude = () => (partner ??= new ClaudePartner({
    live,
    store: d.project,
    openAsset: async (id, app) => { await openLive(id, app, 'claude'); },
    emit: (st) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.claudeEvent, st); },
    cliPath: defaultClaudeCli(),
    generate: (job) => runGeneration(job, 'claude'),
    imageModels: async () => (await providerStatus()).filter((p) => p.configured),
    workDir: async () => { const dir = path.join((await d.project()).root, 'work', 'claude'); await fs.mkdir(dir, { recursive: true }); return dir; },
  }));
  handle(IPC.claudeState, none, () => claude().state());
  handle(IPC.claudeSend, z.tuple([z.string().min(1).max(4000)]), (msg) => claude().send(msg));
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
  handle(IPC.liveQuickEdit, z.tuple([z.string().min(1).max(64), z.record(z.string().max(64), z.union([z.number(), z.string().max(64)]))]),
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
  handle(IPC.editApply, z.tuple([id, z.string().min(1).max(64), z.record(z.string().max(64), z.union([z.number(), z.string().max(64)]))]),
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

  // ---- Projects ----
  const projectKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
  handle(IPC.projectsList, none, () => d.projects.list());
  handle(IPC.projectsCurrent, none, () => d.projects.currentKey());
  handle(IPC.projectsCreate, z.tuple([z.string().max(80)]), (name) => d.projects.create(name));
  handle(IPC.projectsRename, z.tuple([projectKey, z.string().min(1).max(80)]), (key, name) => d.projects.rename(key, name));
  handle(IPC.projectsRemove, z.tuple([projectKey]), (key) => d.projects.remove(key));
  handle(IPC.projectsReveal, z.tuple([projectKey]), (key) => { shell.openPath(d.projects.folder(key)); });
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

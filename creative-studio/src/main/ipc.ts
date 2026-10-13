// Narrow IPC surface. Every handler validates its arguments and checks the sender frame.

import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC, type ImportResult, type IntegrationSnapshot } from '@shared/ipc';
import type { AppearanceSettings } from '@shared/types';
import { MockArtCraftAdapter, MockGenerationProvider } from '@shared/mocks';
import { validateGraph } from '@shared/workflow';
import { WorkflowRunner, type RunnerDeps } from '@shared/workflowRunner';
import { probeAllArtCraftApps } from './artcraftProbe';
import { IMPORTABLE_EXTENSIONS } from './media';
import { AppEditors } from './appEditors';
import { LiveTaskController } from './liveTask';
import { PhotoCraftCliAdapter } from './photocraftCli';
import type { EditorAppId } from '@shared/appEditors';
import type { EmbeddedApp } from './embeddedApp';
import { LiveSoundCraft, LiveVectorCraft } from './liveApps';
import { LivePhotoCraft } from './photocraftLive';
import type { ProjectStore } from './projectStore';
import { parseWorkflow } from './schemas';
import { NotConfiguredCredentialVault, UnavailableWindowCapture } from './services';
import type { SettingsStore } from './settingsStore';

export interface IpcDeps {
  window: () => BrowserWindow | null;
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean;
  settings: SettingsStore;
  onAppearanceChanged: (s: AppearanceSettings) => void;
  project: () => Promise<ProjectStore>;
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

  const capture = new UnavailableWindowCapture();
  const vault = new NotConfiguredCredentialVault();
  const mockProvider = new MockGenerationProvider();
  // PhotoCraft is REAL when photocraft-cli.exe is installed; otherwise a labelled mock stands in.
  let depsPromise: Promise<RunnerDeps> | null = null;
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
    return s;
  });

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
  const drivers: Partial<Record<EditorAppId, LivePhotoCraft | LiveVectorCraft | LiveSoundCraft>> = {};
  const live = () => (livePromise ??= (async () => {
    const store = await d.project();
    const roots: Record<'photocraft' | 'vectorcraft' | 'soundcraft', string> = {
      photocraft: path.join(store.root, 'work', 'live'),
      vectorcraft: path.join(store.root, 'work', 'vectorcraft-live'),
      soundcraft: path.join(store.root, 'work', 'soundcraft-live'),
    };
    const driver = (app: EditorAppId) => {
      if (drivers[app]) return drivers[app]!;
      if (app === 'photocraft') drivers[app] = new LivePhotoCraft({ installDir: PFdir('PhotoCraft'), secretsDir: d.secretsDir, readRoot: store.root, writeRoot: roots.photocraft });
      else if (app === 'vectorcraft') drivers[app] = new LiveVectorCraft({ installDir: PFdir('VectorCraft'), readRoot: store.root, writeRoot: roots.vectorcraft });
      else if (app === 'soundcraft') drivers[app] = new LiveSoundCraft({ installDir: PFdir('SoundCraft'), readRoot: store.root, writeRoot: roots.soundcraft });
      else throw new Error(`${app} can't be opened live.`);
      return drivers[app]!;
    };
    const ctl = new LiveTaskController({
      connect: async (app) => { const drv = driver(app); await drv.ensureStarted(); return drv; },
      store,
      emit: (s) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.liveEvent, s); },
      writeDir: async (app) => { const dir = roots[app as keyof typeof roots]; if (!dir) throw new Error('No write folder.'); await fs.mkdir(dir, { recursive: true }); return dir; },
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
  handle(IPC.liveOpen, z.tuple([z.string().min(1).max(128)]), async (id) => {
    const ctl = await live();
    const s = await ctl.open(id);
    const pid = await currentPid();
    if (pid) {
      d.embedded.attach(pid);
      if (d.embedded.mode === 'window') { d.panel.close(); await d.panel.open(pid); ctl.setPoppedOut(true); return ctl.snapshot(); }
    }
    return s;
  });
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

  handle(IPC.probeApps, none, () => probeAllArtCraftApps());
  handle(IPC.integrationStatus, none, async (): Promise<IntegrationSnapshot> => ({
    appAdapters: Object.values((await runnerDeps()).apps).map((a) => ({ id: a.id, isMock: a.isMock })),
    realExport: !!(await runnerDeps()).exportAsset,
    windowCapture: { available: capture.available, reason: capture.unavailableReason() },
    credentialVault: { available: vault.available },
    claude: { connected: false, reason: 'Claude integration is not configured in this build.' },
    providers: [{ id: mockProvider.id, label: 'Mock provider', isMock: true, billable: mockProvider.billable }],
  }));
}

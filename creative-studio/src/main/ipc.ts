// Narrow IPC surface. Every handler validates its arguments and checks the sender frame.

import path from 'node:path';
import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC, type ImportResult, type IntegrationSnapshot } from '@shared/ipc';
import type { AppearanceSettings } from '@shared/types';
import { MockArtCraftAdapter, MockGenerationProvider } from '@shared/mocks';
import { validateGraph } from '@shared/workflow';
import { WorkflowRunner, type RunnerDeps } from '@shared/workflowRunner';
import { probeAllArtCraftApps } from './artcraftProbe';
import { IMPORTABLE_EXTENSIONS } from './media';
import { PhotoCraftCliAdapter } from './photocraftCli';
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
}

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

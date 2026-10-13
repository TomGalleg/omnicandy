// Sandboxed preload: exposes exactly the StudioApi, nothing else. No Node APIs reach the renderer.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { ASSET_SCHEME, IPC, type StudioApi } from '@shared/ipc';
import type { LiveSnapshot } from '@shared/live';
import type { WorkflowRunEvent } from '@shared/workflow';

const api: StudioApi = {
  getAppearance: () => ipcRenderer.invoke(IPC.getAppearance),
  setAppearance: (s) => ipcRenderer.invoke(IPC.setAppearance, s),
  loadProject: () => ipcRenderer.invoke(IPC.loadProject),
  importAssets: () => ipcRenderer.invoke(IPC.importAssets),
  setAssetRating: (id, rating) => ipcRenderer.invoke(IPC.setAssetRating, id, rating),
  loadWorkflow: () => ipcRenderer.invoke(IPC.loadWorkflow),
  saveWorkflow: (g) => ipcRenderer.invoke(IPC.saveWorkflow, g),
  runWorkflow: (g) => ipcRenderer.invoke(IPC.runWorkflow, g),
  answerApproval: (nodeId, approved) => ipcRenderer.invoke(IPC.answerApproval, nodeId, approved),
  cancelWorkflow: () => ipcRenderer.invoke(IPC.cancelWorkflow),
  onWorkflowEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: WorkflowRunEvent) => cb(ev);
    ipcRenderer.on(IPC.workflowEvent, listener);
    return () => ipcRenderer.removeListener(IPC.workflowEvent, listener);
  },
  listExports: () => ipcRenderer.invoke(IPC.listExports),
  revealExport: (name) => ipcRenderer.invoke(IPC.revealExport, name),
  live: {
    state: () => ipcRenderer.invoke(IPC.liveState),
    open: (assetId) => ipcRenderer.invoke(IPC.liveOpen, assetId),
    run: (steps) => ipcRenderer.invoke(IPC.liveRun, steps),
    pause: () => ipcRenderer.invoke(IPC.livePause),
    takeControl: () => ipcRenderer.invoke(IPC.liveTakeControl),
    releaseControl: () => ipcRenderer.invoke(IPC.liveRelease),
    resume: () => ipcRenderer.invoke(IPC.liveResume),
    confirmReplan: () => ipcRenderer.invoke(IPC.liveConfirm),
    cancel: () => ipcRenderer.invoke(IPC.liveCancel),
    saveVersion: () => ipcRenderer.invoke(IPC.liveSave),
    refresh: () => ipcRenderer.invoke(IPC.liveRefresh),
    onChange: (cb) => {
      const listener = (_e: IpcRendererEvent, s: LiveSnapshot) => cb(s);
      ipcRenderer.on(IPC.liveEvent, listener);
      return () => ipcRenderer.removeListener(IPC.liveEvent, listener);
    },
  },
  probeApps: () => ipcRenderer.invoke(IPC.probeApps),
  integrationStatus: () => ipcRenderer.invoke(IPC.integrationStatus),
  assetUrl: (assetId) => `${ASSET_SCHEME}://asset/${encodeURIComponent(assetId)}`,
};

contextBridge.exposeInMainWorld('studio', api);

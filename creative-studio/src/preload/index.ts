// Sandboxed preload: exposes exactly the StudioApi, nothing else. No Node APIs reach the renderer.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { ASSET_SCHEME, IPC, type StudioApi } from '@shared/ipc';
import type { ClaudeState } from '@shared/claude';
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
    popOut: () => ipcRenderer.invoke(IPC.livePopOut),
    dock: () => ipcRenderer.invoke(IPC.liveDock),
    setViewport: (v) => ipcRenderer.invoke(IPC.liveViewport, v),
    quickEdit: (opId, values) => ipcRenderer.invoke(IPC.liveQuickEdit, opId, values),
    undo: () => ipcRenderer.invoke(IPC.liveUndo),
    onChange: (cb) => {
      const listener = (_e: IpcRendererEvent, s: LiveSnapshot) => cb(s);
      ipcRenderer.on(IPC.liveEvent, listener);
      return () => ipcRenderer.removeListener(IPC.liveEvent, listener);
    },
  },
  claude: {
    state: () => ipcRenderer.invoke(IPC.claudeState),
    send: (message) => ipcRenderer.invoke(IPC.claudeSend, message),
    stop: () => ipcRenderer.invoke(IPC.claudeStop),
    reset: () => ipcRenderer.invoke(IPC.claudeReset),
    setModel: (model) => ipcRenderer.invoke(IPC.claudeModel, model),
    checkAuth: () => ipcRenderer.invoke(IPC.claudeAuth),
    signIn: () => ipcRenderer.invoke(IPC.claudeSignIn),
    cancelSignIn: () => ipcRenderer.invoke(IPC.claudeCancelSignIn),
    onChange: (cb) => {
      const listener = (_e: IpcRendererEvent, s: ClaudeState) => cb(s);
      ipcRenderer.on(IPC.claudeEvent, listener);
      return () => ipcRenderer.removeListener(IPC.claudeEvent, listener);
    },
  },
  edit: {
    apply: (assetId, opId, values) => ipcRenderer.invoke(IPC.editApply, assetId, opId, values),
    openWorkingCopy: (assetId) => ipcRenderer.invoke(IPC.editOpenCopy, assetId),
    list: () => ipcRenderer.invoke(IPC.editList),
    bringBack: (id) => ipcRenderer.invoke(IPC.editBringBack, id),
  },
  projects: {
    list: () => ipcRenderer.invoke(IPC.projectsList),
    current: () => ipcRenderer.invoke(IPC.projectsCurrent),
    create: (name) => ipcRenderer.invoke(IPC.projectsCreate, name),
    open: (key) => ipcRenderer.invoke(IPC.projectsOpen, key),
    rename: (key, name) => ipcRenderer.invoke(IPC.projectsRename, key, name),
    remove: (key) => ipcRenderer.invoke(IPC.projectsRemove, key),
    reveal: (key) => ipcRenderer.invoke(IPC.projectsReveal, key),
    assetUrl: (key, assetId) => `${ASSET_SCHEME}://asset/${encodeURIComponent(assetId)}?p=${encodeURIComponent(key)}`,
  },
  probeApps: () => ipcRenderer.invoke(IPC.probeApps),
  integrationStatus: () => ipcRenderer.invoke(IPC.integrationStatus),
  assetUrl: (assetId) => `${ASSET_SCHEME}://asset/${encodeURIComponent(assetId)}`,
};

contextBridge.exposeInMainWorld('studio', api);

// Sandboxed preload: exposes exactly the StudioApi, nothing else. No Node APIs reach the renderer.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { ASSET_SCHEME, IPC, type StudioApi } from '@shared/ipc';
import type { ClaudeState } from '@shared/claude';
import type { GenerateResultDto } from '@shared/ipc';
import type { DeliverJob } from '@shared/deliver';
import type { LiveSnapshot } from '@shared/live';
import type { WorkflowGraph, WorkflowRunEvent } from '@shared/workflow';
import type { WorkflowPlan } from '@shared/workflowPlan';

const api: StudioApi = {
  getAppearance: () => ipcRenderer.invoke(IPC.getAppearance),
  setAppearance: (s) => ipcRenderer.invoke(IPC.setAppearance, s),
  loadProject: () => ipcRenderer.invoke(IPC.loadProject),
  importAssets: () => ipcRenderer.invoke(IPC.importAssets),
  references: {
    pick: () => ipcRenderer.invoke(IPC.refsPick),
    remove: (id) => ipcRenderer.invoke(IPC.refsRemove, id),
    clear: () => ipcRenderer.invoke(IPC.refsClear),
    import: () => ipcRenderer.invoke(IPC.refsImport),
  },
  setAssetRating: (id, rating) => ipcRenderer.invoke(IPC.setAssetRating, id, rating),
  loadWorkflow: () => ipcRenderer.invoke(IPC.loadWorkflow),
  saveWorkflow: (g) => ipcRenderer.invoke(IPC.saveWorkflow, g),
  runWorkflow: (g) => ipcRenderer.invoke(IPC.runWorkflow, g),
  answerApproval: (nodeId, approved) => ipcRenderer.invoke(IPC.answerApproval, nodeId, approved),
  cancelWorkflow: () => ipcRenderer.invoke(IPC.cancelWorkflow),
  rerunWorkflow: (g, from) => ipcRenderer.invoke(IPC.rerunWorkflow, g, from ?? null),
  workflowAffected: (g) => ipcRenderer.invoke(IPC.workflowAffected, g),
  pauseWorkflow: () => ipcRenderer.invoke(IPC.pauseWorkflow),
  resumeWorkflow: () => ipcRenderer.invoke(IPC.resumeWorkflow),
  setWorkflowControl: (who) => ipcRenderer.invoke(IPC.setWorkflowControl, who),
  workflowRunState: () => ipcRenderer.invoke(IPC.workflowRunState),
  listWorkflowVersions: () => ipcRenderer.invoke(IPC.workflowVersions),
  restoreWorkflowVersion: (id) => ipcRenderer.invoke(IPC.workflowRestore, id),
  listWorkflowTemplates: () => ipcRenderer.invoke(IPC.workflowTemplates),
  saveWorkflowTemplate: (name, description) => ipcRenderer.invoke(IPC.workflowTemplateSave, name, description),
  useWorkflowTemplate: (id) => ipcRenderer.invoke(IPC.workflowTemplateUse, id),
  onWorkflowChanged: (cb) => {
    const listener = (_e: IpcRendererEvent, g: WorkflowGraph) => cb(g);
    ipcRenderer.on(IPC.workflowChanged, listener);
    return () => ipcRenderer.removeListener(IPC.workflowChanged, listener);
  },
  getWorkflowPlan: () => ipcRenderer.invoke(IPC.workflowPlanGet),
  applyWorkflowPlan: () => ipcRenderer.invoke(IPC.workflowPlanApply),
  dismissWorkflowPlan: () => ipcRenderer.invoke(IPC.workflowPlanDismiss),
  onWorkflowPlan: (cb) => {
    const listener = (_e: IpcRendererEvent, p: WorkflowPlan | null) => cb(p);
    ipcRenderer.on(IPC.workflowPlan, listener);
    return () => ipcRenderer.removeListener(IPC.workflowPlan, listener);
  },
  pickWorkflowFolder: () => ipcRenderer.invoke(IPC.workflowPickFolder),
  onWorkflowEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: WorkflowRunEvent) => cb(ev);
    ipcRenderer.on(IPC.workflowEvent, listener);
    return () => ipcRenderer.removeListener(IPC.workflowEvent, listener);
  },
  listExports: () => ipcRenderer.invoke(IPC.listExports),
  revealExport: (name) => ipcRenderer.invoke(IPC.revealExport, name),
  deliver: {
    jobs: () => ipcRenderer.invoke(IPC.deliverJobs),
    enqueue: (assetId, presetIds) => ipcRenderer.invoke(IPC.deliverEnqueue, assetId, presetIds),
    cancel: (jobId) => ipcRenderer.invoke(IPC.deliverCancel, jobId),
    clearFinished: () => ipcRenderer.invoke(IPC.deliverClear),
    history: (assetId) => (assetId ? ipcRenderer.invoke(IPC.deliverHistory, assetId) : ipcRenderer.invoke(IPC.deliverHistory)),
    openFolder: () => ipcRenderer.invoke(IPC.deliverOpenFolder),
    onJobs: (cb) => {
      const listener = (_e: IpcRendererEvent, jobs: DeliverJob[]) => cb(jobs);
      ipcRenderer.on(IPC.deliverEvent, listener);
      return () => ipcRenderer.removeListener(IPC.deliverEvent, listener);
    },
  },
  live: {
    state: () => ipcRenderer.invoke(IPC.liveState),
    open: (assetId, app) => (app ? ipcRenderer.invoke(IPC.liveOpen, assetId, app) : ipcRenderer.invoke(IPC.liveOpen, assetId)),
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
    timeline: () => ipcRenderer.invoke(IPC.liveTimeline),
    setPlayhead: (s) => ipcRenderer.invoke(IPC.livePlayhead, s),
    selectClip: (c) => ipcRenderer.invoke(IPC.liveSelectClip, c),
    editTimeline: (edit) => ipcRenderer.invoke(IPC.liveTimelineEdit, edit),
    onChange: (cb) => {
      const listener = (_e: IpcRendererEvent, s: LiveSnapshot) => cb(s);
      ipcRenderer.on(IPC.liveEvent, listener);
      return () => ipcRenderer.removeListener(IPC.liveEvent, listener);
    },
  },
  setProjectMeta: (patch) => ipcRenderer.invoke(IPC.setProjectMeta, patch),
  claude: {
    state: () => ipcRenderer.invoke(IPC.claudeState),
    send: (message) => ipcRenderer.invoke(IPC.claudeSend, message),
    planProject: (request) => ipcRenderer.invoke(IPC.claudePlanProject, request),
    seed: (user, claude) => ipcRenderer.invoke(IPC.claudeSeed, user, claude),
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
    create: (name, parentDir, meta) => ipcRenderer.invoke(IPC.projectsCreate, name, parentDir ?? null, meta ?? null),
    storage: () => ipcRenderer.invoke(IPC.projectsStorage),
    pickFolder: () => ipcRenderer.invoke(IPC.projectsPickFolder),
    setDefaultDir: (dir) => ipcRenderer.invoke(IPC.projectsSetDefaultDir, dir),
    revealDefaultDir: () => ipcRenderer.invoke(IPC.projectsRevealDefault),
    openExisting: () => ipcRenderer.invoke(IPC.projectsAddExisting),
    locate: (key) => ipcRenderer.invoke(IPC.projectsLocate, key),
    duplicate: (key) => ipcRenderer.invoke(IPC.projectsDuplicate, key),
    move: (key) => ipcRenderer.invoke(IPC.projectsMove, key),
    open: (key) => ipcRenderer.invoke(IPC.projectsOpen, key),
    rename: (key, name) => ipcRenderer.invoke(IPC.projectsRename, key, name),
    remove: (key) => ipcRenderer.invoke(IPC.projectsRemove, key),
    reveal: (key) => ipcRenderer.invoke(IPC.projectsReveal, key),
    assetUrl: (key, assetId) => `${ASSET_SCHEME}://asset/${encodeURIComponent(assetId)}?p=${encodeURIComponent(key)}`,
  },
  generate: {
    providers: () => ipcRenderer.invoke(IPC.genProviders),
    pasteKey: (id) => ipcRenderer.invoke(IPC.genPasteKey, id),
    removeKey: (id) => ipcRenderer.invoke(IPC.genRemoveKey, id),
    test: (id) => ipcRenderer.invoke(IPC.genTest, id),
    run: (job) => ipcRenderer.invoke(IPC.genRun, job),
    spending: () => ipcRenderer.invoke(IPC.genSpending),
    setSpendingLimit: (limitUsd) => ipcRenderer.invoke(IPC.genSpendingSet, limitUsd),
    openKeyPage: (id) => ipcRenderer.invoke(IPC.genKeyPage, id),
    onResult: (cb) => {
      const listener = (_e: IpcRendererEvent, r: GenerateResultDto) => cb(r);
      ipcRenderer.on(IPC.genEvent, listener);
      return () => ipcRenderer.removeListener(IPC.genEvent, listener);
    },
  },
  probeApps: () => ipcRenderer.invoke(IPC.probeApps),
  integrationStatus: () => ipcRenderer.invoke(IPC.integrationStatus),
  assetUrl: (assetId) => `${ASSET_SCHEME}://asset/${encodeURIComponent(assetId)}`,
};

contextBridge.exposeInMainWorld('studio', api);

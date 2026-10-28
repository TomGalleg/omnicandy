// Sandboxed preload: exposes exactly the StudioApi, nothing else. No Node APIs reach the renderer.

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { ASSET_SCHEME, IPC, type StudioApi } from '@shared/ipc';
import type { ClaudeState } from '@shared/claude';
import type { BuildState } from '@shared/buildSession';
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
  pathForFile: (file) => webUtils.getPathForFile(file),
  importPaths: (paths) => ipcRenderer.invoke(IPC.importPaths, paths),
  listSamples: () => ipcRenderer.invoke(IPC.samplesList),
  addSamples: (ids) => ipcRenderer.invoke(IPC.samplesAdd, ids),
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
  build: {
    state: () => ipcRenderer.invoke(IPC.buildState),
    send: (message, images) => ipcRenderer.invoke(IPC.buildSend, message, images ?? []),
    setModel: (id) => ipcRenderer.invoke(IPC.buildModel, id),
    setEffort: (e) => ipcRenderer.invoke(IPC.buildEffort, e),
    stop: () => ipcRenderer.invoke(IPC.buildStop),
    reset: () => ipcRenderer.invoke(IPC.buildReset),
    planUsage: () => ipcRenderer.invoke(IPC.buildPlanUsage),
    setup: () => ipcRenderer.invoke(IPC.buildSetup),
    rebuild: () => ipcRenderer.invoke(IPC.buildRebuild),
    restore: () => ipcRenderer.invoke(IPC.buildRestore),
    installNode: () => ipcRenderer.invoke(IPC.buildInstallNode),
    answer: (id, allow) => ipcRenderer.invoke(IPC.buildAnswer, id, allow),
    onChange: (cb) => {
      const listener = (_e: IpcRendererEvent, s: BuildState) => cb(s);
      ipcRenderer.on(IPC.buildEvent, listener);
      return () => ipcRenderer.removeListener(IPC.buildEvent, listener);
    },
  },
  deliver: {
    jobs: () => ipcRenderer.invoke(IPC.deliverJobs),
    enqueue: (assetId, presetIds) => ipcRenderer.invoke(IPC.deliverEnqueue, assetId, presetIds),
    cancel: (jobId) => ipcRenderer.invoke(IPC.deliverCancel, jobId),
    clearFinished: () => ipcRenderer.invoke(IPC.deliverClear),
    history: (assetId) => (assetId ? ipcRenderer.invoke(IPC.deliverHistory, assetId) : ipcRenderer.invoke(IPC.deliverHistory)),
    openFolder: () => ipcRenderer.invoke(IPC.deliverOpenFolder),
    addToLibrary: (jobId) => ipcRenderer.invoke(IPC.deliverKeep, jobId),
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
  agent: {
    state: () => ipcRenderer.invoke(IPC.agentState),
    run: (goal, model, budget, provider) => ipcRenderer.invoke(IPC.agentRun, goal, model, budget, provider),
    stop: () => ipcRenderer.invoke(IPC.agentStop),
    resume: () => ipcRenderer.invoke(IPC.agentResume),
    send: (text, model, budget, provider) => ipcRenderer.invoke(IPC.agentSend, text, model, budget, provider),
    interrupt: () => ipcRenderer.invoke(IPC.agentInterrupt),
    updatePlan: (steps) => ipcRenderer.invoke(IPC.agentPlanUpdate, steps),
    onChange: (cb) => {
      const listener = (_e: IpcRendererEvent, state: import('@shared/agentHarness').AgentUiState) => cb(state);
      ipcRenderer.on(IPC.agentEvent, listener);
      return () => ipcRenderer.removeListener(IPC.agentEvent, listener);
    },
  },
  claude: {
    state: () => ipcRenderer.invoke(IPC.claudeState),
    send: (message) => ipcRenderer.invoke(IPC.claudeSend, message),
    planProject: (request, via) => ipcRenderer.invoke(IPC.claudePlanProject, request, via),
    seed: (user, claude) => ipcRenderer.invoke(IPC.claudeSeed, user, claude),
    stop: () => ipcRenderer.invoke(IPC.claudeStop),
    reset: () => ipcRenderer.invoke(IPC.claudeReset),
    setModel: (model) => ipcRenderer.invoke(IPC.claudeModel, model),
    checkAuth: () => ipcRenderer.invoke(IPC.claudeAuth),
    authInfo: () => ipcRenderer.invoke(IPC.claudeAuthGet),
    setAuthMode: (mode) => ipcRenderer.invoke(IPC.claudeAuthMode, mode),
    pasteApiKey: () => ipcRenderer.invoke(IPC.claudeAuthPasteKey),
    removeApiKey: () => ipcRenderer.invoke(IPC.claudeAuthRemoveKey),
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
    setOrder: (keys) => ipcRenderer.invoke(IPC.projectsSetOrder, keys),
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
    studioJobs: () => ipcRenderer.invoke(IPC.studioJobs),
    studioJobsSave: (jobs) => ipcRenderer.invoke(IPC.studioJobsSave, jobs),
    recraftRun: (job) => ipcRenderer.invoke(IPC.recraftRun, job),
    recraftToolRun: (job) => ipcRenderer.invoke(IPC.recraftToolRun, job),
    higgsfieldJobs: () => ipcRenderer.invoke(IPC.higgsfieldJobs),
    higgsfieldRun: (job) => ipcRenderer.invoke(IPC.higgsfieldRun, job),
    higgsfieldCancel: (id) => ipcRenderer.invoke(IPC.higgsfieldCancel, id),
    higgsfieldStyles: (modelId) => ipcRenderer.invoke(IPC.higgsfieldStyles, modelId),
    onHiggsfield: (cb) => {
      const listener = (_e: unknown, r: Parameters<typeof cb>[0]) => cb(r);
      ipcRenderer.on(IPC.higgsfieldEvent, listener);
      return () => ipcRenderer.removeListener(IPC.higgsfieldEvent, listener);
    },
    videoJobs: () => ipcRenderer.invoke(IPC.videoList),
    videoSubmit: (job) => ipcRenderer.invoke(IPC.videoSubmit, job),
    videoCancel: (id) => ipcRenderer.invoke(IPC.videoCancel, id),
    motionRender: (job) => ipcRenderer.invoke(IPC.motionRender, job),
    motionCancel: () => ipcRenderer.invoke(IPC.motionCancel),
    localAiStatus: () => ipcRenderer.invoke(IPC.localAiStatus),
    localAiDownloads: () => ipcRenderer.invoke(IPC.localAiDownloads),
    localAiDownload: (id) => ipcRenderer.invoke(IPC.localAiDownload, id),
    localAiCancel: (id) => ipcRenderer.invoke(IPC.localAiCancel, id),
    localAiRemove: (id) => ipcRenderer.invoke(IPC.localAiRemove, id),
    localAiPickDir: () => ipcRenderer.invoke(IPC.localAiPickDir),
    localVideoRender: (job) => ipcRenderer.invoke(IPC.localVideoRender, job),
    localVideoCancel: () => ipcRenderer.invoke(IPC.localVideoCancel),
    onLocalVideoProgress: (cb) => {
      const listener = (_e: unknown, r: Parameters<typeof cb>[0]) => cb(r);
      ipcRenderer.on(IPC.localVideoProgress, listener);
      return () => ipcRenderer.removeListener(IPC.localVideoProgress, listener);
    },
    onLocalAi: (cb) => {
      const listener = (_e: unknown, r: Parameters<typeof cb>[0]) => cb(r);
      ipcRenderer.on(IPC.localAiEvent, listener);
      return () => ipcRenderer.removeListener(IPC.localAiEvent, listener);
    },
    onVideo: (cb) => {
      const listener = (_e: unknown, r: Parameters<typeof cb>[0]) => cb(r);
      ipcRenderer.on(IPC.videoEvent, listener);
      return () => ipcRenderer.removeListener(IPC.videoEvent, listener);
    },
    onResult: (cb) => {
      const listener = (_e: IpcRendererEvent, r: GenerateResultDto) => cb(r);
      ipcRenderer.on(IPC.genEvent, listener);
      return () => ipcRenderer.removeListener(IPC.genEvent, listener);
    },
  },
  external: {
    scan: () => ipcRenderer.invoke(IPC.extScan),
    list: () => ipcRenderer.invoke(IPC.extList),
    liveState: () => ipcRenderer.invoke(IPC.extLiveState),
    liveShow: () => ipcRenderer.invoke(IPC.extLiveShow),
    onLive: (cb) => {
      const listener = (_e: IpcRendererEvent, s: { name: string; pid: number | null }) => cb(s);
      ipcRenderer.on(IPC.extLive, listener);
      return () => ipcRenderer.removeListener(IPC.extLive, listener);
    },
    connect: (key) => ipcRenderer.invoke(IPC.extConnect, key),
    disconnect: (key) => ipcRenderer.invoke(IPC.extDisconnect, key),
    repair: (key) => ipcRenderer.invoke(IPC.extRepair, key),
    revoke: (key) => ipcRenderer.invoke(IPC.extRevoke, key),
    addLocation: () => ipcRenderer.invoke(IPC.extAddLocation),
    packages: () => ipcRenderer.invoke(IPC.extPkgList),
    pickPackage: (kind) => ipcRenderer.invoke(IPC.extPkgPick, kind),
    reviewPackage: (p) => ipcRenderer.invoke(IPC.extPkgReview, p),
    installPackage: (p, a) => ipcRenderer.invoke(IPC.extPkgInstall, p, a),
    setPackageEnabled: (id, on) => ipcRenderer.invoke(IPC.extPkgEnable, id, on),
    uninstallPackage: (id) => ipcRenderer.invoke(IPC.extPkgUninstall, id),
    repairPackage: (id) => ipcRenderer.invoke(IPC.extPkgRepair, id),
    jobs: () => ipcRenderer.invoke(IPC.extJobs),
    cancelJob: (id) => ipcRenderer.invoke(IPC.extJobCancel, id),
  },
  connect: {
    overview: (rescan) => ipcRenderer.invoke(IPC.connectOverview, rescan),
    connectApp: (key) => ipcRenderer.invoke(IPC.connectApp, key),
    browse: (kind) => ipcRenderer.invoke(IPC.connectBrowse, kind),
    forget: (key) => ipcRenderer.invoke(IPC.connectForget, key),
    done: () => ipcRenderer.invoke(IPC.connectDone),
  },
  builder: {
    overview: () => ipcRenderer.invoke(IPC.builderOverview),
    create: (req) => ipcRenderer.invoke(IPC.builderCreate, req),
    detail: (id) => ipcRenderer.invoke(IPC.builderDetail, id),
    pickDocs: (kind) => ipcRenderer.invoke(IPC.builderPickDocs, kind),
    pickProgram: () => ipcRenderer.invoke(IPC.builderPickProgram),
    cancel: (id) => ipcRenderer.invoke(IPC.builderCancel, id),
    sync: (id) => ipcRenderer.invoke(IPC.builderSync, id),
    verifyLive: (id, project) => ipcRenderer.invoke(IPC.builderVerify, id, project),
    propose: (id, why) => ipcRenderer.invoke(IPC.builderPropose, id, why ?? {}),
    discardProposal: (id) => ipcRenderer.invoke(IPC.builderDiscard, id),
    rollback: (id, v) => ipcRenderer.invoke(IPC.builderRollback, id, v),
    removeIntegration: (id) => ipcRenderer.invoke(IPC.builderRemove, id),
    deleteProject: (id) => ipcRenderer.invoke(IPC.builderDelete, id),
    mine: () => ipcRenderer.invoke(IPC.builderMine),
    compatibility: (id) => ipcRenderer.invoke(IPC.builderCompat, id),
    refreshDocs: (id) => ipcRenderer.invoke(IPC.builderRefreshDocs, id),
    onProgress: (cb) => {
      const h = (_e: IpcRendererEvent, p: Parameters<typeof cb>[0]) => cb(p);
      ipcRenderer.on(IPC.builderProgress, h);
      return () => ipcRenderer.removeListener(IPC.builderProgress, h);
    },
  },
  planner: Object.fromEntries(['list', 'get', 'activity', 'assetHealth', 'create', 'update', 'addItem', 'updateItem', 'setItemStatus', 'removeItem', 'addTask', 'updateTask', 'setTaskStatus', 'removeTask', 'releaseClaim', 'addAsset', 'pickAssets', 'removeAsset', 'addMilestone', 'removeMilestone', 'decideProposal', 'createPackage', 'prepareSend', 'importSuggestions', 'createFromHomePlan', 'chatProviders', 'chatModels', 'chat', 'chatLoad', 'chatSave', 'forProject', 'startPlan', 'analyze', 'applyFindings', 'touchTask', 'attachOlder', 'cancelPackage', 'packageView', 'savePackage', 'importReport', 'reviewReport', 'rawReport', 'exportProject', 'importProject', 'connectionInfo', 'openFolder'].map((m) => [m, (...a: unknown[]) => ipcRenderer.invoke(IPC.plannerCall, m, a)])) as unknown as StudioApi['planner'],
  probeApps: () => ipcRenderer.invoke(IPC.probeApps),
  launchApp: (appId: string) => ipcRenderer.invoke(IPC.launchApp, appId),
  integrationStatus: () => ipcRenderer.invoke(IPC.integrationStatus),
  assetUrl: (assetId) => `${ASSET_SCHEME}://asset/${encodeURIComponent(assetId)}`,
};

contextBridge.exposeInMainWorld('studio', api);

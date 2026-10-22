// The complete renderer ↔ main surface. Every channel here is validated in main (src/main/ipc.ts).

import type { AppearanceSettings, AppProbeResult, Asset, ProjectManifest, ProjectSummary } from './types';
import type { InstalledProgram } from './builder';
import type { ClaudeAuthMode, ClaudeBilling, ClaudeState } from './claude';
import type { AgentUiState } from './agentHarness';
import type { ProjectPlan } from './projectPlan';

export type ProjectMeta = Pick<ProjectManifest, 'kind' | 'brief' | 'objective'>;
export type ProjectMetaPatch = Pick<ProjectManifest, 'objective' | 'view'>;
import type { CostEstimate, ImageJob, ProviderId } from './generation';
import type { LiveSnapshot, TimelineDto, TimelineEdit } from './live';
import type { EditorAppId } from './appEditors';
import type { DeliverJob, DeliverRecord } from './deliver';
import type { WorkflowGraph, WorkflowRunEvent } from './workflow';
import type { WorkflowPlan } from './workflowPlan';
import type { RunSnapshot, WorkflowTemplate } from './workflowControl';

export interface StorageDto {
  defaultDir: string;
  isCustom: boolean;
  builtInDir: string;
  freeBytes: number | null;
  totalBytes: number | null;
}

export interface ExternalLiveState { name: string; pid: number | null }

export const IPC = {
  getAppearance: 'appearance:get',
  setAppearance: 'appearance:set',
  loadProject: 'project:load',
  importAssets: 'project:import',
  setAssetRating: 'project:rate',
  loadWorkflow: 'workflow:load',
  saveWorkflow: 'workflow:save',
  runWorkflow: 'workflow:run',
  answerApproval: 'workflow:approval',
  cancelWorkflow: 'workflow:cancel',
  workflowPickFolder: 'workflow:pick-folder',
  workflowEvent: 'workflow:event',
  workflowPlan: 'workflow:plan',
  rerunWorkflow: 'workflow:rerun',
  workflowAffected: 'workflow:affected',
  pauseWorkflow: 'workflow:pause',
  resumeWorkflow: 'workflow:resume',
  setWorkflowControl: 'workflow:control',
  workflowRunState: 'workflow:run-state',
  workflowVersions: 'workflow:versions',
  workflowRestore: 'workflow:restore',
  workflowTemplates: 'workflow:templates',
  workflowTemplateSave: 'workflow:template-save',
  workflowTemplateUse: 'workflow:template-use',
  workflowChanged: 'workflow:changed',
  workflowPlanGet: 'workflow:plan-get',
  workflowPlanApply: 'workflow:plan-apply',
  workflowPlanDismiss: 'workflow:plan-dismiss',
  listExports: 'exports:list',
  revealExport: 'exports:reveal',
  liveState: 'live:state',
  liveOpen: 'live:open',
  liveRun: 'live:run',
  livePause: 'live:pause',
  liveTakeControl: 'live:take-control',
  liveRelease: 'live:release',
  liveResume: 'live:resume',
  liveConfirm: 'live:confirm',
  liveCancel: 'live:cancel',
  liveSave: 'live:save',
  liveRefresh: 'live:refresh',
  liveEvent: 'live:event',
  livePopOut: 'live:pop-out',
  liveViewport: 'live:viewport',
  liveQuickEdit: 'live:quick-edit',
  liveUndo: 'live:undo',
  liveDock: 'live:dock',
  liveTimeline: 'live:timeline',
  livePlayhead: 'live:playhead',
  liveSelectClip: 'live:select-clip',
  liveTimelineEdit: 'live:timeline-edit',
  agentState: 'agent:state',
  agentRun: 'agent:run',
  agentStop: 'agent:stop',
  agentResume: 'agent:resume',
  agentPlanUpdate: 'agent:plan-update',
  agentEvent: 'agent:event',
  claudeState: 'claude:state',
  claudeSend: 'claude:send',
  claudePlanProject: 'claude:plan-project',
  claudeSeed: 'claude:seed',
  refsPick: 'refs:pick',
  refsRemove: 'refs:remove',
  refsClear: 'refs:clear',
  refsImport: 'refs:import',
  setProjectMeta: 'project:set-meta',
  claudeStop: 'claude:stop',
  claudeReset: 'claude:reset',
  claudeModel: 'claude:model',
  claudeAuth: 'claude:auth',
  claudeAuthGet: 'claude:auth-get',
  claudeAuthMode: 'claude:auth-mode',
  claudeAuthPasteKey: 'claude:auth-paste-key',
  claudeAuthRemoveKey: 'claude:auth-remove-key',
  claudeSignIn: 'claude:sign-in',
  claudeCancelSignIn: 'claude:cancel-sign-in',
  claudeEvent: 'claude:event',
  editApply: 'edit:apply',
  editOpenCopy: 'edit:open-copy',
  editList: 'edit:list',
  editBringBack: 'edit:bring-back',
  projectsList: 'projects:list',
  projectsCurrent: 'projects:current',
  projectsCreate: 'projects:create',
  projectsOpen: 'projects:open',
  projectsRename: 'projects:rename',
  projectsRemove: 'projects:remove',
  projectsReveal: 'projects:reveal',
  projectsSetOrder: 'projects:set-order',
  projectsStorage: 'projects:storage',
  projectsAddExisting: 'projects:add-existing',
  projectsLocate: 'projects:locate',
  projectsDuplicate: 'projects:duplicate',
  projectsMove: 'projects:move',
  projectsPickFolder: 'projects:pick-folder',
  projectsSetDefaultDir: 'projects:set-default-dir',
  projectsRevealDefault: 'projects:reveal-default',
  genProviders: 'generate:providers',
  genPasteKey: 'generate:paste-key',
  genRemoveKey: 'generate:remove-key',
  genTest: 'generate:test',
  genRun: 'generate:run',
  genSpending: 'generate:spending',
  genSpendingSet: 'generate:spending-set',
  genKeyPage: 'generate:key-page',
  genEvent: 'generate:event',
  videoList: 'video:list',
  videoSubmit: 'video:submit',
  videoCancel: 'video:cancel',
  videoEvent: 'video:event',
  motionRender: 'motion:render',
  extScan: 'ext:scan',
  extList: 'ext:list',
  extLive: 'ext:live',
  extLiveState: 'ext:live-state',
  extLiveShow: 'ext:live-show',
  extConnect: 'ext:connect',
  extDisconnect: 'ext:disconnect',
  extRepair: 'ext:repair',
  extRevoke: 'ext:revoke',
  extAddLocation: 'ext:add-location',
  extPkgList: 'ext:pkg-list',
  extPkgPick: 'ext:pkg-pick',
  extPkgReview: 'ext:pkg-review',
  extPkgInstall: 'ext:pkg-install',
  extPkgEnable: 'ext:pkg-enable',
  extPkgUninstall: 'ext:pkg-uninstall',
  extPkgRepair: 'ext:pkg-repair',
  extJobs: 'ext:jobs',
  extJobCancel: 'ext:job-cancel',
  connectOverview: 'connect:overview',
  connectApp: 'connect:app',
  connectBrowse: 'connect:browse',
  connectForget: 'connect:forget',
  connectDone: 'connect:done',
  builderOverview: 'builder:overview',
  builderCreate: 'builder:create',
  builderDetail: 'builder:detail',
  builderPickDocs: 'builder:pick-docs',
  builderPickProgram: 'builder:pick-program',
  builderCancel: 'builder:cancel',
  builderSync: 'builder:sync',
  builderVerify: 'builder:verify',
  builderPropose: 'builder:propose',
  builderDiscard: 'builder:discard',
  builderRollback: 'builder:rollback',
  builderRemove: 'builder:remove',
  builderDelete: 'builder:delete',
  builderMine: 'builder:mine',
  builderCompat: 'builder:compat',
  builderRefreshDocs: 'builder:refresh-docs',
  builderProgress: 'builder:progress',
  plannerCall: 'planner:call',
  localAiStatus: 'localai:status',
  localAiDownloads: 'localai:downloads',
  localAiDownload: 'localai:download',
  localAiCancel: 'localai:cancel',
  localAiRemove: 'localai:remove',
  localAiPickDir: 'localai:pick-dir',
  localAiEvent: 'localai:event',
  localVideoRender: 'localai:render',
  localVideoCancel: 'localai:render-cancel',
  localVideoProgress: 'localai:progress',
  motionCancel: 'motion:cancel',
  deliverJobs: 'deliver:jobs',
  deliverEnqueue: 'deliver:enqueue',
  deliverKeep: 'deliver:keep',
  deliverCancel: 'deliver:cancel',
  deliverClear: 'deliver:clear',
  deliverHistory: 'deliver:history',
  deliverOpenFolder: 'deliver:open-folder',
  deliverEvent: 'deliver:event',
  probeApps: 'apps:probe',
  launchApp: 'apps:launch',
  integrationStatus: 'integrations:status',
} as const;

export interface IntegrationSnapshot {
  appAdapters: Array<{ id: string; isMock: boolean }>;
  realExport: boolean;
  windowCapture: { available: boolean; reason: string | null };
  credentialVault: { available: boolean; label: string; problem: string | null; help: string | null };
  claude: { connected: boolean; reason: string };
  providers: Array<{ id: string; label: string; isMock: boolean; billable: boolean }>;
}

/** What the renderer may know about a provider key: never the key itself. */
export interface ProviderStatusDto {
  id: ProviderId;
  label: string;
  billable: boolean;
  configured: boolean;
  /** A saved key exists but cannot be decrypted on this PC (moved from another PC or user): add it again. */
  unreadable?: boolean;
  savedAt: string | null;
  lastTest: { ok: boolean; at: string; message: string; models?: string[] } | null;
  /** False when Windows protected storage is unavailable (keys can't be saved). */
  encryptionAvailable: boolean;
  /** Why keys cannot be saved (and what to do), or null. */
  encryptionProblem?: string | null;
  keyHint: string;
}

import type { VideoJob, VideoJobRecord } from './video';
import type { MotionJob } from './motionEffects';
import type { DownloadState, LocalAiStatus } from './localAi';
import type { BrowseResult, ConnectOutcome, ConnectOverview, ForgetResult } from './connect';
import type { ExternalAppInfo, ExternalScan, JobInfo, PackageApproval, PackageListing, PackageReview } from './integrations';
import type { LocalVideoJob } from './localVideo';
import type { PlannerApi } from './plannerApi';
import type { BuilderOverview, BuilderProgress, BuilderProjectDetail, BuilderProjectSummary, BuilderRequest, MyIntegration, PipelineReport, RepairProposal } from './builder';

export interface GenerateResultDto {
  assetIds: string[];
  message: string;
  estimate: CostEstimate;
  requestedBy: 'user' | 'claude';
}

export interface EditResultDto {
  app: string;
  assetIds: string[];
  message: string;
}

export interface ExternalEditDto {
  id: string;
  app: string;
  assetId: string;
  assetName: string;
  workPath: string;
  openedAt: string;
}

export interface PendingReference { id: string; name: string; kind: string; bytes: number }

export interface ImportResult {
  imported: Asset[];
  duplicates: Array<{ name: string; duplicateOf: string }>;
  errors: string[];
}

export interface StudioApi {
  getAppearance(): Promise<AppearanceSettings>;
  setAppearance(s: AppearanceSettings): Promise<AppearanceSettings>;
  loadProject(): Promise<ProjectManifest>;
  /** Opens a native file dialog in main; the renderer never supplies paths. */
  importAssets(): Promise<ImportResult>;
  /**
   * Reference files for a new project, chosen on Home. Main keeps the paths (the renderer never
   * supplies them); nothing is copied until `import` runs after the user approves the plan.
   */
  references: {
    pick(): Promise<PendingReference[]>;
    remove(id: string): Promise<PendingReference[]>;
    clear(): Promise<void>;
    /** Copies the pending files into the open project's originals (hashed, provenance, never modified). */
    import(): Promise<ImportResult>;
  };
  /** Saves where the user left off and Claude's current objective for the open project. */
  setProjectMeta(patch: ProjectMetaPatch): Promise<void>;
  setAssetRating(assetId: string, rating: number): Promise<ProjectManifest>;
  loadWorkflow(): Promise<WorkflowGraph>;
  saveWorkflow(g: WorkflowGraph): Promise<{ ok: true } | { ok: false; issues: string[] }>;
  runWorkflow(g: WorkflowGraph): Promise<{ ok: boolean; cancelled: boolean }>;
  /** true = approve every file, false = reject, or the indexes of the approved files. */
  answerApproval(nodeId: string, approved: boolean | number[]): Promise<void>;
  cancelWorkflow(): Promise<void>;
  /** Runs again only what a change affects (or `fromNodeId` and what follows); everything else keeps its earlier results. */
  rerunWorkflow(g: WorkflowGraph, fromNodeId?: string): Promise<{ ok: boolean; cancelled: boolean }>;
  /** Which steps would rerun for this graph, and whether it can become a template. */
  workflowAffected(g: WorkflowGraph): Promise<{ hasRun: boolean; affected: string[]; templateReady: boolean }>;
  /** Pauses between steps (never in the middle of one). */
  pauseWorkflow(): Promise<void>;
  resumeWorkflow(): Promise<void>;
  /** 'user' = manual control: the run pauses and Claude may not change or start anything until it is given back. */
  setWorkflowControl(who: 'user' | 'claude'): Promise<RunSnapshot>;
  workflowRunState(): Promise<RunSnapshot>;
  listWorkflowVersions(): Promise<Array<{ id: string; savedAt: string; reason: string; steps: number }>>;
  restoreWorkflowVersion(id: string): Promise<WorkflowGraph>;
  listWorkflowTemplates(): Promise<WorkflowTemplate[]>;
  saveWorkflowTemplate(name: string, description: string): Promise<WorkflowTemplate>;
  useWorkflowTemplate(id: string): Promise<WorkflowGraph>;
  /** The workflow was replaced from outside the editor (Claude changed a step, a version was restored). */
  onWorkflowChanged(cb: (g: WorkflowGraph) => void): () => void;
  /** Claude's proposed workflow (validated; not saved). Applying replaces the workflow and keeps a backup of the old one. */
  getWorkflowPlan(): Promise<WorkflowPlan | null>;
  applyWorkflowPlan(): Promise<WorkflowGraph>;
  dismissWorkflowPlan(): Promise<void>;
  onWorkflowPlan(cb: (p: WorkflowPlan | null) => void): () => void;
  /** Native folder picker for a workflow's Files step; null when cancelled. */
  pickWorkflowFolder(): Promise<string | null>;
  onWorkflowEvent(cb: (e: WorkflowRunEvent) => void): () => void;
  listExports(): Promise<Array<{ name: string; bytes: number; modified: string }>>;
  revealExport(name: string): Promise<void>;
  /** Deliver tab: export queue (ArtCraft command-line tools, no app windows). */
  deliver: {
    jobs(): Promise<DeliverJob[]>;
    enqueue(assetId: string, presetIds: string[]): Promise<DeliverJob[]>;
    cancel(jobId: string): Promise<void>;
    clearFinished(): Promise<void>;
    /** Recorded exports, newest first (all, or made from one file). */
    history(assetId?: string): Promise<DeliverRecord[]>;
    openFolder(): Promise<void>;
    /** Copies a finished export into the library so another app can open it; returns the new file's id. */
    addToLibrary(jobId: string): Promise<string>;
    onJobs(cb: (jobs: DeliverJob[]) => void): () => void;
  };
  live: {
    state(): Promise<LiveSnapshot>;
    /** Opens a library file in its app (or in `app`, e.g. LightCraft for the Color tab). */
    open(assetId: string, app?: EditorAppId): Promise<LiveSnapshot>;
    run(steps: Array<{ command: string; params: Record<string, unknown> }>): Promise<LiveSnapshot>;
    pause(): Promise<LiveSnapshot>;
    takeControl(): Promise<LiveSnapshot>;
    releaseControl(): Promise<LiveSnapshot>;
    resume(): Promise<LiveSnapshot>;
    confirmReplan(): Promise<LiveSnapshot>;
    cancel(): Promise<LiveSnapshot>;
    saveVersion(): Promise<LiveSnapshot>;
    refresh(): Promise<LiveSnapshot>;
    /** Opens the app in its own window, with the controls docked beside it. */
    popOut(): Promise<LiveSnapshot>;
    /** Puts the app back inside OmniCandy's Edit area. */
    dock(): Promise<LiveSnapshot>;
    /** Where the Edit area's app viewport is (CSS px relative to the window content); null/invisible hides the app. */
    setViewport(v: { x: number; y: number; width: number; height: number; visible: boolean } | null): Promise<void>;
    /** One-click edit applied in the open app window. */
    quickEdit(opId: string, values: Record<string, number | string>): Promise<LiveSnapshot>;
    undo(): Promise<LiveSnapshot>;
    /** The open video's timeline (FilmCraft), or null. */
    timeline(): Promise<TimelineDto | null>;
    setPlayhead(seconds: number): Promise<void>;
    selectClip(clipId: number): Promise<void>;
    /** Adds a library file as a clip or music, or moves/removes a clip (FilmCraft). */
    editTimeline(edit: TimelineEdit): Promise<LiveSnapshot>;
    onChange(cb: (s: LiveSnapshot) => void): () => void;
  };
  agent: {
    state(): Promise<AgentUiState>;
    run(goal: string, model: string, budget?: import('./agentBudget').AgentBudget): Promise<AgentUiState>;
    stop(): Promise<AgentUiState>;
    resume(): Promise<AgentUiState>;
    updatePlan(steps: import('./agentHarness').AgentPlanStep[]): Promise<AgentUiState>;
    onChange(cb: (state: AgentUiState) => void): () => void;
  };
  claude: {
    state(): Promise<ClaudeState>;
    /** Sends a message; resolves when Claude has finished its turn. */
    send(message: string): Promise<void>;
    /** One real Claude call: name, category, apps and steps for a described project. Starts no work and no paid generation. */
    planProject(request: string): Promise<ProjectPlan>;
    /** Starts a new project's chat with the planning exchange (ignored when a chat already exists). */
    seed(user: string, claude: string): Promise<void>;
    stop(): Promise<void>;
    reset(): Promise<ClaudeState>;
    setModel(model: string): Promise<ClaudeState>;
    /** Re-checks whether Claude Code on this PC is signed in. */
    checkAuth(): Promise<boolean | null>;
    /** Which credentials Claude uses (the Claude sign-in by default, or an Anthropic API key saved in Settings). Never contains the key. */
    authInfo(): Promise<ClaudeBilling>;
    setAuthMode(mode: ClaudeAuthMode): Promise<ClaudeBilling>;
    /** Main reads the key from the clipboard, stores it encrypted and clears the clipboard. The key never passes through the renderer. */
    pasteApiKey(): Promise<ClaudeBilling>;
    removeApiKey(): Promise<ClaudeBilling>;
    /** Starts Claude Code's own sign-in (opens the browser). */
    signIn(): Promise<void>;
    cancelSignIn(): Promise<void>;
    onChange(cb: (s: ClaudeState) => void): () => void;
  };
  edit: {
    /** Runs a quick edit with the app that owns this file type; returns the new version ids. */
    apply(assetId: string, opId: string, values: Record<string, number | string>): Promise<EditResultDto>;
    /** Opens a writable working copy in the app's own window. */
    openWorkingCopy(assetId: string): Promise<ExternalEditDto>;
    list(): Promise<ExternalEditDto[]>;
    bringBack(editId: string): Promise<EditResultDto>;
  };
  projects: {
    list(): Promise<ProjectSummary[]>;
    /** Saves the order the owner arranged the project list in. An empty list goes back to most recent first. */
    setOrder(keys: string[]): Promise<void>;
    current(): Promise<string>;
    /** Creates an empty project (in `parentDir`, else the default project folder); returns its key (does not open it). */
    create(name: string, parentDir?: string, meta?: ProjectMeta): Promise<string>;
    /** Where new projects go, and free space there when known. */
    storage(): Promise<StorageDto>;
    /** Native Browse dialog; null when cancelled. */
    pickFolder(): Promise<string | null>;
    /** Changes where NEW projects go (null = built-in folder). Existing projects are never moved. */
    setDefaultDir(dir: string | null): Promise<StorageDto>;
    revealDefaultDir(): Promise<void>;
    /** Native dialog: pick an existing project folder (from any drive) and add it; returns its key, or null if cancelled. */
    openExisting(): Promise<string | null>;
    /** Reconnects a project whose folder went missing; asks for the folder. False if cancelled. */
    locate(key: string): Promise<boolean>;
    /** Full copy under a new name; asks for the destination folder. Returns the new key, or null if cancelled. */
    duplicate(key: string): Promise<string | null>;
    /** Verified move to another folder; asks for it. The old folder goes to the Recycle Bin only after the copy is checked. */
    move(key: string): Promise<boolean>;
    /** Switches the open project (refused while a task, workflow or Claude is busy). */
    open(key: string): Promise<void>;
    rename(key: string, name: string): Promise<void>;
    /** Moves the project folder to the Recycle Bin. */
    remove(key: string): Promise<void>;
    reveal(key: string): Promise<void>;
    /** Thumbnail URL for an asset of any project. */
    assetUrl(key: string, assetId: string): string;
  };
  generate: {
    providers(): Promise<ProviderStatusDto[]>;
    /** Main reads the key from the clipboard, encrypts it and clears the clipboard. The key never passes through the renderer. */
    pasteKey(providerId: ProviderId): Promise<ProviderStatusDto[]>;
    removeKey(providerId: ProviderId): Promise<ProviderStatusDto[]>;
    /** Lists the provider's models with the saved key (free). */
    test(providerId: ProviderId): Promise<ProviderStatusDto[]>;
    /** Asks for approval in a native dialog (billable providers), then generates. */
    run(job: ImageJob): Promise<GenerateResultDto>;
    /** The open project's spending limit (USD, null = none) and the estimated total of paid generation so far. Estimates, not confirmed charges. */
    spending(): Promise<{ limitUsd: number | null; spentUsd: number; count: number }>;
    setSpendingLimit(limitUsd: number | null): Promise<{ limitUsd: number | null; spentUsd: number; count: number }>;
    openKeyPage(providerId: ProviderId): Promise<void>;
    /** AI video (Google Veo): saved jobs of this project; running ones are tracked in the background. */
    videoJobs(): Promise<VideoJobRecord[]>;
    /** Asks for approval in a native dialog, then submits. Returns at once; the video arrives minutes later. */
    videoSubmit(job: VideoJob): Promise<VideoJobRecord>;
    videoCancel(id: string): Promise<VideoJobRecord>;
    onVideo(cb: (r: VideoJobRecord) => void): () => void;
    /** Motion Effects: free local camera move on a picture (FilmCraft). Not AI. Resolves when the video is in the library. */
    motionRender(job: MotionJob): Promise<{ assetId: string; message: string }>;
    motionCancel(): Promise<void>;
    /** Free local AI: re-checks this PC (read-only) and returns tier, warnings and which models could be offered. */
    localAiStatus(): Promise<LocalAiStatus>;
    localAiDownloads(): Promise<DownloadState[]>;
    /** Shows a native dialog (license, size, folder); starts only if the user accepts there. Returns null when declined. */
    localAiDownload(modelId: string): Promise<DownloadState | null>;
    localAiCancel(modelId: string): Promise<void>;
    localAiRemove(modelId: string): Promise<void>;
    /** Native folder picker for where models are stored. Returns the new folder or null. */
    localAiPickDir(): Promise<string | null>;
    onLocalAi(cb: (s: DownloadState) => void): () => void;
    /** Free local generation with an installed model. Resolves when the clip is in the library. */
    localVideoRender(job: LocalVideoJob): Promise<{ assetId: string; message: string }>;
    localVideoCancel(): Promise<void>;
    onLocalVideoProgress(cb: (p: { fraction: number | null; line: string }) => void): () => void;
    /** New generated images (from the Generate tab or Claude). */
    onResult(cb: (r: GenerateResultDto) => void): () => void;
  };
  /** External third-party applications (Universal Application Integration Framework). */
  external: {
    /** Looks for supported applications on this PC (local only). */
    scan(): Promise<ExternalScan>;
    /** Last scan result without scanning again. */
    list(): Promise<ExternalAppInfo[]>;
    /** The third-party program whose window is open for Claude (docked into OmniCandy's Software tab), if any. */
    liveState(): Promise<ExternalLiveState>;
    /** Brings the open program's window back into the Software tab (after another app was shown). */
    liveShow(): Promise<void>;
    onLive(cb: (s: ExternalLiveState) => void): () => void;
    connect(key: string): Promise<ExternalAppInfo>;
    disconnect(key: string): Promise<ExternalAppInfo | null>;
    repair(key: string): Promise<ExternalAppInfo>;
    /** Forgets the permissions granted to this application. */
    revoke(key: string): Promise<ExternalAppInfo[]>;
    /** Native picker for a portable copy; rescans. Null when cancelled. */
    addLocation(): Promise<ExternalScan | null>;
    /** Installed integration packages and packages waiting in the inbox folder. */
    packages(): Promise<PackageListing>;
    /** Native picker for a .ccadapter file or a folder; returns its review (nothing is installed or run). Null when cancelled. */
    pickPackage(kind: 'file' | 'folder'): Promise<PackageReview | null>;
    /** Review of a package from the inbox. */
    reviewPackage(path: string): Promise<PackageReview>;
    /** Installs after a native confirmation dialog; rescans the applications. Returns the new listing. */
    installPackage(path: string, approval: PackageApproval): Promise<PackageListing>;
    setPackageEnabled(id: string, enabled: boolean): Promise<PackageListing>;
    uninstallPackage(id: string): Promise<PackageListing>;
    repairPackage(id: string): Promise<PackageListing>;
    jobs(): Promise<JobInfo[]>;
    cancelJob(id: string): Promise<JobInfo[]>;
  };
  /** Universal Connect: guided setup for external applications (plain language over the same framework). */
  connect: {
    /** Programs found on this PC, classified for a beginner; `rescan` false reuses the last scan. */
    overview(rescan: boolean): Promise<ConnectOverview>;
    /** Connects one program and tests it for real; never reports success without the test passing. */
    connectApp(key: string): Promise<ConnectOutcome>;
    /** Native picker for a portable or unregistered program (file or its folder). */
    browse(kind: 'file' | 'folder'): Promise<BrowseResult>;
    /** Forgets the saved location and permissions of a program; the program itself is not touched. */
    forget(key: string): Promise<ForgetResult>;
    /** Remembers that the guided setup was completed once. */
    done(): Promise<void>;
  };
  /** AI Adapter Builder: private, local integrations for programs OmniCandy has no connector for. */
  builder: {
    overview(): Promise<BuilderOverview>;
    /** Starts research and building. Returns at once; follow it with onProgress and detail(). */
    create(req: BuilderRequest): Promise<BuilderProjectSummary>;
    detail(id: string): Promise<BuilderProjectDetail>;
    /** Native picker for documentation or SDK files/folders. Returns the chosen paths (nothing is read until you create). */
    pickDocs(kind: 'files' | 'folder'): Promise<string[]>;
    /** Opens a file picker so the user can point at a program installed somewhere unusual. Null when cancelled. */
    pickProgram(): Promise<InstalledProgram | null>;
    cancel(id: string): Promise<void>;
    /** After an install through the normal review: reads the truth from the installer. */
    sync(id: string): Promise<BuilderProjectSummary>;
    /** Live testing on the real program (each command still asks you first). */
    /** `project`: the full path of a project file, for programs that work with project files (see BuilderProjectDetail.needsProject). */
    verifyLive(id: string, project?: string): Promise<PipelineReport>;
    propose(id: string, why?: { commandId?: string; error?: string }): Promise<RepairProposal>;
    discardProposal(id: string): Promise<void>;
    rollback(id: string, version: string): Promise<BuilderProjectSummary>;
    removeIntegration(id: string): Promise<BuilderProjectSummary>;
    deleteProject(id: string): Promise<void>;
    mine(): Promise<MyIntegration[]>;
    /** Downloads the official documentation for this program again (replaces the stored copy). */
    refreshDocs(id: string): Promise<{ notes: string[]; count: number }>;
    compatibility(id: string): Promise<{ appVersion: string | null; tested: string[]; needsCheck: boolean; message: string }>;
    onProgress(cb: (p: BuilderProgress) => void): () => void;
  };
  /** Project Planner: plans, execution packages, reports and the connection details for AI clients. */
  planner: PlannerApi;
  probeApps(): Promise<AppProbeResult[]>;
  /** Starts an installed ArtCraft app on its own (no file). */
  launchApp(appId: string): Promise<void>;
  integrationStatus(): Promise<IntegrationSnapshot>;
  /** URL the renderer can use in <img src>, served read-only by main from the project root. */
  assetUrl(assetId: string): string;
}

export const ASSET_SCHEME = 'studio-asset';

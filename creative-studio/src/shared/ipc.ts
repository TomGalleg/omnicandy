// The complete renderer ↔ main surface. Every channel here is validated in main (src/main/ipc.ts).

import type { AppearanceSettings, AppProbeResult, Asset, ProjectManifest, ProjectSummary } from './types';
import type { ClaudeState } from './claude';
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
  localAiStatus: 'localai:status',
  motionCancel: 'motion:cancel',
  deliverJobs: 'deliver:jobs',
  deliverEnqueue: 'deliver:enqueue',
  deliverCancel: 'deliver:cancel',
  deliverClear: 'deliver:clear',
  deliverHistory: 'deliver:history',
  deliverOpenFolder: 'deliver:open-folder',
  deliverEvent: 'deliver:event',
  probeApps: 'apps:probe',
  integrationStatus: 'integrations:status',
} as const;

export interface IntegrationSnapshot {
  appAdapters: Array<{ id: string; isMock: boolean }>;
  realExport: boolean;
  windowCapture: { available: boolean; reason: string | null };
  credentialVault: { available: boolean };
  claude: { connected: boolean; reason: string };
  providers: Array<{ id: string; label: string; isMock: boolean; billable: boolean }>;
}

/** What the renderer may know about a provider key: never the key itself. */
export interface ProviderStatusDto {
  id: ProviderId;
  label: string;
  billable: boolean;
  configured: boolean;
  savedAt: string | null;
  lastTest: { ok: boolean; at: string; message: string; models?: string[] } | null;
  /** False when Windows protected storage is unavailable (keys can't be saved). */
  encryptionAvailable: boolean;
  keyHint: string;
}

import type { VideoJob, VideoJobRecord } from './video';
import type { MotionJob } from './motionEffects';
import type { LocalAiStatus } from './localAi';

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
    /** Puts the app back inside CreateCraft's Edit area. */
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
    /** New generated images (from the Generate tab or Claude). */
    onResult(cb: (r: GenerateResultDto) => void): () => void;
  };
  probeApps(): Promise<AppProbeResult[]>;
  integrationStatus(): Promise<IntegrationSnapshot>;
  /** URL the renderer can use in <img src>, served read-only by main from the project root. */
  assetUrl(assetId: string): string;
}

export const ASSET_SCHEME = 'studio-asset';

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
  genKeyPage: 'generate:key-page',
  genEvent: 'generate:event',
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
  /** Saves where the user left off and Claude's current objective for the open project. */
  setProjectMeta(patch: ProjectMetaPatch): Promise<void>;
  setAssetRating(assetId: string, rating: number): Promise<ProjectManifest>;
  loadWorkflow(): Promise<WorkflowGraph>;
  saveWorkflow(g: WorkflowGraph): Promise<{ ok: true } | { ok: false; issues: string[] }>;
  runWorkflow(g: WorkflowGraph): Promise<{ ok: boolean; cancelled: boolean }>;
  /** true = approve every file, false = reject, or the indexes of the approved files. */
  answerApproval(nodeId: string, approved: boolean | number[]): Promise<void>;
  cancelWorkflow(): Promise<void>;
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
    openKeyPage(providerId: ProviderId): Promise<void>;
    /** New generated images (from the Generate tab or Claude). */
    onResult(cb: (r: GenerateResultDto) => void): () => void;
  };
  probeApps(): Promise<AppProbeResult[]>;
  integrationStatus(): Promise<IntegrationSnapshot>;
  /** URL the renderer can use in <img src>, served read-only by main from the project root. */
  assetUrl(assetId: string): string;
}

export const ASSET_SCHEME = 'studio-asset';

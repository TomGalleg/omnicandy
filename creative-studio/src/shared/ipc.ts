// The complete renderer ↔ main surface. Every channel here is validated in main (src/main/ipc.ts).

import type { AppearanceSettings, AppProbeResult, Asset, ProjectManifest, ProjectSummary } from './types';
import type { ClaudeState } from './claude';
import type { CostEstimate, ImageJob, ProviderId } from './generation';
import type { LiveSnapshot, TimelineDto } from './live';
import type { EditorAppId } from './appEditors';
import type { DeliverJob, DeliverRecord } from './deliver';
import type { WorkflowGraph, WorkflowRunEvent } from './workflow';

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
  claudeState: 'claude:state',
  claudeSend: 'claude:send',
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
  setAssetRating(assetId: string, rating: number): Promise<ProjectManifest>;
  loadWorkflow(): Promise<WorkflowGraph>;
  saveWorkflow(g: WorkflowGraph): Promise<{ ok: true } | { ok: false; issues: string[] }>;
  runWorkflow(g: WorkflowGraph): Promise<{ ok: boolean; cancelled: boolean }>;
  answerApproval(nodeId: string, approved: boolean): Promise<void>;
  cancelWorkflow(): Promise<void>;
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
    onChange(cb: (s: LiveSnapshot) => void): () => void;
  };
  claude: {
    state(): Promise<ClaudeState>;
    /** Sends a message; resolves when Claude has finished its turn. */
    send(message: string): Promise<void>;
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
    /** Creates an empty project; returns its key (does not open it). */
    create(name: string): Promise<string>;
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

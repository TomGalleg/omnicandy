// The complete renderer ↔ main surface. Every channel here is validated in main (src/main/ipc.ts).

import type { AppearanceSettings, AppProbeResult, Asset, ProjectManifest, ProjectSummary } from './types';
import type { ClaudeState } from './claude';
import type { LiveSnapshot } from './live';
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
  live: {
    state(): Promise<LiveSnapshot>;
    open(assetId: string): Promise<LiveSnapshot>;
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
  probeApps(): Promise<AppProbeResult[]>;
  integrationStatus(): Promise<IntegrationSnapshot>;
  /** URL the renderer can use in <img src>, served read-only by main from the project root. */
  assetUrl(assetId: string): string;
}

export const ASSET_SCHEME = 'studio-asset';

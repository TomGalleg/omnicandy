// Service contracts. Implementations live in the main process; the renderer only ever sees
// results through the preload API. Mock implementations must set `isMock: true`.

import type { Asset, AppProbeResult, ProjectManifest } from './types';
import type { Actor, CollabState } from './collaboration';
import type { WorkflowGraph, WorkflowRunEvent } from './workflow';

export type AppCapability = 'open' | 'edit' | 'save' | 'export' | 'preview' | 'selection' | 'layers';

export interface AppOperation {
  /** Engine command id, e.g. PhotoCraft `edit.fill`. Validated against the app's registry before use. */
  command: string;
  params: Record<string, unknown>;
}

export interface AppAdapter {
  readonly id: string;
  readonly isMock: boolean;
  probe(): Promise<AppProbeResult>;
  open(assetId: string): Promise<{ documentId: string }>;
  execute(documentId: string, operation: AppOperation): Promise<{ checkpointId: string; outputAssetIds: string[] }>;
  save(documentId: string): Promise<void>;
  export(documentId: string, format: string): Promise<string>;
}

export interface GenerationJob {
  modelId: string;
  prompt: string;
  referenceAssetIds: string[];
  aspect?: string;
}

export type GenerationJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface GenerationProvider {
  readonly id: string;
  readonly isMock: boolean;
  /** True when submit() can incur a charge. Executors must obtain consent first. */
  readonly billable: boolean;
  listModels(): Promise<Array<{ id: string; capabilities: string[] }>>;
  estimate(job: GenerationJob): Promise<{ amount: number; currency: string; approximate: boolean }>;
  submit(job: GenerationJob, credentialHandle: string | null): Promise<{ jobId: string }>;
  status(jobId: string): Promise<GenerationJobStatus>;
}

export interface AssetRepository {
  loadManifest(): Promise<ProjectManifest>;
  /** Copies a user-selected file into the project. Never modifies or moves the source. */
  importFile(sourcePath: string): Promise<{ asset: Asset; duplicateOf?: string }>;
  resolveAssetPath(assetId: string): Promise<string>;
}

export interface WorkflowRunOptions {
  onEvent(event: WorkflowRunEvent): void;
  /**
   * Waits for your decision at an Approval step. `true` approves every file, `false` none, or a
   * list of the approved files' indexes (the others stop there).
   */
  requestApproval(nodeId: string, summary: string, items?: Array<{ item: number; name: string; assetId: string }>): Promise<boolean | number[]>;
  /** Explicit consent for billable calls. Undefined means no consent. */
  consentToBillable?: (nodeId: string, estimate: string) => Promise<boolean>;
  signal?: AbortSignal;
  /** Outputs kept from an earlier run: those steps are not run again (rerun of only what changed). */
  reuse?: Record<string, Array<{ name: string; refs: string[] | null }>>;
  /** Pause between steps: `isPaused()` is checked before each step, then `wait()` holds until resumed. */
  pause?: { isPaused(): boolean; wait(signal?: AbortSignal): Promise<void> };
  /** True for an asset the user already approved: an Approval step does not ask about it again. */
  isApproved?: (assetId: string) => boolean;
}

export interface WorkflowRunResult {
  ok: boolean;
  cancelled: boolean;
  /** What each step that finished produced (for reuse by a later rerun). */
  outputs?: Record<string, Array<{ name: string; refs: string[] | null }>>;
}

export interface WorkflowExecutor {
  readonly isMock: boolean;
  run(graph: WorkflowGraph, options: WorkflowRunOptions): Promise<WorkflowRunResult>;
}

export interface WindowCaptureSource {
  id: string;
  title: string;
  appId: string | null;
}

export interface WindowCapture {
  readonly available: boolean;
  listSources(): Promise<WindowCaptureSource[]>;
  /** Reason the capture is unavailable, shown verbatim in the UI. */
  unavailableReason(): string | null;
}

export interface CredentialStatus {
  providerId: string;
  /** True only when a key is saved and can be decrypted on this PC. */
  configured: boolean;
  /** A key file exists but cannot be decrypted here (copied from another PC or Windows user, or protected storage is gone): the key must be added again. */
  unreadable?: boolean;
  /** Opaque, non-secret handle. The secret itself never leaves the vault. */
  handle: string | null;
}

export interface CredentialVault {
  readonly available: boolean;
  status(providerId: string): Promise<CredentialStatus>;
  // Saving/removing keys happens in main only (SafeStorageVault); the renderer never sends secrets.
}

export interface CollaborationController {
  readonly state: CollabState;
  requestPause(): Promise<void>;
  acquireEditLock(actor: Actor, documentId: string): Promise<void>;
  releaseEditLock(actor: Actor, documentId: string): Promise<void>;
  resumeAfterSync(documentId: string, diskVersion: string): Promise<void>;
}

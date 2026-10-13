// The complete renderer ↔ main surface. Every channel here is validated in main (src/main/ipc.ts).

import type { AppearanceSettings, AppProbeResult, Asset, ProjectManifest } from './types';
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
  probeApps: 'apps:probe',
  integrationStatus: 'integrations:status',
} as const;

export interface IntegrationSnapshot {
  windowCapture: { available: boolean; reason: string | null };
  credentialVault: { available: boolean };
  claude: { connected: boolean; reason: string };
  providers: Array<{ id: string; label: string; isMock: boolean; billable: boolean }>;
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
  probeApps(): Promise<AppProbeResult[]>;
  integrationStatus(): Promise<IntegrationSnapshot>;
  /** URL the renderer can use in <img src>, served read-only by main from the project root. */
  assetUrl(assetId: string): string;
}

export const ASSET_SCHEME = 'studio-asset';

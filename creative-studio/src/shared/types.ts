// Domain types shared by main, preload and renderer. No runtime dependencies.

export type AssetKind = 'image' | 'video' | 'audio' | 'vector' | 'design' | 'project' | 'document' | 'sheet' | 'deck';

export type AssetOrigin = 'imported' | 'generated' | 'fixture';

export interface AssetProvenance {
  origin: AssetOrigin;
  /** Free-text note on where the bytes came from (e.g. tool + command that produced them). */
  source: string;
  prompt?: string;
  provider?: string;
  model?: string;
  createdAt: string;
  licensingNotes?: string;
  /** Generation settings (size, quality, aspect, …) as sent to the provider. */
  settings?: Record<string, string>;
  /** Estimate shown to the user when they approved the call (USD, whole request). */
  estimatedCostUsd?: number;
  requestedBy?: 'user' | 'claude';
  /** Library assets used as reference images. */
  referenceAssetIds?: string[];
  /** 'reference' = attached on Home while planning; available as a source image to later steps. */
  role?: 'reference';
  /** Where the file came from on the user's PC when it was imported. */
  originalPath?: string;
}

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  /** Path relative to the project root, forward slashes. Originals live under `originals/`. */
  relPath: string;
  sha256: string;
  bytes: number;
  sourceFormat: string;
  width?: number;
  height?: number;
  durationSec?: number;
  rating?: 0 | 1 | 2 | 3 | 4 | 5;
  approval: 'none' | 'approved' | 'rejected';
  provenance: AssetProvenance;
  /** Asset this one was derived from (version lineage). */
  parentId?: string;
}

export interface ProjectManifest {
  schemaVersion: 1;
  /** 2 = self-contained Phase 2 folder layout; absent = older layout (originals/, versions/, exports/). */
  layout?: 2;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  assets: Asset[];
  /** Project category chosen at creation (Phase 3); absent on older projects. */
  kind?: 'image' | 'design' | 'video' | 'audio' | 'mixed';
  /** The creative brief: what the user asked for. */
  brief?: string;
  /** What Claude is working toward right now. */
  objective?: string;
  /** Where the user left off, restored when the project is opened. */
  view?: { workspace: WorkspaceId; assetId?: string };
}

export interface ProjectSummary {
  /** Stable project key (registry id). */
  id: string;
  /** The project's folder on disk. */
  folder: string;
  /** The folder can't be found (drive disconnected or folder moved): Locate it to reconnect. */
  missing?: boolean;
  name: string;
  assetCount: number;
  originals: number;
  versions: number;
  createdAt: string;
  updatedAt: string;
  thumbAssetId: string | null;
  isOpen: boolean;
  isSample: boolean;
  kind?: ProjectManifest['kind'];
  brief?: string;
}

/** artcraft = ArtCraft Match (charcoal, matches PhotoCraft); studioDark = original near-black; system follows Windows. */
export type ThemeMode = 'artcraft' | 'studioDark' | 'light' | 'system';
/** A concrete look after resolving System. */
export type ThemePalette = 'artcraft' | 'studioDark' | 'light';

export interface AppearanceSettings {
  version: 2;
  mode: ThemeMode;
  accent: string;
  /** The dark look System uses when Windows is dark. */
  systemDark: 'artcraft' | 'studioDark';
  /** Switch the open ArtCraft app's theme to match (official app settings only). */
  syncApps: boolean;
}

export type WorkspaceId = 'home' | 'media' | 'edit' | 'generate' | 'workflow' | 'effects' | 'color' | 'audio' | 'deliver';

export type IntegrationStatus = 'real-verified' | 'mocked' | 'blocked' | 'untested' | 'not-installed';

export interface AppProbeResult {
  appId: string;
  displayName: string;
  installed: boolean;
  /** True only when a live control session exists. Never true in Phase 1. */
  connected: boolean;
  version: string | null;
  capabilities: string[];
  notes: string[];
}

// Domain types shared by main, preload and renderer. No runtime dependencies.

export type AssetKind = 'image' | 'video' | 'audio' | 'vector' | 'design' | 'project';

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
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  assets: Asset[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  assetCount: number;
}

export type ThemeMode = 'dark' | 'light' | 'system';

export interface AppearanceSettings {
  mode: ThemeMode;
  accent: string;
}

export type WorkspaceId = 'media' | 'edit' | 'generate' | 'workflow' | 'effects' | 'color' | 'audio' | 'deliver';

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

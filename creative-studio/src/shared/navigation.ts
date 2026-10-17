import type { WorkspaceId } from './types';

export type NavMode = 'simplified' | 'advanced';
export const DEFAULT_NAV_MODE: NavMode = 'simplified';

export interface NavItem { id: WorkspaceId; label: string }

/** Every workspace, in professional order (Advanced mode). */
export const ADVANCED_NAV: NavItem[] = [
  { id: 'home', label: 'Home' },
  { id: 'media', label: 'Media' },
  { id: 'edit', label: 'Edit' },
  { id: 'generate', label: 'AI Generate' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'effects', label: 'Effects' },
  { id: 'color', label: 'Color' },
  { id: 'audio', label: 'Audio' },
  { id: 'deliver', label: 'Deliver' },
  { id: 'planner', label: 'Planner' },
];

/** Simplified mode shows these directly; everything else sits under "More". */
export const SIMPLE_NAV: NavItem[] = [
  { id: 'home', label: 'Project' },
  { id: 'edit', label: 'Create' },
  { id: 'generate', label: 'AI Generate' },
  { id: 'deliver', label: 'Deliver' },
];

export const MORE_NAV: NavItem[] = ADVANCED_NAV.filter((n) => !SIMPLE_NAV.some((s) => s.id === n.id));

export function parseNavMode(v: unknown): NavMode {
  return v === 'advanced' || v === 'simplified' ? v : DEFAULT_NAV_MODE;
}

export function isMoreWorkspace(id: WorkspaceId): boolean {
  return MORE_NAV.some((n) => n.id === id);
}

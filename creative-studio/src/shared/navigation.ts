import type { WorkspaceId } from './types';

export type NavMode = 'simplified' | 'advanced';
export const DEFAULT_NAV_MODE: NavMode = 'simplified';

export interface NavItem { id: WorkspaceId; label: string }

/** Workspaces that exist but are hidden from the tabs (and from links, and from a saved "where I was"). */
export const HIDDEN_WORKSPACES: WorkspaceId[] = ['workflow'];

/** Where to land instead when something asks for a hidden workspace. */
export const shownWorkspace = (w: WorkspaceId): WorkspaceId => (HIDDEN_WORKSPACES.includes(w) ? 'home' : w);

/** Every workspace, in professional order (Advanced mode). */
export const ADVANCED_NAV: NavItem[] = [
  { id: 'home', label: 'Home' },
  { id: 'media', label: 'Media' },
  { id: 'edit', label: 'Edit' },
  { id: 'generate', label: 'AI Generate' },
  { id: 'software', label: 'Software' },
  { id: 'planner', label: 'OmniTown' },
  { id: 'deliver', label: 'Deliver' },
];

/** Simplified mode shows these directly; everything else sits under "More". */
export const SIMPLE_NAV: NavItem[] = [
  { id: 'home', label: 'Project' },
  { id: 'edit', label: 'Edit' },
  { id: 'generate', label: 'AI Generate' },
  { id: 'software', label: 'Software' },
  { id: 'planner', label: 'OmniTown' },
  { id: 'deliver', label: 'Deliver' },
];

export const MORE_NAV: NavItem[] = ADVANCED_NAV.filter((n) => !SIMPLE_NAV.some((s) => s.id === n.id));

/** How the Edit tab works on the selected file: the file's own editor, LightCraft (color) or EffectCraft (effects). */
export type EditMode = 'edit' | 'color' | 'effects';

/**
 * Effects, Color and Audio used to be tabs of their own. They are now modes inside Edit; the old
 * workspace ids still work (saved positions, links, Claude) and land in Edit in the matching mode.
 * Sound files open in SoundCraft in Edit itself, so Audio needs no mode of its own.
 */
export function routeWorkspace(w: WorkspaceId): { workspace: WorkspaceId; mode?: EditMode } {
  if (w === 'color' || w === 'effects') return { workspace: 'edit', mode: w };
  if (w === 'audio') return { workspace: 'edit', mode: 'edit' };
  return { workspace: w };
}

export function parseNavMode(v: unknown): NavMode {
  return v === 'advanced' || v === 'simplified' ? v : DEFAULT_NAV_MODE;
}

export function isMoreWorkspace(id: WorkspaceId): boolean {
  return MORE_NAV.some((n) => n.id === id);
}

import type { WorkspaceId } from './types';

export interface NavItem { id: WorkspaceId; label: string }

/** Workspaces that exist but are hidden from the tabs (and from links, and from a saved "where I was"). */
export const HIDDEN_WORKSPACES: WorkspaceId[] = ['workflow'];

/** Where to land instead when something asks for a hidden workspace. */
export const shownWorkspace = (w: WorkspaceId): WorkspaceId => (HIDDEN_WORKSPACES.includes(w) ? 'home' : w);

/** The toolbar: every workspace, one list (there is no Simplified/Advanced switch). Media sits on it directly. */
export const NAV: NavItem[] = [
  { id: 'home', label: 'Project' },
  { id: 'media', label: 'Media' },
  { id: 'edit', label: 'Edit' },
  { id: 'generate', label: 'AI Generate' },
  { id: 'planner', label: 'Planner' },
  { id: 'deliver', label: 'Deliver' },
  { id: 'software', label: 'Software' },
];

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

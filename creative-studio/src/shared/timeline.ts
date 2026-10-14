import type { AssetKind, WorkspaceId } from './types';

const TIME_BASED: readonly AssetKind[] = ['video', 'audio'];

/** The bottom timeline appears only for time-based media; stills, vectors and layouts never get one. */
const EDITING: readonly WorkspaceId[] = ['edit', 'effects', 'color', 'audio'];

/** With a workspace given, the timeline also appears only while editing (not in Home, Deliver, Workflow...). */
export function shouldShowTimeline(kind: AssetKind | null | undefined, workspace?: WorkspaceId): boolean {
  if (workspace !== undefined && !EDITING.includes(workspace)) return false;
  return kind != null && TIME_BASED.includes(kind);
}

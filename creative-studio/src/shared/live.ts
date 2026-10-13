// State of the live (windowed) ArtCraft session, pushed from main to the renderer.

import type { CollabState } from './collaboration';

export type LiveStatus = 'stopped' | 'starting' | 'ready' | 'error';

export interface LiveStep {
  command: string;
  label: string;
  params: Record<string, unknown>;
}

export interface LiveSnapshot {
  appId: 'photocraft';
  status: LiveStatus;
  error: string | null;
  /** Library asset currently open in the app window. */
  asset: { id: string; name: string } | null;
  history: string[];
  collab: CollabState;
  steps: LiveStep[];
  /** Index of the next step to run. */
  stepIndex: number;
  /** True when the document changed while paused and the remaining steps need your go-ahead. */
  needsReplanConfirm: boolean;
  savedVersionIds: string[];
  message: string | null;
  /** Controls are shown in the pop-out panel docked to the app window instead of the main window. */
  poppedOut: boolean;
}

// State of the live (windowed) ArtCraft session, pushed from main to the renderer.

import type { EditorAppId } from './appEditors';
import type { CollabState } from './collaboration';

/** A video's timeline as FilmCraft has it (times in seconds). */
export interface TimelineClip { id: number; name: string; start: number; duration: number; speed: number; effects: string[] }
export interface TimelineTrack { id: number; name: string; kind: 'video' | 'audio'; clips: TimelineClip[]; transitions: number }
export interface TimelineDto { duration: number; fps: number; playhead: number | null; tracks: TimelineTrack[]; selection: number[] }

export type LiveStatus = 'stopped' | 'starting' | 'ready' | 'error';

export interface LiveStep {
  command: string;
  label: string;
  params: Record<string, unknown>;
}

export interface LiveSnapshot {
  /** App the live document is open in. */
  appId: EditorAppId;
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
  /** The open app's interface theme as last set by CreateCraft (read back from the app). */
  appTheme: { app: EditorAppId; value: string } | null;
}

// State of the live (windowed) ArtCraft session, pushed from main to the renderer.

import type { EditorAppId } from './appEditors';
import type { CollabState } from './collaboration';

/** A timeline as FilmCraft (video) or SoundCraft (audio) has it (times in seconds; fps 0 for audio). */
export interface TimelineClip {
  id: number; name: string; start: number; duration: number; speed: number; effects: string[];
  /** SoundCraft clips: gain, fade lengths (seconds) and mute. */
  gainDb?: number; fadeIn?: number; fadeOut?: number; muted?: boolean;
}
export interface TimelineTrack { id: number; name: string; kind: 'video' | 'audio'; clips: TimelineClip[]; transitions: number; /** FilmCraft: an audio track after A1, used for music. */ music?: boolean }
export interface TimelineDto { duration: number; fps: number; playhead: number | null; tracks: TimelineTrack[]; selection: number[] }

/** Changes to a video's clip list (FilmCraft): add a library file as a clip or as music, reorder, remove. */
export type TimelineEdit =
  | { kind: 'add'; assetId: string; as: 'clip' | 'music' }
  /** `to` is the clip's new position among the picture clips (0 = first). */
  | { kind: 'move'; clip: number; to: number }
  | { kind: 'remove'; clip: number };

export type LiveStatus ='stopped' | 'starting' | 'ready' | 'error';

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
  /** The open app's interface theme as last set by OmniCandy (read back from the app). */
  appTheme: { app: EditorAppId; value: string } | null;
  /** Who opened the current file: Claude's opens make the main window follow (tab + selection). */
  openedBy: 'user' | 'claude';
}

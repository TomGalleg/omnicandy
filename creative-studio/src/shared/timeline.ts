import type { AssetKind } from './types';

const TIME_BASED: readonly AssetKind[] = ['video', 'audio'];

/** The bottom timeline appears only for time-based media; stills, vectors and layouts never get one. */
export function shouldShowTimeline(kind: AssetKind | null | undefined): boolean {
  return kind != null && TIME_BASED.includes(kind);
}

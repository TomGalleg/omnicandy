import { useSyncExternalStore } from 'react';

/**
 * Whether a modal (e.g. Settings) is open over the workspace. The embedded ArtCraft window is a
 * separate native window that would sit on top of any HTML dialog, so it hides while this is true.
 */
let open = false;
const listeners = new Set<() => void>();

export function setOverlayOpen(v: boolean) {
  if (open === v) return;
  open = v;
  for (const l of listeners) l();
}

export function useOverlayOpen(): boolean {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => open);
}

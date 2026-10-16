/** Fired after anything that changes the list of external applications (install, connect, disconnect, repair, remove, forget, browse). */
export const EXTERNAL_CHANGED = 'createcraft:external-apps-changed';

export const announceExternalChanged = () => window.dispatchEvent(new Event(EXTERNAL_CHANGED));

/** Error text without Electron's "Error invoking remote method" prefix. */
export const errorText = (e: unknown): string =>
  (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

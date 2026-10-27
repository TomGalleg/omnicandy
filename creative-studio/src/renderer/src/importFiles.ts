import type { ImportResult } from '@shared/ipc';
import { importSummary } from '@shared/importSummary';

/** Fired after files were added to the library, so whichever screen holds the project list can reload it. */
export const LIBRARY_CHANGED = 'cs-library-changed';

/** True when a drag carries files from the computer (not one of OmniCandy's own thumbnails being dragged). */
export const isFileDrag = (e: { dataTransfer: DataTransfer | null }) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

/** Adds dropped files to the open project. Paths are read by the preload (the only place allowed to), then main copies the files in. */
export async function importDropped(files: FileList | File[]): Promise<{ result: ImportResult; text: string; error: boolean }> {
  const paths = Array.from(files).map((f) => { try { return window.studio.pathForFile(f); } catch { return ''; } }).filter(Boolean);
  const result: ImportResult = paths.length ? await window.studio.importPaths(paths) : { imported: [], duplicates: [], errors: ['Those items are not files from your computer (try dragging from a folder).'] };
  if (result.imported.length || result.duplicates.length) window.dispatchEvent(new Event(LIBRARY_CHANGED));
  return { result, ...importSummary(result) };
}

/** The upload button: the same file picker and safe import as the Media tab. */
export async function uploadWithPicker(): Promise<{ result: ImportResult; text: string; error: boolean }> {
  const result = await window.studio.importAssets();
  if (result.imported.length || result.duplicates.length) window.dispatchEvent(new Event(LIBRARY_CHANGED));
  return { result, ...importSummary(result) };
}

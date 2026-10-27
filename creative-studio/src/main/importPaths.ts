// Brings files the user dropped (or picked) into the open project. The same safe import as the Media tab's button:
// originals are copied and never modified, exact duplicates are not copied again, and a file that is not a supported
// media type, or is not a regular file, is refused with a plain reason (ProjectStore.importFile enforces both).

import type { ImportResult } from '@shared/ipc';
import type { ProjectStore } from './projectStore';

export const MAX_DROPPED_FILES = 50;

export async function importPathsInto(store: Pick<ProjectStore, 'importFile'>, paths: string[]): Promise<ImportResult> {
  const result: ImportResult = { imported: [], duplicates: [], errors: [] };
  for (const p of paths.slice(0, MAX_DROPPED_FILES)) {
    const name = p.split(/[\\/]/).pop() || p;
    try {
      const r = await store.importFile(p);
      if (r.duplicateOf) result.duplicates.push({ name: r.asset.name, duplicateOf: r.duplicateOf });
      else result.imported.push(r.asset);
    } catch (err) {
      result.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (paths.length > MAX_DROPPED_FILES) result.errors.push(`Only the first ${MAX_DROPPED_FILES} files were added; ${paths.length - MAX_DROPPED_FILES} were left out.`);
  return result;
}

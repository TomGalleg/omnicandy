import { EDITOR_APPS } from '@shared/appEditors';
import { presetsFor } from '@shared/deliver';
import type { DeliverQueue } from './deliver';
import type { LiveTaskController } from './liveTask';
import type { ProjectStore } from './projectStore';

/**
 * Library export operations shared by the Claude tools and the Independent AI tools. They only name library
 * files and Deliver presets: DeliverQueue owns preset validation, the exports/ folder and output naming, so no
 * caller can choose an output path.
 */
async function findAsset(store: ProjectStore, name: string) {
  const a = (await store.loadManifest()).assets.find((x) => x.name === name);
  if (!a) throw new Error(`No file named "${name}". Use list_files.`);
  return a;
}

export async function listExportFormatsText(store: ProjectStore, name: string): Promise<string> {
  const a = await findAsset(store, name);
  const ps = presetsFor(a.sourceFormat);
  if (!ps.length) return `${a.sourceFormat.toUpperCase()} files can't be exported yet.`;
  return JSON.stringify(ps.map((p) => ({ preset_id: p.id, label: p.label, note: p.note, file_type: p.ext, made_by: EDITOR_APPS[p.app].name })), null, 2);
}

export async function exportFileText(
  store: ProjectStore,
  queue: DeliverQueue,
  ctl: LiveTaskController,
  args: { name: string; presetIds: string[]; addToLibrary?: boolean },
  activity: (line: string) => void = () => undefined,
): Promise<string> {
  const a = await findAsset(store, args.name);
  const jobs = await queue.enqueue(a.id, args.presetIds, 'claude');
  activity(`Exporting ${a.name}: ${jobs.map((j) => j.presetLabel).join(', ')}`);
  const done = await queue.wait(jobs.map((j) => j.id));
  const lines: string[] = [];
  for (const j of done) {
    if (j.status !== 'done') { lines.push(`${j.presetLabel}: ${j.status}${j.error ? ` (${j.error})` : ''}`); continue; }
    let kept = '';
    if (args.addToLibrary) {
      try { kept = ` · in the library as ${(await queue.addToLibrary(j.id)).name}`; } catch (e) { kept = ` · not added to the library (${e instanceof Error ? e.message : String(e)})`; }
    }
    lines.push(`${j.presetLabel}: exports/${j.output}${j.note ? ` (${j.note})` : ''}${kept}`);
  }
  activity(`Export finished: ${lines.join('; ')}`);
  const s = ctl.snapshot();
  const unsaved = s.asset?.id === a.id && s.history.length > 1 && !s.savedVersionIds.length;
  return lines.join('\n') + (unsaved ? '\nNote: the open document has edits that are not saved, so they are not in these exports.' : '');
}

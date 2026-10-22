import { z } from 'zod';
import type { LiveTaskController } from '../liveTask';
import type { ProjectStore } from '../projectStore';
import type { DeliverQueue } from '../deliver';
import { exportFileText, listExportFormatsText } from '../exportOps';
import { tool, ToolRegistry } from './registry';

const userHasControl = (ctl: LiveTaskController): boolean => {
  const c = ctl.snapshot().collab;
  return c.lockOwner === 'user' || ['manual', 'pausing', 'paused', 'awaiting_approval'].includes(c.phase);
};

/**
 * Export tools for Independent AI. Same operations as the Claude tools (exportOps.ts): the agent can only name a
 * library file and Deliver presets; DeliverQueue chooses the exports/ output location. Never changes the library
 * except when add_to_library is requested, which is the same hand-off Claude has.
 */
export function addExportTools(registry: ToolRegistry, deps: { ctl: LiveTaskController; store: ProjectStore; deliver: () => Promise<DeliverQueue> }): ToolRegistry {
  registry.add(tool('list_export_formats', 'Export formats (Deliver presets) available for a library file (exact name from list_files).',
    z.object({ name: z.string().min(1).max(512) }).strict(), async ({ name }) => listExportFormatsText(deps.store, name)));
  registry.add(tool('export_file', 'Exports a library file (exact name from list_files) with one or more Deliver presets (see list_export_formats) into the project exports folder and waits until done. Exports use the SAVED library file: save_version first only if the user asked for a save. Does not edit the document.',
    z.object({ name: z.string().min(1).max(512), preset_ids: z.array(z.string().min(1).max(64)).min(1).max(10), add_to_library: z.boolean().optional() }).strict(),
    async ({ name, preset_ids, add_to_library }) => {
      if (userHasControl(deps.ctl)) throw new Error('User has control or an approval is pending; stop and wait.');
      return exportFileText(deps.store, await deps.deliver(), deps.ctl, { name, presetIds: preset_ids, addToLibrary: add_to_library });
    }));
  return registry;
}

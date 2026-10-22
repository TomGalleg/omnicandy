import { z } from 'zod';
import { appendNativeCapabilityInspection } from '@shared/commandInspectionProjection';
import type { LiveTaskController } from '../liveTask';
import type { ProjectStore } from '../projectStore';
import { BLANK_FILES, EDITOR_APPS, type EditorAppId } from '@shared/appEditors';
import type { ToolDef } from './types';
import { tool, ToolRegistry } from './registry';

const empty = z.object({}).strict();
const values = z.record(z.string().max(64), z.unknown());
/** Uses the existing controller: it owns command allow-lists, versioning and human approval. */
export function nativeToolRegistry(ctl: LiveTaskController, store: ProjectStore, opts: { supportsVision?: boolean; createBlank?: (app: Exclude<EditorAppId, 'filmcraft'>, name?: string) => Promise<{id:string;name:string}> } = {}): ToolRegistry {
  const tools = [
    tool('get_status', 'Get the currently open app, document, edit lock and available edits. Call first.', empty, async () => {
      // Fresh controller state, independent of any edit response: usable as read-back evidence for edits whose effect shows in the status (timeline, document details, history).
      const status = await ctl.statusForClaude();
      return { text: JSON.stringify(status), readback: JSON.parse(JSON.stringify(status)) as unknown, trustedReadback: true };
    }),
    tool('list_files', 'List names and formats of project library files.', empty, async () => JSON.stringify((await store.loadManifest()).assets.map(a => ({ name: a.name, kind: a.kind, format: a.sourceFormat, version: !!a.parentId })))),
    tool('open_file', 'Open a project library file by its exact name. Do not discard unsaved edits.', z.object({ name: z.string().min(1).max(512), app: z.string().max(32).optional() }).strict(), async ({name, app}) => {
      const s = ctl.snapshot();
      if (s.asset && s.history.length > 1 && s.savedVersionIds.length === 0) throw new Error('Unsaved edits may exist; ask the user before changing documents.');
      if (s.collab.phase === 'manual' || s.collab.phase === 'pausing' || s.collab.phase === 'paused') throw new Error('The user has control or paused the task; stop and wait.');
      const assets = (await store.loadManifest()).assets.filter(a => a.name === name);
      if (assets.length !== 1) throw new Error(assets.length ? 'Ambiguous file name.' : `No file named ${name}. Use list_files.`);
      if (app && !(app in EDITOR_APPS)) throw new Error('Unknown application id. Use get_status.');
      await ctl.open(assets[0]!.id, app as EditorAppId | undefined, 'claude');
      return JSON.stringify((await ctl.statusForClaude()).open);
    }),
    tool('apply_edit', 'Apply an edit listed in get_status to the open app.', z.object({ edit_id: z.string().min(1).max(64), settings: values.optional() }).strict(), async ({edit_id,settings}) => ctl.claudeQuickEdit(edit_id, settings ?? {})),
    tool('app_commands', 'Search the open app by task noun (e.g. ellipse), then inspect one exact command ID for full parameters and valid ranges before executing. Never guess identifiers or missing schemas.', z.object({ filter: z.string().max(64).optional() }).strict(), async ({filter}) => appendNativeCapabilityInspection(await ctl.appCommandList(filter), filter)),
    tool('app_command', 'Execute one command from an exact-ID app_commands inspection. Discovery does not grant permission: existing policy, validation and human approval gates always apply.', z.object({ command: z.string().min(1).max(128), params: values.optional() }).strict(), async ({command,params}) => ctl.claudeAppCommand(command,params ?? {})),
    tool('undo', 'Undo the last change to the active document.', empty, async () => ctl.claudeUndo()),
    tool('save_version', 'Save changes as a new library version only if the user requested a save.', empty, async () => {
      const s = ctl.snapshot();
      if (s.collab.lockOwner === 'user' || ['manual','pausing','paused'].includes(s.collab.phase)) throw new Error('User controls or paused document; stop and wait.');
      const before = new Set(s.savedVersionIds);
      const saved = await ctl.saveVersion();
      const versionId = saved.savedVersionIds.find(id => !before.has(id));
      if (!versionId) throw new Error(saved.message ?? 'No new version was created; save not confirmed.');
      return JSON.stringify({saved:true,versionId,message:saved.message ?? 'New library version created.'});
    }),
  ];
  const createBlank = opts.createBlank;
  if (createBlank) {
    tools.push(tool('new_document', 'Create and open a blank document in a supported native Craft app. FilmCraft needs an existing video. Use when the user wants a new file.',
      z.object({app:z.enum(['photocraft','vectorcraft','designcraft','wordcraft','pdfcraft','gridcraft','deckcraft','figcraft','cadcraft','soundcraft','lightcraft','effectcraft']),name:z.string().max(60).optional()}).strict(), async ({app,name}) => {
        const state = ctl.snapshot();
        if (state.collab.lockOwner === 'user' || ['manual','pausing','paused','awaiting_approval'].includes(state.collab.phase)) throw new Error('User has control or an approval is pending; stop and wait.');
        if (state.asset && state.history.length > 1 && state.savedVersionIds.length === 0) throw new Error('Unsaved edits may exist; ask before changing documents.');
        if (!BLANK_FILES[app]) throw new Error('This application has no blank document starter.');
        const created = await createBlank(app,name);
        await ctl.open(created.id,app,'claude');
        return `Created and opened ${created.name} in ${EDITOR_APPS[app].name}. Call get_status, then app_commands.`;
      }));
  }
  if (opts.supportsVision) {
    const previewTool: ToolDef = {
      name:'look_at_document',description:'Look at a PNG preview of the currently open document. Requires a vision-capable model. Inspect before making visual claims.',
      parameters:z.toJSONSchema(empty) as Record<string,unknown>,
      execute:async (args) => {
        const parsed = empty.safeParse(args);
        if (!parsed.success) return {text:'Error: Invalid preview arguments.',isError:true};
        const png = await ctl.preview(1024);
        if (!png) return {text:'Error: The open application does not provide a preview.',isError:true};
        if (png.length > 2_800_000 || png.length < 8 || png.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') return {text:'Error: Invalid or oversized PNG preview.',isError:true};
        return {text:'Document preview captured; image follows.',imageDataUrl:`data:image/png;base64,${png.toString('base64')}`};
      },
    };
    tools.push(previewTool);
  }
  return new ToolRegistry(tools);
}

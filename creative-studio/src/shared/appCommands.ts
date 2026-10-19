// Which commands Claude may send to the other ArtCraft apps (VectorCraft, EffectCraft, DesignCraft, WordCraft, ...), by tier:
//   free      anything that edits the open document;
//   approval  anything that opens, saves, imports, exports, places or runs files, scripts, actions, plugins or batches:
//             the user approves a native dialog first (shown by main);
//   never     app preferences, and OmniCandi's own internal helper commands.
// PhotoCraft has its own, more precise table (photocraftOps.ts).

import { checkParamValues, type OpCheck } from './photocraftOps';

const NEVER = /(^|\.)(prefs?|preferences|settings|options|createcraft)(\.|$)/i;
const APPROVAL = /(^|\.)(file|files|open|save|saveAs|export|import|place|embed|link|script|scripts|action|actions|plugin|plugins|macro|macros|batch|automate|run|exec|shell|eval|download|upload|print|package|publish|recent)([A-Z.]|$)/;

const PROPERTY_TOOLS = /^(get|set)_property$|^add_keyframe$|^(get|set|remove|delete)_keyframes?$|^get_layer$/;
const PROPERTY_PATH = /^(@\d+|#?[\w-]+(\/#?[\w-]+){0,8})$/;

export type AppCommandTier = 'free' | 'approval' | 'never';

/** `tool:name` ids (EffectCraft) are judged by the tool name. */
export function appCommandTier(id: string): AppCommandTier {
  const name = id.startsWith('tool:') ? id.slice(5) : id;
  if (!/^[A-Za-z0-9_]+([.:_-][A-Za-z0-9_]+)*$/.test(name) || name.length > 128) return 'never';
  if (NEVER.test(name)) return 'never';
  // Words inside snake_case or camelCase names count too (open_file, saveAs, exportPdf).
  const words = name.replace(/_/g, '.').replace(/([a-z])([A-Z])/g, '$1.$2');
  if (APPROVAL.test(name) || APPROVAL.test(words)) return 'approval';
  return 'free';
}

export function checkAppCommand(command: string, params: Record<string, unknown> | undefined, opts: { approved?: boolean } = {}): OpCheck {
  const tier = appCommandTier(command);
  if (tier === 'never') return { ok: false, reason: `Command "${command}" is not allowed.` };
  if (tier === 'approval' && !opts.approved) return { ok: false, reason: `Command "${command}" needs the user's approval first.` };
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) return { ok: false, reason: 'Parameters must be an object.' };
  // Property paths such as transform/opacity or effects/#1/blurriness are not file paths.
  let p = params ?? {};
  if (command.startsWith('tool:') && PROPERTY_TOOLS.test(command.slice(5)) && typeof p.path === 'string' && PROPERTY_PATH.test(p.path)) { const { path: _ignored, ...rest } = p; p = rest; }
  return checkParamValues(p, tier === 'approval');
}

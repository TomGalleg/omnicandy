// Which commands Claude may send to the other ArtCraft apps (VectorCraft, EffectCraft, DesignCraft, WordCraft, ...), by tier:
//   free      anything that edits the open document;
//   approval  anything that opens, saves, imports, exports, places or runs files, scripts, actions, plugins or batches:
//             the user approves a native dialog first (shown by main);
//   never     app preferences, and OmniCandy's own internal helper commands.
// PhotoCraft has its own, more precise table (photocraftOps.ts).

import { checkParamValues, type OpCheck } from './photocraftOps';
import type { EditorAppId } from './appEditors';

const NEVER = /(^|\.)(prefs?|preferences|settings|options|createcraft)(\.|$)/i;
// Legacy app CLIs sometimes use all-lowercase, concatenated verb names.
// This list is deliberately explicit: avoid treating arbitrary editing commands as file I/O.
const APPROVAL_WORDS = new Set([
  'file', 'files', 'open', 'save', 'saveas', 'export', 'import', 'embed',
  'action', 'actions', 'plugin', 'plugins', 'macro', 'macros', 'batch', 'automate',
  'download', 'upload', 'print', 'package', 'publish', 'recent',
]);
const APPROVAL_ALIASES = new Set([
  'qsave', 'wblock', 'bsave', 'bsaveas', 'tableexport', 'plot', 'exportpdf',
  'pdfbook', 'stylesmanager', 'plottermanager', 'new', 'recover', 'drawingrecovery',
  'insert', 'xattach', 'compare', 'datalink', 'aliasedit', 'reinit',
  'hatch.patterns', 'linetype', 'place', 'link', 'run',
]);
// Never hand arbitrary executable input to the native command bridge, even with approval.
// A future script feature needs its own isolated, explicitly permissioned interface.
const NEVER_EXECUTION = new Set([
  'lisp', 'appload', 'eval', 'exec', 'execute', 'shell', 'script', 'scripts',
  'runscript', 'runfile', 'python', 'javascript', 'js', 'macroexecute',
]);

// Verified against the read-only Patch 8E native command catalog audit.
// These explicit legacy names supplement (but do not replace) semantic capabilities.
// Keep context-sensitive commands scoped to their full IDs to avoid blocking ordinary edits.
const SENSITIVE_APPROVAL = new Set([
  'photo.converttodng', 'photo.editexternal',
  'library.xmppreferences', 'library.toggleautowritexmp',
  'library.smartpreviewslocation', 'folder.synchronize',
  'refclose', 'session.revert', 'links.unembed', 'links.copyto',
  'fields.setcode',
]);
// Catalog-verified legacy CADCraft commands with nonstandard identifiers.
// This is an explicit exception list, not a relaxed identifier grammar.
// Dash-prefixed commands require human approval; ordinary unknown dashed IDs remain denied.
const LEGACY_CAD_APPROVAL = new Set([
  '-vports', '-block', '-attedit', '-xref', '-group',
  '-linetype', '-plottermanager',
]);

const SENSITIVE_NEVER = new Set([
  'plugin.run', 'plugins.runlast', 'home.addins',
  'view.macros', 'tools.macros', 'prop.setexpression',
  'widget.insert', 'widget.click',
]);

function commandParts(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1.$2')
    .split(/[.:_-]/).filter(Boolean).map((part) => part.toLowerCase());
}


const PROPERTY_TOOLS = /^(get|set)_property$|^add_keyframe$|^(get|set|remove|delete)_keyframes?$|^get_layer$/;
const PROPERTY_PATH = /^(@\d+|#?[\w-]+(\/#?[\w-]+){0,8})$/;

export type AppCommandTier = 'free' | 'approval' | 'never';

/** `tool:name` ids (EffectCraft) are judged by the tool name. */
export function appCommandTier(id: string, appId?: EditorAppId): AppCommandTier {
  const name = id.startsWith('tool:') ? id.slice(5) : id;
  if (name.length > 128) return 'never';
  const canonical = name.toLowerCase();
  if (name.startsWith('-')) return appId === 'cadcraft' && LEGACY_CAD_APPROVAL.has(canonical) && name === canonical ? 'approval' : 'never';
  if (!/^[A-Za-z0-9_]+([.:_-][A-Za-z0-9_]+)*$/.test(name)) return 'never';
  if (SENSITIVE_NEVER.has(canonical) || canonical.startsWith('scriptui.')) return 'never';
  if (SENSITIVE_APPROVAL.has(canonical)) return 'approval';
  if (NEVER.test(name)) return 'never';
  const parts = commandParts(name);
  const lower = name.toLowerCase();
  // Match complete command names AND subcommands, without substring matching (e.g. "plotterColor").
  if (parts.some((part) => NEVER_EXECUTION.has(part)) || NEVER_EXECUTION.has(lower)) return 'never';
  if (APPROVAL_ALIASES.has(lower)) return 'approval';
  if (parts.some((part) => APPROVAL_WORDS.has(part))) return 'approval';
  return 'free';
}

export function checkAppCommand(command: string, params: Record<string, unknown> | undefined, opts: { approved?: boolean; appId?: EditorAppId } = {}): OpCheck {
  const tier = appCommandTier(command, opts.appId);
  if (tier === 'never') return { ok: false, reason: `Command "${command}" is not allowed.` };
  if (tier === 'approval' && !opts.approved) return { ok: false, reason: `Command "${command}" needs the user's approval first.` };
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) return { ok: false, reason: 'Parameters must be an object.' };
  // Property paths such as transform/opacity or effects/#1/blurriness are not file paths.
  let p = params ?? {};
  if (command.startsWith('tool:') && PROPERTY_TOOLS.test(command.slice(5)) && typeof p.path === 'string' && PROPERTY_PATH.test(p.path)) { const { path: _ignored, ...rest } = p; p = rest; }
  return checkParamValues(p, tier === 'approval');
}

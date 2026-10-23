// Safety tiers and argument checks for the generic Unreal tool commands.
//
// Unreal's MCP server exposes ~830 tools in ~55 toolsets. Wrapping each by hand would never end, so the adapter passes calls
// through, but never blindly: every (toolset, tool) belongs to ONE tier, and each command accepts only its own tier.
//   read        looks, never changes (get_*, list_*, find_*, is_*, ...)         -> tool.read     (read-project)
//   edit        changes the open project in ways the editor can undo/redo       -> tool.edit     (modify-project)
//   restricted  deletes whole assets/actors, touches disk paths, switches level,
//               changes plugins/config, or drives the editor UI                 -> tool.restricted (asked every time, can be
//                                                                                  allowed for the session)
// Sandboxed scripts (ProgrammaticToolset) are never reachable through these commands; they have their own approval command.
// The tier is a guard against picking the wrong command, not a security boundary: the manager's permission grants and approval
// dialog are the real protection, and the tool must also exist in the live toolset (checked against describe_toolset).

export type Tier = 'read' | 'edit' | 'restricted' | 'script';

/** Last dotted segment: "editor_toolset.toolsets.scene.SceneTools" -> "SceneTools". */
export const shortToolset = (toolset: string): string => toolset.slice(toolset.lastIndexOf('.') + 1);

const READ_RE = /^(?:get|list|find|is|has|can|search|exists|trace|describe|evaluate|query|check|resolve|read_graph|read_graph_dsl|Get|Is|Find|Search|List|Has|Can|Capture|WorldPosToScreenCoords|ScreenCoordsToWorld|Snapshot|Screenshot)(?![a-z]*_or_)/;
const GET_OR_CREATE_RE = /^(?:get|find)_or_/i;

/** Whole toolsets that always need the restricted tier for anything that is not a plain read. */
const RESTRICTED_TOOLSETS = new Set(['PluginToolset', 'SlateInspectorToolset', 'ConfigSettingsToolset', 'SequencerImportExportTools', 'GameFeaturesToolset']);

/** Individual tools that are restricted whatever their toolset (disk paths, whole-asset or whole-actor removal, level switch). */
const RESTRICTED_TOOLS = new Set([
  'AssetTools.delete', 'AssetTools.move', 'AssetTools.write_file', 'AssetTools.read_file',
  'SceneTools.remove_from_scene', 'SceneTools.delete_folder', 'SceneTools.load_level', 'SceneTools.merge_actors',
  'ControlRigTools.import_bones_from_asset', 'SequencerControlRigTools.import_fbx_to_rig',
]);

const RESTRICTED_NAME_RE = /^(?:import|export)_|_file$/;

export function classifyTool(toolset: string, tool: string): Tier {
  const short = shortToolset(toolset);
  if (short === 'ProgrammaticToolset') return 'script';
  if (RESTRICTED_TOOLS.has(`${short}.${tool}`)) return 'restricted';
  if (GET_OR_CREATE_RE.test(tool)) return RESTRICTED_TOOLSETS.has(short) ? 'restricted' : 'edit';
  const isRead = READ_RE.test(tool);
  if (RESTRICTED_TOOLSETS.has(short)) return isRead ? 'read' : 'restricted';
  if (RESTRICTED_NAME_RE.test(tool) && !isRead) return 'restricted';
  return isRead ? 'read' : 'edit';
}

export const TIER_COMMAND: Record<Tier, string> = { read: 'tool.read', edit: 'tool.edit', restricted: 'tool.restricted', script: 'script.run' };

/** Which tiers a command may run. A batch may mix read and edit, never restricted or script. */
export const COMMAND_TIERS: Record<string, readonly Tier[]> = {
  'tool.read': ['read'], 'tool.edit': ['edit'], 'tool.restricted': ['restricted'], 'tool.batch': ['read', 'edit'],
};

export const MAX_BATCH_CALLS = 50;
export const TOOL_ARGS_MAX_CHARS = 32_000;
export const TOOL_ARGS_MAX_DEPTH = 10;
export const SCRIPT_MAX_CODE = 8000;

const NAME_RE = /^[A-Za-z0-9_.]{1,200}$/;
export const isToolsetName = (s: unknown): s is string => typeof s === 'string' && NAME_RE.test(s);
export const isToolName = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_]{1,120}$/.test(s);
export const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Schema checks that run before the user is asked or anything is dispatched. Returns a problem text or undefined. */
export function validateUnrealJson(commandId: string, param: string, value: unknown): string | undefined {
  if (param === 'arguments') {
    return isPlainObject(value) ? undefined : 'arguments must be a JSON object of the tool\'s parameters (use {} for none).';
  }
  if (commandId === 'tool.batch' && param === 'calls') {
    if (!Array.isArray(value) || value.length < 1) return 'calls must be a non-empty array of {toolset, tool, arguments}.';
    if (value.length > MAX_BATCH_CALLS) return `calls may hold at most ${MAX_BATCH_CALLS} entries; split larger work into several batches.`;
    for (const [i, c] of value.entries()) {
      if (!isPlainObject(c)) return `calls[${i}] must be an object.`;
      if (!isToolsetName(c.toolset)) return `calls[${i}].toolset must be a toolset name from tools.search or toolsets.list.`;
      if (!isToolName(c.tool)) return `calls[${i}].tool must be a tool name.`;
      if (c.arguments !== undefined && !isPlainObject(c.arguments)) return `calls[${i}].arguments must be an object.`;
      const tier = classifyTool(c.toolset, c.tool);
      if (tier === 'restricted' || tier === 'script') return `calls[${i}] (${c.tool}) is a ${tier} tool; a batch may only hold read and edit tools. Run it with ${TIER_COMMAND[tier]}.`;
    }
    return undefined;
  }
  if (commandId === 'script.run' && param === 'script') {
    if (!isPlainObject(value)) return 'script must be {"purpose": "...", "code": "..."}.';
    const keys = Object.keys(value);
    if (keys.some((k) => k !== 'purpose' && k !== 'code')) return 'script may only have "purpose" and "code".';
    if (typeof value.purpose !== 'string' || value.purpose.length < 3 || value.purpose.length > 200) return 'purpose must be 3 to 200 characters shown to the user.';
    if (typeof value.code !== 'string' || !value.code.trim() || value.code.length > SCRIPT_MAX_CODE) return `code must be 1 to ${SCRIPT_MAX_CODE} characters of Python defining run().`;
    if (!/def\s+run\s*\(/.test(value.code)) return 'code must define a run() function that returns a dict.';
    return undefined;
  }
  return undefined;
}

/** Plain-text failures the server returns without isError. */
export const PLAIN_ERROR_RE = /^(?:Function "|Parameter error|Error:|Exception|Traceback|Script error)/;

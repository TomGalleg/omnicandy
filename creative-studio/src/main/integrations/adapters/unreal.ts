// Unreal Engine adapter. It talks to the editor through Epic's own MCP server (the "Unreal MCP" plugin, Unreal 5.8+), over
// Streamable HTTP on this computer. That server exposes three meta tools (list_toolsets, describe_toolset, call_tool); every real
// operation is a toolset tool reached through call_tool.
//
// What Unreal itself dictates, and the adapter reports instead of hiding:
//  * The editor must be RUNNING with the Unreal MCP and toolset plugins enabled and the server started
//    (Editor Preferences > Model Context Protocol > Auto Start Server, or the console command ModelContextProtocol.StartServer).
//    OmniCandy never starts the editor or the server.
//  * The server has no authentication; the client refuses any endpoint that is not on this computer.
//  * Tool calls run one at a time on the editor's game thread, so every command makes serial calls.
//  * While Play-In-Editor runs, the editor has no level to edit; edits are refused with that explanation.
//  * There is NO undo tool. Recovery is the user's Ctrl+Z in the editor, plus the read-back checks below.
//
// Control is layered so that the ~830 toolset tools are all reachable without hand-wrapping each one, and never blindly:
//   typed read commands      app.info, toolsets.*, tools.search, level.inspect, assets.find, logs.read, tool.read
//   verified shortcuts       actor.place, actor.transform, actor.delete, level.save: each re-reads the editor and fails if it differs
//   generic tiered passthrough  tool.read / tool.edit / tool.restricted / tool.batch (see unrealTools.ts for the tiers)
//   sandboxed script         script.run (Epic's tool-orchestration sandbox: it can only call registered tools), asked every time

import fs from 'node:fs/promises';
import path from 'node:path';
import { ADAPTER_SDK_VERSION, type AdapterManifest, type CommandSpec, type DiscoveredApp } from '@shared/integrations';
import { McpHttpClient, McpHttpError } from '../../mcpHttpClient';
import { AdapterError, type AdapterFactory, type AdapterOutcome, type ExecuteContext, type ExternalAdapter, type HealthResult, type ProbeResult } from '../sdk';
import {
  classifyTool, COMMAND_TIERS, isPlainObject, isToolName, isToolsetName, MAX_BATCH_CALLS, PLAIN_ERROR_RE, SCRIPT_MAX_CODE, shortToolset,
  TIER_COMMAND, TOOL_ARGS_MAX_CHARS, TOOL_ARGS_MAX_DEPTH, validateUnrealJson, type Tier,
} from './unrealTools';

export const UNREAL_DEFAULT_ENDPOINT = 'http://127.0.0.1:8000/mcp';

const SCENE = 'editor_toolset.toolsets.scene.SceneTools';
const ACTOR = 'editor_toolset.toolsets.actor.ActorTools';
const ASSETS = 'editor_toolset.toolsets.asset.AssetTools';
const APP = 'EditorToolset.EditorAppToolset';
const LOGS = 'EditorToolset.LogsToolset';
const PROGRAMMATIC = 'editor_toolset.toolsets.programmatic.ProgrammaticToolset';

const REF_HELP = 'Objects are passed as {"refPath": "<path>"}, classes as {"refPath": "/Script/Engine.StaticMeshActor"}, transforms as {"location":{x,y,z},"rotation":{pitch,yaw,roll},"scale":{x,y,z}}.';
const ARGS_PARAM = { type: 'json', description: `JSON object with the tool's parameters exactly as toolsets.describe / tools.search list them (use {} for none). ${REF_HELP}`, default: '{}', maxChars: TOOL_ARGS_MAX_CHARS, maxDepth: TOOL_ARGS_MAX_DEPTH } as const;
const TOOLSET_PARAM = { type: 'string', description: 'Exact toolset name from tools.search or toolsets.list, e.g. editor_toolset.toolsets.scene.SceneTools.', required: true } as const;
const TOOL_PARAM = { type: 'string', description: 'Tool name inside that toolset without the toolset prefix, e.g. find_actors.', required: true } as const;
const NUM = (description: string, def?: number): { type: 'number'; description: string; default?: number } => ({ type: 'number', description, ...(def !== undefined ? { default: def } : {}) });

const COMMANDS: CommandSpec[] = [
  {
    id: 'app.info', label: 'Check Unreal Editor',
    description: 'Connects to the editor\'s MCP server and reports the server, how many toolsets it offers, the open level and whether Play-In-Editor is running (read only).',
    params: {}, permissions: ['read-info', 'read-project'], idempotent: true, timeoutMs: 60_000,
  },
  {
    id: 'toolsets.list', label: 'List Unreal toolsets',
    description: 'Lists the toolsets the editor offers (name and one-line purpose) (read only). To find a specific tool use tools.search.',
    params: {}, permissions: ['read-info'], idempotent: true, timeoutMs: 60_000,
  },
  {
    id: 'toolsets.describe', label: 'Describe one Unreal toolset',
    description: 'Lists the tools of one toolset with their parameter names, which are required, a one-line description and the tier (read, edit, restricted) that says which tool.* command runs them (read only).',
    params: { toolset: { type: 'string', description: 'Exact toolset name from toolsets.list, e.g. editor_toolset.toolsets.scene.SceneTools.', required: true } },
    permissions: ['read-info'], idempotent: true, timeoutMs: 60_000,
  },
  {
    id: 'tools.search', label: 'Search Unreal tools',
    description: 'Searches all ~830 Unreal tools by words in the toolset, tool name or description (every word must appear) and returns toolset, tool, parameters, and the tier that tells which command runs it: read -> tool.read, edit -> tool.edit, restricted -> tool.restricted (read only). Start here to find what to call.',
    params: {
      query: { type: 'string', description: 'Words to look for, e.g. "material connect" or "spawn actor". Empty lists the first tools.', default: '' },
      tier: { type: 'string', description: 'Optional filter: read, edit or restricted.', default: '' },
      limit: { type: 'number', description: 'Most tools to return.', default: 25, min: 1, max: 100 },
    },
    permissions: ['read-info'], idempotent: true, timeoutMs: 120_000,
  },
  {
    id: 'level.inspect', label: 'Inspect the open level',
    description: 'Reports the open level and the actors in it, counted by kind with the first names listed. Changes nothing.',
    params: { max_names: { type: 'number', description: 'How many actor names to list.', default: 40, min: 0, max: 200 } },
    permissions: ['read-project'], idempotent: true, timeoutMs: 60_000,
  },
  {
    id: 'assets.find', label: 'Find project assets',
    description: 'Lists asset paths in a project folder, optionally filtered by a name fragment (read only).',
    params: {
      folder: { type: 'string', description: 'Content folder, e.g. /Game or /Game/ThirdPerson.', default: '/Game' },
      name: { type: 'string', description: 'Part of the asset name (empty for all).', default: '' },
      recursive: { type: 'boolean', description: 'Include subfolders.', default: false },
      max: { type: 'number', description: 'Most assets to list.', default: 100, min: 1, max: 500 },
    },
    permissions: ['read-project'], idempotent: true, timeoutMs: 60_000,
  },
  {
    id: 'logs.read', label: 'Read the editor log',
    description: 'Returns the most recent output-log lines, optionally only those matching a regular expression (read only).',
    params: {
      pattern: { type: 'string', description: 'Regular expression the line must match (empty for all).', default: '' },
      max: { type: 'number', description: 'Most lines to return, taken from the end of the log.', default: 50, min: 1, max: 500 },
    },
    permissions: ['read-info'], idempotent: true, timeoutMs: 60_000,
  },
  {
    id: 'tool.read', label: 'Run a read-only Unreal tool',
    description: `Runs one READ-tier toolset tool (get_*, list_*, find_*, is_*...), for example blueprint graphs, material expressions, properties, sequences. Refuses edit and restricted tools. Nothing is changed. ${REF_HELP}`,
    params: { toolset: TOOLSET_PARAM, tool: TOOL_PARAM, arguments: ARGS_PARAM },
    permissions: ['read-project'], idempotent: true, timeoutMs: 90_000,
  },
  {
    id: 'tool.edit', label: 'Run an editing Unreal tool',
    description: `Runs one EDIT-tier toolset tool that changes the open project: spawn or move actors, set properties, build Blueprints and materials, add keys, create assets. The result is Unreal's own answer, NOT independently re-read: afterwards check with a read command. There is no undo tool (the user can press Ctrl+Z in the editor). Not available while Play-In-Editor runs. ${REF_HELP}`,
    params: { toolset: TOOLSET_PARAM, tool: TOOL_PARAM, arguments: ARGS_PARAM },
    permissions: ['modify-project'], idempotent: false, timeoutMs: 120_000,
  },
  {
    id: 'tool.restricted', label: 'Run a restricted Unreal tool',
    description: `Runs one RESTRICTED-tier tool: deleting whole assets or actors, moving assets, reading or writing files by path, importing, switching level, plugin or config changes, driving the editor UI. Always asks first. ${REF_HELP}`,
    params: { toolset: TOOLSET_PARAM, tool: TOOL_PARAM, arguments: ARGS_PARAM },
    permissions: ['modify-project', 'write-files'], destructive: true, idempotent: false, timeoutMs: 120_000,
  },
  {
    id: 'tool.batch', label: 'Run several Unreal tools in one step',
    description: `Runs up to ${MAX_BATCH_CALLS} read or edit tools one after the other in a single approval: {"calls":[{"toolset":"...","tool":"...","arguments":{...}}, ...]}. Every call is checked (tool exists, required parameters present, no restricted tool) before the first one runs, and it stops at the first failure and reports how many were applied. Use it instead of many separate calls. ${REF_HELP}`,
    params: { calls: { type: 'json', description: 'Array of {toolset, tool, arguments} objects.', required: true, maxChars: 48_000, maxDepth: TOOL_ARGS_MAX_DEPTH } },
    permissions: ['modify-project'], idempotent: false, timeoutMs: 300_000,
  },
  {
    id: 'actor.place', label: 'Place an actor (verified)',
    description: 'Spawns one actor in the open level from an asset path (/Game/...) or a class (/Script/Engine.StaticMeshActor, a Blueprint class path) and then re-reads the editor to confirm the actor exists and sits at the requested place. Returns the actor reference for later calls.',
    params: {
      asset: { type: 'string', description: 'Asset path such as /Game/ThirdPerson/Maps/X, or a class path starting /Script/ such as /Script/Engine.PointLight.', required: true },
      name: { type: 'string', description: 'Name for the new actor.', required: true },
      x: NUM('World X (cm).', 0), y: NUM('World Y (cm).', 0), z: NUM('World Z (cm).', 0),
      pitch: NUM('Pitch (degrees).', 0), yaw: NUM('Yaw (degrees).', 0), roll: NUM('Roll (degrees).', 0),
      scale: { type: 'number', description: 'Uniform scale.', default: 1, min: 0.001, max: 10000 },
      snap_to_ground: { type: 'boolean', description: 'Lower the actor onto the ground below it.', default: false },
    },
    permissions: ['modify-project'], idempotent: false, timeoutMs: 90_000,
  },
  {
    id: 'actor.transform', label: 'Move, rotate or scale an actor (verified)',
    description: 'Sets any of location, rotation and uniform scale of one actor (only the values you give change) and re-reads the actor to confirm.',
    params: {
      actor: { type: 'string', description: 'Actor reference path, e.g. from level.inspect, tool results or actor.place.', required: true },
      x: NUM('World X (cm).'), y: NUM('World Y (cm).'), z: NUM('World Z (cm).'),
      pitch: NUM('Pitch (degrees).'), yaw: NUM('Yaw (degrees).'), roll: NUM('Roll (degrees).'),
      scale: { type: 'number', description: 'Uniform scale.', min: 0.001, max: 10000 },
    },
    permissions: ['modify-project'], idempotent: true, timeoutMs: 90_000,
  },
  {
    id: 'actor.delete', label: 'Delete an actor (verified)',
    description: 'Removes one actor from the open level and re-reads the level to confirm it is gone. Always asks first. The user can undo it with Ctrl+Z in the editor.',
    params: { actor: { type: 'string', description: 'Actor reference path.', required: true } },
    permissions: ['modify-project'], destructive: true, idempotent: false, timeoutMs: 90_000,
  },
  {
    id: 'level.save', label: 'Save the open level (verified)',
    description: 'Saves the open level to disk and confirms it is no longer marked as having unsaved changes. Overwrites the level file.',
    params: {},
    permissions: ['modify-project', 'write-files'], idempotent: true, timeoutMs: 120_000,
  },
  {
    id: 'script.run', label: 'Run an Unreal tool script',
    description: `Runs a short Python script in Unreal's tool-orchestration sandbox (only math, re, time, json, copy, datetime; it can only call registered tools through execute_tool(name, json_text)) and returns what run() returns. The user sees the whole script and is asked EVERY time. Use tool.batch when a plain list of calls is enough. Needs {"purpose":"shown to the user","code":"def run(): ... return {...}"}, at most ${SCRIPT_MAX_CODE} characters. A script can call any tool, restricted ones included.`,
    params: { script: { type: 'json', description: 'A JSON OBJECT {"purpose": "...", "code": "def run():\\n    ...\\n    return {...}"}, never a bare string.', required: true, maxChars: SCRIPT_MAX_CODE + 1500, maxDepth: 3 } },
    permissions: ['modify-project', 'write-files', 'execute-scripts'], destructive: true, confirmEveryTime: true, idempotent: false, timeoutMs: 300_000,
  },
];

export const UNREAL_MANIFEST: AdapterManifest = {
  id: 'unreal', name: 'Unreal Engine', vendor: 'Epic Games', sdkVersion: ADAPTER_SDK_VERSION, maturity: 'experimental',
  exeNames: ['UnrealEditor.exe'], displayNames: ['^Unreal Engine'],
  versions: { min: '5.8' },
  methods: ['mcp'],
  capabilities: ['detect', 'inspectCapabilities', 'connect', 'disconnect', 'healthCheck', 'executeCommand', 'cancelOperation', 'saveProject', 'dispose'],
  commands: COMMANDS,
  requirements: [
    { kind: 'running', text: 'Unreal Editor 5.8 or newer must be open with a project (and not in Play-In-Editor).' },
    { kind: 'preference', text: 'Enable the "Unreal MCP" and "All Toolsets" plugins (Edit > Plugins), restart, then turn on Auto Start Server (Editor Preferences > Model Context Protocol) or run ModelContextProtocol.StartServer in the editor console.' },
  ],
  notes: 'Uses Epic\'s experimental built-in MCP server on this computer (default http://127.0.0.1:8000/mcp; set OMNICANDY_UNREAL_MCP_URL for another local port). OmniCandy never starts the editor or the server. It reaches all ~830 editor tools in tiers: reading, editing (asked once, then allowed), and restricted (deleting assets, files, plugins: asked every time). Unreal has no undo tool: use Ctrl+Z in the editor, and check results with the read commands.',
};

type Obj = Record<string, unknown>;

function endpoint(): string { return process.env.OMNICANDY_UNREAL_MCP_URL || UNREAL_DEFAULT_ENDPOINT; }

/** Turns client failures into adapter failures with a message the user can act on. */
function classify(e: unknown): never {
  if (e instanceof AdapterError) throw e;
  if (e instanceof McpHttpError) {
    if (e.kind === 'unreachable') throw new AdapterError('app-error', `Unreal's MCP server is not reachable (${e.message}). Open the editor, enable the Unreal MCP and All Toolsets plugins, and turn on Auto Start Server or run ModelContextProtocol.StartServer in its console.`);
    if (e.kind === 'aborted') throw new AdapterError('app-error', 'Cancelled.');
    throw new AdapterError('app-error', e.message);
  }
  throw e;
}

/** One session: connect, run `fn`, always close. Sessions are short so an editor restart never leaves a stale one. */
async function withSession<T>(signal: AbortSignal | undefined, fn: (c: McpHttpClient) => Promise<T>): Promise<T> {
  let c: McpHttpClient | null = null;
  try {
    c = await McpHttpClient.connect(endpoint(), { clientName: 'omnicandy' }, signal);
    return await fn(c);
  } catch (e) { return classify(e); } finally { await c?.close(); }
}

/** Calls one toolset tool and returns what Unreal answered: parsed JSON (a lone {returnValue} is unwrapped) or text.
 *  The server reports some argument errors as plain text without isError; those are recognised and thrown. */
async function rawToolCall(c: McpHttpClient, toolset: string, tool: string, args: Obj, signal?: AbortSignal, timeoutMs = 90_000): Promise<unknown> {
  let r: unknown;
  try { r = await c.callTool('call_tool', { toolset_name: toolset, tool_name: tool, arguments: args }, timeoutMs, signal); } catch (e) {
    if (e instanceof McpHttpError && e.kind === 'tool') throw new AdapterError('app-error', `${tool}: ${e.message.slice(0, 600)}`);
    throw e;
  }
  if (typeof r === 'string') {
    if (PLAIN_ERROR_RE.test(r)) throw new AdapterError('app-error', `${tool}: ${r.slice(0, 600)}`);
    return r;
  }
  if (isPlainObject(r) && Object.keys(r).length === 1 && 'returnValue' in r) return r.returnValue;
  return r;
}

/** For the fixed read helpers: the answer must be {returnValue}. */
async function toolCall(c: McpHttpClient, toolset: string, tool: string, args: Obj, signal?: AbortSignal): Promise<unknown> {
  const r = await rawToolCall(c, toolset, tool, args, signal, 45_000);
  if (typeof r === 'string' && PLAIN_ERROR_RE.test(r)) throw new AdapterError('app-error', `${tool}: ${r.slice(0, 400)}`);
  return r;
}

async function metaText(c: McpHttpClient, tool: string, args: Obj, signal?: AbortSignal): Promise<string> {
  const r = await c.callTool(tool, args, 45_000, signal).catch((e) => {
    if (e instanceof McpHttpError && e.kind === 'tool') throw new AdapterError('app-error', `${tool}: ${e.message.slice(0, 400)}`);
    throw e;
  });
  return typeof r === 'string' ? r : JSON.stringify(r);
}

/** `- Name.Space: description` lines (a description may continue on following lines, even with "- word:" bullets) into entries.
 *  Toolset names always contain a dot, which keeps bullets inside a description from being read as toolsets. */
export function parseToolsetList(text: string): Array<{ name: string; summary: string }> {
  const out: Array<{ name: string; summary: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^- ([A-Za-z0-9_]+\.[A-Za-z0-9_.]*): (.*)$/.exec(line);
    if (m) out.push({ name: m[1]!, summary: m[2]!.trim() });
  }
  return out;
}

/** Actor kind guessed from its object name: StaticMeshActor_UAID_.._123 and StaticMeshActor_7 are both StaticMeshActor. */
export function actorKind(refPath: string): { name: string; kind: string } {
  const name = refPath.slice(refPath.lastIndexOf('.') + 1);
  return { name, kind: name.replace(/_UAID_.*$/, '').replace(/_\d+$/, '') };
}

const refName = (v: unknown): string | null => (v && typeof v === 'object' && typeof (v as Obj).refPath === 'string' ? (v as Obj).refPath as string : null);
const refList = (v: unknown): string[] => (Array.isArray(v) ? v : []).map(refName).filter((x): x is string => x !== null);

interface ToolInfo { name: string; summary: string; params: string[]; required: string[] }
interface Described { description: string; tools: Map<string, ToolInfo> }

/** Output of a tool call can be huge (whole graphs); keep what is shown to the AI bounded and say so. */
export const RESULT_MAX_CHARS = 60_000;
export function capResult(v: unknown): { result?: unknown; preview?: string; truncated: boolean; chars: number } {
  const text = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  if (text.length <= RESULT_MAX_CHARS) return { result: v, truncated: false, chars: text.length };
  return { preview: text.slice(0, RESULT_MAX_CHARS), truncated: true, chars: text.length };
}

const near = (a: unknown, b: number, tol: number) => typeof a === 'number' && Math.abs(a - b) <= tol;
const angleNear = (a: unknown, b: number, tol: number) => typeof a === 'number' && Math.abs((((a - b) % 360) + 540) % 360 - 180) <= tol;
type Vec = { x?: number; y?: number; z?: number }; type Rot = { pitch?: number; yaw?: number; roll?: number };
interface Xform { location?: Vec; rotation?: Rot; scale?: Vec }

class UnrealAdapter implements ExternalAdapter {
  private app: DiscoveredApp | null = null;
  private described = new Map<string, { at: number; d: Described }>();
  private index: { at: number; entries: Array<{ toolset: string; tool: string; tier: Tier; summary: string; params: string[]; required: string[] }> } | null = null;

  async probe(app: DiscoveredApp): Promise<ProbeResult> {
    if (app.version) return { version: app.version, detail: 'version from the installer record' };
    // <root>/Engine/Binaries/Win64/UnrealEditor.exe -> <root>/Engine/Build/Build.version
    try {
      const j = JSON.parse(await fs.readFile(path.join(path.dirname(app.exePath), '..', '..', 'Build', 'Build.version'), 'utf8')) as { MajorVersion?: number; MinorVersion?: number; PatchVersion?: number };
      if (typeof j.MajorVersion === 'number') return { version: `${j.MajorVersion}.${j.MinorVersion ?? 0}.${j.PatchVersion ?? 0}`, detail: 'version from Engine/Build/Build.version' };
    } catch { /* fall through */ }
    return { version: null };
  }
  async connect(app: DiscoveredApp): Promise<void> { this.app = app; this.described.clear(); this.index = null; }
  async disconnect(): Promise<void> { this.app = null; }

  async healthCheck(): Promise<HealthResult> {
    if (!this.app) return { ok: false, detail: 'Not connected.' };
    try {
      const n = await withSession(undefined, async (c) => parseToolsetList(await metaText(c, 'list_toolsets', {})).length);
      if (n === 0) return { ok: false, state: 'api-unavailable', detail: 'The MCP server answered but offers no toolsets. Enable the "All Toolsets" plugin and restart the editor.' };
      return { ok: true, detail: `Unreal's MCP server answers with ${n} toolsets.` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, state: /not reachable/.test(msg) ? 'api-unavailable' : undefined, detail: msg };
    }
  }

  /** describe_toolset, cached for a minute (tools do not change while the editor runs). */
  private async describe(c: McpHttpClient, toolset: string, sig?: AbortSignal): Promise<Described> {
    const hit = this.described.get(toolset);
    if (hit && Date.now() - hit.at < 60_000) return hit.d;
    const text = await metaText(c, 'describe_toolset', { toolset_name: toolset }, sig);
    let j: { description?: string; tools?: Array<{ name?: string; description?: string; inputSchema?: { properties?: Obj; required?: string[] } }> };
    try { j = JSON.parse(text); } catch { throw new AdapterError('app-error', `Unreal has no toolset "${toolset}" (${text.slice(0, 200)}). Use tools.search or toolsets.list for the exact name.`); }
    const tools = new Map<string, ToolInfo>();
    for (const t of j.tools ?? []) {
      const name = String(t.name ?? '').slice(toolset.length + 1);
      if (name) tools.set(name, { name, summary: String(t.description ?? '').split('\n')[0]!.trim(), params: Object.keys(t.inputSchema?.properties ?? {}), required: t.inputSchema?.required ?? [] });
    }
    const d = { description: j.description ?? '', tools };
    this.described.set(toolset, { at: Date.now(), d });
    return d;
  }

  private async toolIndex(c: McpHttpClient, sig?: AbortSignal) {
    if (this.index && Date.now() - this.index.at < 120_000) return this.index.entries;
    const entries: NonNullable<UnrealAdapter['index']>['entries'] = [];
    for (const ts of parseToolsetList(await metaText(c, 'list_toolsets', {}, sig))) {
      if (sig?.aborted) throw new AdapterError('app-error', 'Cancelled.');
      let d: Described;
      try { d = await this.describe(c, ts.name, sig); } catch (e) { if (e instanceof McpHttpError) throw e; continue; }
      for (const t of d.tools.values()) entries.push({ toolset: ts.name, tool: t.name, tier: classifyTool(ts.name, t.name), summary: t.summary, params: t.params, required: t.required });
    }
    this.index = { at: Date.now(), entries };
    return entries;
  }

  /** The editor world is gone while Play-In-Editor runs, so edits would hit nothing (or the wrong thing). */
  private async requireEditable(c: McpHttpClient, sig?: AbortSignal): Promise<void> {
    if ((await toolCall(c, APP, 'IsPIERunning', {}, sig)) === true) {
      throw new AdapterError('app-error', 'Play-In-Editor is running, so the editor has no level to edit. Stop the play session (press Esc in it, or call EditorToolset.EditorAppToolset StopPIE with tool.edit), then try again.');
    }
  }

  /** Checks a call against the live toolset before anything runs: the tool exists, its tier fits the command, required arguments are present. */
  private async checkCall(c: McpHttpClient, commandId: string, toolset: string, tool: string, args: Obj, sig?: AbortSignal, where = ''): Promise<void> {
    if (!isToolsetName(toolset)) throw new AdapterError('invalid-params', `${where}toolset must be a toolset name from tools.search or toolsets.list.`);
    if (!isToolName(tool)) throw new AdapterError('invalid-params', `${where}tool must be a tool name.`);
    const tier = classifyTool(toolset, tool);
    if (!COMMAND_TIERS[commandId]?.includes(tier)) {
      throw new AdapterError('invalid-params', `${where}${tool} is a ${tier} tool; run it with ${TIER_COMMAND[tier]}${tier === 'script' ? ' (it needs the user to read the script)' : ''}, not ${commandId}.`);
    }
    const d = await this.describe(c, toolset, sig);
    const info = d.tools.get(tool);
    if (!info) {
      const near = [...d.tools.keys()].filter((k) => k.includes(tool) || tool.includes(k)).slice(0, 5);
      throw new AdapterError('invalid-params', `${where}the toolset has no tool "${tool}".${near.length ? ` Similar: ${near.join(', ')}.` : ' Use toolsets.describe or tools.search.'}`);
    }
    const missing = info.required.filter((k) => !(k in args));
    if (missing.length) throw new AdapterError('invalid-params', `${where}${tool} needs ${missing.join(', ')} (all parameters: ${info.params.join(', ') || 'none'}).`);
    const unknown = Object.keys(args).filter((k) => !info.params.includes(k));
    if (unknown.length) throw new AdapterError('invalid-params', `${where}${tool} has no parameter ${unknown.join(', ')} (it takes: ${info.params.join(', ') || 'none'}).`);
  }

  private actorList(c: McpHttpClient, sig?: AbortSignal): Promise<string[]> {
    return toolCall(c, SCENE, 'find_actors', { name: '', tag: '', collision_channels: [] }, sig).then(refList);
  }
  private async transformOf(c: McpHttpClient, actor: string, sig?: AbortSignal): Promise<Xform> {
    const t = await toolCall(c, ACTOR, 'get_actor_transform', { actor: { refPath: actor } }, sig);
    if (!isPlainObject(t)) throw new AdapterError('app-error', `Unreal returned no transform for ${actor}.`);
    return t as Xform;
  }

  async execute(cmd: CommandSpec, params: Record<string, string | number | boolean>, ctx: ExecuteContext): Promise<AdapterOutcome> {
    if (!this.app) throw new AdapterError('app-error', 'Unreal Engine is not connected.');
    const sig = ctx.signal;
    const live = ['read from the running Unreal Editor through its MCP server'];
    const receipt = (what: string) => [`${what} (Unreal's own answer; not independently re-read: check with a read command)`];
    return withSession(sig, async (c) => {
      switch (cmd.id) {
        case 'app.info': {
          const toolsets = parseToolsetList(await metaText(c, 'list_toolsets', {}, sig));
          const level = await toolCall(c, SCENE, 'get_current_level', {}, sig);
          const pie = await toolCall(c, APP, 'IsPIERunning', {}, sig);
          const d = { server: c.serverInfo, toolsetCount: toolsets.length, level: String(level), pieRunning: pie === true, endpoint: endpoint() };
          const where = String(level) ? `level ${String(level)}` : 'no editor level reported (a Play-In-Editor session hides it)';
          return { message: `Unreal Editor answers: ${toolsets.length} toolsets, ${where}${pie === true ? ', Play-In-Editor running' : ''}.`, outputs: [], data: d, verified: true, evidence: live };
        }
        case 'toolsets.list': {
          const toolsets = parseToolsetList(await metaText(c, 'list_toolsets', {}, sig));
          return { message: `${toolsets.length} toolsets available.`, outputs: [], data: { count: toolsets.length, toolsets }, verified: true, evidence: live };
        }
        case 'toolsets.describe': {
          const name = String(params.toolset).trim();
          if (!isToolsetName(name)) throw new AdapterError('invalid-params', 'toolset must be a name from toolsets.list.');
          const d = await this.describe(c, name, sig);
          const tools = [...d.tools.values()].map((t) => ({ ...t, tier: classifyTool(name, t.name) }));
          return { message: `${name}: ${tools.length} tools.`, outputs: [], data: { toolset: name, description: d.description, count: tools.length, tools }, verified: true, evidence: live };
        }
        case 'tools.search': {
          const words = String(params.query).toLowerCase().split(/\s+/).filter(Boolean);
          const tier = String(params.tier).trim();
          if (tier && !['read', 'edit', 'restricted'].includes(tier)) throw new AdapterError('invalid-params', 'tier must be read, edit or restricted.');
          const limit = Math.max(1, Math.min(100, Number(params.limit)));
          const all = await this.toolIndex(c, sig);
          const hits = all.filter((e) => (!tier || e.tier === tier) && words.every((w) => `${shortToolset(e.toolset)} ${e.tool} ${e.summary}`.toLowerCase().includes(w)));
          const score = (e: typeof all[number]) => words.reduce((s, w) => s + (e.tool.toLowerCase().includes(w) ? 2 : 0), 0);
          hits.sort((a, b) => score(b) - score(a));
          const shown = hits.slice(0, limit).map((e) => ({ ...e, command: TIER_COMMAND[e.tier] }));
          return { message: `${hits.length} matching tool(s) of ${all.length}${hits.length > limit ? ` (first ${limit} shown)` : ''}.`, outputs: [], data: { total: all.length, matches: hits.length, tools: shown }, verified: true, evidence: live };
        }
        case 'level.inspect': {
          const level = String(await toolCall(c, SCENE, 'get_current_level', {}, sig));
          if (!level) {
            const pie = await toolCall(c, APP, 'IsPIERunning', {}, sig);
            throw new AdapterError('app-error', pie === true
              ? 'The editor reports no open level because a Play-In-Editor session is running. Stop the play session (or press Esc in it), then try again.'
              : 'The editor reports no open level. Open a level in Unreal Editor first.');
          }
          const actors = (await this.actorList(c, sig)).map(actorKind);
          const kinds: Record<string, number> = {};
          for (const a of actors) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
          const max = Math.max(0, Math.min(200, Number(params.max_names)));
          const d = { level, actorCount: actors.length, kinds, names: actors.slice(0, max).map((a) => a.name) };
          return { message: `Level ${level}: ${actors.length} actors in ${Object.keys(kinds).length} kinds.`, outputs: [], data: d, verified: true, evidence: live };
        }
        case 'assets.find': {
          const folder = String(params.folder).trim() || '/Game';
          if (!/^\/[A-Za-z0-9_\-./]{0,300}$/.test(folder)) throw new AdapterError('invalid-params', 'folder must be a content path such as /Game/ThirdPerson.');
          const r = await toolCall(c, ASSETS, 'find_assets', { folder_path: folder, name: String(params.name), recursive: params.recursive === true }, sig);
          const all = (Array.isArray(r) ? r : []).map(String);
          const max = Math.max(1, Math.min(500, Number(params.max)));
          return { message: `${all.length} asset(s) in ${folder}${all.length > max ? ` (first ${max} listed)` : ''}.`, outputs: [], data: { folder, total: all.length, assets: all.slice(0, max) }, verified: true, evidence: live };
        }
        case 'logs.read': {
          const pattern = String(params.pattern);
          if (pattern.length > 200) throw new AdapterError('invalid-params', 'pattern is too long.');
          try { new RegExp(pattern); } catch { throw new AdapterError('invalid-params', 'pattern is not a valid regular expression.'); }
          const r = await toolCall(c, LOGS, 'GetLogEntries', { category: '', pattern, maxEntries: Math.max(1, Math.min(500, Number(params.max))) }, sig);
          const lines = (Array.isArray(r) ? r : []).map(String);
          return { message: `${lines.length} log line(s).`, outputs: [], data: { count: lines.length, lines }, verified: true, evidence: live };
        }

        case 'tool.read': case 'tool.edit': case 'tool.restricted': {
          const toolset = String(params.toolset).trim(), tool = String(params.tool).trim();
          const args = JSON.parse(String(params.arguments ?? '{}')) as Obj;
          await this.checkCall(c, cmd.id, toolset, tool, args, sig);
          if (cmd.id !== 'tool.read' && toolset !== APP) await this.requireEditable(c, sig);
          const r = await rawToolCall(c, toolset, tool, args, sig, cmd.timeoutMs ?? 90_000);
          const capped = capResult(r);
          const edit = cmd.id !== 'tool.read';
          return {
            message: `${shortToolset(toolset)}.${tool} done${capped.truncated ? ` (result of ${capped.chars} characters cut to ${RESULT_MAX_CHARS})` : ''}.`,
            outputs: [], data: { toolset, tool, ...capped },
            verified: edit ? false : true, evidence: edit ? receipt(`${tool} returned`) : live,
          };
        }
        case 'tool.batch': {
          const calls = JSON.parse(String(params.calls)) as Array<{ toolset: string; tool: string; arguments?: Obj }>;
          for (const [i, k] of calls.entries()) await this.checkCall(c, 'tool.batch', k.toolset, k.tool, k.arguments ?? {}, sig, `calls[${i}]: `);
          if (calls.some((k) => k.toolset !== APP)) await this.requireEditable(c, sig);
          const results: Array<{ index: number; tool: string; ok: boolean; result?: unknown; error?: string }> = [];
          let failedAt: number | null = null;
          for (const [i, k] of calls.entries()) {
            if (sig.aborted) { failedAt = i; results.push({ index: i, tool: k.tool, ok: false, error: 'Cancelled before this call.' }); break; }
            ctx.progress(`Call ${i + 1} of ${calls.length}: ${k.tool}`, i / calls.length);
            try {
              const r = await rawToolCall(c, k.toolset, k.tool, k.arguments ?? {}, sig, 90_000);
              results.push({ index: i, tool: k.tool, ok: true, result: capResult(r).result ?? '(too large; call it alone to see it)' });
            } catch (e) {
              if (e instanceof AdapterError || e instanceof McpHttpError) { failedAt = i; results.push({ index: i, tool: k.tool, ok: false, error: e.message }); break; }
              throw e;
            }
          }
          const applied = results.filter((r) => r.ok).length;
          const data = { total: calls.length, applied, failedAt, results };
          if (failedAt !== null) throw new AdapterError('app-error', `Batch stopped at call ${failedAt + 1} of ${calls.length} (${results[failedAt]!.tool}): ${results[failedAt]!.error}. ${applied} earlier call(s) were applied and are NOT rolled back; check with a read command or press Ctrl+Z in the editor. Details: ${JSON.stringify(data).slice(0, 3000)}`);
          return { message: `Ran ${applied} of ${calls.length} calls.`, outputs: [], data, verified: false, evidence: receipt('each call returned without error') };
        }

        case 'actor.place': {
          await this.requireEditable(c, sig);
          const asset = String(params.asset).trim(), name = String(params.name).trim();
          if (!/^\/[A-Za-z0-9_\-./:]{1,300}$/.test(asset)) throw new AdapterError('invalid-params', 'asset must be an asset path (/Game/...) or a class path (/Script/...).');
          if (!/^[A-Za-z0-9_ \-.]{1,100}$/.test(name)) throw new AdapterError('invalid-params', 'name may only use letters, digits, space, _ - and .');
          const want: Xform = { location: { x: Number(params.x), y: Number(params.y), z: Number(params.z) }, rotation: { pitch: Number(params.pitch), yaw: Number(params.yaw), roll: Number(params.roll) }, scale: { x: Number(params.scale), y: Number(params.scale), z: Number(params.scale) } };
          const snap = params.snap_to_ground === true;
          const before = new Set(await this.actorList(c, sig));
          const made = asset.startsWith('/Script/')
            ? await toolCall(c, SCENE, 'add_to_scene_from_class', { actor_type: { refPath: asset }, name, xform: want, snap_to_ground: snap }, sig)
            : await toolCall(c, SCENE, 'add_to_scene_from_asset', { asset_path: asset, name, xform: want, snap_to_ground: snap }, sig);
          const ref = refName(made);
          if (!ref) throw new AdapterError('app-error', `Unreal did not create the actor from ${asset} (it returned nothing). Check the path with assets.find.`);
          const after = await this.actorList(c, sig);
          if (!after.includes(ref) || before.has(ref)) throw new AdapterError('verification-failed', `Unreal returned ${ref} but the level does not list it as a new actor.`);
          const got = await this.transformOf(c, ref, sig);
          const loc = got.location ?? {};
          if (!snap && !(near(loc.x, want.location!.x!, 1) && near(loc.y, want.location!.y!, 1) && near(loc.z, want.location!.z!, 1))) {
            throw new AdapterError('verification-failed', `The actor ${ref} exists but is at ${JSON.stringify(loc)} instead of ${JSON.stringify(want.location)}.`);
          }
          const label = await toolCall(c, ACTOR, 'get_label', { actor: { refPath: ref } }, sig).catch(() => null);
          return { message: `Placed ${ref}.`, outputs: [], data: { actor: ref, label, transform: got, actorCount: after.length }, verified: true, evidence: [`the level lists ${ref} as a new actor (${before.size} -> ${after.length} actors)`, snap ? 'position not compared (snap to ground)' : 'location read back and within 1 cm of the request'] };
        }
        case 'actor.transform': {
          await this.requireEditable(c, sig);
          const actor = String(params.actor).trim();
          const num = (k: string): number | undefined => (typeof params[k] === 'number' ? params[k] as number : undefined);
          const [x, y, z, pitch, yaw, roll, scale] = ['x', 'y', 'z', 'pitch', 'yaw', 'roll', 'scale'].map(num);
          if ([x, y, z, pitch, yaw, roll, scale].every((v) => v === undefined)) throw new AdapterError('invalid-params', 'Give at least one of x, y, z, pitch, yaw, roll or scale.');
          if (!(await this.actorList(c, sig)).includes(actor)) throw new AdapterError('invalid-params', `The open level has no actor ${actor}. Use level.inspect or tool.read find_actors for exact references.`);
          const cur = await this.transformOf(c, actor, sig);
          const want: Xform = {};
          if (x !== undefined || y !== undefined || z !== undefined) want.location = { x: x ?? cur.location?.x ?? 0, y: y ?? cur.location?.y ?? 0, z: z ?? cur.location?.z ?? 0 };
          if (pitch !== undefined || yaw !== undefined || roll !== undefined) want.rotation = { pitch: pitch ?? cur.rotation?.pitch ?? 0, yaw: yaw ?? cur.rotation?.yaw ?? 0, roll: roll ?? cur.rotation?.roll ?? 0 };
          if (scale !== undefined) want.scale = { x: scale, y: scale, z: scale };
          const ok = await toolCall(c, ACTOR, 'set_actor_transform', { actor: { refPath: actor }, xform: want, worldspace: true }, sig);
          if (ok !== true) throw new AdapterError('app-error', `Unreal did not apply the transform to ${actor} (it answered ${JSON.stringify(ok)}).`);
          const got = await this.transformOf(c, actor, sig);
          const bad: string[] = [];
          if (want.location) for (const k of ['x', 'y', 'z'] as const) if (!near(got.location?.[k], want.location[k]!, 0.5)) bad.push(`location.${k}`);
          if (want.rotation) for (const k of ['pitch', 'yaw', 'roll'] as const) if (!angleNear(got.rotation?.[k], want.rotation[k]!, 0.05)) bad.push(`rotation.${k}`);
          if (want.scale) for (const k of ['x', 'y', 'z'] as const) if (!near(got.scale?.[k], want.scale[k]!, 0.001)) bad.push(`scale.${k}`);
          if (bad.length) throw new AdapterError('verification-failed', `${actor} was changed but reads back differently for ${bad.join(', ')}: now ${JSON.stringify(got)}.`);
          return { message: `Updated ${actor}.`, outputs: [], data: { actor, requested: want, transform: got }, verified: true, evidence: ['transform read back from the editor and equal to the request'] };
        }
        case 'actor.delete': {
          await this.requireEditable(c, sig);
          const actor = String(params.actor).trim();
          const before = await this.actorList(c, sig);
          if (!before.includes(actor)) return { message: `${actor} is not in the level (nothing to delete).`, outputs: [], data: { actor, existed: false }, verified: true, evidence: ['the level does not list it'] };
          const ok = await toolCall(c, SCENE, 'remove_from_scene', { actor: { refPath: actor } }, sig);
          const after = await this.actorList(c, sig);
          if (after.includes(actor)) throw new AdapterError('verification-failed', `Unreal answered ${JSON.stringify(ok)} but the level still lists ${actor}.`);
          return { message: `Deleted ${actor}. Ctrl+Z in the editor brings it back.`, outputs: [], data: { actor, existed: true, actorCount: after.length }, verified: true, evidence: [`the level no longer lists it (${before.length} -> ${after.length} actors)`] };
        }
        case 'level.save': {
          await this.requireEditable(c, sig);
          const level = String(await toolCall(c, SCENE, 'get_current_level', {}, sig));
          if (!level) throw new AdapterError('app-error', 'The editor reports no open level to save.');
          const dirtyBefore = await toolCall(c, ASSETS, 'is_dirty', { asset_path: level }, sig).catch(() => null);
          await toolCall(c, ASSETS, 'save_assets', { asset_paths: [level] }, sig);
          const dirtyAfter = await toolCall(c, ASSETS, 'is_dirty', { asset_path: level }, sig);
          if (dirtyAfter !== false) throw new AdapterError('verification-failed', `Unreal still reports ${level} as having unsaved changes after saving (${JSON.stringify(dirtyAfter)}).`);
          return { message: `Saved ${level}.`, outputs: [], data: { level, dirtyBefore, dirtyAfter }, verified: true, evidence: ['the level is no longer marked as having unsaved changes'] };
        }
        case 'script.run': {
          await this.requireEditable(c, sig);
          const s = JSON.parse(String(params.script)) as { purpose: string; code: string };
          const r = await rawToolCall(c, PROGRAMMATIC, 'execute_tool_script', { script: s.code }, sig, cmd.timeoutMs ?? 300_000);
          let value: unknown = r;
          if (typeof r === 'string') { try { value = JSON.parse(r); } catch { /* plain text result */ } }
          const capped = capResult(value);
          return { message: `Script "${s.purpose.slice(0, 80)}" ran.`, outputs: [], data: { purpose: s.purpose, ...capped }, verified: false, evidence: receipt('the script returned') };
        }
      }
      throw new AdapterError('unsupported', `Unreal Engine cannot run "${cmd.id}".`);
    });
  }

  async dispose(): Promise<void> { this.app = null; this.described.clear(); this.index = null; }
}

export const unrealFactory: AdapterFactory = {
  manifest: UNREAL_MANIFEST,
  create: () => new UnrealAdapter(),
  validateJson: (commandId, param, value) => validateUnrealJson(commandId, param, value),
};

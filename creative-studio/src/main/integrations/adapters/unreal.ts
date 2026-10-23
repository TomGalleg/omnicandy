// Unreal Engine adapter (read only for now). It talks to the editor through Epic's own MCP server (the "Unreal MCP" plugin,
// Unreal 5.8+), over Streamable HTTP on this computer. That server exposes three meta tools (list_toolsets, describe_toolset,
// call_tool); every real operation is a toolset tool reached through call_tool.
//
// What Unreal itself dictates, and the adapter reports instead of hiding:
//  * The editor must be RUNNING with the Unreal MCP and toolset plugins enabled and the server started
//    (console: ModelContextProtocol.StartServer). OmniCandy never starts the editor or the server.
//  * The server has no authentication; the client refuses any endpoint that is not on this computer.
//  * Tool calls run one at a time on the editor's game thread, so each command here makes a few short, serial calls.
// Only fixed, named toolset tools are called; the commands below take no free-form tool name.

import fs from 'node:fs/promises';
import path from 'node:path';
import { ADAPTER_SDK_VERSION, type AdapterManifest, type CommandSpec, type DiscoveredApp } from '@shared/integrations';
import { McpHttpClient, McpHttpError } from '../../mcpHttpClient';
import { AdapterError, type AdapterFactory, type AdapterOutcome, type ExecuteContext, type ExternalAdapter, type HealthResult, type ProbeResult } from '../sdk';

export const UNREAL_DEFAULT_ENDPOINT = 'http://127.0.0.1:8000/mcp';

const SCENE = 'editor_toolset.toolsets.scene.SceneTools';
const ASSETS = 'editor_toolset.toolsets.asset.AssetTools';
const APP = 'EditorToolset.EditorAppToolset';
const LOGS = 'EditorToolset.LogsToolset';

const COMMANDS: CommandSpec[] = [
  {
    id: 'app.info', label: 'Check Unreal Editor',
    description: 'Connects to the editor\'s MCP server and reports the server, how many toolsets it offers, the open level and whether Play-In-Editor is running (read only).',
    params: {}, permissions: ['read-info', 'read-project'], idempotent: true, timeoutMs: 60_000,
  },
  {
    id: 'toolsets.list', label: 'List Unreal toolsets',
    description: 'Lists the toolsets the editor offers (name and one-line purpose). This is the inventory of what OmniCandy can be given control of (read only).',
    params: {}, permissions: ['read-info'], idempotent: true, timeoutMs: 60_000,
  },
  {
    id: 'toolsets.describe', label: 'Describe one Unreal toolset',
    description: 'Lists the tools of one toolset with their parameter names and a one-line description (read only).',
    params: { toolset: { type: 'string', description: 'Exact toolset name from toolsets.list, e.g. editor_toolset.toolsets.scene.SceneTools.', required: true } },
    permissions: ['read-info'], idempotent: true, timeoutMs: 60_000,
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
];

export const UNREAL_MANIFEST: AdapterManifest = {
  id: 'unreal', name: 'Unreal Engine', vendor: 'Epic Games', sdkVersion: ADAPTER_SDK_VERSION, maturity: 'experimental',
  exeNames: ['UnrealEditor.exe'], displayNames: ['^Unreal Engine'],
  versions: { min: '5.8' },
  methods: ['mcp'],
  capabilities: ['detect', 'inspectCapabilities', 'connect', 'disconnect', 'healthCheck', 'executeCommand', 'cancelOperation', 'dispose'],
  commands: COMMANDS,
  requirements: [
    { kind: 'running', text: 'Unreal Editor 5.8 or newer must be open with a project.' },
    { kind: 'preference', text: 'Enable the "Unreal MCP" and "All Toolsets" plugins (Edit > Plugins), restart, then run ModelContextProtocol.StartServer in the editor console.' },
  ],
  notes: 'Uses Epic\'s experimental built-in MCP server on this computer (default http://127.0.0.1:8000/mcp; set OMNICANDY_UNREAL_MCP_URL for another local port). OmniCandy never starts the editor or the server. This first version only reads: toolsets, the open level, assets and the log.',
};

type Obj = Record<string, unknown>;

function endpoint(): string { return process.env.OMNICANDY_UNREAL_MCP_URL || UNREAL_DEFAULT_ENDPOINT; }

/** Turns client failures into adapter failures with a message the user can act on. */
function classify(e: unknown): never {
  if (e instanceof AdapterError) throw e;
  if (e instanceof McpHttpError) {
    if (e.kind === 'unreachable') throw new AdapterError('app-error', `Unreal's MCP server is not reachable (${e.message}). Open the editor, enable the Unreal MCP and All Toolsets plugins, and run ModelContextProtocol.StartServer in its console.`);
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

/** Calls one toolset tool. The server reports some argument errors as plain text without isError, so anything that is not a
 *  {returnValue} object is treated as an error and its text is passed on. */
async function toolCall(c: McpHttpClient, toolset: string, tool: string, args: Obj, signal?: AbortSignal): Promise<unknown> {
  let r: unknown;
  try { r = await c.callTool('call_tool', { toolset_name: toolset, tool_name: tool, arguments: args }, 45_000, signal); } catch (e) {
    if (e instanceof McpHttpError && e.kind === 'tool') throw new AdapterError('app-error', `${tool}: ${e.message.slice(0, 400)}`);
    throw e;
  }
  if (r && typeof r === 'object' && 'returnValue' in (r as Obj)) return (r as Obj).returnValue;
  throw new AdapterError('app-error', `${tool}: ${(typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 400)}`);
}

async function metaText(c: McpHttpClient, tool: string, args: Obj, signal?: AbortSignal): Promise<string> {
  const r = await c.callTool(tool, args, 45_000, signal).catch((e) => {
    if (e instanceof McpHttpError && e.kind === 'tool') throw new AdapterError('app-error', `${tool}: ${e.message.slice(0, 400)}`);
    throw e;
  });
  return typeof r === 'string' ? r : JSON.stringify(r);
}

/** `- Name: description` lines (a description may continue on following lines) into entries. */
export function parseToolsetList(text: string): Array<{ name: string; summary: string }> {
  const out: Array<{ name: string; summary: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^- ([A-Za-z0-9_.]+): (.*)$/.exec(line);
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

class UnrealAdapter implements ExternalAdapter {
  private app: DiscoveredApp | null = null;

  async probe(app: DiscoveredApp): Promise<ProbeResult> {
    if (app.version) return { version: app.version, detail: 'version from the installer record' };
    // <root>/Engine/Binaries/Win64/UnrealEditor.exe -> <root>/Engine/Build/Build.version
    try {
      const j = JSON.parse(await fs.readFile(path.join(path.dirname(app.exePath), '..', '..', 'Build', 'Build.version'), 'utf8')) as { MajorVersion?: number; MinorVersion?: number; PatchVersion?: number };
      if (typeof j.MajorVersion === 'number') return { version: `${j.MajorVersion}.${j.MinorVersion ?? 0}.${j.PatchVersion ?? 0}`, detail: 'version from Engine/Build/Build.version' };
    } catch { /* fall through */ }
    return { version: null };
  }
  async connect(app: DiscoveredApp): Promise<void> { this.app = app; }
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

  async execute(cmd: CommandSpec, params: Record<string, string | number | boolean>, ctx: ExecuteContext): Promise<AdapterOutcome> {
    if (!this.app) throw new AdapterError('app-error', 'Unreal Engine is not connected.');
    const sig = ctx.signal;
    const live = ['read from the running Unreal Editor through its MCP server'];
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
          if (!/^[A-Za-z0-9_.]{1,200}$/.test(name)) throw new AdapterError('invalid-params', 'toolset must be a name from toolsets.list.');
          const text = await metaText(c, 'describe_toolset', { toolset_name: name }, sig);
          let d: { description?: string; tools?: Array<{ name?: string; description?: string; inputSchema?: { properties?: Obj; required?: string[] } }> };
          try { d = JSON.parse(text); } catch { throw new AdapterError('app-error', `describe_toolset: ${text.slice(0, 300)}`); }
          const tools = (d.tools ?? []).map((t) => ({
            name: String(t.name ?? '').slice(name.length + 1),
            summary: String(t.description ?? '').split('\n')[0]!.trim(),
            params: Object.keys(t.inputSchema?.properties ?? {}),
            required: t.inputSchema?.required ?? [],
          }));
          return { message: `${name}: ${tools.length} tools.`, outputs: [], data: { toolset: name, description: d.description ?? '', count: tools.length, tools }, verified: true, evidence: live };
        }
        case 'level.inspect': {
          const level = String(await toolCall(c, SCENE, 'get_current_level', {}, sig));
          if (!level) {
            const pie = await toolCall(c, APP, 'IsPIERunning', {}, sig);
            throw new AdapterError('app-error', pie === true
              ? 'The editor reports no open level because a Play-In-Editor session is running. Stop the play session (or press Esc in it), then try again.'
              : 'The editor reports no open level. Open a level in Unreal Editor first.');
          }
          const found = await toolCall(c, SCENE, 'find_actors', { name: '', tag: '', collision_channels: [] }, sig);
          const actors = (Array.isArray(found) ? found : []).map(refName).filter((x): x is string => x !== null).map(actorKind);
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
      }
      throw new AdapterError('unsupported', `Unreal Engine cannot run "${cmd.id}".`);
    });
  }

  async dispose(): Promise<void> { this.app = null; }
}

export const unrealFactory: AdapterFactory = { manifest: UNREAL_MANIFEST, create: () => new UnrealAdapter() };

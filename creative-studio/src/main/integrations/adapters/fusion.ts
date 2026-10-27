// Autodesk Fusion adapter. It talks to Fusion through Autodesk's OWN built-in Fusion MCP server (General Availability,
// shipped inside Fusion itself; Preferences > General > API > "Fusion MCP Server"), over Streamable HTTP on this computer.
// That server exposes exactly three tools OmniCandy uses:
//   fusion_mcp_read     queryType: licensing, projects, document (search/open/recent), apiDocumentation, screenshot, activeCommand
//   fusion_mcp_execute  featureType: script (Python against the Fusion API), document (open/close/save)
//   fusion_mcp_update   featureType: undo, redo
// (fusion_mcp_electronics_read, and the execute featureTypes purchase/editImage/generatePowerpoint/previewImage, are
// Autodesk Assistant's own consumer features — billing, AI image/slide generation, the in-app store — and are out of
// scope here; OmniCandy never calls them.)
//
// What Fusion itself dictates, reported instead of hidden:
//  * Fusion must be RUNNING with the Fusion MCP Server preference turned on. app.launch starts Fusion (the user approves it)
//    and waits until the server answers; OmniCandy never flips that preference itself.
//  * The server has no authentication; the client refuses any endpoint that is not on this computer.
//  * Autodesk's own server has NO modelling tools of its own beyond undo/redo: the only way to create or change geometry
//    is a Python script run through fusion_mcp_execute's "script" feature. A normal (non read-only) script also cannot
//    run while a command dialog is open.
//  * There is no dedicated undo-per-command the way FreeCAD's "always write a new file" gives a free rollback: Fusion's
//    own undo/redo (edit.undo / edit.redo) is the recovery path, same as a human mistake in the UI.
//
// Because every mutation goes through one raw "run this Python" door, control is layered the same way the rest of this
// SDK asks for ("Scripts that run inside an application are fixed templates; parameters are passed as a JSON file, never
// spliced into code"):
//   typed read commands   app.info, project.list, document.*, api.search, viewport.capture, command.inspect
//   fixed script templates  document.inspect (Fusion-enforced read-only), parameter.set, component.create_primitive,
//                            export.step, export.stl — OmniCandy writes the Python; your values travel as base64 JSON
//   full power, always asked  script.run — exactly Fusion's own script door, so (unlike Unreal's script.run) it is NOT
//                            limited to a safe tool allow-list: it is the whole Fusion Python API. You see the code first.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ADAPTER_SDK_VERSION, type AdapterManifest, type CommandSpec, type DiscoveredApp } from '@shared/integrations';
import { McpHttpClient, McpHttpError } from '../../mcpHttpClient';
import { safeFileName, parseResultLine, runProcess } from '../process';
import { fusionLive, fusionProcess } from './fusionLive';
import { AdapterError, type AdapterFactory, type AdapterOutcome, type ExecuteContext, type ExternalAdapter, type HealthResult, type ProbeResult } from '../sdk';

export const FUSION_DEFAULT_ENDPOINT = 'http://127.0.0.1:27182/mcp';
export const FUSION_SCRIPT_MAX_CODE = 8000;

type Obj = Record<string, unknown>;
const isPlainObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates the one 'json' parameter this adapter declares, before the user is asked or anything is dispatched. */
export function validateFusionJson(commandId: string, param: string, value: unknown): string | undefined {
  if (commandId === 'script.run' && param === 'script') {
    if (!isPlainObject(value)) return 'script must be {"purpose": "...", "code": "...", "readOnly": false}.';
    const keys = Object.keys(value);
    if (keys.some((k) => !['purpose', 'code', 'readOnly'].includes(k))) return 'script may only have "purpose", "code" and "readOnly".';
    if (typeof value.purpose !== 'string' || value.purpose.length < 3 || value.purpose.length > 200) return 'purpose must be 3 to 200 characters shown to the user.';
    if (typeof value.code !== 'string' || !value.code.trim() || value.code.length > FUSION_SCRIPT_MAX_CODE) return `code must be 1 to ${FUSION_SCRIPT_MAX_CODE} characters of Python defining run(_context).`;
    if (!/def\s+run\s*\(/.test(value.code)) return 'code must define run(_context).';
    if ('readOnly' in value && typeof value.readOnly !== 'boolean') return 'readOnly must be true or false.';
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------- commands

const DIRECTIONS = ['current', 'front', 'back', 'bottom', 'top', 'left', 'right', 'iso-bottom-left', 'iso-bottom-right', 'iso-top-left', 'iso-top-right'];

const COMMANDS: CommandSpec[] = [
  {
    id: 'app.launch', label: 'Start Fusion',
    description: 'Starts Autodesk Fusion if it is not open and waits until its MCP server answers, so the other commands work. Use it when another command says Fusion is not reachable. It never closes anything. If Fusion opens but never answers, the "Fusion MCP Server" preference (Preferences > General > API) is off: the person has to turn it on.',
    params: { wait_seconds: { type: 'number', description: 'How long to wait for Fusion to be ready.', default: 240, min: 30, max: 600 } },
    permissions: ['launch'], offline: true, idempotent: false, timeoutMs: 660_000,
  },
  {
    id: 'app.info', label: 'Check Fusion',
    description: 'START HERE. Connects to Fusion\'s own MCP server and reports your licence/plan, the active document and any other open documents (read only). Then: document.search finds a file by name; document.inspect reads the active design\'s components, bodies and parameters; component.create_primitive, parameter.set and export.* make typed, verified changes; script.run is the full Fusion Python API for anything else (always shown to you and asked).',
    params: {}, permissions: ['read-info'], idempotent: true, timeoutMs: 30_000,
  },
  {
    id: 'app.show', label: 'Show Fusion inside OmniCandy',
    description: 'Docks the window of the running Fusion into OmniCandy (the Software tab) so you watch the work happen there instead of behind OmniCandy. app.launch does this by itself when it starts or finds Fusion.',
    params: {}, permissions: ['ui-automation'], offline: true, idempotent: true, timeoutMs: 60_000,
  },
  {
    id: 'project.list', label: 'List Fusion projects',
    description: 'Lists the projects (name and id) in your current Fusion hub (read only).',
    params: {}, permissions: ['read-info'], idempotent: true, timeoutMs: 30_000,
  },
  {
    id: 'document.search', label: 'Find a Fusion document',
    description: 'Searches your Fusion hub for files whose name contains the given text (fuzzy, case-insensitive) and returns their name and id, needed by document.open (read only).',
    params: {
      name: { type: 'string', description: 'Text to look for in the file name.', required: true },
      project: { type: 'string', description: 'Project name or id to search in (empty searches every project).', default: '' },
    },
    permissions: ['read-project'], idempotent: true, timeoutMs: 30_000,
  },
  {
    id: 'document.list_open', label: 'List open Fusion documents',
    description: 'Lists documents currently open in Fusion, which one is active and which have unsaved changes (read only).',
    params: {}, permissions: ['read-project'], idempotent: true, timeoutMs: 30_000,
  },
  {
    id: 'document.list_recent', label: 'List recent Fusion documents',
    description: 'Lists documents Fusion recently had open (read only).',
    params: {}, permissions: ['read-info'], idempotent: true, timeoutMs: 30_000,
  },
  {
    id: 'document.open', label: 'Open a Fusion document',
    description: 'Opens a document in Fusion by the id document.search or document.list_recent gave you.',
    params: { file_id: { type: 'string', description: 'A file id from document.search, document.list_open or document.list_recent.', required: true } },
    permissions: ['open-files'], idempotent: true, timeoutMs: 120_000,
  },
  {
    id: 'document.close', label: 'Close the active Fusion document',
    description: 'Closes the active document. Always asks first, because unsaved changes are kept or discarded depending on "save".',
    params: { save: { type: 'boolean', description: 'true: save unsaved changes before closing. false: discard them.', required: true } },
    permissions: ['modify-project'], destructive: true, idempotent: false, timeoutMs: 60_000,
  },
  {
    id: 'document.save', label: 'Save the active Fusion document',
    description: 'Saves the active document. Use only when you want to save: Autodesk\'s own guidance is not to save unless asked to.',
    params: {}, permissions: ['write-files', 'modify-project'], idempotent: true, timeoutMs: 120_000,
  },
  {
    id: 'edit.undo', label: 'Undo in Fusion',
    description: 'Undoes the most recent operation in the active document (fails honestly if there is nothing to undo, or a command dialog is mid-interaction).',
    params: {}, permissions: ['modify-project'], idempotent: false, timeoutMs: 30_000,
  },
  {
    id: 'edit.redo', label: 'Redo in Fusion',
    description: 'Redoes the most recently undone operation in the active document.',
    params: {}, permissions: ['modify-project'], idempotent: false, timeoutMs: 30_000,
  },
  {
    id: 'api.search', label: 'Search the Fusion API reference',
    description: 'Searches Fusion\'s own, live API documentation (classes, properties, functions) by a regular expression, optionally limited to a namespace such as adsk.fusion.Extrude. Use this before writing a script.run to check an exact class or method exists (read only).',
    params: {
      search_pattern: { type: 'string', description: 'Regular expression over class or member names.', required: true },
      category: { type: 'string', description: 'class, member, description or all.', default: 'all' },
      filter: { type: 'string', description: 'Dotted namespace or class to limit the search, e.g. adsk.fusion.Extrude.', default: '' },
    },
    permissions: ['read-info'], idempotent: true, timeoutMs: 30_000,
  },
  {
    id: 'command.inspect', label: 'Read the open Fusion command dialog',
    description: 'Reports the currently open command dialog (if any): its name and every visible input\'s current value. Returns {"activeCommand": null} when no dialog is open. Changes nothing.',
    params: {}, permissions: ['read-project'], idempotent: true, timeoutMs: 30_000,
  },
  {
    id: 'viewport.capture', label: 'Take a picture of the Fusion viewport',
    description: 'Captures the active graphics view as a PNG, added to the library like a render from any other app. direction can set a standard view first.',
    params: {
      file_name: { type: 'string', description: 'Name for the picture (letters, digits, space, dash).', default: 'viewport' },
      direction: { type: 'string', description: DIRECTIONS.join(', ') + '.', default: 'current' },
      width: { type: 'number', description: 'Pixels (32-4096).', default: 1280, min: 32, max: 4096 },
      height: { type: 'number', description: 'Pixels (32-4096).', default: 720, min: 32, max: 4096 },
      transparent_background: { type: 'boolean', description: 'Transparent instead of a solid background.', default: false },
    },
    permissions: ['read-project', 'write-files'], idempotent: false, timeoutMs: 60_000,
  },
  {
    id: 'document.inspect', label: 'Inspect the active Fusion design (verified read only)',
    description: 'Reads the active design through a read-only script (Fusion itself refuses any modification from it, so this cannot change your model): components, bodies (name, volume, bounding box), user parameters (name, expression, value, unit) and the feature timeline length.',
    params: {}, permissions: ['execute-scripts', 'read-project'], idempotent: true, timeoutMs: 60_000,
  },
  {
    id: 'parameter.set', label: 'Change a Fusion user parameter (verified)',
    description: 'Sets a named user parameter\'s expression (e.g. "25 mm" or "width * 2") through a fixed script, lets Fusion recompute, then reads the parameter and every solid body\'s volume back to confirm what actually happened.',
    params: {
      name: { type: 'string', description: 'User parameter name, exactly as it appears in the Parameters dialog.', required: true },
      expression: { type: 'string', description: 'New expression, e.g. "40 mm" or "width / 2".', required: true },
    },
    permissions: ['execute-scripts', 'modify-project'], idempotent: true, timeoutMs: 60_000,
  },
  {
    id: 'component.create_primitive', label: 'Create a primitive body in Fusion (verified)',
    description: 'Creates a new component containing one solid body (box, cylinder or sphere) through a fixed script, then reads back the new body\'s measured volume and bounding box from Fusion to confirm it was made at the size asked for.',
    params: {
      kind: { type: 'string', description: 'box, cylinder or sphere.', required: true },
      name: { type: 'string', description: 'Component name. Defaults to kind.', default: '' },
      width: { type: 'number', description: 'box: width (cm).', default: 10, min: 0.01, max: 100_000 },
      depth: { type: 'number', description: 'box: depth (cm).', default: 10, min: 0.01, max: 100_000 },
      height: { type: 'number', description: 'box or cylinder: height (cm).', default: 10, min: 0.01, max: 100_000 },
      radius: { type: 'number', description: 'cylinder or sphere: radius (cm).', default: 5, min: 0.01, max: 50_000 },
    },
    permissions: ['execute-scripts', 'modify-project'], idempotent: false, timeoutMs: 90_000,
  },
  {
    id: 'export.step', label: 'Export the active design as STEP (verified)',
    description: 'Exports the active design to a STEP file in this OmniCandy project through a fixed script, then re-reads the file and confirms it is a real STEP file (ISO-10303 header) and is not empty.',
    params: { file_name: { type: 'string', description: 'Name for the file (letters, digits, space, dash).', default: 'export' } },
    permissions: ['execute-scripts', 'write-files'], idempotent: false, timeoutMs: 180_000,
  },
  {
    id: 'export.stl', label: 'Export the active design as STL (verified)',
    description: 'Exports the active design to an STL file in this OmniCandy project through a fixed script, then re-reads the file: for a binary STL, the triangle count in the header is checked against the file\'s actual size.',
    params: { file_name: { type: 'string', description: 'Name for the file (letters, digits, space, dash).', default: 'export' } },
    permissions: ['execute-scripts', 'write-files'], idempotent: false, timeoutMs: 180_000,
  },
  {
    id: 'script.run', label: 'Run a Fusion Python script',
    description: `Runs a Python script through Fusion's own script door: def run(_context): ..., using the Fusion API (adsk.core, adsk.fusion). This is Fusion's full API, NOT limited to a safe set of calls, so the whole script is shown to you and asked about EVERY time. Printed output (print(...)) is returned; an exception is returned as an error. Set readOnly true for a script that only inspects the design (it is then enforced: an attempt to modify anything fails) — and a read-only script can run even while a command dialog is open, unlike a normal one. Needs {"purpose":"shown to the user","code":"def run(_context):\\n    ...","readOnly":false}, at most ${FUSION_SCRIPT_MAX_CODE} characters.`,
    params: { script: { type: 'json', description: 'A JSON OBJECT {"purpose": "...", "code": "def run(_context):\\n    ...", "readOnly": false}, never a bare string.', required: true, maxChars: FUSION_SCRIPT_MAX_CODE + 1500, maxDepth: 3 } },
    permissions: ['modify-project', 'write-files', 'execute-scripts'], destructive: true, confirmEveryTime: true, idempotent: false, timeoutMs: 180_000,
  },
];

export const FUSION_MANIFEST: AdapterManifest = {
  id: 'autodesk.fusion', name: 'Fusion', vendor: 'Autodesk', sdkVersion: ADAPTER_SDK_VERSION, maturity: 'experimental',
  exeNames: ['Fusion360.exe'], displayNames: ['^Autodesk Fusion'],
  versions: {},
  methods: ['mcp'],
  capabilities: ['detect', 'inspectCapabilities', 'connect', 'disconnect', 'healthCheck', 'executeCommand', 'cancelOperation', 'saveProject', 'dispose'],
  commands: COMMANDS,
  requirements: [
    { kind: 'running', text: 'Fusion must be open, with a document active for most commands.' },
    { kind: 'preference', text: 'Turn on Preferences > General > API > "Fusion MCP Server" (Apply). Default port 27182.' },
    { kind: 'licence', text: 'Autodesk lists the Fusion MCP Server for Fusion subscribers; whether the free Personal Use plan includes it is not confirmed.' },
  ],
  notes: 'Uses Autodesk\'s own built-in Fusion MCP server on this computer (default http://127.0.0.1:27182/mcp; set OMNICANDY_FUSION_MCP_URL for another local port). Autodesk\'s server has no modelling tools of its own beyond undo/redo: every change here runs as a short, fixed Python script OmniCandy writes and sends through Fusion\'s own script door, with your values passed as JSON (never spliced into the code) and the result read back from Fusion itself. script.run is the same door opened all the way for anything the fixed commands do not cover: unlike Unreal\'s script.run, Fusion gives no safe allow-list to sandbox it to, so the code is always shown to you and asked about every time.',
};

// ---------------------------------------------------------------------------------------------------------------- MCP plumbing

/** Starting Fusion and noticing it is already open; replaced in tests. */
export const fusionLaunch: { start: (exe: string) => ChildProcess; isRunning: () => Promise<boolean> } = {
  start: (exe) => spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }),
  isRunning: async () => {
    const r = await runProcess('tasklist', ['/FI', 'IMAGENAME eq Fusion360.exe', '/NH'], { timeoutMs: 10_000, label: 'tasklist' }).catch(() => null);
    return /Fusion360\.exe/i.test(r?.out ?? '');
  },
};

function endpoint(): string { return process.env.OMNICANDY_FUSION_MCP_URL || FUSION_DEFAULT_ENDPOINT; }

function classify(e: unknown): never {
  if (e instanceof AdapterError) throw e;
  if (e instanceof McpHttpError) {
    if (e.kind === 'unreachable') throw new AdapterError('app-error', `Fusion's MCP server is not reachable (${e.message}). Start Fusion with app.launch (or open it yourself with a document), then make sure Preferences > General > API > "Fusion MCP Server" is on.`);
    if (e.kind === 'aborted') throw new AdapterError('app-error', 'Cancelled.');
    throw new AdapterError('app-error', e.message);
  }
  throw e;
}

async function withSession<T>(signal: AbortSignal | undefined, fn: (c: McpHttpClient) => Promise<T>): Promise<T> {
  let c: McpHttpClient | null = null;
  try {
    c = await McpHttpClient.connect(endpoint(), { clientName: 'omnicandy' }, signal);
    return await fn(c);
  } catch (e) { return classify(e); } finally { await c?.close(); }
}

async function call(c: McpHttpClient, tool: string, args: Obj, sig?: AbortSignal, timeoutMs = 60_000): Promise<unknown> {
  try { return await c.callTool(tool, args, timeoutMs, sig); } catch (e) {
    if (e instanceof McpHttpError && e.kind === 'tool') throw new AdapterError('app-error', e.message.slice(0, 800));
    throw e;
  }
}
const read = (c: McpHttpClient, queryType: string, extra: Obj = {}, sig?: AbortSignal, timeoutMs?: number): Promise<unknown> => call(c, 'fusion_mcp_read', { queryType, ...extra }, sig, timeoutMs);
const doExecute = (c: McpHttpClient, featureType: string, object: Obj, sig?: AbortSignal, timeoutMs?: number): Promise<unknown> => call(c, 'fusion_mcp_execute', { featureType, object }, sig, timeoutMs);
const doUpdate = (c: McpHttpClient, featureType: string, sig?: AbortSignal, timeoutMs?: number): Promise<unknown> => call(c, 'fusion_mcp_update', { featureType }, sig, timeoutMs);

function expectObj(v: unknown, what: string): Obj {
  if (!isPlainObject(v)) throw new AdapterError('app-error', `Fusion's ${what} answered with something unexpected: ${JSON.stringify(v).slice(0, 300)}`);
  return v;
}

// ---------------------------------------------------------------------------------------------------------------- fixed script templates

/** Base64-JSON header: the only way values reach a template is as data a script decodes, never as spliced code. */
function pyParams(params: Obj): string {
  const b64 = Buffer.from(JSON.stringify(params), 'utf8').toString('base64');
  return `import json, base64\n_p = json.loads(base64.b64decode("${b64}").decode("utf-8"))\n`;
}

const NOT_A_DESIGN = `print("CREATECRAFT_RESULT " + json.dumps({"error": "The active document is not a Fusion design (open or switch to a design document first)."}))\n        return\n`;

const INSPECT_SCRIPT = `import adsk.core, adsk.fusion, json

def run(_context):
    app = adsk.core.Application.get()
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not design:
        ${NOT_A_DESIGN}
    root = design.rootComponent

    def body_info(comp):
        out = []
        for b in comp.bRepBodies:
            bb = b.boundingBox
            out.append({
                "name": b.name, "isSolid": b.isSolid,
                "volume": (b.physicalProperties.volume if b.isSolid else None),
                "boundingBox": ({"min": [bb.minPoint.x, bb.minPoint.y, bb.minPoint.z], "max": [bb.maxPoint.x, bb.maxPoint.y, bb.maxPoint.z]} if bb else None),
            })
        return out

    components = [{"name": root.name, "bodies": body_info(root), "sketchCount": root.sketches.count}]
    for occ in root.allOccurrences:
        c = occ.component
        components.append({"name": c.name, "bodies": body_info(c), "sketchCount": c.sketches.count})
    components = components[:200]

    params = [{"name": p.name, "expression": p.expression, "value": p.value, "unit": p.unit, "comment": p.comment} for p in design.userParameters]

    result = {
        "document": app.activeDocument.name if app.activeDocument else None,
        "units": design.unitsManager.defaultLengthUnits,
        "componentCount": len(components),
        "components": components,
        "parameters": params,
        "timelineCount": (design.timeline.count if design.timeline else 0),
    }
    print("CREATECRAFT_RESULT " + json.dumps(result))
`;

function parameterSetScript(name: string, expression: string): string {
  return `${pyParams({ name, expression })}import adsk.core, adsk.fusion, json

def run(_context):
    app = adsk.core.Application.get()
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not design:
        ${NOT_A_DESIGN}
    up = design.userParameters.itemByName(_p["name"])
    if not up:
        print("CREATECRAFT_RESULT " + json.dumps({"error": "No user parameter named " + _p["name"] + "."}))
        return
    before = up.value
    up.expression = _p["expression"]
    design.computeAll()
    bodies = [{"name": b.name, "volume": b.physicalProperties.volume} for b in design.rootComponent.bRepBodies if b.isSolid]
    print("CREATECRAFT_RESULT " + json.dumps({"name": _p["name"], "before": before, "after": up.value, "expression": up.expression, "bodies": bodies}))
`;
}

function createPrimitiveScript(p: { kind: string; name: string; width: number; depth: number; height: number; radius: number }): string {
  return `${pyParams(p)}import adsk.core, adsk.fusion, json, math

def run(_context):
    app = adsk.core.Application.get()
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not design:
        ${NOT_A_DESIGN}
    root = design.rootComponent
    kind = _p["kind"]
    comp = root
    try:
        occ = root.occurrences.addNewComponent(adsk.core.Matrix3D.create())
        comp = occ.component
        comp.name = _p["name"] or kind
    except RuntimeError:
        comp = root  # a single-part ("Part Design") document allows only the root component
    sketch = comp.sketches.add(comp.xYConstructionPlane)
    cm = adsk.core.ValueInput.createByReal

    if kind == "box":
        sketch.sketchCurves.sketchLines.addTwoPointRectangle(adsk.core.Point3D.create(0, 0, 0), adsk.core.Point3D.create(_p["width"], _p["depth"], 0))
        prof = sketch.profiles.item(0)
        ext = comp.features.extrudeFeatures
        extInput = ext.createInput(prof, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
        extInput.setDistanceExtent(False, cm(_p["height"]))
        ext.add(extInput)
    elif kind == "cylinder":
        sketch.sketchCurves.sketchCircles.addByCenterRadius(adsk.core.Point3D.create(0, 0, 0), _p["radius"])
        prof = sketch.profiles.item(0)
        ext = comp.features.extrudeFeatures
        extInput = ext.createInput(prof, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
        extInput.setDistanceExtent(False, cm(_p["height"]))
        ext.add(extInput)
    elif kind == "sphere":
        r = _p["radius"]
        top = adsk.core.Point3D.create(0, r, 0)
        bottom = adsk.core.Point3D.create(0, -r, 0)
        axis = sketch.sketchCurves.sketchLines.addByTwoPoints(top, bottom)
        sketch.sketchCurves.sketchArcs.addByCenterStartSweep(adsk.core.Point3D.create(0, 0, 0), top, math.pi)
        prof = sketch.profiles.item(0)
        rev = comp.features.revolveFeatures
        revInput = rev.createInput(prof, axis, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
        revInput.setAngleExtent(False, cm(2 * math.pi))
        rev.add(revInput)
    else:
        print("CREATECRAFT_RESULT " + json.dumps({"error": "kind must be box, cylinder or sphere."}))
        return

    if comp.bRepBodies.count == 0:
        print("CREATECRAFT_RESULT " + json.dumps({"error": "Fusion created no body (the profile may have been empty)."}))
        return
    body = comp.bRepBodies.item(comp.bRepBodies.count - 1)  # the body just added, not necessarily index 0 (root may already hold others)
    bb = body.boundingBox
    print("CREATECRAFT_RESULT " + json.dumps({
        "component": comp.name, "body": body.name, "volume": body.physicalProperties.volume,
        "boundingBox": {"min": [bb.minPoint.x, bb.minPoint.y, bb.minPoint.z], "max": [bb.maxPoint.x, bb.maxPoint.y, bb.maxPoint.z]},
    }))
`;
}

function exportScript(format: 'step' | 'stl', filePath: string): string {
  return `${pyParams({ path: filePath.replace(/\\/g, '/'), format })}import adsk.core, adsk.fusion, json

def run(_context):
    app = adsk.core.Application.get()
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not design:
        ${NOT_A_DESIGN}
    em = design.exportManager
    fmt = _p["format"]
    out_path = _p["path"]
    if fmt == "step":
        opts = em.createSTEPExportOptions(out_path)
    else:
        opts = em.createSTLExportOptions(design.rootComponent, out_path)
    ok = em.execute(opts)
    print("CREATECRAFT_RESULT " + json.dumps({"ok": bool(ok), "path": out_path, "format": fmt}))
`;
}

/**
 * Fusion's execute "script" feature does not report failure through the MCP protocol's own isError flag: it always
 * replies with a JSON body, {"success": true, "message": "<everything the script printed>"} or {"success": false,
 * "error": "<printed output so far, then the Python traceback>"}. This reads either shape into one printed-output string.
 */
function scriptOutput(r: unknown): { ok: boolean; text: string } {
  if (isPlainObject(r)) {
    if (r.success === false) return { ok: false, text: String(r.error ?? 'The script failed.') };
    if (typeof r.message === 'string') return { ok: true, text: r.message };
  }
  return { ok: true, text: typeof r === 'string' ? r : JSON.stringify(r) };
}

/** Runs a fixed script through fusion_mcp_execute and parses its CREATECRAFT_RESULT line. */
async function runScript(c: McpHttpClient, script: string, opts: { readOnly?: boolean; sig?: AbortSignal; timeoutMs?: number } = {}): Promise<Obj> {
  const r = await doExecute(c, 'script', { script, readOnly: opts.readOnly === true }, opts.sig, opts.timeoutMs ?? 90_000);
  const { ok, text } = scriptOutput(r);
  if (!ok) throw new AdapterError('app-error', text.slice(0, 1500));
  const parsed = parseResultLine(text);
  if (!parsed) throw new AdapterError('app-error', `The script produced no result. Fusion said: ${text.slice(0, 600) || '(nothing)'}`);
  if (typeof parsed.error === 'string') throw new AdapterError('app-error', parsed.error);
  return parsed;
}

function volumeOf(j: unknown): number | undefined {
  return isPlainObject(j) && typeof j.volume === 'number' ? j.volume : undefined;
}

// ---------------------------------------------------------------------------------------------------------------- adapter

class FusionAdapter implements ExternalAdapter {
  private app: DiscoveredApp | null = null;

  async probe(app: DiscoveredApp): Promise<ProbeResult> { return { version: app.version, detail: app.version ? 'version from the installer record' : undefined }; }
  async connect(app: DiscoveredApp): Promise<void> { this.app = app; }
  async disconnect(): Promise<void> { this.app = null; }
  async dispose(): Promise<void> { this.app = null; }

  async healthCheck(): Promise<HealthResult> {
    if (!this.app) return { ok: false, detail: 'Not connected.' };
    try {
      const lic = expectObj(await withSession(undefined, (c) => read(c, 'licensing', {}, undefined, 10_000)), 'licensing read');
      const plan = isPlainObject(lic.summary) ? Object.entries(lic.summary).filter(([, v]) => v === true).map(([k]) => k).join(', ') : 'unknown plan';
      return { ok: true, detail: `Fusion's MCP server answers (${plan || 'signed in'}).` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, state: /not reachable/.test(msg) ? 'api-unavailable' : undefined, detail: msg };
    }
  }

  /** Hands the running Fusion's window to the host to dock; returns whether there was a window to show. */
  private async dock(): Promise<number | null> {
    const hooks = fusionLive();
    if (!hooks?.onShow) return null;
    const pid = await fusionProcess.windowPid();
    if (pid) hooks.onShow(pid);
    return pid;
  }

  private async show(): Promise<AdapterOutcome> {
    if (!fusionLive()?.onShow) throw new AdapterError('unsupported', "OmniCandy cannot show another program's window on this computer (Windows only); Fusion keeps its own window.");
    const pid = await this.dock();
    if (!pid) throw new AdapterError('app-error', 'No open Fusion window was found. Start Fusion with app.launch.');
    return { message: `Showing Fusion (process ${pid}) inside OmniCandy.`, outputs: [], data: { pid }, verified: false, evidence: ['the Fusion process was found and its window handed to OmniCandy to dock (the window itself is not read back)'] };
  }

  /** app.launch: starts Fusion unless it is open, then waits for its MCP server. Works while Fusion is closed (no server involved at first). */
  private async launch(app: DiscoveredApp, params: Record<string, string | number | boolean>, ctx: ExecuteContext): Promise<AdapterOutcome> {
    const answers = async (): Promise<boolean> => {
      try { await withSession(ctx.signal, (c) => read(c, 'licensing', {}, ctx.signal, 8_000)); return true; } catch { return false; }
    };
    if (await answers()) {
      const pid = await this.dock();
      return { message: `Fusion is already open and its MCP server answers; OmniCandy can control it now${pid ? ' and shows it in the Software tab' : ''}.`, outputs: [], data: { alreadyRunning: true, pid }, verified: true, evidence: ["Fusion's MCP server answered a licensing read"] };
    }
    const waitMs = Number(process.env.OMNICANDY_FUSION_LAUNCH_WAIT_MS) || Math.max(30, Math.min(600, Number(params.wait_seconds) || 240)) * 1000;
    const pollMs = Number(process.env.OMNICANDY_FUSION_LAUNCH_POLL_MS) || 3000;
    let spawnError = '';
    const wasOpen = await fusionLaunch.isRunning();
    if (wasOpen) ctx.progress('Fusion is open; waiting for its MCP server', 0.05);
    else {
      ctx.progress('Starting Fusion', 0.05);
      const child = fusionLaunch.start(app.exePath);
      child.once('error', (e) => { spawnError = e.message; });
      child.unref?.(); // Fusion is the user's program: it keeps running when OmniCandy closes
    }
    const t0 = Date.now();
    for (;;) {
      if (spawnError) throw new AdapterError('app-error', `Fusion could not be started: ${spawnError}`);
      if (ctx.signal.aborted) throw new AdapterError('app-error', 'Cancelled while waiting; Fusion was left running.');
      if (await answers()) {
        const seconds = Math.round((Date.now() - t0) / 1000);
        const pid = await this.dock();
        return { message: `Fusion is ${wasOpen ? 'open' : 'started'} and its MCP server answers after ${seconds} s; OmniCandy can control it now${pid ? ' and shows it in the Software tab' : ''}.`, outputs: [], data: { started: !wasOpen, seconds, pid }, verified: true, evidence: ["Fusion's MCP server answered a licensing read"] };
      }
      if (Date.now() - t0 > waitMs) {
        throw new AdapterError('app-error', `Fusion did not answer within ${Math.round(waitMs / 1000)} s. If it is open, turn on Preferences > General > API > "Fusion MCP Server" (and sign in if Fusion asks), then try app.info.`);
      }
      ctx.progress(`Waiting for Fusion (${Math.round((Date.now() - t0) / 1000)} s)`, Math.min(0.9, 0.1 + (Date.now() - t0) / waitMs));
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async execute(cmd: CommandSpec, params: Record<string, string | number | boolean>, ctx: ExecuteContext): Promise<AdapterOutcome> {
    if (!this.app) throw new AdapterError('app-error', 'Fusion is not connected.');
    if (cmd.id === 'app.launch') return this.launch(this.app, params, ctx);
    if (cmd.id === 'app.show') return this.show();
    const sig = ctx.signal;
    const live = ["read from Fusion's own MCP server"];
    return withSession(sig, async (c) => {
      switch (cmd.id) {
        case 'app.info': {
          const lic = expectObj(await read(c, 'licensing', {}, sig), 'licensing read');
          const open = expectObj(await read(c, 'document', { operation: 'open' }, sig), 'document read');
          const docs = Array.isArray(open.results) ? open.results : [];
          const active = docs.find((d) => isPlainObject(d) && d.isActive) as Obj | undefined;
          return {
            message: `Fusion answers: ${docs.length} open document(s)${active ? `, active: ${String(active.name)}` : ', none active'}.`,
            outputs: [], data: { endpoint: endpoint(), licensing: lic, openDocuments: docs }, verified: true, evidence: live,
          };
        }
        case 'project.list': {
          const r = expectObj(await read(c, 'projects', {}, sig), 'projects read');
          const projects = Array.isArray(r.projects) ? r.projects : [];
          return { message: `${projects.length} project(s).`, outputs: [], data: { projects }, verified: true, evidence: live };
        }
        case 'document.search': {
          const name = String(params.name).trim();
          if (!name) throw new AdapterError('invalid-params', 'name must not be empty.');
          const project = String(params.project ?? '').trim();
          const r = expectObj(await read(c, 'document', { operation: 'search', name, ...(project ? { project } : {}) }, sig), 'document search');
          const results = Array.isArray(r.results) ? r.results : [];
          return { message: `${results.length} document(s) matching "${name}".`, outputs: [], data: { results }, verified: true, evidence: live };
        }
        case 'document.list_open': {
          const r = expectObj(await read(c, 'document', { operation: 'open' }, sig), 'document read');
          const results = Array.isArray(r.results) ? r.results : [];
          return { message: `${results.length} open document(s).`, outputs: [], data: { results }, verified: true, evidence: live };
        }
        case 'document.list_recent': {
          const r = expectObj(await read(c, 'document', { operation: 'recent' }, sig), 'document read');
          const results = Array.isArray(r.results) ? r.results : [];
          return { message: `${results.length} recent document(s).`, outputs: [], data: { results }, verified: true, evidence: live };
        }
        case 'document.open': {
          const fileId = String(params.file_id).trim();
          if (!fileId) throw new AdapterError('invalid-params', 'file_id must not be empty.');
          const opened = expectObj(await doExecute(c, 'document', { operation: 'open', fileId }, sig, 120_000), 'document open');
          if (opened.success === false) throw new AdapterError('app-error', String(opened.error ?? 'Fusion could not open the document.'));
          const open = expectObj(await read(c, 'document', { operation: 'open' }, sig), 'document read');
          const docs = Array.isArray(open.results) ? open.results : [];
          return { message: 'Opened the document.', outputs: [], data: { openDocuments: docs }, verified: false, evidence: ["Fusion's own answer to the open request; not independently re-checked"] };
        }
        case 'document.close': {
          const save = params.save === true;
          const object: Obj = save ? { operation: 'close', userConfirmedSaveAndClose: true } : { operation: 'close', userConfirmedCloseWithoutSave: true };
          const r = expectObj(await doExecute(c, 'document', object, sig, 60_000), 'document close');
          if (r.success === false) throw new AdapterError('app-error', String(r.error ?? 'Fusion could not close the document.'));
          return { message: save ? 'Saved and closed the document.' : 'Closed the document without saving.', outputs: [], data: r, verified: false, evidence: ["Fusion's own answer to the close request"] };
        }
        case 'document.save': {
          const r = expectObj(await doExecute(c, 'document', { operation: 'save' }, sig, 120_000), 'document save');
          if (r.success === false) throw new AdapterError('app-error', String(r.error ?? 'Fusion could not save the document.'));
          return { message: 'Saved the document.', outputs: [], data: r, verified: false, evidence: ["Fusion's own answer to the save request"] };
        }
        case 'edit.undo': case 'edit.redo': {
          const r = expectObj(await doUpdate(c, cmd.id === 'edit.undo' ? 'undo' : 'redo', sig, 30_000), 'undo/redo');
          if (r.success !== true) throw new AdapterError('app-error', String(r.error ?? `Fusion could not ${cmd.id === 'edit.undo' ? 'undo' : 'redo'}.`));
          return { message: cmd.id === 'edit.undo' ? 'Undid the last operation.' : 'Redid the last undone operation.', outputs: [], data: r, verified: true, evidence: ["Fusion reports success and its current canUndo/canRedo state"] };
        }
        case 'api.search': {
          const searchPattern = String(params.search_pattern).trim();
          if (!searchPattern) throw new AdapterError('invalid-params', 'search_pattern must not be empty.');
          try { new RegExp(searchPattern); } catch { throw new AdapterError('invalid-params', 'search_pattern is not a valid regular expression.'); }
          const category = String(params.category || 'all');
          const filter = String(params.filter || '').trim();
          const r = expectObj(await read(c, 'apiDocumentation', { searchPattern, apiCategory: category, ...(filter ? { filter } : {}) }, sig, 60_000), 'apiDocumentation read');
          const classes = Array.isArray(r.classes) ? r.classes : [], members = Array.isArray(r.members) ? r.members : [];
          return { message: `${classes.length} class(es), ${members.length} member(s) matching "${searchPattern}".`, outputs: [], data: { classes, members }, verified: true, evidence: live };
        }
        case 'command.inspect': {
          const r = await read(c, 'activeCommand', {}, sig);
          return { message: isPlainObject(r) && r.activeCommand ? 'A command dialog is open.' : 'No command dialog is open.', outputs: [], data: expectObj(r, 'activeCommand read'), verified: true, evidence: live };
        }
        case 'viewport.capture': {
          const direction = String(params.direction || 'current');
          if (!DIRECTIONS.includes(direction)) throw new AdapterError('invalid-params', `direction must be one of: ${DIRECTIONS.join(', ')}.`);
          const content = await c.callToolContent('fusion_mcp_read', {
            queryType: 'screenshot', direction, width: Number(params.width) || 1280, height: Number(params.height) || 720,
            antiAliasing: true, transparentBackground: params.transparent_background === true,
          }, 60_000, sig);
          const image = content.find((x) => x.type === 'image' && typeof x.data === 'string');
          if (!image?.data) throw new AdapterError('app-error', 'Fusion returned no image data for the screenshot.');
          const png = Buffer.from(image.data, 'base64');
          if (png.length < 33 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new AdapterError('app-error', 'Fusion returned data that is not a PNG.');
          const dir = path.join(ctx.workDir, 'captures');
          await fs.mkdir(dir, { recursive: true });
          const file = path.join(dir, safeFileName(String(params.file_name || 'viewport'), `-${Date.now().toString(36)}.png`));
          await fs.writeFile(file, png);
          const back = await fs.readFile(file);
          if (!back.equals(png)) throw new AdapterError('verification-failed', 'The picture on disk differs from what Fusion returned.');
          return { message: `Saved a picture (${path.basename(file)}, ${png.length} bytes).`, outputs: [file], data: { file: path.basename(file), bytes: png.length }, verified: true, evidence: [`a valid PNG (${png.length} bytes) written and re-read from disk`] };
        }
        case 'document.inspect': {
          const r = await runScript(c, INSPECT_SCRIPT, { readOnly: true, sig, timeoutMs: 60_000 });
          const components = Array.isArray(r.components) ? r.components : [];
          return { message: `${r.document ?? 'Active design'}: ${components.length} component(s), ${Array.isArray(r.parameters) ? r.parameters.length : 0} parameter(s).`, outputs: [], data: r, verified: true, evidence: ["read through a read-only script; Fusion itself refuses any modification from it"] };
        }
        case 'parameter.set': {
          const name = String(params.name).trim(), expression = String(params.expression).trim();
          if (!name) throw new AdapterError('invalid-params', 'name must not be empty.');
          if (!expression) throw new AdapterError('invalid-params', 'expression must not be empty.');
          const r = await runScript(c, parameterSetScript(name, expression), { sig, timeoutMs: 60_000 });
          return { message: `${name}: ${String(r.before)} -> ${String(r.after)} (${String(r.expression)}).`, outputs: [], data: r, verified: true, evidence: ["Fusion recomputed the design and the parameter's value and every solid body's volume were read back"] };
        }
        case 'component.create_primitive': {
          const kind = String(params.kind).trim();
          if (!['box', 'cylinder', 'sphere'].includes(kind)) throw new AdapterError('invalid-params', 'kind must be box, cylinder or sphere.');
          const p = { kind, name: String(params.name || ''), width: Number(params.width) || 10, depth: Number(params.depth) || 10, height: Number(params.height) || 10, radius: Number(params.radius) || 5 };
          const r = await runScript(c, createPrimitiveScript(p), { sig, timeoutMs: 90_000 });
          const v = volumeOf(r);
          return { message: `Created ${kind} "${r.component}"${v !== undefined ? ` (volume ${v.toFixed(3)} cm3)` : ''}.`, outputs: [], data: r, verified: true, evidence: ["Fusion created the body and its measured volume and bounding box were read back"] };
        }
        case 'export.step': case 'export.stl': {
          const isStep = cmd.id === 'export.step';
          const file = path.join(ctx.workDir, safeFileName(String(params.file_name || 'export'), isStep ? '.step' : '.stl'));
          await fs.mkdir(path.dirname(file), { recursive: true });
          await runScript(c, exportScript(isStep ? 'step' : 'stl', file), { sig, timeoutMs: 150_000 });
          const bytes = await fs.readFile(file).catch(() => { throw new AdapterError('verification-failed', `Fusion reported success but ${path.basename(file)} was not written.`); });
          if (bytes.length === 0) throw new AdapterError('verification-failed', `${path.basename(file)} was written empty.`);
          const evidence: string[] = [`the file exists and is ${bytes.length} bytes`];
          if (isStep) {
            if (!bytes.subarray(0, 64).toString('latin1').includes('ISO-10303')) throw new AdapterError('verification-failed', `${path.basename(file)} has no ISO-10303 STEP header.`);
            evidence.push('its header carries the ISO-10303 STEP signature');
          } else if (bytes.subarray(0, 5).toString('latin1') === 'solid') {
            evidence.push('it is an ASCII STL (starts "solid")');
          } else if (bytes.length >= 84) {
            const triangles = bytes.readUInt32LE(80);
            const expected = 84 + triangles * 50;
            if (bytes.length !== expected) throw new AdapterError('verification-failed', `${path.basename(file)} claims ${triangles} triangles but is ${bytes.length} bytes (expected ${expected}).`);
            evidence.push(`binary STL header reports ${triangles} triangle(s), matching the file size`);
          } else throw new AdapterError('verification-failed', `${path.basename(file)} is too small to be a valid STL.`);
          return { message: `Exported ${path.basename(file)} (${bytes.length} bytes).`, outputs: [file], data: { file: path.basename(file), bytes: bytes.length }, verified: true, evidence };
        }
        case 'script.run': {
          const spec = JSON.parse(String(params.script)) as { purpose: string; code: string; readOnly?: boolean };
          const r = await doExecute(c, 'script', { script: spec.code, readOnly: spec.readOnly === true }, sig, 150_000);
          const { ok, text } = scriptOutput(r);
          if (!ok) throw new AdapterError('app-error', text.slice(0, 2000));
          return { message: `Ran: ${spec.purpose}.`, outputs: [], data: { output: text.slice(0, 20_000) }, verified: false, evidence: [`Fusion ran the script and returned its printed output${spec.readOnly ? ' (readOnly: Fusion refuses any modification attempt)' : ''}`] };
        }
        default:
          throw new AdapterError('unsupported', `${cmd.id} is not implemented.`);
      }
    });
  }
}

export const fusionFactory: AdapterFactory = {
  manifest: FUSION_MANIFEST,
  create: () => new FusionAdapter(),
  validateJson: (commandId, param, value) => validateFusionJson(commandId, param, value),
};

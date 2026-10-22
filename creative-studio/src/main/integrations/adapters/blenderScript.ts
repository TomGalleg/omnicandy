// script.run command spec and its fixed Python templates (see blenderScriptSpec.ts for the model). The user's code is DATA in the
// parameter file; the templates below are the only code the adapter ever writes.

import type { CommandSpec } from '@shared/integrations';
import { SCRIPT_MAX_CODE, SCRIPT_PARAM_MAX_CHARS, SCRIPT_PARAM_MAX_DEPTH } from './blenderScriptSpec';

export const SCRIPT_COMMAND: CommandSpec = {
  id: 'script.run', label: 'Run a Blender Python script', destructive: true, confirmEveryTime: true, timeoutMs: 600_000,
  permissions: ['launch', 'open-files', 'read-project', 'modify-project', 'write-files', 'execute-scripts'],
  description: `Runs a Python script (bpy / bmesh / mathutils) in Blender for anything the typed commands cannot do: armatures and rigging, geometry nodes, simulations, UV unwrapping, curves, shape keys, drivers, importing assets. The user approves EVERY run after reading the exact code. It runs on a copy of the project; if it fails nothing changes. On success a backup is kept and the saved project is replaced; the open Blender window reloads it (unsaved hand edits are saved first). Do NOT use it for towers, walls, roofs, boxes, cylinders, cones or other ordinary shapes: scene.build makes those, without a script. Use script.run only for what scene.build cannot do. Only bpy, bmesh, bpy_extras, mathutils, math, random, itertools, collections, functools, colorsys, json, re, typing and dataclasses can be imported; no files, processes or network. Set a variable named result to a small JSON value to get it back. Not idempotent: read the result back with scene.inspect_detail (and the viewport, when available) before claiming success.`,
  params: {
    file_name: { type: 'string', description: 'Name of an existing .blend file in the Blender folder.', required: true },
    script: { type: 'json', description: `A JSON OBJECT with two text fields, never a bare string of code: {"purpose": "what this script is for (shown to the user)", "code": "the Python source, at most ${SCRIPT_MAX_CODE} characters"}. Example: {"purpose":"Add a two-bone rig","code":"import bpy\narm = bpy.data.armatures.new('Rig')"}.`, required: true, maxChars: SCRIPT_PARAM_MAX_CHARS, maxDepth: SCRIPT_PARAM_MAX_DEPTH },
  },
};

/** Runs inside a background Blender that has opened the COPY. The code never becomes part of this text. */
export const SCRIPT_RUN_BODY = String.raw`
bpy.ops.wm.open_mainfile(filepath=_p['input'])
def _script_run():
    import ast, builtins, traceback
    from mathutils import Vector, Matrix, Euler, Quaternion
    R = _p['rules']
    code = _p['code']
    allowed = set(R['allowed_modules'])
    bad_names = set(R['forbidden_names'])
    bad_attrs = set(R['forbidden_attrs'])
    def refuse(node, why):
        raise SystemExit('invalid parameter - script_refused: line ' + str(getattr(node, 'lineno', '?')) + ': ' + why + '. Nothing was changed.')
    try:
        tree = ast.parse(code, '<omnicandy-script>')
    except SyntaxError as ex:
        raise SystemExit('invalid parameter - script_syntax: line ' + str(ex.lineno) + ': ' + str(ex.msg) + '. Nothing was changed.')
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name.split('.')[0] not in allowed:
                    refuse(node, 'module ' + a.name + ' is not available')
        elif isinstance(node, ast.ImportFrom):
            if node.level or (node.module or '').split('.')[0] not in allowed:
                refuse(node, 'module ' + str(node.module) + ' is not available')
        elif isinstance(node, ast.Name):
            if node.id in bad_names or (node.id.startswith('__') and node.id.endswith('__')):
                refuse(node, 'the name ' + node.id + ' is not available')
        elif isinstance(node, ast.Attribute):
            if node.attr in bad_attrs or (node.attr.startswith('__') and node.attr.endswith('__')):
                refuse(node, 'the attribute ' + node.attr + ' is not available')
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value.startswith('__') and node.value.endswith('__') and len(node.value) > 4:
                refuse(node, 'double-underscore names are not available')
    safe = dict((k, v) for k, v in vars(builtins).items() if k not in bad_names and k != '__import__' and k != '__loader__')
    def _imp(name, globals=None, locals=None, fromlist=(), level=0):
        if level or name.split('.')[0] not in allowed:
            raise ImportError('module ' + name + ' is not available to scripts')
        return builtins.__import__(name, globals, locals, fromlist, level)
    safe['__import__'] = _imp
    g = {'__builtins__': safe, '__name__': 'omnicandy_script', 'bpy': bpy, 'bmesh': bmesh, 'math': math, 'Vector': Vector, 'Matrix': Matrix, 'Euler': Euler, 'Quaternion': Quaternion}
    try:
        exec(compile(tree, '<omnicandy-script>', 'exec'), g)
    except SystemExit:
        raise
    except BaseException as ex:
        lines = [l.strip() for l in traceback.format_exc().splitlines()]
        mine = [l for l in lines if 'omnicandy-script' in l][-2:]
        raise SystemExit('script_error: ' + type(ex).__name__ + ': ' + str(ex)[:300] + (' (' + ' | '.join(mine) + ')' if mine else '') + '. The project was not changed.')
    out = None
    try:
        r = g.get('result')
        if r is not None:
            txt = json.dumps(r)
            out = json.loads(txt) if len(txt) <= 4000 else {'truncated': True, 'chars': len(txt)}
    except Exception:
        out = {'unserializable': True}
    bpy.context.view_layer.update()
    bpy.ops.wm.save_as_mainfile(filepath=_p['input'], check_existing=False)
    _result({'result': out, 'objects': len(bpy.data.objects), 'armatures': len(bpy.data.armatures), 'meshes': len(bpy.data.meshes)})
_script_run()
`;

/** Open window only: write what the window holds to the project so hand edits are in the file the script starts from. */
export const SCRIPT_WINDOW_SAVE_BODY = String.raw`
if _same_file(_p['input']):
    _safe_save(_p['input'])
_result({'saved': _same_file(_p['input'])})
`;

/**
 * Open window only: pick up the replaced project without touching the user's layout. The reload itself is done by the window's
 * listener OUTSIDE the script's context override (opening a file inside it can close the window): this body carries the open
 * call the listener recognises, and the adapter asks for a forced reload.
 */
export const SCRIPT_WINDOW_RELOAD_BODY = String.raw`
bpy.ops.wm.open_mainfile(filepath=_p['input'])
_result({'reloaded': True})
`;

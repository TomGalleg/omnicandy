// Blender batch modeling: discover.search (what can I ask for?), scene.build (make many objects from a strict spec,
// idempotently) and scene.inspect_detail (read the saved project back). Like every other Blender command these are FIXED
// Python templates: the spec travels in a JSON file, is validated twice (blenderBatchSpec.ts, then against Blender's own
// runtime schema) and is never spliced into code. Geometry uses bmesh and bpy.data, not context-sensitive bpy.ops.
//
// scene.build is transactional at the project-file level:
//   1. validate the whole spec and every reference BEFORE changing anything;
//   2. build in memory with an undo log (a failure puts the open scene back);
//   3. stamp each object with a stable cc_id and record the chunk in the batch ledger (a scene property inside the .blend);
//   4. write a temporary copy, check it, keep Blender's usual previous-version backup (.blend1), then replace the project file
//      in one step. A crash leaves either the old file or the new one, never half of a batch.

import type { CommandSpec, ParamSpec } from '@shared/integrations';
import { BATCH_ID, BUILD_SPEC_MAX_CHARS, BUILD_SPEC_MAX_DEPTH, LIGHT_TYPES, MAX_BATCH_OBJECTS, MESH_KINDS, MODIFIERS, OTHER_KINDS, POINTER_PROPS } from './blenderBatchSpec';

const FILE: ParamSpec = { type: 'string', description: 'Name of an existing .blend file in the Blender folder (see scene.create_basic / scene.inspect).', required: true };
const text = (description: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ type: 'string', description, ...extra });
const EDIT: CommandSpec['permissions'] = ['launch', 'open-files', 'read-project', 'modify-project', 'write-files', 'execute-scripts'];

export const BATCH_COMMANDS: CommandSpec[] = [
  {
    id: 'discover.search', label: 'Search Blender commands and modeling vocabulary', permissions: ['launch', 'execute-scripts'], idempotent: true, timeoutMs: 120_000,
    description: 'Searches what scene.build can make (primitives, modifiers, materials, lights) against the running Blender version, and lists bpy.ops entries for reference only (informational: scene.build never runs bpy.ops). Give name for one item\'s full parameter schema; name "spec" returns the scene.build grammar with an example.',
    params: {
      kind: text('primitives, modifiers, materials, lights, operators or all.', { default: 'all' }),
      query: text('Words to search for (case-insensitive).'),
      name: text('Exact item name (or bpy.ops id such as mesh.primitive_cube_add) for its full schema.'),
      limit: { type: 'number', description: 'Most results to list.', default: 12, min: 1, max: 40 },
    },
  },
  {
    id: 'scene.inspect_detail', label: 'Read back a Blender project in detail', permissions: ['launch', 'open-files', 'read-project', 'execute-scripts'], idempotent: true, timeoutMs: 120_000,
    description: 'Opens the SAVED .blend file in a fresh background Blender (never the open window) and reports its identity, every object\'s cc_id, transforms, world bounding box, vertex/face counts, materials, modifiers, parent and collections, plus the batch ledger. Use ids / batch_id to focus; it is the read-back that proves a scene.build.',
    params: {
      file_name: FILE,
      ids: text('Comma-separated cc_ids to list first (up to 64).'),
      batch_id: text('Report this batch\'s ledger state and which of ids exist.'),
      chunk: { type: 'number', description: 'Chunk index of batch_id (default 0).', default: 0, min: 0, max: 63 },
      max_objects: { type: 'number', description: 'Most objects to list in detail.', default: 60, min: 1, max: 200 },
    },
  },
  {
    id: 'scene.build', label: 'Build many objects from a validated scene spec', permissions: EDIT, timeoutMs: 300_000,
    description: `Creates or updates up to ${MAX_BATCH_OBJECTS} objects in one saved step from a strict spec (see discover.search name "spec"). Every object has a stable id (cc_id); repeating the same batch_id + chunk with the same spec does nothing, with a different spec it is refused. Larger scenes: several calls with the same batch_id and chunk {index,total}. The spec is checked before anything changes and the project file is replaced atomically.`,
    params: {
      file_name: FILE,
      spec: { type: 'json', description: 'The scene spec: {batch_id, chunk?, objects:[{id, kind, name?, collection?, parent_id?, loc?, rot_deg?, scale?, shape?, origin?, smooth?, material?, modifiers?, light?, camera?}], scene?}.', required: true, maxChars: BUILD_SPEC_MAX_CHARS, maxDepth: BUILD_SPEC_MAX_DEPTH },
    },
  },
];

/** Static facts the fixed Python needs (single source of truth with the TypeScript schema). */
export const BATCH_VOCAB = {
  modifiers: Object.fromEntries(Object.entries(MODIFIERS).map(([k, v]) => [k, { type: v.type, rna: v.rna }])),
  pointers: POINTER_PROPS,
  mesh: { box: 'create_cube', uv_sphere: 'create_uvsphere', ico_sphere: 'create_icosphere', cylinder: 'create_cone', cone: 'create_cone', plane: 'create_grid', circle: 'create_circle', monkey: 'create_monkey' } as Record<string, string>,
};

const SHAPE_DOCS: Record<string, string> = {
  size: 'metres: one number or [x,y,z] (default 1)', radius: 'metres (default 0.5)', radius2: 'top radius for cone (default 0)', depth: 'height in metres (default 1)',
  segments: '3-128 (default 16; uv_sphere 32)', rings: '3-64 (default 16)', subdivisions: '1-4 (default 2)',
};

export const SPEC_GRAMMAR = {
  summary: `scene.build spec. Up to ${MAX_BATCH_OBJECTS} objects per call. Ids: ${BATCH_ID.source}. Transforms are local to the parent (metres, degrees). origin "base" puts the bottom of a mesh at its location.`,
  top: { batch_id: 'required id for this build', chunk: '{index,total} when one scene needs several calls (same batch_id, same total)', project_id: 'optional: refuse if the file has a different project_id', objects: 'required list', scene: '{camera_id}' },
  object: { id: 'required stable id', kind: [...Object.keys(MESH_KINDS), ...OTHER_KINDS], name: 'display name (Blender may add .001 if taken)', collection: 'collection name (created if missing)', parent_id: 'id of another object (this spec or an earlier chunk)', loc: '[x,y,z]', rot_deg: '[x,y,z]', scale: 'number or [x,y,z]', shape: 'per kind, see discover name=<kind>', origin: 'center|base', smooth: 'bool', material: '{name?,color #rrggbb,metallic,roughness,alpha,emission_color,emission_strength}', modifiers: '[{type, props}] see discover kind=modifiers', light: '{type: point|sun|spot|area, energy?, color?}', camera: '{lens?,clip_start?,clip_end?}' },
  example: {
    batch_id: 'castle-1', objects: [
      { id: 'tower-a', kind: 'cylinder', loc: [4, 4, 0], origin: 'base', shape: { radius: 1.2, depth: 6, segments: 24 }, material: { name: 'stone', color: '#8a8d91', roughness: 0.9 }, collection: 'Castle' },
      { id: 'roof-a', kind: 'cone', parent_id: 'tower-a', loc: [0, 0, 6], origin: 'base', shape: { radius: 1.5, depth: 2 }, material: { name: 'tile', color: '#9b2d20' } },
    ],
  },
  rules: ['The same batch_id+chunk with identical content is a no-op; different content is refused (use a new batch_id).', 'An id belongs to the batch that created it.', 'Read the result back with scene.inspect_detail before claiming success.'],
};

// ---------------------------------------------------------------------------------------------------------------------
// Python (fixed templates; no code is ever built from input)

export const BATCH_PRELUDE = String.raw`
import os, sys, json, uuid, shutil, datetime
import bmesh
from mathutils import Vector
def _fin(x):
    try:
        x = float(x)
    except Exception:
        return None
    return x if math.isfinite(x) else None
def _r(v, n=4):
    return [round(float(a), n) for a in v]
def _same_file(path):
    cur = os.path.normcase(os.path.realpath(bpy.data.filepath)) if bpy.data.filepath else ''
    return cur == os.path.normcase(os.path.realpath(path))
def _fault(point):
    # Test seam (set through CREATECRAFT_BATCH_FAULT, passed in by the adapter): lets the automated tests stop Blender at a
    # precise moment to prove recovery. It can only abort: 'point' ends the process, 'raise_<point>' raises an error.
    f = _p.get('fault')
    if f == point:
        sys.stdout.flush()
        os._exit(9)
    if f == 'raise_' + point:
        raise RuntimeError('injected fault at ' + point)
def _ledger_load(sc):
    empty = {'v': 1, 'entries': {}}
    raw = sc.get('cc_ledger')
    if raw is None:
        return empty, None
    try:
        led = json.loads(str(raw))
    except Exception:
        return empty, 'the ledger is not valid JSON'
    if not isinstance(led, dict) or led.get('v') != 1 or not isinstance(led.get('entries'), dict):
        return empty, 'the ledger has an unexpected structure'
    for k, e in led['entries'].items():
        ok = isinstance(e, dict) and isinstance(e.get('batch'), str) and isinstance(e.get('chunk'), int) and isinstance(e.get('total'), int) and isinstance(e.get('hash'), str) and len(e['hash']) == 64 and isinstance(e.get('ids'), list)
        if not ok or k != e['batch'] + '#' + str(e['chunk']):
            return empty, 'ledger entry ' + str(k) + ' is damaged'
    return led, None
def _rna_props(cls, pointers):
    out = []
    for p in cls.bl_rna.properties:
        k = p.identifier
        if k in ('rna_type', 'name', 'type') or p.is_readonly:
            continue
        t = p.type
        if t == 'POINTER':
            tgt = [a for a, b in pointers.items() if b == k]
            if tgt:
                out.append({'key': tgt[0], 'type': 'object_id'})
            continue
        if t not in ('BOOLEAN', 'INT', 'FLOAT', 'ENUM'):
            continue
        d = {'key': k, 'type': t.lower()}
        if t == 'ENUM':
            if p.is_enum_flag:
                continue
            d['values'] = [i.identifier for i in p.enum_items]
            d['default'] = p.default
        else:
            if p.is_array:
                if len(p.array_dimensions) > 1:
                    continue
                d['len'] = p.array_length
                d['default'] = [_fin(a) for a in p.default_array]
            else:
                d['default'] = p.default if t == 'BOOLEAN' else _fin(p.default)
            if t != 'BOOLEAN':
                d['min'] = _fin(p.hard_min)
                d['max'] = _fin(p.hard_max)
        out.append(d)
    return out
def _mat_read(m):
    st = {'diffuse': tuple(m.diffuse_color), 'metallic': m.metallic, 'roughness': m.roughness, 'inputs': {}}
    b = m.node_tree.nodes.get('Principled BSDF') if m.use_nodes and m.node_tree else None
    if b:
        for k in ('Base Color', 'Metallic', 'Roughness', 'Alpha', 'Emission Color', 'Emission', 'Emission Strength'):
            if k in b.inputs:
                v = b.inputs[k].default_value
                st['inputs'][k] = tuple(v) if hasattr(v, '__len__') else v
    return st
def _mat_restore(m, st):
    m.diffuse_color = st['diffuse']
    m.metallic = st['metallic']
    m.roughness = st['roughness']
    b = m.node_tree.nodes.get('Principled BSDF') if m.use_nodes and m.node_tree else None
    if b:
        for k, v in st['inputs'].items():
            b.inputs[k].default_value = v
def _mat_set(m, d):
    b = m.node_tree.nodes.get('Principled BSDF') if m.use_nodes and m.node_tree else None
    if d.get('color'):
        c = _hex(d['color'])
        m.diffuse_color = c
        if b: _input(b, ['Base Color'], c)
    if d.get('metallic') is not None:
        m.metallic = float(d['metallic'])
        if b: _input(b, ['Metallic'], float(d['metallic']))
    if d.get('roughness') is not None:
        m.roughness = float(d['roughness'])
        if b: _input(b, ['Roughness'], float(d['roughness']))
    if d.get('alpha') is not None:
        c = tuple(m.diffuse_color)
        m.diffuse_color = (c[0], c[1], c[2], float(d['alpha']))
        if b: _input(b, ['Alpha'], float(d['alpha']))
        try:
            m.blend_method = 'BLEND' if float(d['alpha']) < 1 else 'OPAQUE'
        except Exception:
            pass
    if d.get('emission_color') and b:
        _input(b, ['Emission Color', 'Emission'], _hex(d['emission_color']))
    if d.get('emission_strength') is not None and b:
        _input(b, ['Emission Strength'], float(d['emission_strength']))
def _stale_temps(path):
    d = os.path.dirname(os.path.abspath(path))
    stem = os.path.splitext(os.path.basename(path))[0]
    for f in os.listdir(d):
        if f.startswith('.cc-' + stem + '-') and f.endswith('.tmp.blend'):
            try:
                os.remove(os.path.join(d, f))
            except Exception:
                pass
def _safe_save(path):
    # Blender's own save is not transactional. Write a temporary copy, check it, keep the previous version as Blender
    # does (.blend1), then replace the project in one step: a crash leaves the old file or the new one, never a mix.
    path = os.path.abspath(path)
    d = os.path.dirname(path)
    stem = os.path.splitext(os.path.basename(path))[0]
    tmp = os.path.join(d, '.cc-' + stem + '-' + uuid.uuid4().hex[:8] + '.tmp.blend')
    try:
        bpy.ops.wm.save_as_mainfile(filepath=tmp, copy=True, check_existing=False)
        _fault('tmp_written')
        if not os.path.isfile(tmp) or os.path.getsize(tmp) < 1024:
            raise RuntimeError('the temporary copy was not written')
        with open(tmp, 'rb') as fh:
            head = fh.read(12)
        if not (head.startswith(b'BLENDER') or head[:4] == bytes([0x28, 0xB5, 0x2F, 0xFD]) or head[:2] == bytes([0x1F, 0x8B])):
            raise RuntimeError('the temporary copy is not a Blender file')
        if os.path.isfile(path):
            shutil.copy2(path, path + '1')
        os.replace(tmp, path)
    finally:
        if os.path.isfile(tmp):
            try:
                os.remove(tmp)
            except Exception:
                pass
`;

const DISCOVER_BODY = String.raw`
def _discover():
    V = _p['vocab']
    out = {'blender': bpy.app.version_string}
    en = set(i.identifier for i in bpy.types.Modifier.bl_rna.properties['type'].enum_items)
    mods = {}
    for name, m in V['modifiers'].items():
        cls = getattr(bpy.types, m['rna'], None)
        ok = cls is not None and m['type'] in en
        mods[name] = {'available': ok, 'props': _rna_props(cls, V['pointers']) if ok else []}
    out['modifiers'] = mods
    out['bmesh_ops'] = sorted(set(n for n in dir(bmesh.ops) if n.startswith('create_')))
    q = str(_p.get('ops_query') or '').lower()
    nm = str(_p.get('op_name') or '')
    if _p.get('want_ops'):
        cats = [c for c in dir(bpy.ops) if not c.startswith('_')]
        if nm and '.' in nm:
            cat, op = nm.split('.', 1)
            try:
                rna = getattr(getattr(bpy.ops, cat), op).get_rna_type()
                props = []
                for p in rna.properties:
                    if p.identifier == 'rna_type':
                        continue
                    props.append({'key': p.identifier, 'type': p.type.lower(), 'description': (p.description or '')[:80]})
                out['op'] = {'id': nm, 'description': rna.description, 'props': props[:30]}
            except Exception:
                out['op'] = None
        names = []
        for c in cats:
            try:
                ops = [o for o in dir(getattr(bpy.ops, c)) if not o.startswith('_')]
            except Exception:
                ops = []
            for o in ops:
                if not q or q in (c + '.' + o).lower():
                    names.append(c + '.' + o)
        out['ops_total'] = len(names)
        out['ops'] = names[:60]
    _result(out)
_discover()
`;

const INSPECT_BODY = String.raw`
def _inspect_detail():
    bpy.context.view_layer.update()
    sc = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    led, err = _ledger_load(sc)
    want = [str(x) for x in (_p.get('ids') or [])]
    batch_id = _p.get('batch_id') or None
    chunk = int(_p.get('chunk') or 0)
    limit = int(_p.get('max_objects') or 60)
    objs = list(bpy.data.objects)
    ccmap = {}
    for o in objs:
        cid = o.get('cc_id')
        if cid:
            ccmap.setdefault(str(cid), o)
    cc_ids = sorted(ccmap.keys())
    def rank(o):
        cid = str(o.get('cc_id') or '')
        if cid and cid in want: return 0
        if cid and batch_id and str(o.get('cc_batch') or '') == batch_id: return 1
        return 2 if cid else 3
    ordered = sorted(objs, key=lambda o: (rank(o), o.name))
    def detail(o):
        ev = o.evaluated_get(dg)
        if o.type in ('MESH', 'CURVE', 'SURFACE', 'META', 'FONT'):
            pts = [ev.matrix_world @ Vector(c) for c in ev.bound_box]
        else:
            pts = [ev.matrix_world.translation.copy()]
        lo = [min(p[i] for p in pts) for i in range(3)]
        hi = [max(p[i] for p in pts) for i in range(3)]
        d = {'id': str(o.get('cc_id')) if o.get('cc_id') else None, 'name': o.name, 'type': o.type,
             'location': _r(o.location), 'rotation_deg': [round(math.degrees(v), 2) for v in o.rotation_euler], 'scale': _r(o.scale), 'size': _r(o.dimensions),
             'bbox_min': _r(lo), 'bbox_max': _r(hi)}
        if o.get('cc_batch'): d['batch'] = str(o.get('cc_batch'))
        if o.type == 'MESH':
            d['verts'] = len(o.data.vertices)
            d['faces'] = len(o.data.polygons)
        if getattr(o.data, 'materials', None) is not None:
            d['materials'] = [{'name': m.name, 'color': [round(v, 3) for v in m.diffuse_color], 'metallic': round(m.metallic, 3), 'roughness': round(m.roughness, 3)} for m in o.data.materials if m]
        if o.modifiers:
            d['modifiers'] = [{'name': m.name, 'type': m.type} for m in o.modifiers]
        if o.parent:
            d['parent'] = o.parent.name
            d['parent_id'] = str(o.parent.get('cc_id')) if o.parent.get('cc_id') else None
        d['collections'] = [c.name for c in o.users_collection]
        return d
    entries = []
    for k, e in sorted(led['entries'].items())[:100]:
        item = {'batch': e['batch'], 'chunk': e['chunk'], 'total': e['total'], 'hash': e['hash'], 'n': len(e['ids']), 'at': e.get('at')}
        if batch_id and e['batch'] == batch_id:
            item['ids'] = [str(i) for i in e['ids']][:64]
        entries.append(item)
    data = {'project': {'file': os.path.basename(bpy.data.filepath), 'project_id': sc.get('cc_project_id'), 'scene': sc.name,
                        'file_bytes': os.path.getsize(bpy.data.filepath) if bpy.data.filepath and os.path.isfile(bpy.data.filepath) else None},
            'object_count': len(objs), 'truncated': len(objs) > limit,
            'cc_ids': cc_ids[:5000], 'cc_ids_truncated': len(cc_ids) > 5000,
            'details': [detail(o) for o in ordered[:limit]],
            'ledger': {'ok': err is None, 'error': err, 'entries': entries, 'entries_total': len(led['entries'])}}
    if batch_id:
        ent = led['entries'].get(batch_id + '#' + str(chunk))
        present = [i for i in want if i in ccmap]
        if err: state = 'corrupt'
        elif ent: state = 'recorded'
        elif present: state = 'partial'
        else: state = 'absent'
        data['batch'] = {'batch_id': batch_id, 'chunk': chunk, 'state': state, 'ledger_hash': ent['hash'] if ent else None,
                         'ids_present': present, 'ids_missing': [i for i in want if i not in ccmap]}
    _result(dict(_summary(), **data))
_inspect_detail()
`;

const BUILD_BODY = String.raw`
def _kind_type(kind, V):
    if kind in V['mesh']: return 'MESH'
    return {'light': 'LIGHT', 'camera': 'CAMERA', 'empty': 'EMPTY'}[kind]
def _fit(bm, target):
    d = [max(v.co[i] for v in bm.verts) - min(v.co[i] for v in bm.verts) for i in range(3)]
    s = tuple((target[i] / d[i]) if d[i] > 1e-9 and target[i] is not None else 1.0 for i in range(3))
    bmesh.ops.scale(bm, vec=s, verts=bm.verts)
def _make_mesh(kind, sh, origin, smooth, name):
    bm = bmesh.new()
    def v3(s):
        if s is None: return (1.0, 1.0, 1.0)
        if isinstance(s, (int, float)): return (float(s),) * 3
        return tuple(float(a) for a in s)
    if kind == 'box':
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=v3(sh.get('size')), verts=bm.verts)
    elif kind == 'uv_sphere':
        bmesh.ops.create_uvsphere(bm, u_segments=int(sh.get('segments', 32)), v_segments=int(sh.get('rings', 16)), radius=float(sh.get('radius', 0.5)))
    elif kind == 'ico_sphere':
        bmesh.ops.create_icosphere(bm, subdivisions=int(sh.get('subdivisions', 2)), radius=float(sh.get('radius', 0.5)))
    elif kind in ('cylinder', 'cone'):
        r = float(sh.get('radius', 0.5))
        r2 = float(sh.get('radius2', 0.0)) if kind == 'cone' else r
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=int(sh.get('segments', 16)), radius1=r, radius2=r2, depth=float(sh.get('depth', 1.0)))
    elif kind == 'plane':
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.5)
        s = v3(sh.get('size'))
        bmesh.ops.scale(bm, vec=(s[0], s[1], 1.0), verts=bm.verts)
    elif kind == 'circle':
        bmesh.ops.create_circle(bm, cap_ends=True, cap_tris=False, segments=int(sh.get('segments', 16)), radius=float(sh.get('radius', 0.5)))
    elif kind == 'monkey':
        bmesh.ops.create_monkey(bm)
        s = v3(sh.get('size'))
        k = max(s) / 2.734
        bmesh.ops.scale(bm, vec=(k, k, k), verts=bm.verts)
    if origin == 'base' and len(bm.verts):
        lo = min(v.co.z for v in bm.verts)
        bmesh.ops.translate(bm, vec=(0.0, 0.0, -lo), verts=bm.verts)
    if smooth:
        for f in bm.faces:
            f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return me
def _mods_state(o):
    out = []
    for md in o.modifiers:
        if not md.name.startswith('cc_'):
            continue
        props = {}
        for p in md.bl_rna.properties:
            if p.is_readonly or p.identifier in ('rna_type', 'name', 'type'):
                continue
            if p.type in ('BOOLEAN', 'INT', 'FLOAT') or (p.type == 'ENUM' and not p.is_enum_flag):
                v = getattr(md, p.identifier)
                props[p.identifier] = tuple(v) if hasattr(v, '__len__') and not isinstance(v, str) else v
            elif p.type == 'POINTER' and p.identifier in ('object', 'mirror_object', 'offset_object'):
                props[p.identifier] = getattr(md, p.identifier)
        out.append({'name': md.name, 'type': md.type, 'props': props})
    return out
def _mods_restore(o, state):
    for md in [m for m in o.modifiers if m.name.startswith('cc_') or m.name.startswith('ccnew_')]:
        o.modifiers.remove(md)
    for s in state:
        md = o.modifiers.new(name=s['name'], type=s['type'])
        for k, v in s['props'].items():
            try:
                setattr(md, k, v)
            except Exception:
                pass

def _build():
    spec = _p['spec']
    spec_hash = _p['spec_hash']
    V = _p['vocab']
    if not _same_file(_p['input']):
        raise SystemExit('invalid parameter - project_identity: the open Blender project is not ' + os.path.basename(_p['input']) + '; nothing was changed.')
    sc = bpy.context.scene
    led, err = _ledger_load(sc)
    if err:
        raise SystemExit('invalid parameter - ledger_corrupt: ' + err + '. Nothing was changed; ask the user to review the project.')
    batch = spec['batch_id']
    ch = spec.get('chunk') or {'index': 0, 'total': 1}
    key = batch + '#' + str(ch['index'])
    cur_pid = sc.get('cc_project_id')
    if spec.get('project_id') and cur_pid and spec['project_id'] != cur_pid:
        raise SystemExit('invalid parameter - project_identity: this project is ' + str(cur_pid) + ' but the batch was written for ' + spec['project_id'] + '; nothing was changed.')
    existing = {}
    for o in bpy.data.objects:
        cid = o.get('cc_id')
        if cid:
            existing[str(cid)] = o
    ent = led['entries'].get(key)
    if ent:
        if ent['hash'] != spec_hash:
            raise SystemExit('invalid parameter - batch_conflict: batch ' + key + ' was already applied with different content. Use a new batch_id for changed content; nothing was changed.')
        _result({'status': 'already_applied', 'ledger_key': key, 'missing_ids': [i for i in ent['ids'] if i not in existing], 'created': [], 'updated': [], 'project_id': cur_pid, 'names': {i: existing[i].name for i in ent['ids'] if i in existing}})
        return
    for e in led['entries'].values():
        if e['batch'] == batch and e['total'] != ch['total']:
            raise SystemExit('invalid parameter - batch_conflict: batch ' + batch + ' was started with ' + str(e['total']) + ' chunks, not ' + str(ch['total']) + '; nothing was changed.')

    # ---- 1. validate everything before changing anything ----
    objs = spec['objects']
    by_id = dict((o['id'], o) for o in objs)
    en = set(i.identifier for i in bpy.types.Modifier.bl_rna.properties['type'].enum_items)
    def known(i):
        return i in by_id or i in existing
    def bad(msg):
        raise SystemExit('invalid parameter - invalid_reference: ' + msg + '; nothing was changed.')
    prop_cache = {}
    def mod_props(mname):
        if mname not in prop_cache:
            info = V['modifiers'][mname]
            cls = getattr(bpy.types, info['rna'], None)
            if cls is None or info['type'] not in en:
                bad('the modifier ' + mname + ' is not available in Blender ' + bpy.app.version_string)
            prop_cache[mname] = dict((d['key'], d) for d in _rna_props(cls, V['pointers']))
        return prop_cache[mname]
    def chain_hits(oid, pid):
        seen = set()
        cur = pid
        while cur is not None and cur not in seen:
            if cur == oid:
                return True
            seen.add(cur)
            if cur in by_id:
                cur = by_id[cur].get('parent_id')
            elif cur in existing:
                p = existing[cur].parent
                cur = str(p.get('cc_id')) if p is not None and p.get('cc_id') else None
            else:
                cur = None
        return False
    for so in objs:
        oid = so['id']
        kind = so['kind']
        old = existing.get(oid)
        if old is not None:
            if str(old.get('cc_batch')) != batch:
                bad('object id ' + oid + ' already belongs to batch ' + str(old.get('cc_batch')) + ', choose another id')
            if old.type != _kind_type(kind, V):
                bad('object ' + oid + ' exists as ' + old.type + ' and cannot become ' + kind)
        if kind in V['mesh'] and not hasattr(bmesh.ops, V['mesh'][kind]):
            bad('this Blender has no ' + V['mesh'][kind] + ' for ' + kind)
        pid = so.get('parent_id')
        if pid is not None:
            if not known(pid):
                bad('parent_id ' + pid + ' of ' + oid + ' is neither in this spec nor an existing cc_id')
            if chain_hits(oid, pid):
                bad('parent_id ' + pid + ' would make ' + oid + ' its own ancestor')
        m = so.get('material')
        if m:
            mn = m.get('name') or ('cc_' + oid)
            mat = bpy.data.materials.get(mn)
            if mat is not None and not mat.get('cc_managed'):
                bad('material ' + mn + ' already exists and was not made by scene.build; choose another material name')
        for md in so.get('modifiers') or []:
            props = mod_props(md['type'])
            for k, v in (md.get('props') or {}).items():
                d = props.get(k)
                if d is None:
                    bad('modifier ' + md['type'] + ' has no property ' + k + ' (see discover.search name=' + md['type'] + ')')
                t = d['type']
                if t == 'object_id':
                    if not isinstance(v, str) or not known(v): bad('modifier ' + md['type'] + '.' + k + ' points at unknown id ' + str(v))
                elif t == 'boolean':
                    if not isinstance(v, bool): bad('modifier ' + md['type'] + '.' + k + ' must be true or false')
                elif t == 'enum':
                    if v not in d['values']: bad('modifier ' + md['type'] + '.' + k + ' must be one of ' + ', '.join(d['values'][:12]))
                else:
                    vals = v if isinstance(v, list) else [v]
                    if d.get('len') is not None and (not isinstance(v, list) or len(v) != d['len']): bad('modifier ' + md['type'] + '.' + k + ' needs ' + str(d['len']) + ' numbers')
                    if d.get('len') is None and isinstance(v, list): bad('modifier ' + md['type'] + '.' + k + ' takes one number')
                    for x in vals:
                        if isinstance(x, bool) or not isinstance(x, (int, float)): bad('modifier ' + md['type'] + '.' + k + ' must be a number')
                        if t == 'int' and float(x) != int(x): bad('modifier ' + md['type'] + '.' + k + ' must be a whole number')
                        if d.get('min') is not None and x < d['min']: bad('modifier ' + md['type'] + '.' + k + ' must be at least ' + str(d['min']))
                        if d.get('max') is not None and x > d['max']: bad('modifier ' + md['type'] + '.' + k + ' must be at most ' + str(d['max']))
    cam_id = (spec.get('scene') or {}).get('camera_id')
    if cam_id is not None:
        if not known(cam_id): bad('scene.camera_id ' + cam_id + ' is unknown')
        if (by_id[cam_id]['kind'] != 'camera') if cam_id in by_id else (existing[cam_id].type != 'CAMERA'): bad('scene.camera_id ' + cam_id + ' is not a camera')
    _stale_temps(_p['input'])

    # ---- 2. build in memory; every step can be undone ----
    undo = []
    created, updated, names = [], [], {}
    def undo_all():
        for f in reversed(undo):
            try:
                f()
            except Exception:
                pass
    cols = {}
    def collection(name):
        if not name:
            return sc.collection
        if name not in cols:
            c = bpy.data.collections.get(name)
            if c is None:
                c = bpy.data.collections.new(name)
                sc.collection.children.link(c)
                def rm(c=c):
                    for par in bpy.data.collections:
                        if c.name in par.children: par.children.unlink(c)
                    if c.name in sc.collection.children: sc.collection.children.unlink(c)
                    bpy.data.collections.remove(c)
                undo.append(rm)
            cols[name] = c
        return cols[name]
    def material(md, oid):
        name = md.get('name') or ('cc_' + oid)
        m = bpy.data.materials.get(name)
        if m is None:
            m = bpy.data.materials.new(name)
            m.use_nodes = True
            m['cc_managed'] = 1
            undo.append(lambda m=m: bpy.data.materials.remove(m))
        else:
            st = _mat_read(m)
            undo.append(lambda m=m, st=st: _mat_restore(m, st))
        _mat_set(m, md)
        return m
    new_objs = {}
    staged = []
    try:
        for so in objs:
            oid = so['id']
            kind = so['kind']
            old = existing.get(oid)
            nm = so.get('name') or oid
            data = None
            if kind in V['mesh']:
                data = _make_mesh(kind, so.get('shape') or {}, so.get('origin') or 'center', bool(so.get('smooth')), 'cc_' + oid)
                undo.append(lambda d=data: bpy.data.meshes.remove(d))
                if so.get('material'):
                    data.materials.append(material(so['material'], oid))
            elif kind == 'light':
                li = so['light']
                data = bpy.data.lights.new(nm, li['type'].upper())
                undo.append(lambda d=data: bpy.data.lights.remove(d))
                data.energy = float(li.get('energy', 3.0 if li['type'] == 'sun' else 1000.0))
                if li.get('color'): data.color = _hex(li['color'])[:3]
            elif kind == 'camera':
                ca = so.get('camera') or {}
                data = bpy.data.cameras.new(nm)
                undo.append(lambda d=data: bpy.data.cameras.remove(d))
                if ca.get('lens'): data.lens = float(ca['lens'])
                if ca.get('clip_start'): data.clip_start = float(ca['clip_start'])
                if ca.get('clip_end'): data.clip_end = float(ca['clip_end'])
            if old is None:
                o = bpy.data.objects.new(nm, data)
                collection(so.get('collection')).objects.link(o)
                undo.append(lambda o=o: bpy.data.objects.remove(o, do_unlink=True))
                new_objs[oid] = o
                created.append(oid)
            else:
                staged.append((old, data, so))
        def place(o, so):
            if so.get('loc'): o.location = tuple(so['loc'])
            if so.get('rot_deg'): o.rotation_euler = tuple(math.radians(a) for a in so['rot_deg'])
            sc_ = so.get('scale')
            if sc_ is not None: o.scale = (float(sc_),) * 3 if isinstance(sc_, (int, float)) else tuple(sc_)
        def apply_mods(o, so, prefix):
            for n, md in enumerate(so.get('modifiers') or []):
                info = V['modifiers'][md['type']]
                m = o.modifiers.new(name=prefix + str(n) + '_' + info['type'], type=info['type'])
                for k, v in (md.get('props') or {}).items():
                    if k in V['pointers']:
                        setattr(m, V['pointers'][k], (new_objs.get(v) or existing.get(v)))
                    elif isinstance(v, list):
                        setattr(m, k, tuple(v))
                    elif isinstance(v, float) and mod_props(md['type'])[k]['type'] == 'int':
                        setattr(m, k, int(v))
                    else:
                        setattr(m, k, v)
        for so in objs:
            o = new_objs.get(so['id'])
            if o is not None:
                place(o, so)
                apply_mods(o, so, 'cc_')
        # updates of objects that already carry this batch's ids: stage the new modifiers, then swap in one cheap step
        for old, data, so in staged:
            snap = {'name': old.name, 'data': old.data, 'loc': tuple(old.location), 'rot': tuple(old.rotation_euler), 'scale': tuple(old.scale), 'parent': old.parent, 'cols': list(old.users_collection), 'mods': _mods_state(old)}
            def restore(o=old, st=snap):
                o.name = st['name']
                if o.type == 'MESH' or st['data'] is not None:
                    o.data = st['data']
                o.location, o.rotation_euler, o.scale = st['loc'], st['rot'], st['scale']
                o.parent = st['parent']
                for c in list(o.users_collection): c.objects.unlink(o)
                for c in st['cols']: c.objects.link(o)
                _mods_restore(o, st['mods'])
            undo.append(restore)
            for md in [m for m in old.modifiers if m.name.startswith('cc_')]:
                old.modifiers.remove(md)
            if data is not None:
                old.data = data
            old.name = so.get('name') or so['id']
            place(old, so)
            apply_mods(old, so, 'cc_')
            want_col = collection(so.get('collection'))
            for c in list(old.users_collection):
                if c != want_col: c.objects.unlink(old)
            if old.name not in want_col.objects:
                want_col.objects.link(old)
            updated.append(so['id'])
            new_objs[so['id']] = old
        for so in objs:
            if so.get('parent_id'):
                new_objs[so['id']].parent = new_objs.get(so['parent_id']) or existing.get(so['parent_id'])
            elif so['id'] in updated:
                new_objs[so['id']].parent = None
        for oid, o in new_objs.items():
            prev = dict((k, o.get(k)) for k in ('cc_id', 'cc_batch', 'cc_chunk'))
            def unstamp(o=o, prev=prev):
                for k, v in prev.items():
                    if v is None:
                        if k in o: del o[k]
                    else: o[k] = v
            undo.append(unstamp)
            o['cc_id'] = oid
            o['cc_batch'] = batch
            o['cc_chunk'] = int(ch['index'])
        if cam_id is not None:
            prev_cam = sc.camera
            undo.append(lambda: setattr(sc, 'camera', prev_cam))
            sc.camera = new_objs.get(cam_id) or existing.get(cam_id)
        pid = cur_pid or spec.get('project_id') or uuid.uuid4().hex
        prev_props = (sc.get('cc_project_id'), sc.get('cc_ledger'))
        def unprop(sc=sc, prev=prev_props):
            for k, v in zip(('cc_project_id', 'cc_ledger'), prev):
                if v is None:
                    if k in sc: del sc[k]
                else: sc[k] = v
        undo.append(unprop)
        led['entries'][key] = {'batch': batch, 'chunk': int(ch['index']), 'total': int(ch['total']), 'hash': spec_hash, 'ids': [o['id'] for o in objs], 'at': datetime.datetime.utcnow().isoformat() + 'Z'}
        sc['cc_project_id'] = pid
        sc['cc_ledger'] = json.dumps(led, sort_keys=True)
        bpy.context.view_layer.update()
        for so in objs:
            names[so['id']] = new_objs[so['id']].name
        _fault('before_save')
        _safe_save(_p['input'])
    except SystemExit:
        undo_all()
        raise
    except Exception as ex:
        undo_all()
        raise SystemExit('apply_failed: ' + type(ex).__name__ + ': ' + str(ex) + '. The project file was not changed.')
    _fault('after_save')
    for me in [m for m in bpy.data.meshes if m.users == 0 and m.name.startswith('cc_')]:
        bpy.data.meshes.remove(me)
    _result({'status': 'applied', 'ledger_key': key, 'created': created, 'updated': updated, 'names': names, 'project_id': pid, 'missing_ids': []})
_build()
`;

const OPEN = "bpy.ops.wm.open_mainfile(filepath=_p['input'])";

/** Script bodies (the adapter prepends PRELUDE + SCENE_PRELUDE + BATCH_PRELUDE). */
export const BATCH_SCRIPTS: Record<string, string> = {
  'discover.search': DISCOVER_BODY,
  'scene.inspect_detail': `${OPEN}\n${INSPECT_BODY}`,
  'scene.build': `${OPEN}\n${BUILD_BODY}`,
};

export const BATCH_COMMAND_IDS = new Set(BATCH_COMMANDS.map((c) => c.id));

// ---------------------------------------------------------------------------------------------------------------------
// discover.search: runtime facts from Blender + the approved vocabulary, assembled compactly

export interface DiscoveryFacts {
  blender?: string; modifiers?: Record<string, { available: boolean; props: Array<Record<string, unknown>> }>; bmesh_ops?: string[];
  ops?: string[]; ops_total?: number; op?: { id: string; description: string; props: unknown[] } | null;
}
interface Item { name: string; kind: string; executable: boolean; summary: string }

export function assembleDiscovery(params: { kind?: string; query?: string; name?: string; limit?: number }, facts: DiscoveryFacts): Record<string, unknown> {
  const kind = (params.kind ?? 'all').toLowerCase();
  const q = (params.query ?? '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(40, Number(params.limit ?? 12)));
  const ops = new Set(facts.bmesh_ops ?? []);
  const items: Item[] = [];
  for (const [k, v] of Object.entries(MESH_KINDS)) items.push({ name: k, kind: 'primitive', executable: ops.size === 0 || ops.has(BATCH_VOCAB.mesh[k]!), summary: v.summary });
  items.push({ name: 'empty', kind: 'primitive', executable: true, summary: 'Empty (a transform handle / group parent).' }, { name: 'light', kind: 'primitive', executable: true, summary: `Light: ${LIGHT_TYPES.join(', ')}.` }, { name: 'camera', kind: 'primitive', executable: true, summary: 'Camera (lens, clip).' });
  for (const [k, v] of Object.entries(MODIFIERS)) items.push({ name: k, kind: 'modifier', executable: facts.modifiers?.[k]?.available ?? true, summary: v.summary });
  items.push({ name: 'material', kind: 'material', executable: true, summary: 'name?, color #rrggbb, metallic, roughness, alpha (0-1), emission_color, emission_strength.' });
  items.push({ name: 'spec', kind: 'grammar', executable: true, summary: 'The scene.build spec grammar with an example (use name "spec").' });
  for (const o of facts.ops ?? []) items.push({ name: o, kind: 'operator', executable: false, summary: 'Informational bpy.ops entry. scene.build never runs bpy.ops; it uses bmesh and bpy.data.' });

  const want = kind === 'all' ? null : kind === 'primitives' ? 'primitive' : kind === 'modifiers' ? 'modifier' : kind === 'materials' ? 'material' : kind === 'lights' ? 'primitive' : kind === 'operators' ? 'operator' : null;
  let list = items.filter((i) => (want === null || i.kind === want) && (kind !== 'lights' || i.name === 'light'));
  if (q) list = list.filter((i) => `${i.name} ${i.summary}`.toLowerCase().includes(q));
  const out: Record<string, unknown> = { blender: facts.blender, total: list.length, items: list.slice(0, limit) };
  if (list.length > limit) out.next = 'Narrow with query or kind to see the rest.';
  if (kind === 'operators' && facts.ops_total !== undefined) out.operators_total = facts.ops_total;

  const name = params.name?.trim();
  if (name) {
    if (name === 'spec') out.schema = SPEC_GRAMMAR;
    else if (name in MESH_KINDS) out.schema = { kind: name, shape: Object.fromEntries(MESH_KINDS[name as keyof typeof MESH_KINDS].keys.map((k) => [k, SHAPE_DOCS[k]])), also: 'loc, rot_deg, scale, origin, smooth, material, modifiers, parent_id, collection' };
    else if (name in MODIFIERS) out.schema = { modifier: name, type: MODIFIERS[name]!.type, available: facts.modifiers?.[name]?.available ?? null, props: facts.modifiers?.[name]?.props ?? [], use: 'modifiers:[{type, props:{key:value}}]; *_id props name another object id' };
    else if (name === 'material') out.schema = { name: 'string (reused by name; made by scene.build only)', color: '#rrggbb', metallic: '0-1', roughness: '0-1', alpha: '0-1', emission_color: '#rrggbb', emission_strength: '0-1000' };
    else if (name === 'light') out.schema = { type: [...LIGHT_TYPES], energy: 'watts (sun: strength)', color: '#rrggbb' };
    else if (name === 'camera') out.schema = { lens: 'mm', clip_start: 'm', clip_end: 'm' };
    else if (name.includes('.')) out.schema = facts.op ? { ...facts.op, executable: false, note: 'Reference only. scene.build does not run bpy.ops; use the bmesh/bpy.data vocabulary above.' } : { error: `No bpy.ops entry named ${name}.` };
    else out.schema = { error: `Nothing named "${name}". Search with query, or use name "spec".` };
  }
  return out;
}

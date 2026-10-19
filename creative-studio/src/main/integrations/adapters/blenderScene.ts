// Blender scene-editing commands (add objects, move, materials, modifiers, scene settings, keyframes,
// animation render). Like the first three Blender commands these are FIXED Python templates run in the
// background; every parameter travels in a JSON file and is never spliced into code. Each edit command
// opens the .blend file from the project's Blender folder, changes it and saves it in place; the adapter
// then re-opens it in a fresh Blender and reports what is really in it.

import type { CommandSpec, ParamSpec } from '@shared/integrations';

const FILE: ParamSpec = { type: 'string', description: 'Name of an existing .blend file in the Blender folder (see scene.inspect / scene.create_basic).', required: true };
const NAME: ParamSpec = { type: 'string', description: 'Exact object name from scene.inspect.', required: true };
const num = (description: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ type: 'number', description, ...extra });
const text = (description: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ type: 'string', description, ...extra });

const XYZ: Record<string, ParamSpec> = {
  x: num('Location X in metres.'), y: num('Location Y in metres.'), z: num('Location Z in metres.'),
  rx: num('Rotation X in degrees.'), ry: num('Rotation Y in degrees.'), rz: num('Rotation Z in degrees.'),
  sx: num('Scale X (1 = unchanged size).'), sy: num('Scale Y.'), sz: num('Scale Z.'),
};
const MATERIAL: Record<string, ParamSpec> = {
  color: text('Base colour as #rrggbb.'),
  metallic: num('0 to 1.', { min: 0, max: 1 }), roughness: num('0 to 1.', { min: 0, max: 1 }), alpha: num('Opacity 0 to 1.', { min: 0, max: 1 }),
  emission_color: text('Glow colour as #rrggbb.'), emission_strength: num('Glow strength (0 = none).', { min: 0, max: 1000 }),
};
const EDIT: CommandSpec['permissions'] = ['launch', 'open-files', 'read-project', 'modify-project', 'write-files', 'execute-scripts'];

export const SCENE_COMMANDS: CommandSpec[] = [
  {
    id: 'object.add', label: 'Add an object', permissions: EDIT, timeoutMs: 120_000,
    description: 'Adds a shape, light, camera, empty or text to a .blend file (saved in place). type: cube, sphere, cylinder, cone, torus, plane, monkey, circle, light_point, light_sun, light_spot, light_area, camera, empty, text. Optional colour/material settings apply to shapes.',
    params: { file_name: FILE, type: text('What to add (see description).', { required: true }), name: text('Name for the new object.'), size: num('Overall size in metres (radius is half). For lights: power in watts.', { default: 1, min: 0.001, max: 100000 }), text: text('The words, for type text.'), ...XYZ, ...MATERIAL },
  },
  {
    id: 'object.transform', label: 'Move, rotate or scale an object', permissions: EDIT, timeoutMs: 120_000, idempotent: true,
    description: 'Sets the location, rotation (degrees) and/or scale of an object. Only the values you give change. look_at aims a camera or light at another object; parent attaches it to another object; new_name renames it.',
    params: { file_name: FILE, name: NAME, ...XYZ, look_at: text('Name of an object to aim at.'), parent: text('Name of an object to become a child of.'), new_name: text('Rename the object.') },
  },
  {
    id: 'material.set', label: 'Set colour and material', permissions: EDIT, timeoutMs: 120_000, idempotent: true,
    description: 'Gives an object a material (creating it if needed) with colour, metallic, roughness, opacity and glow. The colour also shows in the fast Workbench render.',
    params: { file_name: FILE, name: NAME, ...MATERIAL },
  },
  {
    id: 'object.delete', label: 'Delete an object', permissions: EDIT, timeoutMs: 120_000, destructive: true,
    description: 'Deletes one object from the .blend file (saved in place).',
    params: { file_name: FILE, name: NAME },
  },
  {
    id: 'object.duplicate', label: 'Duplicate an object', permissions: EDIT, timeoutMs: 120_000,
    description: 'Copies an object (mesh data too) and moves the copy by an offset.',
    params: { file_name: FILE, name: NAME, new_name: text('Name of the copy.'), x: num('Offset X in metres.'), y: num('Offset Y in metres.'), z: num('Offset Z in metres.') },
  },
  {
    id: 'object.modifier', label: 'Add a modifier', permissions: EDIT, timeoutMs: 120_000,
    description: 'Adds a modifier to a mesh. kind: subsurf (smooth), bevel, solidify, mirror, array, wireframe. amount: subdivision levels, bevel width, thickness, array count or wire thickness. smooth_shade also shades the faces smooth.',
    params: { file_name: FILE, name: NAME, kind: text('subsurf, bevel, solidify, mirror, array or wireframe.', { required: true }), amount: num('Level / width / thickness / count.', { min: 0, max: 100 }), smooth_shade: { type: 'boolean', description: 'Also shade the faces smooth.', default: false } },
  },
  {
    id: 'scene.set', label: 'Change scene and render settings', permissions: EDIT, timeoutMs: 120_000, idempotent: true,
    description: 'Sets the render engine (workbench, eevee or cycles), samples, resolution, frame rate, frame range, background colour and the active camera.',
    params: { file_name: FILE, engine: text('workbench, eevee or cycles.'), samples: num('Render samples.', { min: 1, max: 4096 }), width: num('Width in pixels.', { min: 64, max: 8192 }), height: num('Height in pixels.', { min: 64, max: 8192 }), fps: num('Frames per second.', { min: 1, max: 240 }), frame_start: num('First frame.', { min: 0, max: 100000 }), frame_end: num('Last frame.', { min: 1, max: 100000 }), world_color: text('Background colour as #rrggbb.'), camera: text('Name of the camera object to make active.') },
  },
  {
    id: 'animation.keyframe', label: 'Set a keyframe', permissions: EDIT, timeoutMs: 120_000,
    description: 'Sets the given location / rotation / scale of an object at a frame and records a keyframe for each group you gave (location, rotation, scale), so it animates.',
    params: { file_name: FILE, name: NAME, frame: num('Frame number.', { required: true, min: 0, max: 100000 }), ...XYZ },
  },
  {
    id: 'scene.render_animation', label: 'Render an animation', permissions: ['launch', 'open-files', 'read-project', 'write-files', 'execute-scripts'], timeoutMs: 1_800_000, idempotent: true,
    description: 'Renders the frame range to an MP4 (H.264). engine overrides the scene (workbench is fastest).',
    params: { file_name: FILE, engine: text('workbench, eevee or cycles.', { default: 'workbench' }), width: num('Width in pixels.', { default: 960, min: 64, max: 4096 }), height: num('Height in pixels.', { default: 540, min: 64, max: 4096 }), frame_start: num('First frame (default: the scene start).', { min: 0, max: 100000 }), frame_end: num('Last frame (default: the scene end).', { min: 1, max: 100000 }) },
  },
  {
    id: 'scene.open_window', label: 'Open in Blender for hand editing', permissions: ['launch', 'open-files', 'read-project'], timeoutMs: 30_000,
    description: 'Opens the .blend file in a normal Blender window so the user can edit by hand. Stop after this; when the user has saved and says they are done, run scene.inspect to see their changes.',
    params: { file_name: FILE },
  },
];

/** Commands that change the .blend file: after them the adapter re-opens it in a fresh Blender to verify. */
export const EDIT_COMMAND_IDS = new Set(['object.add', 'object.transform', 'material.set', 'object.delete', 'object.duplicate', 'object.modifier', 'scene.set', 'animation.keyframe']);

/** Shared Python helpers (used by every scene script; `_p` is the parameter dictionary). */
export const SCENE_PRELUDE = `
import math
def _hex(h):
    h = str(h).lstrip('#')
    if len(h) != 6:
        raise SystemExit('Colours must be #rrggbb.')
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)) + (1.0,)
def _obj(name):
    o = bpy.data.objects.get(str(name))
    if o is None:
        raise SystemExit('There is no object named ' + str(name) + '. Names: ' + ', '.join(sorted(x.name for x in bpy.data.objects)))
    return o
def _input(b, names, v):
    for n in names:
        if n in b.inputs:
            b.inputs[n].default_value = v
            return
def _material(o, color=None, metallic=None, roughness=None, alpha=None, emission_color=None, emission_strength=None):
    if not hasattr(o.data, 'materials'):
        return
    m = o.active_material
    if m is None:
        m = bpy.data.materials.new(o.name + '_Material')
        m.use_nodes = True
        o.data.materials.append(m)
    b = m.node_tree.nodes.get('Principled BSDF') if m.use_nodes and m.node_tree else None
    if color is not None:
        c = _hex(color)
        m.diffuse_color = c
        if b: _input(b, ['Base Color'], c)
    if metallic is not None:
        m.metallic = float(metallic)
        if b: _input(b, ['Metallic'], float(metallic))
    if roughness is not None:
        m.roughness = float(roughness)
        if b: _input(b, ['Roughness'], float(roughness))
    if alpha is not None and b:
        _input(b, ['Alpha'], float(alpha))
        m.blend_method = 'BLEND' if float(alpha) < 1 else 'OPAQUE'
    if emission_color is not None and b:
        _input(b, ['Emission Color', 'Emission'], _hex(emission_color))
    if emission_strength is not None and b:
        _input(b, ['Emission Strength'], float(emission_strength))
def _apply_xyz(o, p):
    if any(k in p for k in ('x', 'y', 'z')):
        o.location = (p.get('x', o.location.x), p.get('y', o.location.y), p.get('z', o.location.z))
    if any(k in p for k in ('rx', 'ry', 'rz')):
        r = o.rotation_euler
        o.rotation_euler = (math.radians(p.get('rx', math.degrees(r.x))), math.radians(p.get('ry', math.degrees(r.y))), math.radians(p.get('rz', math.degrees(r.z))))
    if any(k in p for k in ('sx', 'sy', 'sz')):
        o.scale = (p.get('sx', o.scale.x), p.get('sy', o.scale.y), p.get('sz', o.scale.z))
def _engine(sc, name):
    n = str(name).lower()
    if n == 'cycles':
        sc.render.engine = 'CYCLES'
        return
    if n == 'eevee':
        for e in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
            try:
                sc.render.engine = e
                return
            except TypeError:
                pass
    sc.render.engine = 'BLENDER_WORKBENCH'
def _details():
    out = []
    for o in bpy.data.objects:
        d = {'name': o.name, 'type': o.type, 'location': [round(v, 4) for v in o.location], 'rotation_deg': [round(math.degrees(v), 2) for v in o.rotation_euler], 'scale': [round(v, 4) for v in o.scale], 'size': [round(v, 4) for v in o.dimensions]}
        if getattr(o.data, 'materials', None) is not None:
            d['materials'] = [{'name': m.name, 'color': [round(v, 3) for v in m.diffuse_color]} for m in o.data.materials if m]
        if o.modifiers:
            d['modifiers'] = [m.type for m in o.modifiers]
        if o.parent:
            d['parent'] = o.parent.name
        if o.animation_data and o.animation_data.action:
            d['keyframed'] = sorted(set(f.data_path for f in o.animation_data.action.fcurves))
        out.append(d)
    sc = bpy.context.scene
    return {'details': out, 'scene': {'engine': sc.render.engine, 'width': sc.render.resolution_x, 'height': sc.render.resolution_y, 'fps': sc.render.fps, 'frame_start': sc.frame_start, 'frame_end': sc.frame_end, 'camera': sc.camera.name if sc.camera else None}}
def _save():
    bpy.ops.wm.save_mainfile()
`;

const OPEN = `bpy.ops.wm.open_mainfile(filepath=_p['input'])`;
const DONE = `_result(dict(_summary(), **_details()))`;

export const SCENE_SCRIPTS: Record<string, string> = {
  'object.add': `${OPEN}
t = str(_p['type']).lower()
loc = (_p.get('x', 0), _p.get('y', 0), _p.get('z', 0))
rot = tuple(math.radians(_p.get(k, 0)) for k in ('rx', 'ry', 'rz'))
size = float(_p.get('size', 1))
for o in bpy.context.selected_objects:
    o.select_set(False)
if t == 'cube': bpy.ops.mesh.primitive_cube_add(size=size, location=loc, rotation=rot)
elif t == 'sphere': bpy.ops.mesh.primitive_uv_sphere_add(radius=size / 2, location=loc, rotation=rot)
elif t == 'cylinder': bpy.ops.mesh.primitive_cylinder_add(radius=size / 2, depth=size, location=loc, rotation=rot)
elif t == 'cone': bpy.ops.mesh.primitive_cone_add(radius1=size / 2, depth=size, location=loc, rotation=rot)
elif t == 'torus': bpy.ops.mesh.primitive_torus_add(major_radius=size / 2, minor_radius=size / 8, location=loc, rotation=rot)
elif t == 'plane': bpy.ops.mesh.primitive_plane_add(size=size, location=loc, rotation=rot)
elif t == 'monkey': bpy.ops.mesh.primitive_monkey_add(size=size, location=loc, rotation=rot)
elif t == 'circle': bpy.ops.mesh.primitive_circle_add(radius=size / 2, location=loc, rotation=rot)
elif t.startswith('light_') and t[6:] in ('point', 'sun', 'spot', 'area'):
    bpy.ops.object.light_add(type=t[6:].upper(), location=loc, rotation=rot)
    bpy.context.active_object.data.energy = size if t != 'light_sun' else min(size, 20)
elif t == 'camera':
    bpy.ops.object.camera_add(location=loc, rotation=rot)
    if bpy.context.scene.camera is None:
        bpy.context.scene.camera = bpy.context.active_object
elif t == 'empty': bpy.ops.object.empty_add(location=loc, rotation=rot)
elif t == 'text':
    bpy.ops.object.text_add(location=loc, rotation=rot)
    bpy.context.active_object.data.body = str(_p.get('text', 'Text'))
    bpy.context.active_object.data.size = size
else:
    raise SystemExit('Unknown type ' + t + '. Use cube, sphere, cylinder, cone, torus, plane, monkey, circle, light_point, light_sun, light_spot, light_area, camera, empty or text.')
o = bpy.context.active_object
if _p.get('name'):
    o.name = str(_p['name'])
_apply_xyz(o, {k: _p[k] for k in ('sx', 'sy', 'sz') if k in _p})
_material(o, _p.get('color'), _p.get('metallic'), _p.get('roughness'), _p.get('alpha'), _p.get('emission_color'), _p.get('emission_strength'))
_save()
${DONE}`,
  'object.transform': `${OPEN}
o = _obj(_p['name'])
_apply_xyz(o, _p)
if _p.get('look_at'):
    target = _obj(_p['look_at'])
    for c in [c for c in o.constraints if c.type == 'TRACK_TO']:
        o.constraints.remove(c)
    c = o.constraints.new('TRACK_TO')
    c.target = target
    c.track_axis = 'TRACK_NEGATIVE_Z'
    c.up_axis = 'UP_Y'
if _p.get('parent'):
    o.parent = _obj(_p['parent'])
if _p.get('new_name'):
    o.name = str(_p['new_name'])
_save()
${DONE}`,
  'material.set': `${OPEN}
o = _obj(_p['name'])
if not hasattr(o.data, 'materials'):
    raise SystemExit(o.name + ' cannot have a material.')
_material(o, _p.get('color'), _p.get('metallic'), _p.get('roughness'), _p.get('alpha'), _p.get('emission_color'), _p.get('emission_strength'))
_save()
${DONE}`,
  'object.delete': `${OPEN}
o = _obj(_p['name'])
bpy.data.objects.remove(o, do_unlink=True)
_save()
${DONE}`,
  'object.duplicate': `${OPEN}
o = _obj(_p['name'])
c = o.copy()
if o.data is not None:
    c.data = o.data.copy()
for coll in o.users_collection:
    coll.objects.link(c)
if not o.users_collection:
    bpy.context.scene.collection.objects.link(c)
c.location = (o.location.x + _p.get('x', 1), o.location.y + _p.get('y', 0), o.location.z + _p.get('z', 0))
if _p.get('new_name'):
    c.name = str(_p['new_name'])
_save()
${DONE}`,
  'object.modifier': `${OPEN}
o = _obj(_p['name'])
k = str(_p['kind']).lower()
amt = _p.get('amount')
kinds = {'subsurf': 'SUBSURF', 'bevel': 'BEVEL', 'solidify': 'SOLIDIFY', 'mirror': 'MIRROR', 'array': 'ARRAY', 'wireframe': 'WIREFRAME'}
if k not in kinds:
    raise SystemExit('Unknown modifier ' + k + '. Use ' + ', '.join(kinds))
m = o.modifiers.new(name=k.title(), type=kinds[k])
if amt is not None:
    if k == 'subsurf':
        m.levels = int(amt)
        m.render_levels = int(amt)
    elif k == 'bevel': m.width = float(amt)
    elif k == 'solidify': m.thickness = float(amt)
    elif k == 'array': m.count = max(1, int(amt))
    elif k == 'wireframe': m.thickness = float(amt)
if _p.get('smooth_shade') and o.type == 'MESH':
    for poly in o.data.polygons:
        poly.use_smooth = True
_save()
${DONE}`,
  'scene.set': `${OPEN}
sc = bpy.context.scene
if _p.get('engine'): _engine(sc, _p['engine'])
if _p.get('samples') is not None:
    n = int(_p['samples'])
    if sc.render.engine == 'CYCLES': sc.cycles.samples = n
    elif hasattr(sc, 'eevee') and hasattr(sc.eevee, 'taa_render_samples'): sc.eevee.taa_render_samples = n
if _p.get('width') is not None: sc.render.resolution_x = int(_p['width'])
if _p.get('height') is not None: sc.render.resolution_y = int(_p['height'])
sc.render.resolution_percentage = 100
if _p.get('fps') is not None: sc.render.fps = int(_p['fps'])
if _p.get('frame_start') is not None: sc.frame_start = int(_p['frame_start'])
if _p.get('frame_end') is not None: sc.frame_end = int(_p['frame_end'])
if _p.get('world_color'):
    if sc.world is None:
        sc.world = bpy.data.worlds.new('World')
    c = _hex(_p['world_color'])
    sc.world.color = c[:3]
    sc.world.use_nodes = True
    bg = sc.world.node_tree.nodes.get('Background')
    if bg: bg.inputs['Color'].default_value = c
if _p.get('camera'):
    cam = _obj(_p['camera'])
    if cam.type != 'CAMERA':
        raise SystemExit(cam.name + ' is not a camera.')
    sc.camera = cam
_save()
${DONE}`,
  'animation.keyframe': `${OPEN}
sc = bpy.context.scene
o = _obj(_p['name'])
f = int(_p['frame'])
sc.frame_set(f)
_apply_xyz(o, _p)
if any(k in _p for k in ('x', 'y', 'z')): o.keyframe_insert(data_path='location', frame=f)
if any(k in _p for k in ('rx', 'ry', 'rz')): o.keyframe_insert(data_path='rotation_euler', frame=f)
if any(k in _p for k in ('sx', 'sy', 'sz')): o.keyframe_insert(data_path='scale', frame=f)
if f > sc.frame_end: sc.frame_end = f
_save()
${DONE}`,
  'scene.render_animation': `${OPEN}
sc = bpy.context.scene
if sc.camera is None:
    raise SystemExit('The scene has no active camera.')
_engine(sc, _p.get('engine', 'workbench'))
sc.render.resolution_x = int(_p['width'])
sc.render.resolution_y = int(_p['height'])
sc.render.resolution_percentage = 100
if _p.get('frame_start') is not None: sc.frame_start = int(_p['frame_start'])
if _p.get('frame_end') is not None: sc.frame_end = int(_p['frame_end'])
sc.render.image_settings.file_format = 'FFMPEG'
sc.render.ffmpeg.format = 'MPEG4'
sc.render.ffmpeg.codec = 'H264'
sc.render.ffmpeg.constant_rate_factor = 'MEDIUM'
sc.render.filepath = _p['output']
bpy.ops.render.render(animation=True)
_result(dict(_summary(), frames=sc.frame_end - sc.frame_start + 1))`,
};

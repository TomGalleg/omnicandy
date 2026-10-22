// scene.viewport: a picture of what the open Blender window shows, for vision-capable models. Read only, never a render:
// the 3D view is drawn into an offscreen GPU buffer (the same technique Blender's own gpu module offers; it works whatever the
// window state, unlike a screen grab, which comes out black when the window is not in front) with explicit view and projection
// matrices, so the user's own viewport, shading and overlays are not changed.
//
// The picture shows the OPEN WINDOW (possibly with unsaved hand edits), so it is never proof of the saved project: the agent
// still verifies with scene.inspect_detail.

import type { CommandSpec } from '@shared/integrations';

export const VIEWPORT_VIEWS = ['iso', 'front', 'back', 'left', 'right', 'top', 'camera'] as const;
export const VIEWPORT_MAX_SIDE = 1024;
export const VIEWPORT_DEFAULT_SIDE = 800;

export const VIEWPORT_COMMAND: CommandSpec = {
  id: 'scene.viewport', label: 'Look at the Blender viewport', idempotent: true, preview: true, timeoutMs: 60_000,
  permissions: ['launch', 'open-files', 'read-project', 'execute-scripts'],
  description: `Takes a picture of the open Blender window's 3D view for a vision-capable model: solid shading with material colors, from view iso (default), front, back, left, right, top or the scene camera. focus frames one object (a cc_id or object name) and its children; otherwise the whole scene. It is a temporary preview, not a render, shows the open window (including unsaved hand edits) and is NOT proof of the saved project: verify with scene.inspect_detail. Needs the open Blender window and a model that can see images; the number of pictures per task is limited.`,
  params: {
    view: { type: 'string', description: `One of ${VIEWPORT_VIEWS.join(', ')}.`, default: 'iso' },
    focus: { type: 'string', description: 'cc_id or object name to frame (with its children). Default: everything.' },
    size: { type: 'number', description: `Longest side in pixels (at most ${VIEWPORT_MAX_SIDE}).`, default: VIEWPORT_DEFAULT_SIDE, min: 128, max: VIEWPORT_MAX_SIDE },
  },
};

/** Runs in the open window (inside the listener's 3D-view context override). Nothing is changed except two viewport flags it restores. */
export const VIEWPORT_BODY = String.raw`
def _viewport():
    import gpu
    import numpy as np
    from mathutils import Vector, Matrix, Euler
    sc = bpy.context.scene
    area = space = region = None
    for a in bpy.context.screen.areas:
        if a.type == 'VIEW_3D':
            area = a
            space = a.spaces.active
            region = next((r for r in a.regions if r.type == 'WINDOW'), None)
            break
    if area is None or space is None or region is None:
        raise SystemExit('viewport_unavailable: the Blender window has no 3D viewport to look through.')
    view = str(_p.get('view') or 'iso')
    side = max(128, min(1024, int(_p.get('size') or 800)))
    width = side
    height = max(96, int(side * 0.75))
    focus = str(_p.get('focus') or '')
    objs = [o for o in sc.objects if o.visible_get()]
    if focus:
        root = None
        for o in sc.objects:
            if str(o.get('cc_id') or '') == focus or o.name == focus:
                root = o
                break
        if root is None:
            raise SystemExit('invalid parameter - invalid_reference: there is no object with cc_id or name ' + focus + '. Nothing was changed.')
        keep = {root.name}
        grew = True
        while grew:
            grew = False
            for o in sc.objects:
                if o.parent is not None and o.parent.name in keep and o.name not in keep:
                    keep.add(o.name)
                    grew = True
        objs = [o for o in objs if o.name in keep]
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in objs:
        if o.type in ('MESH', 'CURVE', 'SURFACE', 'META', 'FONT'):
            ev = o.evaluated_get(dg)
            pts.extend(ev.matrix_world @ Vector(c) for c in ev.bound_box)
        else:
            pts.append(o.matrix_world.translation.copy())
    if pts:
        lo = Vector((min(p[i] for p in pts) for i in range(3)))
        hi = Vector((max(p[i] for p in pts) for i in range(3)))
    else:
        lo, hi = Vector((-1, -1, -1)), Vector((1, 1, 1))
    c = (lo + hi) / 2
    r = max(0.5, (hi - lo).length / 2)
    aspect = width / height
    if view == 'camera':
        cam = sc.camera
        if cam is None:
            raise SystemExit('viewport_unavailable: the scene has no active camera. Use another view.')
        vm = cam.matrix_world.inverted()
        pm = cam.calc_matrix_camera(dg, x=width, y=height)
    else:
        dirs = {'iso': Vector((1.0, -1.0, 0.8)), 'front': Vector((0, -1, 0)), 'back': Vector((0, 1, 0)), 'left': Vector((-1, 0, 0)), 'right': Vector((1, 0, 0)), 'top': Vector((0, 0, 1))}
        if view not in dirs:
            raise SystemExit('invalid parameter - invalid view ' + view + '. Use iso, front, back, left, right, top or camera. Nothing was changed.')
        ortho = view != 'iso'
        d = dirs[view].normalized()
        fov = math.radians(50)
        dist = r / math.sin(fov / 2) * 1.15
        eye = c + d * dist
        if view == 'top':
            rot = Euler((0, 0, 0)).to_quaternion()
        else:
            rot = (c - eye).to_track_quat('-Z', 'Y')
        vm = (Matrix.Translation(eye) @ rot.to_matrix().to_4x4()).inverted()
        near = max(0.01, dist * 0.01)
        far = dist + r * 4
        if ortho:
            s = r * 1.2
            sx, sy = (s * aspect, s) if aspect >= 1 else (s, s / aspect)
            pm = Matrix(((1 / sx, 0, 0, 0), (0, 1 / sy, 0, 0), (0, 0, -2 / (far - near), -(far + near) / (far - near)), (0, 0, 0, 1)))
        else:
            f = 1 / math.tan(fov / 2)
            pm = Matrix(((f / aspect, 0, 0, 0), (0, f, 0, 0), (0, 0, (far + near) / (near - far), 2 * far * near / (near - far)), (0, 0, -1, 0)))
    sh = space.shading
    prev = (sh.type, sh.color_type, space.overlay.show_overlays)
    try:
        sh.type = 'SOLID'
        sh.color_type = 'MATERIAL'
        space.overlay.show_overlays = False
        off = gpu.types.GPUOffScreen(width, height)
        try:
            off.draw_view3d(sc, bpy.context.view_layer, space, region, vm, pm, do_color_management=True)
            buf = off.texture_color.read()
        finally:
            off.free()
    finally:
        sh.type, sh.color_type = prev[0], prev[1]
        space.overlay.show_overlays = prev[2]
    buf.dimensions = width * height * 4
    pixels = np.asarray(buf, dtype=np.float32) / 255.0
    img = bpy.data.images.new('cc_viewport', width, height, alpha=True)
    try:
        img.pixels.foreach_set(pixels.ravel())
        img.filepath_raw = _p['output']
        img.file_format = 'PNG'
        img.save()
    finally:
        bpy.data.images.remove(img)
    _result({'width': width, 'height': height, 'view': view, 'focus': focus or None, 'objects': len(objs),
             'center': [round(v, 3) for v in c], 'radius': round(r, 3), 'file': bpy.data.filepath, 'scene': sc.name})
_viewport()
`;

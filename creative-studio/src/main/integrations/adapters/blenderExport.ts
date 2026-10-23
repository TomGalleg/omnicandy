// mesh.export: turns the meshes of a project .blend into a standard 3D file (GLB, FBX, OBJ or STL) that other programs can import:
// Unreal, FreeCAD, Godot, other Blender projects. The file lands in the project's Blender folder (exports/) and the app adds it to the
// library as a 3D model, so any other command can take it by library item.
//
// It never changes the project: the .blend is opened in a background Blender, copied meshes are made from what the scene really shows
// (modifiers applied, instances and parents resolved), exported, and Blender exits without saving. The result is checked by reading the
// finished file's own header, not by trusting the exporter.

import fs from 'node:fs/promises';
import type { CommandSpec } from '@shared/integrations';

export const EXPORT_FORMATS = ['glb', 'fbx', 'obj', 'stl'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_COMMAND: CommandSpec = {
  id: 'mesh.export', label: 'Export meshes as a 3D file',
  description: 'Exports the meshes of a .blend file as a 3D model file the other apps can import (Unreal, FreeCAD, Godot...). format: glb (best: keeps colours and materials), fbx, obj or stl (shape only). By default every mesh is merged into ONE mesh with its world position, modifiers applied, so a scene of thousands of trees and tufts becomes a single model that imports cleanly; set join to false to keep objects separate. The file is added to the library as a 3D model. The project is not changed. Units are metres, Z up in Blender (the exporter converts the axes).',
  params: {
    file_name: { type: 'string', description: 'Name of an existing .blend file in the Blender folder.', required: true },
    format: { type: 'string', description: 'glb, fbx, obj or stl.', default: 'glb' },
    name: { type: 'string', description: 'Name of the exported file (letters, digits, space, dash). Defaults to the .blend name.', default: '' },
    objects: { type: 'string', description: 'Comma-separated names of the objects to export (see scene.inspect). Empty exports every mesh.', default: '' },
    join: { type: 'boolean', description: 'Merge the chosen meshes into one mesh (recommended for scenes with many objects).', default: true },
    apply_modifiers: { type: 'boolean', description: 'Apply modifiers (subdivision, mirror, array...) as they look in the scene.', default: true },
  },
  permissions: ['launch', 'open-files', 'read-project', 'write-files', 'execute-scripts'], idempotent: true, timeoutMs: 600_000,
};

/** Runs in a background Blender after PRELUDE + SCENE_PRELUDE. Uses only API calls that exist in Blender 3.6 to 4.x. */
export const EXPORT_BODY = String.raw`
bpy.ops.wm.open_mainfile(filepath=_p['input'])
import bmesh
sc = bpy.context.scene
wanted = [n for n in _p['objects'] if n]
missing = [n for n in wanted if n not in bpy.data.objects]
if missing:
    raise SystemExit('invalid parameter - these objects do not exist: ' + ', '.join(missing[:10]))
objs = [o for o in bpy.data.objects if o.type == 'MESH' and (not wanted or o.name in wanted)]
if not objs:
    raise SystemExit('invalid parameter - there are no mesh objects to export')
dg = bpy.context.evaluated_depsgraph_get()
apply_mods = bool(_p['apply_modifiers'])
export_objs = objs
tri = 0
combined = []
if _p['join']:
    bm = bmesh.new()
    for o in objs:
        src = o.evaluated_get(dg) if apply_mods else o
        me = bpy.data.meshes.new_from_object(src, preserve_all_data_layers=False, depsgraph=dg) if apply_mods else o.data.copy()
        me.transform(o.matrix_world)
        slots = [s.material for s in o.material_slots] or [None]
        remap = []
        for m in slots:
            if m not in combined:
                combined.append(m)
            remap.append(combined.index(m))
        start = len(bm.faces)
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        for f in bm.faces[start:]:
            f.material_index = remap[min(f.material_index, len(remap) - 1)]
        bpy.data.meshes.remove(me)
    out_me = bpy.data.meshes.new(_p['label'])
    bm.to_mesh(out_me)
    bm.free()
    for m in combined:
        out_me.materials.append(m)
    joined = bpy.data.objects.new(_p['label'], out_me)
    sc.collection.objects.link(joined)
    export_objs = [joined]
    apply_mods = False
for o in bpy.data.objects:
    o.select_set(False)
for o in export_objs:
    o.select_set(True)
bpy.context.view_layer.objects.active = export_objs[0]
fmt, out = _p['format'], _p['output']
if fmt == 'glb':
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_apply=apply_mods)
elif fmt == 'fbx':
    bpy.ops.export_scene.fbx(filepath=out, use_selection=True, use_mesh_modifiers=apply_mods, path_mode='AUTO')
elif fmt == 'obj':
    bpy.ops.wm.obj_export(filepath=out, export_selected_objects=True, apply_modifiers=apply_mods)
elif fmt == 'stl':
    if bpy.app.version >= (4, 1, 0):
        bpy.ops.wm.stl_export(filepath=out, export_selected_objects=True, apply_modifiers=apply_mods)
    else:
        import addon_utils
        addon_utils.enable('io_mesh_stl', default_set=False, persistent=False)
        bpy.ops.export_mesh.stl(filepath=out, use_selection=True, use_mesh_modifiers=apply_mods)
else:
    raise SystemExit('invalid parameter - format must be glb, fbx, obj or stl')
verts = faces = 0
for o in export_objs:
    verts += len(o.data.vertices)
    faces += len(o.data.polygons)
    for p in o.data.polygons:
        tri += max(1, len(p.vertices) - 2)
mats = sorted(set(m.name for o in export_objs for m in o.data.materials if m))
_result({'file': out, 'format': fmt, 'source_objects': len(objs), 'exported_objects': len(export_objs), 'vertices': verts, 'faces': faces, 'triangles': tri, 'materials': mats, 'joined': bool(_p['join'])})
`;

export interface ExportCheck { ok: boolean; detail: string; facts: Record<string, unknown> }

/** Reads the finished file's own header (and for GLB its JSON chunk), so the export is proven by the file, not by the exporter's say-so. */
export async function checkExportedFile(file: string, format: ExportFormat, expect: { joined: boolean; triangles?: number }): Promise<ExportCheck> {
  const buf = await fs.readFile(file);
  if (buf.length < 64) return { ok: false, detail: `the ${format} file is only ${buf.length} bytes`, facts: {} };
  if (format === 'glb') {
    if (buf.toString('latin1', 0, 4) !== 'glTF') return { ok: false, detail: 'the file does not start with the GLB signature', facts: {} };
    const total = buf.readUInt32LE(8), jsonLen = buf.readUInt32LE(12);
    if (total !== buf.length || buf.toString('latin1', 16, 20) !== 'JSON') return { ok: false, detail: 'the GLB container is damaged (length or JSON chunk)', facts: {} };
    let j: { meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number>; indices?: number }> }>; accessors?: Array<{ count: number }>; materials?: unknown[]; nodes?: unknown[] };
    try { j = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen)); } catch { return { ok: false, detail: 'the GLB JSON chunk cannot be read', facts: {} }; }
    const meshes = j.meshes ?? [];
    let tris = 0;
    for (const m of meshes) for (const p of m.primitives ?? []) {
      const idx = p.indices !== undefined ? j.accessors?.[p.indices]?.count : undefined;
      tris += Math.floor((idx ?? j.accessors?.[p.attributes?.POSITION ?? -1]?.count ?? 0) / 3);
    }
    const facts = { meshes: meshes.length, nodes: j.nodes?.length ?? 0, materials: j.materials?.length ?? 0, triangles: tris };
    if (!meshes.length || tris === 0) return { ok: false, detail: 'the GLB holds no triangles', facts };
    if (expect.joined && meshes.length !== 1) return { ok: false, detail: `a joined export should hold one mesh but holds ${meshes.length}`, facts };
    if (expect.triangles && Math.abs(tris - expect.triangles) > Math.max(2, expect.triangles * 0.02)) return { ok: false, detail: `the GLB holds ${tris} triangles but Blender reported ${expect.triangles}`, facts };
    return { ok: true, detail: `GLB with ${meshes.length} mesh(es), ${tris} triangles, ${facts.materials} material(s)`, facts };
  }
  if (format === 'fbx') return buf.toString('latin1', 0, 18) === 'Kaydara FBX Binary' ? { ok: true, detail: 'binary FBX header present', facts: {} } : { ok: false, detail: 'the file does not start with the FBX signature', facts: {} };
  if (format === 'obj') {
    // vertices come first and faces last, so look at both ends of the file
    const head = buf.toString('utf8', 0, Math.min(buf.length, 1_000_000)), tail = buf.toString('utf8', Math.max(0, buf.length - 1_000_000));
    const v = (head.match(/^v /gm) ?? []).length, f = (tail.match(/^f /gm) ?? []).length;
    return v > 0 && f > 0 ? { ok: true, detail: `OBJ with vertices and faces (${(buf.length / 1024).toFixed(0)} KB)`, facts: { sampleVertices: v, sampleFaces: f } } : { ok: false, detail: 'the OBJ has no vertices or faces', facts: {} };
  }
  // stl: binary is 80 header + 4 count + 50 per triangle; ASCII starts with "solid" and has facets
  const n = buf.readUInt32LE(80);
  if (buf.length === 84 + 50 * n && n > 0) return { ok: true, detail: `binary STL with ${n} triangles`, facts: { triangles: n } };
  const t = buf.toString('utf8', 0, Math.min(buf.length, 400_000));
  const facets = (t.match(/facet normal/g) ?? []).length;
  return t.startsWith('solid') && facets > 0 ? { ok: true, detail: `ASCII STL with ${facets}+ facets`, facts: { triangles: facets } } : { ok: false, detail: 'the STL is neither valid binary nor ASCII', facts: {} };
}

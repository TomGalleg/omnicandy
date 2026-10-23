// mesh.export proves its result from the FINISHED FILE, not from the exporter's say-so. These tests build tiny real files of every format
// (and broken ones) and check what the checker concludes; blenderExport.live.test.ts runs the real Blender.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kindForExtension } from '../media';
import { BLENDER_MANIFEST } from './adapters/blender';
import { checkExportedFile, EXPORT_COMMAND, EXPORT_FORMATS } from './adapters/blenderExport';
import { validateManifest } from './sdk';
import { ADAPTER_SDK_VERSION } from '@shared/integrations';

let dir: string;
beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-export-')); });
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const put = async (name: string, data: Buffer | string) => { const f = path.join(dir, name); await fs.writeFile(f, data); return f; };

function glb(json: object, opts: { lie?: boolean; type?: string } = {}): Buffer {
  let j = JSON.stringify(json);
  while (j.length % 4) j += ' ';
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + j.length + (opts.lie ? 7 : 0), 8); head.writeUInt32LE(j.length, 12); head.write(opts.type ?? 'JSON', 16, 'latin1');
  return Buffer.concat([head, Buffer.from(j)]);
}
const oneMesh = { asset: { version: '2.0' }, nodes: [{ mesh: 0 }], materials: [{}, {}], accessors: [{ count: 30 }, { count: 90 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }] };

describe('the export checker reads the finished file', () => {
  it('accepts a real GLB and counts triangles from its own data', async () => {
    const r = await checkExportedFile(await put('ok.glb', glb(oneMesh)), 'glb', { joined: true, triangles: 30 });
    expect(r.ok).toBe(true);
    expect(r.facts).toMatchObject({ meshes: 1, triangles: 30, materials: 2 });
  });
  it('refuses a GLB that is damaged, empty, split when it should be joined, or disagrees with Blender', async () => {
    expect((await checkExportedFile(await put('a.glb', Buffer.from('not a glb at all, just some bytes padded out to be long enough to pass the size check....')), 'glb', { joined: true })).detail).toMatch(/signature/);
    expect((await checkExportedFile(await put('b.glb', glb(oneMesh, { lie: true })), 'glb', { joined: true })).detail).toMatch(/damaged/);
    expect((await checkExportedFile(await put('c.glb', glb({ ...oneMesh, meshes: [] })), 'glb', { joined: true })).detail).toMatch(/no triangles/);
    const two = { ...oneMesh, meshes: [oneMesh.meshes[0], oneMesh.meshes[0]] };
    expect((await checkExportedFile(await put('d.glb', glb(two)), 'glb', { joined: true })).detail).toMatch(/one mesh but holds 2/);
    expect((await checkExportedFile(await put('e.glb', glb(two)), 'glb', { joined: false })).ok).toBe(true); // separate objects are fine when not joined
    expect((await checkExportedFile(await put('f.glb', glb(oneMesh)), 'glb', { joined: true, triangles: 500 })).detail).toMatch(/holds 30 triangles but Blender reported 500/);
    expect((await checkExportedFile(await put('g.glb', 'tiny'), 'glb', { joined: true })).detail).toMatch(/only \d+ bytes/);
  });
  it('checks FBX, OBJ and STL (binary and ASCII) by their own structure', async () => {
    const fbx = Buffer.concat([Buffer.from('Kaydara FBX Binary  \0'), Buffer.alloc(80)]);
    expect((await checkExportedFile(await put('ok.fbx', fbx), 'fbx', { joined: true })).ok).toBe(true);
    expect((await checkExportedFile(await put('bad.fbx', Buffer.alloc(200, 65)), 'fbx', { joined: true })).ok).toBe(false);
    // OBJ: vertices first, faces last, and a long file between them
    const obj = `# Blender\nmtllib x.mtl\no m\n${'v 1 2 3\n'.repeat(5)}${'vn 0 0 1\n'.repeat(400_000)}f 1//1 2//1 3//1\n`;
    expect((await checkExportedFile(await put('ok.obj', obj), 'obj', { joined: true })).ok).toBe(true);
    expect((await checkExportedFile(await put('nofaces.obj', `${'v 1 2 3\n'.repeat(50)}`), 'obj', { joined: true })).detail).toMatch(/no vertices or faces/);
    const tri = (n: number) => { const b = Buffer.alloc(84 + 50 * n); b.writeUInt32LE(n, 80); return b; };
    expect((await checkExportedFile(await put('ok.stl', tri(12)), 'stl', { joined: true })).detail).toMatch(/binary STL with 12 triangles/);
    const broken = tri(12).subarray(0, 300);
    expect((await checkExportedFile(await put('cut.stl', broken), 'stl', { joined: true })).ok).toBe(false);
    const ascii = `solid m\n${'facet normal 0 0 1\n outer loop\n vertex 0 0 0\n vertex 1 0 0\n vertex 0 1 0\n endloop\nendfacet\n'.repeat(5)}endsolid m\n`;
    expect((await checkExportedFile(await put('ascii.stl', ascii), 'stl', { joined: true })).detail).toMatch(/ASCII STL/);
  });
});

describe('the 3D model library type and the command', () => {
  it('knows the exchange formats as one kind, without disturbing the existing ones', () => {
    for (const e of ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'usd', 'usdz', 'step', 'stp', '.GLB']) expect(kindForExtension(e), e).toBe('model');
    expect(kindForExtension('png')).toBe('image');
    expect(kindForExtension('dxf')).toBe('cad'); // 2D drawings stay CAD drawings
    expect(kindForExtension('blend')).toBeNull(); // an app's own project file is not an exchange format
  });
  it('is a read-only-on-the-project command that writes only its export file, and Blender still validates', () => {
    expect(validateManifest(BLENDER_MANIFEST, ADAPTER_SDK_VERSION)).toEqual([]);
    expect(EXPORT_COMMAND.destructive).toBeFalsy();
    expect(EXPORT_COMMAND.permissions).not.toContain('modify-project');
    expect(EXPORT_COMMAND.permissions).toContain('write-files');
    expect(EXPORT_COMMAND.params.format!.default).toBe('glb');
    expect(EXPORT_FORMATS).toEqual(['glb', 'fbx', 'obj', 'stl']);
    expect(BLENDER_MANIFEST.commands.map((c) => c.id)).toContain('mesh.export');
  });
});

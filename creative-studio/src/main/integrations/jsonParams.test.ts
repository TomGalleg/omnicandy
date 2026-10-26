// JSON parameters in the integration framework: trusted built-in adapters only, validated before anything is asked or run,
// and every installed-adapter path unchanged.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADAPTER_SDK_VERSION, type AdapterManifest, type ApprovalAnswer } from '@shared/integrations';
import { preflightExternalParams } from '../agentHarness/commandPreflight';
import { createIntegrationManager, IntegrationManager } from './index';
import { BLENDER_MANIFEST } from './adapters/blender';
import { packageManifestSchema } from './packageFormat';
import { validateManifest, type AdapterFactory } from './sdk';
import type { DiscoveryEnv } from './discovery';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-json-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const fakeEnv = (files: string[]): DiscoveryEnv => ({
  env: { ProgramFiles: 'C:\\Program Files', PATH: '' },
  exists: async (p) => files.map((f) => f.toLowerCase()).includes(p.toLowerCase()),
  listDir: async () => [],
  run: async () => '',
});
const manifest = (id: string, exe: string, withJson: boolean): AdapterManifest => ({
  id, platforms: ['win32', 'linux'], name: id, vendor: 'Test', sdkVersion: ADAPTER_SDK_VERSION, maturity: 'experimental',
  exeNames: [exe], displayNames: [`^${id}`], versions: { min: '0.1' }, methods: ['scripting'], capabilities: ['executeCommand', 'connect', 'disconnect'],
  commands: [
    { id: 'put', label: 'Put', description: 'stores a document', params: { file: { type: 'string', description: 'f', default: 'a' }, ...(withJson ? { doc: { type: 'json' as const, description: 'd', required: true, maxChars: 120, maxDepth: 3 } } : {}) }, permissions: ['launch', 'modify-project'] },
    { id: 'plain', label: 'Plain', description: 'old-style command', params: { n: { type: 'number', description: 'n', default: 1, min: 0, max: 5 } }, permissions: [] },
  ],
});
const factory = (m: AdapterManifest, seen: unknown[]): AdapterFactory => ({
  manifest: m,
  validateJson: (cmd, param, value) => (value as { kind?: string }).kind === 'ok' ? undefined : `kind must be "ok" (${cmd}.${param})`,
  create: () => ({
    probe: async () => ({ version: '1.0' }), connect: async () => undefined, disconnect: async () => undefined, healthCheck: async () => ({ ok: true, detail: 'ok' }), dispose: async () => undefined,
    execute: async (cmd, params) => { seen.push({ cmd: cmd.id, params }); return { message: 'ok', outputs: [], data: { got: params.doc } }; },
  }),
});

async function rig(opts: { builtin: boolean; answer?: ApprovalAnswer; withJson?: boolean }) {
  const exe = path.join(tmp, `app-${Math.random().toString(36).slice(2)}`, 'jsonapp.exe');
  await fs.mkdir(path.dirname(exe), { recursive: true });
  await fs.writeFile(exe, 'x');
  const seen: unknown[] = [];
  const asked: string[] = [];
  const mgr = new IntegrationManager({
    workDir: async (id) => path.join(tmp, 'work', id), permissions: { load: async () => ({}), save: async () => undefined },
    approve: async (r) => { asked.push(JSON.stringify(r.params)); return opts.answer ?? 'always'; },
    discovery: fakeEnv([exe]), userPaths: async () => [exe],
  });
  mgr.register(factory(manifest('jsonapp', 'jsonapp.exe', opts.withJson ?? true), seen), { builtin: opts.builtin });
  const key = (await mgr.scan()).apps[0]!.key;
  return { mgr, key, seen, asked };
}

describe('JSON parameters', () => {
  it('give the built-in adapter one canonical string after the user was asked', async () => {
    const r = await rig({ builtin: true });
    const res = await r.mgr.execute(r.key, 'put', { doc: { z: 1, kind: 'ok', a: [1, 2] } });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(r.seen).toEqual([{ cmd: 'put', params: { file: 'a', doc: '{"a":[1,2],"kind":"ok","z":1}' } }]);
    expect(r.asked).toEqual(['{"file":"a","doc":"{\\"a\\":[1,2],\\"kind\\":\\"ok\\",\\"z\\":1}"}']);
    expect((await r.mgr.execute(r.key, 'put', { doc: '{"kind":"ok"}' })).ok).toBe(true); // JSON text works too
  });
  it('reject malformed, oversized, too deep, unknown and schema-invalid input before anyone is asked or anything runs', async () => {
    const r = await rig({ builtin: true });
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ doc: '{nope' }, /valid JSON/],
      [{ doc: 5 }, /JSON object or JSON text/],
      [{}, /"doc" is required/],
      [{ doc: { kind: 'ok', pad: 'x'.repeat(200) } }, /at most 120/],
      [{ doc: { kind: 'ok', a: { b: { c: { d: 1 } } } } }, /levels deep/],
      [{ doc: { kind: 'nope' } }, /Invalid parameter "doc": kind must be "ok"/],
      [{ doc: { kind: 'ok' }, extra: 1 }, /Unknown setting "extra"/],
      [{ doc: '{"__proto__":{"kind":"ok"}}' }, /__proto__/],
    ];
    for (const [params, re] of bad) {
      const res = await r.mgr.execute(r.key, 'put', params);
      expect(res.ok, JSON.stringify(params)).toBe(false);
      expect(res.error?.kind).toBe('invalid-params');
      expect(res.error?.message).toMatch(re);
    }
    expect(r.asked).toEqual([]);
    expect(r.seen).toEqual([]);
  });
  it('still go through the normal approval: a refusal stops the command before the adapter', async () => {
    const r = await rig({ builtin: true, answer: 'deny' });
    const res = await r.mgr.execute(r.key, 'put', { doc: { kind: 'ok' } });
    expect(res.error?.kind).toBe('permission-denied');
    expect(r.seen).toEqual([]);
    expect(r.asked.length).toBe(1);
  });
  it('are refused for installed (non built-in) adapters, whose other commands keep working', async () => {
    const installed = await rig({ builtin: false, withJson: false });
    expect((await installed.mgr.execute(installed.key, 'plain', { n: 3 })).ok).toBe(true);
    expect((await installed.mgr.execute(installed.key, 'put', { file: 'x' })).ok).toBe(true);
    const exe = path.join(tmp, 'x', 'jsonapp.exe');
    const m = new IntegrationManager({ workDir: async () => tmp, permissions: { load: async () => ({}), save: async () => undefined }, approve: async () => 'always', discovery: fakeEnv([exe]) });
    expect(() => m.register(factory(manifest('jsonapp', 'jsonapp.exe', true), []))).toThrow(/JSON parameters are only available to built-in adapters \(put\.doc\)/);
    expect(() => m.register(factory(manifest('jsonapp', 'jsonapp.exe', true), []), { builtin: true })).not.toThrow();
  });
  it('cannot be declared by an installed package manifest', () => {
    const base = {
      manifestVersion: 1, id: 'x.y', name: 'X', version: '1.0', publisher: { name: 'P' }, sdk: { min: 1, max: 1 },
      application: { kind: 'program', name: 'X', exeNames: ['x.exe'] }, runtime: { entry: 'a.mjs' }, methods: ['cli'], capabilities: ['executeCommand'], files: {},
    };
    const withType = (type: string) => ({ ...base, commands: [{ id: 'c', label: 'c', description: 'd', params: { p: { type, description: 'd' } }, permissions: [] }] });
    expect(packageManifestSchema.safeParse(withType('string')).success).toBe(true);
    expect(packageManifestSchema.safeParse(withType('json')).success).toBe(false);
  });
  it('are validated up front by the agent harness too, without weakening other parameters', () => {
    const build = BLENDER_MANIFEST.commands.find((c) => c.id === 'scene.build')!;
    expect(build.params.spec).toMatchObject({ type: 'json', required: true });
    expect(preflightExternalParams(build, { file_name: 'a.blend', spec: '{bad' })).toMatch(/valid JSON.*Expected: .*batch_id/);
    const script = BLENDER_MANIFEST.commands.find((c) => c.id === 'script.run')!;
    const bare = preflightExternalParams(script, { file_name: 'a.blend', script: 'import bpy' });
    expect(bare).toMatch(/valid JSON/);
    expect(bare).toMatch(/JSON OBJECT with two text fields, never a bare string of code.*"purpose".*"code"/);
    expect(script.description).toMatch(/Do NOT use it for towers, walls, roofs/);
    expect(preflightExternalParams(build, { file_name: 'a.blend' })).toMatch(/Missing required parameter "spec"/);
    expect(preflightExternalParams(build, { file_name: 'a.blend', spec: { batch_id: 'a', objects: [] }, nope: 1 })).toMatch(/Unknown parameter "nope"/);
    expect(preflightExternalParams(build, { file_name: 'a.blend', spec: { batch_id: 'a', objects: [{ id: 'x', kind: 'box' }] } })).toBeUndefined();
    const plain = BLENDER_MANIFEST.commands.find((c) => c.id === 'object.add')!;
    expect(preflightExternalParams(plain, { file_name: 'a.blend', type: 5 })).toMatch(/must be text/);
  });
  it('are only declared by built-in adapters (Blender and Unreal), and Blender still registers cleanly next to its older commands', () => {
    expect(validateManifest(BLENDER_MANIFEST, ADAPTER_SDK_VERSION)).toEqual([]);
    const m = createIntegrationManager({ workDir: async () => tmp, permissions: { load: async () => ({}), save: async () => undefined }, approve: async () => 'deny' });
    const blender = m.manifests().find((x) => x.id === 'blender')!;
    expect(blender.commands.map((c) => c.id)).toEqual(expect.arrayContaining(['scene.create_basic', 'scene.inspect', 'object.add', 'discover.search', 'scene.inspect_detail', 'scene.build']));
    expect(m.isBuiltin('blender')).toBe(true);
    // Unreal passes tool arguments, call lists and script text as structured parameters; both adapters are built in, which the manager requires.
    expect(m.isBuiltin('unreal')).toBe(true);
    // Resolve takes clip, cue and path lists the same way (EDL, SRT, media import).
    expect(m.isBuiltin('davinci.resolve')).toBe(true);
    for (const other of m.manifests().filter((x) => !['blender', 'unreal', 'davinci.resolve'].includes(x.id))) expect(other.commands.some((c) => Object.values(c.params).some((p) => p.type === 'json'))).toBe(false);
  });
});

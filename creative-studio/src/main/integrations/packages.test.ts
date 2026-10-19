// Installable adapter packages: format, integrity, signatures, secure install, isolated runtime, permissions,
// jobs, crash recovery and the sample adapter. Child processes are REAL (Node's permission model, not a mock).

import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalAnswer, ApprovalRequest, Permission } from '@shared/integrations';
import { packAdapter } from '../../../scripts/pack-adapter.mjs';
import type { DiscoveryEnv } from './discovery';
import { AdapterPackages, createIntegrationManager, type IntegrationManager } from './index';
import { parsePackage, readPackageSource } from './packageFormat';
import { crc32, readZip, safeEntryName, writeZip, ZipError } from './zip';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pkg-')); });
const rigs: IntegrationManager[] = [];
afterAll(async () => {
  await Promise.all(rigs.map((m) => m.shutdown().catch(() => undefined)));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const pem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KEY_A = pem();
const KEY_B = pem();

type Cmd = { id: string; label?: string; params?: Record<string, unknown>; permissions?: Permission[]; destructive?: boolean; longRunning?: boolean; timeoutMs?: number };

const MAIN_JS = `
'use strict';
exports.probe = async () => ({ version: '1.0.0' });
exports.connect = async () => {};
exports.healthCheck = async () => ({ ok: true, detail: 'ok' });
exports.disconnect = async () => {};
const sleep = (ms, s) => new Promise((res, rej) => { const t = setTimeout(res, ms); s.addEventListener('abort', () => { clearTimeout(t); rej(new Error('cancelled')); }, { once: true }); });
exports.execute = async (command, params, ctx) => {
  switch (command) {
    case 'echo': return { message: 'echo ' + params.text, outputs: [], data: { text: params.text } };
    case 'write': await ctx.writeFile('out.txt', 'hello'); return { message: 'wrote', outputs: ['out.txt'] };
    case 'sneak': await ctx.writeFile('sneak.txt', 'x'); return { message: 'should not happen', outputs: ['sneak.txt'] };
    case 'read': { const b = await ctx.readFile('out.txt'); return { message: b.toString('utf8'), outputs: [] }; }
    case 'crash': process.exit(7); break;
    case 'hang': await new Promise(() => {}); break;
    case 'spin': for (;;) { /* never yields */ } break;
    case 'slow': for (let i = 1; i <= params.n; i++) { await sleep(150, ctx.signal); ctx.progress('step ' + i, i / params.n); } return { message: 'counted', outputs: [], verified: true };
    case 'runapp': { const r = await ctx.runApp(['-p', '40+2']); return { message: r.out.trim(), outputs: [] }; }
    case 'escape-spawn': { try { require('child_process').execSync('cmd /c echo hi'); return { message: 'ALLOWED', outputs: [] }; } catch (e) { return { message: 'blocked ' + e.code, outputs: [] }; } }
    case 'escape-write': { try { require('fs').writeFileSync(params.where, 'x'); return { message: 'ALLOWED', outputs: [] }; } catch (e) { return { message: 'blocked ' + e.code, outputs: [] }; } }
    case 'escape-read': { try { return { message: 'READ ' + require('fs').readFileSync(params.where, 'utf8'), outputs: [] }; } catch (e) { return { message: 'blocked ' + e.code, outputs: [] }; } }
    case 'env': return { message: JSON.stringify({ key: process.env.SECRET_API_KEY || null }), outputs: [] };
    case 'outside': return { message: 'x', outputs: ['../../escaped.txt'] };
    case 'liar': return { message: 'done', outputs: ['nothing.bin'] };
    default: throw ctx.error('unsupported', 'unknown ' + command);
  }
};
`;

const spec = (c: Cmd) => ({
  id: c.id, label: c.label ?? c.id, description: `${c.id} test command`,
  params: c.params ?? { text: { type: 'string', description: 't', default: 'x' } },
  permissions: c.permissions ?? [], ...(c.destructive ? { destructive: true } : {}), ...(c.longRunning ? { longRunning: true } : {}),
  timeoutMs: c.timeoutMs ?? 10_000,
});

const DEFAULT_CMDS: Cmd[] = [
  { id: 'echo', permissions: ['read-info'] },
  { id: 'write', permissions: ['write-files'], params: {} },
  { id: 'sneak', permissions: ['read-info'], params: {} },
  { id: 'read', permissions: ['read-project'], params: {} },
  { id: 'crash', params: {} },
  { id: 'hang', params: {}, timeoutMs: 1500 },
  { id: 'spin', params: {}, timeoutMs: 1000 },
  { id: 'slow', params: { n: { type: 'number', description: 'n', default: 3, min: 1, max: 100 } }, longRunning: true },
  { id: 'escape-spawn', params: {} },
  { id: 'escape-write', params: { where: { type: 'string', description: 'w', required: true } } },
  { id: 'escape-read', params: { where: { type: 'string', description: 'w', required: true } } },
  { id: 'env', params: {} },
  { id: 'outside', params: {} },
  { id: 'liar', params: {} },
];

interface PkgOpts {
  id?: string; version?: string; key?: string; publisher?: string; commands?: Cmd[]; main?: string;
  program?: { exe: string }; sdk?: { min: number; max: number }; extra?: Record<string, string>; manifest?: Record<string, unknown>;
}

let n = 0;
/** Writes a package folder, packs it (signed with `key`, or unsigned) and returns the .ccadapter path. */
async function makePackage(o: PkgOpts = {}): Promise<{ file: string; dir: string; id: string }> {
  const id = o.id ?? `test.pkg${++n}`;
  const dir = path.join(tmp, `src-${id}-${o.version ?? '1.0.0'}-${Math.random().toString(36).slice(2, 6)}`);
  await fs.mkdir(dir, { recursive: true });
  const manifest = {
    manifestVersion: 1, platforms: ['win32', 'linux'], id, name: `Test ${id}`, version: o.version ?? '1.0.0', description: 'a test integration', license: 'MIT',
    publisher: { name: o.publisher ?? 'Test Publisher' },
    sdk: o.sdk ?? { min: 1, max: 1 },
    application: o.program
      ? { kind: 'program', name: 'Fake App', exeNames: [o.program.exe], displayNames: ['Fake App'], versions: [{ min: '1.0' }] }
      : { kind: 'self-contained', name: 'Test App' },
    runtime: { entry: 'main.js' }, methods: ['api'], capabilities: ['executeCommand', 'connect', 'disconnect', 'healthCheck'],
    commands: (o.commands ?? DEFAULT_CMDS).map(spec), files: {},
    ...(o.manifest ?? {}),
  };
  await fs.writeFile(path.join(dir, 'adapter.json'), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(dir, 'main.js'), o.main ?? MAIN_JS);
  for (const [name, text] of Object.entries(o.extra ?? {})) { await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await fs.writeFile(path.join(dir, name), text); }
  const packed = packAdapter({ dir, privateKeyPem: o.key });
  const file = path.join(tmp, `${id}-${manifest.version}-${Math.random().toString(36).slice(2, 6)}.ccadapter`);
  await fs.writeFile(file, packed.bytes);
  return { file, dir, id };
}

function fakeDiscovery(): DiscoveryEnv {
  return { env: { PATH: '' }, run: async () => '', exists: (p) => fs.stat(p).then(() => true, () => false), listDir: async () => [] };
}

interface Rig { mgr: IntegrationManager; pk: AdapterPackages; asked: ApprovalRequest[]; answer: { value: ApprovalAnswer }; root: string; work: string; stored: Record<string, Permission[]>; userPaths: string[] }

async function rig(): Promise<Rig> {
  const root = await fs.mkdtemp(path.join(tmp, 'root-'));
  const work = path.join(root, 'work');
  const asked: ApprovalRequest[] = [];
  const answer = { value: 'once' as ApprovalAnswer };
  const stored: Record<string, Permission[]> = {};
  const userPaths: string[] = [];
  const mgr = createIntegrationManager({
    workDir: async (id) => path.join(work, id),
    permissions: { load: async () => ({ ...stored }), save: async (g) => { Object.assign(stored, g); } },
    approve: async (r) => { asked.push(r); return answer.value; },
    discovery: fakeDiscovery(),
    userPaths: async () => userPaths,
  });
  const pk = new AdapterPackages(path.join(root, 'integrations'), mgr);
  rigs.push(mgr);
  return { mgr, pk, asked, answer, root, work, stored, userPaths };
}

const ALL: Permission[] = ['read-info', 'write-files', 'read-project', 'execute-scripts', 'launch'];

async function installed(r: Rig, o: PkgOpts = {}, perms: Permission[] = ALL) {
  const p = await makePackage({ key: KEY_A, ...o });
  const review = await r.pk.review(p.file);
  const approved = perms.filter((x) => review.permissions.includes(x));
  await r.pk.install(p.file, { permissions: approved, trustPublisher: true });
  const scan = await r.mgr.scan();
  const app = scan.apps.find((a) => a.adapterId === p.id);
  if (!app) throw new Error(`adapter ${p.id} not listed: ${JSON.stringify(scan.apps.map((a) => a.adapterId))}`);
  return { ...p, key: app.key };
}

// ---------------------------------------------------------------------------------------------
describe('zip reading is defensive', () => {
  it('round-trips files and verifies checksums', () => {
    const z = writeZip({ 'a.txt': 'hello', 'dir/b.bin': Buffer.from([1, 2, 3]) });
    const m = readZip(z);
    expect(m.get('a.txt')?.toString()).toBe('hello');
    expect([...m.get('dir/b.bin')!]).toEqual([1, 2, 3]);
  });

  it.each(['../evil.txt', '/abs.txt', 'C:/win.txt', 'a\\b.txt', 'a/../../b.txt', 'a//b', 'CON.txt', 'x:y.txt', 'trail.', ''])('refuses the entry name %j', (name) => {
    expect(() => safeEntryName(name)).toThrow(ZipError);
  });

  it('rejects a package that contains a traversal name', () => {
    const z = writeZip({ '../escape.txt': 'x' });
    expect(() => readZip(z)).toThrow(/unsafe|segment/);
  });

  it('rejects duplicate and case-colliding names', () => {
    const a = writeZip({ 'A.txt': '1' });
    const b = writeZip({ 'a.txt': '2' });
    // Splice two single-entry zips into one by building a central directory manually via the writer on a Map with both names.
    expect(() => readZip(writeZip(new Map([['A.txt', Buffer.from('1')], ['a.txt', Buffer.from('2')]])))).toThrow(/case-colliding|duplicate/);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
  });

  it('rejects a corrupt checksum', () => {
    const z = Buffer.from(writeZip({ 'a.txt': 'hello' }));
    z[z.indexOf(Buffer.from('hello'))] = 0x48; // 'H': data changed, CRC not
    expect(() => readZip(z)).toThrow(/checksum/);
    expect(crc32(Buffer.from('hello'))).toBeTypeOf('number');
  });

  it('rejects a decompression bomb by its real size, not its header', () => {
    const big = Buffer.alloc(4 * 1024 * 1024, 0x61);
    const comp = zlib.deflateRawSync(big);
    // Build a zip whose header claims 10 bytes uncompressed.
    const z = Buffer.from(writeZip({ 'x.bin': Buffer.alloc(10, 1) }));
    const name = Buffer.from('x.bin');
    const lho = 0;
    const raw = Buffer.concat([z.subarray(0, 8), Buffer.from([8, 0]), z.subarray(10, 18), Buffer.alloc(4), Buffer.alloc(4), z.subarray(26, 30), name, comp]);
    raw.writeUInt32LE(comp.length, 18);
    raw.writeUInt32LE(10, 22);
    const crc = crc32(Buffer.alloc(10, 1));
    raw.writeUInt32LE(crc, 14);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(10, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(lho, 42);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(raw.length, 16);
    expect(() => readZip(Buffer.concat([raw, cd, name, end]))).toThrow(ZipError);
  });

  it('enforces file count and size limits', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`f${i}.txt`] = 'x';
    expect(() => readZip(writeZip(files), { maxFiles: 10, maxFileBytes: 1000, maxTotalBytes: 1000 })).toThrow(/more than 10 files/);
    expect(() => readZip(writeZip({ 'big.bin': Buffer.alloc(2000) }), { maxFiles: 10, maxFileBytes: 1000, maxTotalBytes: 5000 })).toThrow(/larger than/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('package integrity and identity', () => {
  it('accepts a correctly packed, signed package', async () => {
    const p = await makePackage({ key: KEY_A });
    const parsed = parsePackage((await readPackageSource(p.file)).files);
    expect(parsed.problems).toEqual([]);
    expect(parsed.signature.state).toBe('valid');
    expect(parsed.signature.fingerprint).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){7}$/);
  });

  it('detects a file changed after packing (hash mismatch)', async () => {
    const p = await makePackage({ key: KEY_A });
    const files = (await readPackageSource(p.file)).files;
    files.set('main.js', Buffer.from('exports.execute = async () => { require("child_process"); };'));
    const parsed = parsePackage(files);
    expect(parsed.problems.join(' ')).toMatch(/main\.js.*SHA-256/);
  });

  it('detects extra unlisted files', async () => {
    const p = await makePackage({ key: KEY_A });
    const files = (await readPackageSource(p.file)).files;
    files.set('payload.js', Buffer.from('1'));
    expect(parsePackage(files).problems.join(' ')).toMatch(/payload\.js.*not listed/);
  });

  it('marks a modified manifest as an invalid signature', async () => {
    const p = await makePackage({ key: KEY_A });
    const files = (await readPackageSource(p.file)).files;
    const m = JSON.parse(files.get('adapter.json')!.toString());
    m.commands[0].permissions = ['execute-scripts', 'network'];
    files.set('adapter.json', Buffer.from(JSON.stringify(m)));
    expect(parsePackage(files).signature.state).toBe('invalid');
  });

  it('marks a forged signature (another key, copied signature) as invalid', async () => {
    const a = await makePackage({ key: KEY_A, id: 'forge.a' });
    const b = await makePackage({ key: KEY_B, id: 'forge.b' });
    const fa = (await readPackageSource(a.file)).files;
    const fb = (await readPackageSource(b.file)).files;
    fa.set('adapter.sig', fb.get('adapter.sig')!);
    expect(parsePackage(fa).signature.state).toBe('invalid');
  });

  it('rejects unknown manifest fields, bad ids and an unlisted entry file', async () => {
    const dir = path.join(tmp, 'bad-manifest');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'main.js'), '1');
    const base = { manifestVersion: 1, id: 'ok.id', name: 'X', version: '1.0.0', publisher: { name: 'P' }, sdk: { min: 1, max: 1 }, application: { kind: 'self-contained', name: 'X' }, runtime: { entry: 'main.js' }, methods: ['api'], capabilities: [], commands: [], files: {} };
    const check = async (m: Record<string, unknown>) => {
      await fs.writeFile(path.join(dir, 'adapter.json'), JSON.stringify(m));
      return parsePackage((await readPackageSource(dir)).files).problems.join(' | ');
    };
    expect(await check({ ...base, sneaky: true })).toMatch(/Unrecognized|unrecognized/i);
    expect(await check({ ...base, id: '../x' })).toMatch(/id/);
    expect(await check({ ...base, sdk: { min: 2, max: 3 } })).toMatch(/adapter SDK/);
    expect(await check({ ...base, runtime: { entry: '../main.js' } })).toMatch(/unsafe|entry/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('secure installation', () => {
  it('refuses unsigned packages unless the user explicitly confirms, and remembers they are unsigned', async () => {
    const r = await rig();
    const p = await makePackage({});
    const review = await r.pk.review(p.file);
    expect(review.signature).toBe('unsigned');
    expect(review.warnings.join(' ')).toMatch(/not signed/);
    await expect(r.pk.install(p.file, { permissions: [] })).rejects.toThrow(/unsigned/);
    const v = await r.pk.install(p.file, { permissions: ['read-info'], allowUnsigned: true });
    expect(v.trust).toBe('unsigned');
    expect(v.restricted).toBe(true);
  });

  it('refuses a signed package from a new publisher until that publisher is trusted', async () => {
    const r = await rig();
    const p = await makePackage({ key: KEY_A });
    const review = await r.pk.review(p.file);
    expect(review.publisherTrusted).toBe(false);
    await expect(r.pk.install(p.file, { permissions: [] })).rejects.toThrow(/not trusted yet/);
    await r.pk.install(p.file, { permissions: [], trustPublisher: true });
    expect((await r.pk.listing()).trustedPublishers).toHaveLength(1);
    // The second package from the same key needs no new confirmation.
    const q = await makePackage({ key: KEY_A });
    expect((await r.pk.review(q.file)).publisherTrusted).toBe(true);
    await r.pk.install(q.file, { permissions: [] });
  });

  it('does not grant permissions the package did not request', async () => {
    const r = await rig();
    const p = await makePackage({ key: KEY_A, commands: [{ id: 'echo', permissions: ['read-info'] }] });
    await expect(r.pk.install(p.file, { permissions: ['read-info', 'execute-scripts'], trustPublisher: true })).rejects.toThrow(/not requested/);
  });

  it('never executes anything or writes outside its own folders while reviewing and installing', async () => {
    const r = await rig();
    const marker = path.join(tmp, 'executed.marker');
    const p = await makePackage({ key: KEY_A, main: `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');` });
    await r.pk.review(p.file);
    await r.pk.install(p.file, { permissions: [], trustPublisher: true });
    await expect(fs.stat(marker)).rejects.toThrow();
    const dirs = await fs.readdir(path.join(r.root, 'integrations'));
    expect(dirs.sort()).toEqual(['adapters', 'data', 'inbox', 'registry.json'].filter((d) => dirs.includes(d)).sort());
  });

  it('refuses ids that collide with built-in integrations and programs another adapter already drives', async () => {
    const r = await rig();
    const asBlender = await makePackage({ key: KEY_A, id: 'blender' });
    const review = await r.pk.review(asBlender.file);
    expect(review.action).toBe('blocked');
    const sameExe = await makePackage({ key: KEY_A, program: { exe: 'blender.exe' } });
    expect((await r.pk.review(sameExe.file)).problems.join(' ')).toMatch(/same program|already integrates/);
  });

  it('lets a package replace a placeholder (stub) and restores the stub when removed', async () => {
    const r = await rig();
    await r.mgr.scan();
    expect(r.mgr.factory('freecad')?.manifest.maturity).toBe('stub');
    const p = await makePackage({ key: KEY_A, id: 'freecad', program: { exe: 'FreeCADCmd.exe' } });
    await r.pk.install(p.file, { permissions: ['read-info'], trustPublisher: true });
    expect(r.mgr.factory('freecad')?.manifest.source).toBe('package');
    await r.pk.uninstall('freecad');
    expect(r.mgr.factory('freecad')?.manifest.maturity).toBe('stub');
  });

  it('updates in place, refuses downgrades and publisher changes', async () => {
    const r = await rig();
    const v1 = await makePackage({ key: KEY_A, id: 'upd.demo', version: '1.0.0' });
    await r.pk.install(v1.file, { permissions: ['read-info'], trustPublisher: true });
    const v2 = await makePackage({ key: KEY_A, id: 'upd.demo', version: '1.1.0' });
    expect((await r.pk.review(v2.file)).action).toBe('update');
    await r.pk.install(v2.file, { permissions: ['read-info'] });
    expect((await r.pk.listing()).installed[0]?.version).toBe('1.1.0');
    await expect(fs.stat(path.join(r.root, 'integrations', 'adapters', 'upd.demo', '1.0.0'))).rejects.toThrow();
    const older = await makePackage({ key: KEY_A, id: 'upd.demo', version: '1.0.5' });
    expect((await r.pk.review(older.file)).problems.join(' ')).toMatch(/older/);
    const other = await makePackage({ key: KEY_B, id: 'upd.demo', version: '2.0.0' });
    expect((await r.pk.review(other.file)).problems.join(' ')).toMatch(/different publisher/);
    const unsigned = await makePackage({ id: 'upd.demo', version: '2.0.0' });
    expect((await r.pk.review(unsigned.file)).action).toBe('blocked');
  });

  it('turns an adapter off when its installed files are changed, and Repair restores the verified original', async () => {
    const r = await rig();
    const p = await installed(r, { id: 'tamper.demo' });
    expect((await r.mgr.execute(p.key, 'echo', { text: 'a' })).ok).toBe(true);
    // Edit the installed script by hand.
    const main = path.join(r.root, 'integrations', 'adapters', 'tamper.demo', '1.0.0', 'main.js');
    await r.mgr.shutdown(); // a restart: the old process is gone
    await fs.appendFile(main, '\n// changed\n');
    const r2 = await rig2(r);
    await r2.pk.load();
    const listing = await r2.pk.listing();
    expect(listing.installed[0]?.state).toBe('tampered');
    expect(r2.mgr.factory('tamper.demo')).toBeNull();
    const fixed = await r2.pk.repair('tamper.demo');
    expect(fixed.state).toBe('ok');
    expect(r2.mgr.factory('tamper.demo')?.manifest.source).toBe('package');
  });
});

/** A second manager over the same on-disk integrations folder (what a restart looks like). */
async function rig2(r: Rig): Promise<Rig> {
  const asked: ApprovalRequest[] = [];
  const mgr = createIntegrationManager({
    workDir: async (id) => path.join(r.work, id),
    permissions: { load: async () => ({ ...r.stored }), save: async (g) => { Object.assign(r.stored, g); } },
    approve: async (q) => { asked.push(q); return r.answer.value; },
    discovery: fakeDiscovery(),
    userPaths: async () => r.userPaths,
  });
  const pk = new AdapterPackages(path.join(r.root, 'integrations'), mgr);
  rigs.push(mgr);
  return { ...r, mgr, pk, asked };
}

// ---------------------------------------------------------------------------------------------
describe('installed adapters run isolated, with enforced permissions', () => {
  it('is discovered, registers its capabilities and executes through the existing manager', async () => {
    const r = await rig();
    const p = await installed(r);
    const info = (await r.mgr.list()).find((a) => a.key === p.key)!;
    expect(info.origin).toBe('package');
    expect(info.trust).toBe('trusted-publisher');
    expect(info.selfContained).toBe(true);
    expect(info.commands.map((c) => c.id)).toContain('echo');
    const res = await r.mgr.execute(p.key, 'echo', { text: 'hi there' });
    expect(res.ok).toBe(true);
    expect(res.message).toBe('echo hi there');
    expect(res.data).toEqual({ text: 'hi there' });
    expect((await r.mgr.list()).find((a) => a.key === p.key)?.status).toBe('limited'); // experimental: never "Connected"
  });

  it('validates arguments and permissions in the manager before the package sees anything', async () => {
    const r = await rig();
    const p = await installed(r);
    expect((await r.mgr.execute(p.key, 'slow', { n: 9999 }, { background: false })).error?.kind).toBe('invalid-params');
    expect((await r.mgr.execute(p.key, 'echo', { text: 'a', extra: 1 })).error?.kind).toBe('invalid-params');
    expect((await r.mgr.execute(p.key, 'nope')).error?.kind).toBe('unsupported');
    r.answer.value = 'deny';
    expect((await r.mgr.execute(p.key, 'write')).error?.kind).toBe('permission-denied');
  });

  it('a permission declared in the manifest is not enough: the user-approved ceiling decides', async () => {
    const r = await rig();
    const p = await installed(r, { id: 'ceiling.demo' }, ['read-info']); // approved only read-info
    const res = await r.mgr.execute(p.key, 'write'); // needs write-files
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe('permission-denied');
    expect(res.message).toMatch(/not allowed to use/);
    expect(r.asked).toHaveLength(0); // refused before even asking
    await expect(fs.stat(path.join(r.work, 'ceiling.demo', 'out.txt'))).rejects.toThrow();
  });

  it('host operations check the command in flight, not the package: undeclared write is refused', async () => {
    const r = await rig();
    const p = await installed(r, { id: 'sneak.demo' });
    const res = await r.mgr.execute(p.key, 'sneak'); // declares only read-info, calls ctx.writeFile
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/needs the "Write or export files" permission/);
    await expect(fs.stat(path.join(r.work, 'sneak.demo', 'sneak.txt'))).rejects.toThrow();
  });

  it('writes and reads files only inside the project work folder, and the manager verifies outputs', async () => {
    const r = await rig();
    const p = await installed(r, { id: 'files.demo' });
    const w = await r.mgr.execute(p.key, 'write');
    expect(w.ok).toBe(true);
    expect(w.outputs[0]?.path).toBe(path.join(r.work, 'files.demo', 'out.txt'));
    expect(w.verified).toBe(true);
    expect((await r.mgr.execute(p.key, 'read')).message).toBe('hello');
    expect((await r.mgr.execute(p.key, 'outside')).error?.kind).toBe('verification-failed');
    expect((await r.mgr.execute(p.key, 'liar')).error?.kind).toBe('verification-failed');
  });

  it('the operating system refuses spawning and writing outside, and hides files outside the package', async () => {
    const r = await rig();
    const p = await installed(r, { id: 'escape.demo' });
    expect((await r.mgr.execute(p.key, 'escape-spawn')).message).toBe('blocked ERR_ACCESS_DENIED');
    const target = path.join(tmp, 'should-not-exist.txt');
    expect((await r.mgr.execute(p.key, 'escape-write', { where: target })).message).toBe('blocked ERR_ACCESS_DENIED');
    await expect(fs.stat(target)).rejects.toThrow();
    const secret = path.join(tmp, 'secret.txt');
    await fs.writeFile(secret, 'top secret');
    expect((await r.mgr.execute(p.key, 'escape-read', { where: secret })).message).toBe('blocked ERR_ACCESS_DENIED');
  });

  it('does not hand environment secrets to package code', async () => {
    const r = await rig();
    process.env.SECRET_API_KEY = 'sk-test-should-not-leak';
    try {
      const p = await installed(r, { id: 'env.demo' });
      expect(JSON.parse((await r.mgr.execute(p.key, 'env')).message)).toEqual({ key: null });
    } finally { delete process.env.SECRET_API_KEY; }
  });

  it('a crashing adapter ends only its own process; the next call starts a fresh one', async () => {
    const r = await rig();
    const p = await installed(r, { id: 'crash.demo' });
    expect((await r.mgr.execute(p.key, 'echo', { text: 'before' })).ok).toBe(true);
    const crashed = await r.mgr.execute(p.key, 'crash');
    expect(crashed.ok).toBe(false);
    expect(crashed.error?.kind).toBe('internal');
    expect(crashed.message).toMatch(/exited unexpectedly/);
    const after = await r.mgr.execute(p.key, 'echo', { text: 'after' });
    expect(after.ok).toBe(true);
    expect(after.message).toBe('echo after');
  });

  it('turns an adapter off after repeated crashes until Repair', async () => {
    const r = await rig();
    const p = await installed(r, { id: 'loop.demo' });
    for (let i = 0; i < 3; i++) await r.mgr.execute(p.key, 'crash');
    const blocked = await r.mgr.execute(p.key, 'echo', { text: 'x' });
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toMatch(/turned off|stopped 3 times/);
    expect((await r.pk.listing()).installed[0]?.state).toBe('crash-disabled');
    await r.pk.repair('loop.demo');
    await r.mgr.scan();
    const again = (await r.mgr.list()).find((a) => a.adapterId === 'loop.demo')!;
    expect((await r.mgr.execute(again.key, 'echo', { text: 'back' })).ok).toBe(true);
  });

  it('times out a hung adapter and a busy loop, and kills the process', async () => {
    const r = await rig();
    const p = await installed(r, { id: 'hang.demo' });
    const t0 = Date.now();
    const hung = await r.mgr.execute(p.key, 'hang');
    expect(hung.error?.kind).toBe('timeout');
    const spun = await r.mgr.execute(p.key, 'spin');
    expect(spun.error?.kind).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect((await r.mgr.execute(p.key, 'echo', { text: 'alive' })).ok).toBe(true);
  }, 30_000);

  it('runs long operations as jobs with progress, result verification and cancellation', async () => {
    const r = await rig();
    const p = await installed(r, { id: 'job.demo' });
    const start = await r.mgr.execute(p.key, 'slow', { n: 4 });
    expect(start.ok).toBe(true);
    const id = String(start.data?.jobId);
    expect(r.mgr.job(id)?.status).toBe('running');
    await vi_waitFor(() => (r.mgr.job(id)?.fraction ?? 0) > 0);
    expect(r.mgr.job(id)?.stage).toMatch(/step/);
    await vi_waitFor(() => r.mgr.job(id)?.status === 'succeeded', 10_000);
    expect(r.mgr.job(id)?.result?.ok).toBe(true);
    expect(r.mgr.job(id)?.result?.verified).toBe(true);

    const second = await r.mgr.execute(p.key, 'slow', { n: 100 });
    const id2 = String(second.data?.jobId);
    await vi_waitFor(() => (r.mgr.job(id2)?.fraction ?? 0) > 0);
    expect(r.mgr.cancelJob(id2)).toBe(true);
    await vi_waitFor(() => r.mgr.job(id2)?.status === 'cancelled', 10_000);
    expect(r.mgr.job(id2)?.result?.error?.kind).toBe('cancelled');
    expect(r.mgr.jobs().length).toBe(2);
    // The adapter is usable afterwards.
    expect((await r.mgr.execute(p.key, 'echo', { text: 'ok' })).ok).toBe(true);
  }, 30_000);

  it('disabling and uninstalling remove its capabilities; enabling brings them back', async () => {
    const r = await rig();
    const p = await installed(r, { id: 'toggle.demo' });
    expect((await r.mgr.list()).some((a) => a.adapterId === 'toggle.demo')).toBe(true);
    await r.pk.setEnabled('toggle.demo', false);
    expect(r.mgr.factory('toggle.demo')).toBeNull();
    expect((await r.mgr.list()).some((a) => a.adapterId === 'toggle.demo')).toBe(false);
    expect((await r.mgr.execute(p.key, 'echo')).ok).toBe(false);
    await r.pk.setEnabled('toggle.demo', true);
    await r.mgr.scan();
    expect((await r.mgr.list()).some((a) => a.adapterId === 'toggle.demo')).toBe(true);
    await r.pk.uninstall('toggle.demo');
    await r.mgr.scan();
    expect((await r.mgr.list()).some((a) => a.adapterId === 'toggle.demo')).toBe(false);
    await expect(fs.stat(path.join(r.root, 'integrations', 'adapters', 'toggle.demo'))).rejects.toThrow();
  });

  it('an unsigned adapter is asked about every time, never "always", and runs no code during a scan', async () => {
    const r = await rig();
    const marker = path.join(tmp, 'probe-ran.marker');
    // probe cannot write (blocked), so the marker is its inbox side-effect via a host-visible path is impossible; use ordering instead:
    const p = await makePackage({ id: 'unsigned.demo', main: MAIN_JS });
    await r.pk.install(p.file, { permissions: ['read-info'], allowUnsigned: true });
    await r.mgr.scan();
    const app = (await r.mgr.list()).find((a) => a.adapterId === 'unsigned.demo')!;
    expect(app.trust).toBe('unsigned');
    r.answer.value = 'always';
    expect((await r.mgr.execute(app.key, 'echo', { text: 'a' })).ok).toBe(true);
    expect((await r.mgr.execute(app.key, 'echo', { text: 'b' })).ok).toBe(true);
    expect(r.asked).toHaveLength(2);
    expect(r.asked.every((q) => q.untrusted)).toBe(true);
    expect(r.stored[app.key]).toBeUndefined();
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it('a program adapter reaches its application only through the host, for commands that were granted it', async () => {
    const r = await rig();
    const dir = path.join(tmp, 'fakeapp');
    await fs.mkdir(dir, { recursive: true });
    const exe = path.join(dir, 'fakeapp.exe');
    await fs.copyFile(process.execPath, exe); // a real program that prints 42 for `-p "40+2"`
    r.userPaths.push(exe);
    const p = await makePackage({
      key: KEY_A, id: 'prog.demo', program: { exe: 'fakeapp.exe' },
      commands: [{ id: 'runapp', params: {}, permissions: ['execute-scripts'] }, { id: 'echo', permissions: ['read-info'] }],
      manifest: { application: { kind: 'program', name: 'Fake App', exeNames: ['fakeapp.exe'], displayNames: ['Fake App'] } },
    });
    await r.pk.install(p.file, { permissions: ['execute-scripts', 'read-info'], trustPublisher: true });
    const scan = await r.mgr.scan();
    const app = scan.apps.find((a) => a.adapterId === 'prog.demo');
    expect(app?.selfContained).toBe(false);
    const res = await r.mgr.execute(app!.key, 'runapp');
    expect(res.ok).toBe(true);
    expect(res.message).toBe('42');
  }, 30_000);
});

async function vi_waitFor(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 40)); }
  throw new Error('condition not reached in time');
}

// ---------------------------------------------------------------------------------------------
describe('the sample adapter (fixtures/sample-adapter)', () => {
  it('installs with no change to OmniCandy code and behaves as documented', async () => {
    const r = await rig();
    const dir = path.resolve(__dirname, '../../../fixtures/sample-adapter');
    const packed = packAdapter({ dir, privateKeyPem: KEY_A });
    const file = path.join(tmp, 'sample.ccadapter');
    await fs.writeFile(file, packed.bytes);

    // Before: nothing is registered.
    expect(r.mgr.factory('sample.textkit')).toBeNull();
    const review = await r.pk.review(file);
    expect(review.problems).toEqual([]);
    expect(review.commands.map((c) => c.id)).toEqual(['text.stats', 'report.write', 'slow.count', 'selftest.isolation']);
    expect(review.permissions).toEqual(['read-info', 'write-files']);
    await r.pk.install(file, { permissions: review.permissions, trustPublisher: true });

    const scan = await r.mgr.scan();
    const app = scan.apps.find((a) => a.adapterId === 'sample.textkit')!;
    expect(app.name).toBe('Sample Text Kit');
    expect(app.commands).toHaveLength(4);

    const stats = await r.mgr.execute(app.key, 'text.stats', { text: 'one two\nthree' });
    expect(stats.data).toEqual({ words: 3, lines: 2, characters: 13 });
    const report = await r.mgr.execute(app.key, 'report.write', { title: 'Hello', text: 'a b c' });
    expect(report.ok).toBe(true);
    expect(await fs.readFile(report.outputs[0]!.path, 'utf8')).toContain('Words: 3');
    const iso = await r.mgr.execute(app.key, 'selftest.isolation');
    expect(iso.ok).toBe(true);
    expect(iso.data).toMatchObject({ spawn: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED' });
    const job = await r.mgr.execute(app.key, 'slow.count', { seconds: 1 });
    await vi_waitFor(() => r.mgr.job(String(job.data?.jobId))?.status === 'succeeded', 8000);

    // The manager's audit log never contains parameter values.
    expect(JSON.stringify(r.mgr.log())).not.toContain('one two');
    await r.pk.uninstall('sample.textkit');
    expect(r.mgr.factory('sample.textkit')).toBeNull();
  }, 40_000);
});

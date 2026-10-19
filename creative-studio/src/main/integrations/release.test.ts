// Distribution rules: where bundled connectors live once installed, the release gate, and publisher trust from bundled keys.

import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packAdapter } from '../../../scripts/pack-adapter.mjs';
import { inspectPackage, releaseCheck } from '../../../scripts/release-check.mjs';
import { bundledPaths, loadBundledPublishers } from './bundled';
import { PackageStore } from './packageStore';

const FIX = path.resolve(__dirname, '../../../fixtures');
let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-rel-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const keyPem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const DEV = keyPem();
const OFFICIAL = keyPem();

async function resources(opts: { key?: string; fixture?: string; listed?: string[]; extra?: Record<string, string> } = {}) {
  const dir = await fs.mkdtemp(path.join(tmp, 'res-'));
  await fs.mkdir(path.join(dir, 'adapters'), { recursive: true });
  await fs.mkdir(path.join(dir, 'trust'), { recursive: true });
  const p = packAdapter({ dir: path.join(FIX, opts.fixture ?? 'freecad-adapter'), privateKeyPem: opts.key });
  const file = path.join(dir, 'adapters', `${p.manifest.id}-${p.manifest.version}.ccadapter`);
  await fs.writeFile(file, p.bytes);
  await fs.writeFile(path.join(dir, 'trust', 'release-publishers.json'), JSON.stringify({ publishers: (opts.listed ?? []).map((f) => ({ name: 'OmniCandi', fingerprint: f })) }));
  for (const [n, t] of Object.entries(opts.extra ?? {})) { await fs.mkdir(path.dirname(path.join(dir, n)), { recursive: true }); await fs.writeFile(path.join(dir, n), t); }
  return { dir, file, fingerprint: p.fingerprint as string | null };
}

describe('bundled resources', () => {
  it('finds connectors next to the installed program, not in the repository', () => {
    const dev = bundledPaths({ packaged: false, resourcesPath: 'C:\\Program Files\\OmniCandi\\resources', appPath: 'E:\\repo' });
    expect(dev.adaptersDir).toBe(path.join('E:\\repo', 'resources', 'adapters'));
    const inst = bundledPaths({ packaged: true, resourcesPath: 'C:\\Program Files\\OmniCandi\\resources', appPath: 'C:\\Program Files\\OmniCandi\\resources\\app.asar' });
    expect(inst.adaptersDir).toBe(path.join('C:\\Program Files\\OmniCandi\\resources', 'adapters'));
    expect(inst.publishersFile).toBe(path.join('C:\\Program Files\\OmniCandi\\resources', 'trust', 'release-publishers.json'));
  });

  it('reads only well-formed fingerprints from the release list; the shipped list is empty', async () => {
    const f = path.join(tmp, 'pub.json');
    await fs.writeFile(f, JSON.stringify({ publishers: [{ fingerprint: 'e970 10fe 35fe 418c bdeb 5a19 79dc c0ec' }, { fingerprint: 'not a fingerprint' }, { name: 'x' }] }));
    expect(loadBundledPublishers(f)).toEqual(['E970 10FE 35FE 418C BDEB 5A19 79DC C0EC']);
    expect(loadBundledPublishers(path.join(tmp, 'missing.json'))).toEqual([]);
    expect(loadBundledPublishers(path.resolve(__dirname, '../../../resources/trust/release-publishers.json'))).toEqual([]);
  });

  it('the connector committed under resources/adapters is built from source, signed, and verifies', async () => {
    const dir = path.resolve(__dirname, '../../../resources/adapters');
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.ccadapter'));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      const r = inspectPackage(path.join(dir, n));
      expect(r.problems, n).toEqual([]);
      expect(['freecad', 'autodesk.revit']).toContain(r.id);
    }
    expect(names.length).toBe(2);
  });
});

describe('release gate', () => {
  it('refuses a connector signed with a key that is not an official release key', async () => {
    const r = await resources({ key: DEV });
    const res = releaseCheck(r.dir);
    expect(res.releasable).toBe(false);
    expect(res.errors.join()).toMatch(/not an official release key/);
    // A local test build may continue, but is never "releasable".
    const dev = releaseCheck(r.dir, { allowDev: true });
    expect(dev.errors).toEqual([]);
    expect(dev.warnings.length).toBe(1);
    expect(dev.releasable).toBe(false);
  });

  it('accepts a connector signed by a listed release key', async () => {
    const r0 = await resources({ key: OFFICIAL });
    const r = await resources({ key: OFFICIAL, listed: [r0.fingerprint!] });
    const res = releaseCheck(r.dir);
    expect(res.errors).toEqual([]);
    expect(res.releasable).toBe(true);
  });

  it('refuses unsigned, tampered, sample and simulated-application connectors', async () => {
    expect(releaseCheck((await resources({})).dir).errors.join()).toMatch(/not signed/);
    const r = await resources({ key: OFFICIAL });
    const bytes = await fs.readFile(r.file);
    bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
    await fs.writeFile(r.file, bytes);
    expect(releaseCheck(r.dir, { allowDev: true }).errors.length).toBeGreaterThan(0);
    expect(releaseCheck((await resources({ key: OFFICIAL, fixture: 'sample-adapter' })).dir).errors.join()).toMatch(/sample connectors/);
    expect(releaseCheck((await resources({ key: OFFICIAL, fixture: 'hybrid-sample' })).dir).errors.join()).toMatch(/sample connectors|simulated test application/);
  });

  it('refuses private keys, development folders, fixtures and other vendors\' programs', async () => {
    const f0 = await resources({ key: OFFICIAL });
    const r = await resources({ key: OFFICIAL, listed: [f0.fingerprint!], extra: { 'x/dev.pem': 'k', '.local/createcraft.key': 'k', 'fixtures/a.txt': 'x', 'vendor/Photoshop.exe': 'x', 'vendor/AcCore.dll': 'x', 'simcad/simcad.js': 'x' } });
    const errs = releaseCheck(r.dir).errors.join('\n');
    expect(errs).toMatch(/dev\.pem/);
    expect(errs).toMatch(/\.local/);
    expect(errs).toMatch(/fixtures/);
    expect(errs).toMatch(/Photoshop\.exe/);
    expect(errs).toMatch(/AcCore\.dll/);
    expect(errs).toMatch(/simcad/);
  });

  it('fails when the release publisher list is missing', async () => {
    const r = await resources({ key: OFFICIAL });
    await fs.rm(path.join(r.dir, 'trust', 'release-publishers.json'));
    expect(releaseCheck(r.dir).errors.join()).toMatch(/release-publishers\.json is missing/);
  });
});

describe('publisher trust from bundled keys', () => {
  it('a package signed by a bundled release key needs no new-publisher confirmation; any other key still does', async () => {
    const official = await resources({ key: OFFICIAL });
    const other = await resources({ key: DEV });
    const store = new PackageStore(path.join(tmp, 'store'), { conflicts: () => [], bundledPublishers: () => [official.fingerprint!] });
    expect((await store.review(official.file)).publisherTrusted).toBe(true);
    expect((await store.review(other.file)).publisherTrusted).toBe(false);
    const none = new PackageStore(path.join(tmp, 'store2'), { conflicts: () => [] });
    expect((await none.review(official.file)).publisherTrusted).toBe(false);
  });
});

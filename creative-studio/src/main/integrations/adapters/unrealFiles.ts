// Files for the Unreal adapter: pictures that become library assets, and "bundles" that carry Unreal content between projects.
//
// A bundle is ONE file, `<name>.unrealbundle` (a ZIP): a bundle.json manifest and the saved asset packages under Content/, in the same
// layout as an Unreal project's Content folder, each with its SHA-256. It lives in the OmniCandy project (work/external/unreal/bundles)
// like Blender's .blend files, can be copied to any other OmniCandy project, and is installed into any Unreal project's Content folder with
// bundle.import. Every copy is read back and compared by hash; nothing is claimed that was not re-read.
//
// The Unreal MCP server gives no disk paths, so the project's Content folder is recovered from Unreal's own log (the line of the level it
// loaded, or of any package it saved) and accepted only if the open level's file really exists there.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readZip, writeZip, ZipError, type ZipLimits } from '../zip';
import { AdapterError } from '../sdk';

type Obj = Record<string, unknown>;
export interface UnrealIO { tool(toolset: string, tool: string, args: Obj): Promise<unknown> }

export const ASSETS = 'editor_toolset.toolsets.asset.AssetTools';
export const LOGS = 'EditorToolset.LogsToolset';
export const BUNDLE_EXT = '.unrealbundle';
export const BUNDLE_FORMAT = 'omnicandy-unreal-bundle';
const MB = 1024 * 1024;
export const BUNDLE_LIMITS: ZipLimits = { maxFiles: 3000, maxFileBytes: 200 * MB, maxTotalBytes: 400 * MB };
export const MAX_PACKAGES = 300;
const FILE_EXTS = ['.uasset', '.umap', '.uexp', '.ubulk', '.uptnl', '.upayload'];
const ALLOWED_EXT = new Set(FILE_EXTS);
/** Where Unreal keeps the actors of a World Partition / external-actors level, next to (not inside) the level file. */
const ACTOR_DIRS = ['__ExternalActors__', '__ExternalObjects__'];

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
export const isGamePackage = (p: unknown): p is string => typeof p === 'string' && p.length <= 240 && /^\/Game(\/[A-Za-z0-9_-]+)+$/.test(p);
const fileExists = (p: string) => fs.stat(p).then((s) => s.isFile(), () => false);

/** The project root of an OmniCandy project when the work folder is <root>/work/external/<id>; otherwise the work folder itself. */
export function projectRootOf(workDir: string): string {
  const w = path.resolve(workDir);
  const parts = w.split(path.sep);
  const n = parts.length;
  return n >= 4 && parts[n - 3] === 'work' && parts[n - 2] === 'external' ? parts.slice(0, n - 3).join(path.sep) || path.sep : w;
}

/** PNG signature and size, so a "picture" that is not one is never handed on. */
export function pngInfo(b: Buffer): { width: number; height: number } | null {
  if (b.length < 33 || b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

// ---------------------------------------------------------------------------------------------------------------- content folder

async function logLines(io: UnrealIO, pattern: string, max: number): Promise<string[]> {
  const r = await io.tool(LOGS, 'GetLogEntries', { category: '', pattern, maxEntries: max });
  return (Array.isArray(r) ? r : []).map(String);
}

/** The project's Content folder (forward slashes, no trailing slash). `level` is the open level's package, e.g. /Game/ThirdPerson/Lvl. */
export async function findContentRoot(io: UnrealIO, level: string): Promise<string> {
  if (!isGamePackage(level)) throw new AdapterError('app-error', `The open level (${level || 'none'}) is not a saved project level, so the project's Content folder cannot be located. Save it into the project first.`);
  const rel = level.slice('/Game/'.length);
  const roots: string[] = [];
  for (const l of await logLines(io, '/Content/[^\'"]*\\.(umap|uasset)', 400)) {
    for (const m of l.matchAll(/((?:[A-Za-z]:)?\/[^'"\n]*?\/Content)\/[^'"\n]*\.(?:umap|uasset)/g)) {
      const r = m[1]!;
      if (!/\/Engine\/|\/Plugins\//.test(r) && !roots.includes(r)) roots.push(r);
    }
  }
  for (const r of roots.reverse()) if (await fileExists(`${r}/${rel}.umap`)) return r;
  throw new AdapterError('app-error', `Could not find the project's Content folder: no path in Unreal's log contains the open level ${level}. Save the level (level.save) so Unreal logs where it lives, then try again.`);
}

// ---------------------------------------------------------------------------------------------------------------- packages

/** An asset that was only just saved is not in Unreal's asset registry for a moment, and its dependency lookup fails; retry, then say so. */
async function dependenciesOf(io: UnrealIO, pkg: string): Promise<unknown> {
  const tries = Number(process.env.OMNICANDY_UNREAL_DEPS_TRIES) || 10;
  for (let i = 0; ; i++) {
    try { return await io.tool(ASSETS, 'get_dependencies', { asset_path: pkg }); } catch (e) {
      if (!(e instanceof AdapterError) || !/NoneType|not iterable/.test(e.message)) throw e;
      if (i + 1 >= tries) throw new AdapterError('app-error', `Unreal cannot list what ${pkg} depends on yet (it was only just saved and is not in its asset registry). Wait a few seconds and try again, or set include_dependencies to false.`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** The packages to carry: the requested ones plus what they depend on under /Game (engine and plugin content is not carried). */
export async function collectPackages(io: UnrealIO, requested: string[], includeDeps: boolean): Promise<{ packages: string[]; skipped: string[] }> {
  const seen = new Set<string>(), skipped = new Set<string>(), queue = [...requested];
  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p)) continue;
    seen.add(p);
    if (seen.size > MAX_PACKAGES) throw new AdapterError('invalid-params', `The bundle would hold more than ${MAX_PACKAGES} assets (dependencies included). Choose fewer assets or set include_dependencies to false.`);
    if (!includeDeps) continue;
    const deps = await dependenciesOf(io, p);
    for (const d of (Array.isArray(deps) ? deps : []).map(String)) {
      const pkg = d.split('.')[0]!;
      if (isGamePackage(pkg)) { if (!seen.has(pkg)) queue.push(pkg); } else skipped.add(pkg);
    }
  }
  return { packages: [...seen], skipped: [...skipped] };
}

async function walk(dir: string, cap: number, out: string[] = []): Promise<string[]> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length > cap) throw new AdapterError('app-error', `A level has more than ${cap} external actor files; bundle it in smaller parts.`);
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, cap, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Absolute files that make up one package on disk (asset or level file, sidecars, and a level's external actors). */
export async function filesOfPackage(root: string, pkg: string): Promise<string[]> {
  const rel = pkg.slice('/Game/'.length);
  const out: string[] = [];
  let isLevel = false;
  for (const ext of FILE_EXTS) if (await fileExists(`${root}/${rel}${ext}`)) { out.push(`${root}/${rel}${ext}`); if (ext === '.umap') isLevel = true; }
  if (isLevel) for (const d of ACTOR_DIRS) out.push(...(await walk(`${root}/${d}/${rel}`, 2000)).map((f) => f.split(path.sep).join('/')));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- bundle format

const fileEntry = z.object({ path: z.string().min(1).max(300), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const manifestSchema = z.object({
  format: z.literal(BUNDLE_FORMAT), version: z.literal(1),
  name: z.string().min(1).max(80), createdAt: z.string().max(40), engine: z.string().max(40).nullable(),
  assets: z.array(z.object({ package: z.string().max(240), files: z.array(fileEntry).min(1).max(2500) }).strict()).min(1).max(MAX_PACKAGES),
  skippedDependencies: z.array(z.string().max(240)).max(2000).default([]),
}).strict();
export type BundleManifest = z.infer<typeof manifestSchema>;

export const bundleFileName = (name: string): string => {
  const base = name.replace(/\.unrealbundle$/i, '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 60);
  if (!base) throw new AdapterError('invalid-params', 'The bundle name has no usable letters or digits.');
  return base;
};

export interface ExportResult { zipPath: string; manifestPath: string; manifest: BundleManifest; bytes: number; fileCount: number }

export async function exportBundle(io: UnrealIO, o: {
  name: string; assets: string[]; includeDeps: boolean; level: string; engine: string | null; workDir: string;
  progress: (stage: string, fraction?: number) => void;
}): Promise<ExportResult> {
  const name = bundleFileName(o.name);
  for (const a of o.assets) if ((await io.tool(ASSETS, 'exists', { path: a })) !== true) throw new AdapterError('invalid-params', `The project has no asset ${a}. Find the exact path with assets.find.`);
  o.progress('Locating the project', 0.05);
  const root = await findContentRoot(io, o.level);
  // A new, never-saved asset is not in Unreal's asset registry yet and its dependency lookup fails, so save what was asked for first.
  o.progress(`Saving ${o.assets.length} asset(s)`, 0.1);
  await io.tool(ASSETS, 'save_assets', { asset_paths: o.assets });
  const { packages, skipped } = await collectPackages(io, o.assets, o.includeDeps);
  o.progress(`Saving ${packages.length} asset(s)`, 0.15);
  for (let i = 0; i < packages.length; i += 50) await io.tool(ASSETS, 'save_assets', { asset_paths: packages.slice(i, i + 50) });
  const entries = new Map<string, Buffer>();
  const assets: BundleManifest['assets'] = [];
  let total = 0;
  for (const [i, pkg] of packages.entries()) {
    o.progress(`Reading ${pkg}`, 0.2 + 0.5 * (i / packages.length));
    const files = await filesOfPackage(root, pkg);
    if (!files.length) throw new AdapterError('verification-failed', `Unreal has no saved file for ${pkg} under ${root}, so it cannot be bundled (is it a Blueprint or asset that cannot be saved?).`);
    const list: BundleManifest['assets'][number]['files'] = [];
    for (const f of files) {
      const buf = await fs.readFile(f);
      total += buf.length;
      if (buf.length > BUNDLE_LIMITS.maxFileBytes || total > BUNDLE_LIMITS.maxTotalBytes) throw new AdapterError('invalid-params', `The bundle is larger than ${Math.round(BUNDLE_LIMITS.maxTotalBytes / MB)} MB. Choose fewer assets.`);
      const rel = `Content/${f.slice(root.length + 1)}`;
      entries.set(rel, buf);
      list.push({ path: rel, bytes: buf.length, sha256: sha256(buf) });
    }
    assets.push({ package: pkg, files: list });
  }
  if (entries.size + 1 > BUNDLE_LIMITS.maxFiles) throw new AdapterError('invalid-params', `The bundle would hold more than ${BUNDLE_LIMITS.maxFiles} files. Choose fewer assets.`);
  const manifest: BundleManifest = { format: BUNDLE_FORMAT, version: 1, name, createdAt: new Date().toISOString(), engine: o.engine, assets, skippedDependencies: skipped };
  const manifestText = JSON.stringify(manifest, null, 2);
  entries.set('bundle.json', Buffer.from(manifestText));
  o.progress('Writing the bundle', 0.8);
  const dir = path.join(o.workDir, 'bundles');
  await fs.mkdir(dir, { recursive: true });
  const zipPath = path.join(dir, `${name}${BUNDLE_EXT}`), manifestPath = path.join(dir, `${name}.json`);
  const tmp = `${zipPath}.tmp`;
  await fs.writeFile(tmp, writeZip(entries));
  await fs.rename(tmp, zipPath);
  await fs.writeFile(manifestPath, manifestText);
  // read the finished file back and compare every hash with what was read from the project
  o.progress('Checking the bundle', 0.92);
  const back = readZip(await fs.readFile(zipPath), BUNDLE_LIMITS);
  for (const a of assets) for (const f of a.files) {
    const b = back.get(f.path);
    if (!b || sha256(b) !== f.sha256) throw new AdapterError('verification-failed', `The written bundle does not contain an identical ${f.path}.`);
  }
  return { zipPath, manifestPath, manifest, bytes: (await fs.stat(zipPath)).size, fileCount: entries.size - 1 };
}

/** Reads and fully checks a bundle: ZIP safety, manifest schema, only expected Content/ files, sizes and hashes. */
export async function readBundle(file: string): Promise<{ manifest: BundleManifest; files: Map<string, Buffer> }> {
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) throw new AdapterError('invalid-params', `There is no bundle file at ${file}.`);
  if (st.size > BUNDLE_LIMITS.maxTotalBytes) throw new AdapterError('invalid-params', 'The bundle file is too large.');
  let zip: Map<string, Buffer>;
  try { zip = readZip(await fs.readFile(file), BUNDLE_LIMITS); } catch (e) { throw new AdapterError('invalid-params', `Not a valid bundle: ${e instanceof ZipError ? e.message : 'unreadable'}.`); }
  const mText = zip.get('bundle.json');
  if (!mText) throw new AdapterError('invalid-params', 'Not an OmniCandy Unreal bundle: bundle.json is missing.');
  let manifest: BundleManifest;
  try { manifest = manifestSchema.parse(JSON.parse(mText.toString('utf8'))); } catch { throw new AdapterError('invalid-params', 'Not an OmniCandy Unreal bundle: bundle.json is not valid.'); }
  const expected = new Map<string, { bytes: number; sha256: string }>();
  for (const a of manifest.assets) {
    if (!isGamePackage(a.package)) throw new AdapterError('invalid-params', `The bundle names an invalid package ${a.package}.`);
    for (const f of a.files) {
      if (!f.path.startsWith('Content/') || f.path.includes('..') || !ALLOWED_EXT.has(path.extname(f.path).toLowerCase())) throw new AdapterError('invalid-params', `The bundle holds a file that is not Unreal content: ${f.path}.`);
      expected.set(f.path, f);
    }
  }
  const files = new Map<string, Buffer>();
  for (const [p, b] of zip) {
    if (p === 'bundle.json') continue;
    const e = expected.get(p);
    if (!e) throw new AdapterError('invalid-params', `The bundle holds an unlisted file (${p}); it was refused.`);
    if (b.length !== e.bytes || sha256(b) !== e.sha256) throw new AdapterError('invalid-params', `The bundle is damaged: ${p} does not match its checksum.`);
    files.set(p, b);
  }
  for (const p of expected.keys()) if (!files.has(p)) throw new AdapterError('invalid-params', `The bundle is incomplete: ${p} is missing.`);
  return { manifest, files };
}

export interface InstallResult { written: string[]; overwritten: string[]; backupDir: string | null }

/** Copies a checked bundle into a project's Content folder. Existing files are refused unless `overwrite`, and then backed up first. */
export async function installBundle(o: { files: Map<string, Buffer>; root: string; overwrite: boolean; backupDir: string }): Promise<InstallResult> {
  const targets = [...o.files.keys()].map((rel) => ({ rel, abs: `${o.root}/${rel.slice('Content/'.length)}` }));
  const existing: typeof targets = [];
  for (const t of targets) if (await fileExists(t.abs)) existing.push(t);
  if (existing.length && !o.overwrite) {
    throw new AdapterError('invalid-params', `${existing.length} file(s) already exist in the project (first: ${existing.slice(0, 3).map((t) => t.rel).join(', ')}). Nothing was written. Set overwrite to true to replace them; the old versions are backed up first.`);
  }
  let backupDir: string | null = null;
  if (existing.length) {
    backupDir = path.join(o.backupDir, new Date().toISOString().replace(/[:.]/g, '-'));
    for (const t of existing) {
      const to = path.join(backupDir, t.rel);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(t.abs, to);
    }
  }
  const created: string[] = [];
  try {
    for (const t of targets) {
      await fs.mkdir(path.dirname(t.abs), { recursive: true });
      const tmp = `${t.abs}.omnicandy.tmp`;
      await fs.writeFile(tmp, o.files.get(t.rel)!);
      await fs.rename(tmp, t.abs);
      created.push(t.abs);
      const back = await fs.readFile(t.abs);
      if (sha256(back) !== sha256(o.files.get(t.rel)!)) throw new AdapterError('verification-failed', `${t.rel} was written but reads back differently.`);
    }
  } catch (e) {
    // undo: new files are removed, replaced ones are restored from the backup
    for (const abs of created) {
      const t = targets.find((x) => x.abs === abs)!;
      if (existing.includes(t) && backupDir) await fs.copyFile(path.join(backupDir, t.rel), abs).catch(() => undefined);
      else await fs.rm(abs, { force: true }).catch(() => undefined);
    }
    throw e;
  }
  return { written: targets.filter((t) => !existing.includes(t)).map((t) => t.rel), overwritten: existing.map((t) => t.rel), backupDir };
}

/** Packages of a bundle that Unreal can already see (asset exists) - polled because the editor notices new files a moment later. */
export async function waitForPackages(io: UnrealIO, packages: string[], timeoutMs: number, signal?: AbortSignal): Promise<string[]> {
  const t0 = Date.now();
  let missing = packages;
  for (;;) {
    const still: string[] = [];
    for (const p of missing) if ((await io.tool(ASSETS, 'exists', { path: p })) !== true) still.push(p);
    missing = still;
    if (!missing.length || Date.now() - t0 > timeoutMs || signal?.aborted) return missing;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

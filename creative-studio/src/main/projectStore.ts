// Portable project directory:
//   <root>/project.json   manifest (relative paths only)
//   <root>/workflow.json  persisted graph
//   <root>/originals/     immutable imported originals (written once, then marked read-only)
// Independent of Electron so it can be unit-tested.

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AssetRepository } from '@shared/contracts';
import { MANIFEST_FILE } from '@shared/deliver';
import type { Asset, AssetProvenance, ProjectManifest } from '@shared/types';
import { emptyGraph, type WorkflowGraph } from '@shared/workflow';
import { kindForExtension, sniffMedia } from './media';
import { parseManifest, parseWorkflow } from './schemas';

export async function sha256File(p: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(p)).digest('hex');
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

export class ProjectStore implements AssetRepository {
  private manifest: ProjectManifest | null = null;

  constructor(readonly root: string) {}

  private get manifestPath() { return path.join(this.root, 'project.json'); }
  private get workflowPath() { return path.join(this.root, 'workflow.json'); }

  async create(name: string): Promise<ProjectManifest> {
    await fs.mkdir(path.join(this.root, 'originals'), { recursive: true });
    const now = new Date().toISOString();
    this.manifest = { schemaVersion: 1, id: randomUUID(), name, createdAt: now, updatedAt: now, assets: [] };
    await this.persist();
    return this.manifest;
  }

  async exists(): Promise<boolean> {
    return fs.access(this.manifestPath).then(() => true, () => false);
  }

  async loadManifest(): Promise<ProjectManifest> {
    if (!this.manifest) this.manifest = parseManifest(JSON.parse(await fs.readFile(this.manifestPath, 'utf8')));
    return structuredClone(this.manifest);
  }

  private async persist() {
    if (!this.manifest) return;
    this.manifest.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.manifestPath, this.manifest);
  }

  /**
   * Copies `sourcePath` into originals/. The source is only read. Exact duplicates (same SHA-256)
   * are not copied again; the existing asset is returned with `duplicateOf` set.
   */
  async importFile(sourcePath: string, provenance?: Partial<AssetProvenance>): Promise<{ asset: Asset; duplicateOf?: string }> {
    return this.storeFile(sourcePath, {
      folder: 'originals',
      name: path.basename(sourcePath),
      move: false,
      provenance: { origin: 'imported', source: 'Imported by user', ...provenance },
    });
  }

  /**
   * Registers a file produced by a tool (e.g. PhotoCraft) as a new immutable version derived from
   * `parentId`. The file is moved from the work folder into versions/ and marked read-only.
   */
  async addDerivedFile(producedPath: string, meta: { name: string; parentId: string; provenance: Omit<AssetProvenance, 'createdAt'> }): Promise<Asset> {
    this.resolveInsideRoot(path.relative(this.root, producedPath).split(path.sep).join('/'));
    const m = await this.loadManifest();
    if (!m.assets.some((a) => a.id === meta.parentId)) throw new Error('Unknown parent asset.');
    const r = await this.storeFile(producedPath, { folder: 'versions', name: meta.name, move: true, parentId: meta.parentId, provenance: meta.provenance });
    return r.asset;
  }

  /**
   * Registers an AI-generated image (written into the work folder) as a new ORIGINAL with its
   * provenance (prompt, provider, model, settings). Moved into originals/ and marked read-only.
   */
  async addGeneratedFile(producedPath: string, meta: { name: string; provenance: Omit<AssetProvenance, 'createdAt' | 'origin'> }): Promise<{ asset: Asset; duplicateOf?: string }> {
    this.resolveInsideRoot(path.relative(this.root, producedPath).split(path.sep).join('/'));
    return this.storeFile(producedPath, { folder: 'originals', name: meta.name, move: true, provenance: { ...meta.provenance, origin: 'generated' } });
  }

  private async storeFile(
    sourcePath: string,
    o: { folder: 'originals' | 'versions'; name: string; move: boolean; parentId?: string; provenance: Partial<AssetProvenance> & Pick<AssetProvenance, 'origin' | 'source'> },
  ): Promise<{ asset: Asset; duplicateOf?: string }> {
    const m = await this.loadManifest().then(() => this.manifest!);
    const ext = path.extname(o.name).slice(1).toLowerCase();
    const kind = kindForExtension(ext);
    if (!kind) throw new Error(`Unsupported file type ".${ext}".`);
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) throw new Error('Not a regular file.');

    const hash = await sha256File(sourcePath);
    const existing = m.assets.find((a) => a.sha256 === hash);
    if (existing) {
      if (o.move) await fs.rm(sourcePath, { force: true });
      return { asset: structuredClone(existing), duplicateOf: existing.id };
    }

    const id = randomUUID();
    const safeBase = o.name.replace(/[^\w.\- ]+/g, '_');
    const relPath = `${o.folder}/${id.slice(0, 8)}-${safeBase}`;
    const dest = path.join(this.root, ...relPath.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (o.move) await fs.rename(sourcePath, dest);
    else await fs.copyFile(sourcePath, dest, fsc.COPYFILE_EXCL);
    await fs.chmod(dest, 0o444); // read-only: stored files are immutable; edits create new versions

    const fh = await fs.open(dest, 'r');
    const head = Buffer.alloc(Math.min(stat.size, 256 * 1024));
    await fh.read(head, 0, head.length, 0);
    // Video keeps its index (duration, size) at the end as often as at the start.
    let tail: Buffer | undefined;
    if (kind === 'video' && stat.size > head.length) {
      tail = Buffer.alloc(Math.min(stat.size - head.length, 1024 * 1024));
      await fh.read(tail, 0, tail.length, stat.size - tail.length);
    }
    await fh.close();

    const asset: Asset = {
      id,
      name: o.name,
      kind,
      relPath,
      sha256: hash,
      bytes: stat.size,
      sourceFormat: ext,
      ...sniffMedia(ext, head, tail),
      approval: 'none',
      provenance: { createdAt: new Date().toISOString(), ...o.provenance },
      ...(o.parentId ? { parentId: o.parentId } : {}),
    };
    m.assets.push(asset);
    await this.persist();
    return { asset: structuredClone(asset) };
  }

  /** Scratch folder for tool output before it is registered. Inside the project root. */
  async workDir(): Promise<string> {
    const d = path.join(this.root, 'work');
    await fs.mkdir(d, { recursive: true });
    return d;
  }

  /** Deliverables folder (mutable; exports may be overwritten by later runs). */
  async exportsDir(): Promise<string> {
    const d = path.join(this.root, 'exports');
    await fs.mkdir(d, { recursive: true });
    return d;
  }

  async listExports(): Promise<Array<{ name: string; bytes: number; modified: string }>> {
    const d = await this.exportsDir();
    const out = [];
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (!e.isFile() || e.name === MANIFEST_FILE || e.name.endsWith('.tmp')) continue;
      const st = await fs.stat(path.join(d, e.name));
      out.push({ name: e.name, bytes: st.size, modified: st.mtime.toISOString() });
    }
    return out.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async rename(name: string): Promise<void> {
    await this.loadManifest();
    this.manifest!.name = name;
    await this.persist();
  }

  async setRating(assetId: string, rating: number): Promise<ProjectManifest> {
    await this.loadManifest();
    const a = this.manifest!.assets.find((x) => x.id === assetId);
    if (!a) throw new Error('Unknown asset.');
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new Error('Rating must be 0–5.');
    a.rating = rating as Asset['rating'];
    await this.persist();
    return this.loadManifest();
  }

  /** Absolute path for an asset, guaranteed to be inside the project root. */
  async resolveAssetPath(assetId: string): Promise<string> {
    const m = await this.loadManifest();
    const a = m.assets.find((x) => x.id === assetId);
    if (!a) throw new Error('Unknown asset.');
    return this.resolveInsideRoot(a.relPath);
  }

  resolveInsideRoot(relPath: string): string {
    const root = path.resolve(this.root);
    const abs = path.resolve(root, ...relPath.split('/'));
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Path escapes the project root.');
    return abs;
  }

  async loadWorkflow(): Promise<WorkflowGraph> {
    try {
      return parseWorkflow(JSON.parse(await fs.readFile(this.workflowPath, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyGraph();
      throw err;
    }
  }

  async saveWorkflow(g: WorkflowGraph): Promise<void> {
    await writeJsonAtomic(this.workflowPath, parseWorkflow(g));
  }
}

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
    const m = await this.loadManifest().then(() => this.manifest!);
    const ext = path.extname(sourcePath).slice(1).toLowerCase();
    const kind = kindForExtension(ext);
    if (!kind) throw new Error(`Unsupported file type ".${ext}".`);
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) throw new Error('Not a regular file.');

    const hash = await sha256File(sourcePath);
    const existing = m.assets.find((a) => a.sha256 === hash);
    if (existing) return { asset: structuredClone(existing), duplicateOf: existing.id };

    const id = randomUUID();
    const safeBase = path.basename(sourcePath).replace(/[^\w.\- ]+/g, '_');
    const relPath = `originals/${id.slice(0, 8)}-${safeBase}`;
    const dest = path.join(this.root, ...relPath.split('/'));
    await fs.copyFile(sourcePath, dest, fsc.COPYFILE_EXCL);
    await fs.chmod(dest, 0o444); // read-only: originals are immutable

    const fh = await fs.open(dest, 'r');
    const head = Buffer.alloc(Math.min(stat.size, 256 * 1024));
    await fh.read(head, 0, head.length, 0);
    await fh.close();

    const asset: Asset = {
      id,
      name: path.basename(sourcePath),
      kind,
      relPath,
      sha256: hash,
      bytes: stat.size,
      sourceFormat: ext,
      ...sniffMedia(ext, head),
      approval: 'none',
      provenance: {
        origin: 'imported',
        source: 'Imported by user',
        createdAt: new Date().toISOString(),
        ...provenance,
      },
    };
    m.assets.push(asset);
    await this.persist();
    return { asset: structuredClone(asset) };
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

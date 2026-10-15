// Portable, self-contained project directory (paths in project.json are relative to it).
// Layout 2 (new projects): project.json, Assets/{Originals,Generated,Audio,Video,Documents}/,
//   Versions/, Exports/, Workflows/workflow.json, Previews/, Checkpoints/, one folder per
//   ArtCraft app (PhotoCraft/ ... FilmCraft/) for live working files, work/ (scratch).
// Layout 1 (older projects, left as they are): project.json, workflow.json, originals/,
//   versions/, exports/, work/.
// Stored files are written once and marked read-only. Independent of Electron for unit tests.

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EDITOR_APPS, type EditorAppId } from '@shared/appEditors';
import type { AssetRepository } from '@shared/contracts';
import { MANIFEST_FILE } from '@shared/deliver';
import type { ClaudeChatItem } from '@shared/claude';
import { HISTORY_FILE, HISTORY_FOLDER, MAX_SAVED_ITEMS, parseHistory } from '@shared/claudeHistory';
import type { Asset, AssetKind, AssetProvenance, ProjectManifest } from '@shared/types';
import { emptyGraph, type WorkflowGraph } from '@shared/workflow';
import type { WorkflowTemplate } from '@shared/workflowControl';
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

/** Folders of a layout-2 project, created up front so the structure is visible in Explorer. */
export const PROJECT_FOLDERS = [
  'Assets/Originals', 'Assets/Generated', 'Assets/Audio', 'Assets/Video', 'Assets/Documents',
  ...Object.values(EDITOR_APPS).map((a) => a.name),
  'Workflows', 'Previews', 'Versions', 'Exports', 'Checkpoints',
];

type StoreFolder = 'originals' | 'generated' | 'versions';

function v2Folder(folder: StoreFolder, kind: AssetKind): string {
  if (folder === 'versions') return 'Versions';
  if (folder === 'generated') return 'Assets/Generated';
  if (kind === 'audio') return 'Assets/Audio';
  if (kind === 'video') return 'Assets/Video';
  if (kind === 'design' || kind === 'project' || kind === 'document' || kind === 'sheet' || kind === 'deck') return 'Assets/Documents';
  return 'Assets/Originals';
}

/** One paid generation: the estimate shown to the user (not a confirmed charge). */
export interface SpendEntry { at: string; provider: string; model: string; images: number; estimateUsd: number; requestedBy: 'user' | 'claude' }

export interface WorkflowVersionInfo { id: string; savedAt: string; reason: string; steps: number }

export class ProjectStore implements AssetRepository {
  private manifest: ProjectManifest | null = null;

  constructor(readonly root: string) {}

  private get manifestPath() { return path.join(this.root, 'project.json'); }

  /** 2 for projects with the self-contained Phase 2 layout, 1 for older ones. */
  async layout(): Promise<1 | 2> {
    return (await this.loadManifest()).layout === 2 ? 2 : 1;
  }

  private async workflowPath() {
    return (await this.layout()) === 2 ? path.join(this.root, 'Workflows', 'workflow.json') : path.join(this.root, 'workflow.json');
  }

  async create(name: string): Promise<ProjectManifest> {
    for (const f of PROJECT_FOLDERS) await fs.mkdir(path.join(this.root, ...f.split('/')), { recursive: true });
    const now = new Date().toISOString();
    this.manifest = { schemaVersion: 1, layout: 2, id: randomUUID(), name, createdAt: now, updatedAt: now, assets: [] };
    await this.persist();
    return this.manifest;
  }

  /** Gives a copied project its own identity and name (used by Duplicate). */
  async regenerateIdentity(name: string): Promise<void> {
    await this.loadManifest();
    this.manifest!.id = randomUUID();
    this.manifest!.name = name;
    this.manifest!.createdAt = new Date().toISOString();
    await this.persist();
  }

  async exists(): Promise<boolean> {
    return fs.access(this.manifestPath).then(() => true, () => false);
  }

  async loadManifest(): Promise<ProjectManifest> {
    // Concurrent first loads must share one manifest object: two parses would leave callers
    // mutating different copies and silently lose whichever is persisted first.
    if (!this.manifest) {
      const parsed = parseManifest(JSON.parse(await fs.readFile(this.manifestPath, 'utf8')));
      this.manifest ??= parsed;
    }
    return structuredClone(this.manifest);
  }

  private async persist(touch = true) {
    if (!this.manifest) return;
    if (touch) this.manifest.updatedAt = new Date().toISOString();
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
    return this.storeFile(producedPath, { folder: 'generated', name: meta.name, move: true, provenance: { ...meta.provenance, origin: 'generated' } });
  }

  private async storeFile(
    sourcePath: string,
    o: { folder: StoreFolder; name: string; move: boolean; parentId?: string; provenance: Partial<AssetProvenance> & Pick<AssetProvenance, 'origin' | 'source'> },
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
    const folder = m.layout === 2 ? v2Folder(o.folder, kind) : o.folder === 'versions' ? 'versions' : 'originals';
    const relPath = `${folder}/${id.slice(0, 8)}-${safeBase}`;
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

  /** The project's saved Claude chat (`Claude/conversation.json`): travels with Move and Duplicate. */
  async readClaudeHistory(): Promise<ClaudeChatItem[]> {
    try { return parseHistory(JSON.parse(await fs.readFile(path.join(this.root, HISTORY_FOLDER, HISTORY_FILE), 'utf8'))); } catch { return []; }
  }

  async writeClaudeHistory(items: ClaudeChatItem[]): Promise<void> {
    const dir = path.join(this.root, HISTORY_FOLDER);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, HISTORY_FILE), { version: 1, items: items.slice(-MAX_SAVED_ITEMS) });
  }

  /** Scratch folder (or a subfolder) for tool output before it is registered. Inside the project root. */
  async workDir(...sub: string[]): Promise<string> {
    const d = path.join(this.root, 'work', ...sub);
    await fs.mkdir(d, { recursive: true });
    return d;
  }

  /** Where a live ArtCraft app writes working files: its own folder (layout 2) or work/<legacy>. */
  async appWorkDir(app: EditorAppId, legacy: string): Promise<string> {
    const d = (await this.layout()) === 2 ? path.join(this.root, EDITOR_APPS[app].name, 'work') : path.join(this.root, 'work', legacy);
    await fs.mkdir(d, { recursive: true });
    return d;
  }

  /** Deliverables folder (mutable; exports may be overwritten by later runs). */
  async exportsDir(): Promise<string> {
    const d = path.join(this.root, (await this.layout()) === 2 ? 'Exports' : 'exports');
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

  /** Saves project-level details (category, brief, Claude's objective, where the user left off). */
  async setMeta(patch: Partial<Pick<ProjectManifest, 'kind' | 'brief' | 'objective' | 'view'>>): Promise<void> {
    await this.loadManifest();
    Object.assign(this.manifest!, patch);
    // Remembering where the user left off is not an edit: it doesn't change "last edited".
    await this.persist(Object.keys(patch).some((k) => k !== 'view'));
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
      return parseWorkflow(JSON.parse(await fs.readFile(await this.workflowPath(), 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyGraph();
      throw err;
    }
  }

  /** Replaces the workflow with a plan; a non-empty current workflow is kept beside it as a dated backup. */
  async replaceWorkflow(g: WorkflowGraph): Promise<{ backedUp: string | null }> {
    const cur = await this.loadWorkflow();
    let backedUp: string | null = null;
    if (cur.nodes.length) {
      const file = await this.workflowPath();
      backedUp = path.join(path.dirname(file), `workflow-before-claude-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await writeJsonAtomic(backedUp, cur);
    }
    await this.saveWorkflow(g);
    return { backedUp };
  }

  // ---- Spending: a per-project limit and a ledger of estimated paid generation (never contains keys) ----
  private spendingPath() { return path.join(this.root, 'spending.json'); }
  async spending(): Promise<{ limitUsd: number | null; spentUsd: number; entries: SpendEntry[] }> {
    try {
      const j = JSON.parse(await fs.readFile(this.spendingPath(), 'utf8')) as { limitUsd?: number | null; entries?: SpendEntry[] };
      const entries = Array.isArray(j.entries) ? j.entries : [];
      return { limitUsd: typeof j.limitUsd === 'number' ? j.limitUsd : null, spentUsd: Math.round(entries.reduce((n, e) => n + e.estimateUsd, 0) * 10000) / 10000, entries };
    } catch { return { limitUsd: null, spentUsd: 0, entries: [] }; }
  }
  async setSpendingLimit(limitUsd: number | null): Promise<void> {
    if (limitUsd !== null && (!Number.isFinite(limitUsd) || limitUsd < 0 || limitUsd > 100000)) throw new Error('Enter a limit in dollars, or leave it empty for none.');
    const cur = await this.spending();
    await writeJsonAtomic(this.spendingPath(), { limitUsd, entries: cur.entries });
  }
  async recordSpend(e: SpendEntry): Promise<void> {
    const cur = await this.spending();
    await writeJsonAtomic(this.spendingPath(), { limitUsd: cur.limitUsd, entries: [...cur.entries, e].slice(-1000) });
  }

  // ---- Workflow versions (a snapshot per run start, Claude change or restore) and templates ----
  private async wfDir(sub: string) {
    const d = path.join(path.dirname(await this.workflowPath()), sub);
    await fs.mkdir(d, { recursive: true });
    return d;
  }

  /** Keeps the current workflow as a version (skipped when identical to the newest one). */
  async snapshotWorkflow(reason: string, g?: WorkflowGraph): Promise<WorkflowVersionInfo | null> {
    const graph = g ?? (await this.loadWorkflow());
    if (!graph.nodes.length) return null;
    const dir = await this.wfDir('history');
    const list = await this.listWorkflowVersions();
    const newest = list[0];
    if (newest) {
      const cur = JSON.parse(await fs.readFile(path.join(dir, `${newest.id}.json`), 'utf8')) as { graph: WorkflowGraph };
      if (JSON.stringify(cur.graph) === JSON.stringify(graph)) return null;
    }
    const savedAt = new Date().toISOString();
    const id = `v-${savedAt.replace(/[:.]/g, '-')}`;
    await writeJsonAtomic(path.join(dir, `${id}.json`), { savedAt, reason, graph });
    for (const old of list.slice(49)) await fs.rm(path.join(dir, `${old.id}.json`), { force: true });
    return { id, savedAt, reason, steps: graph.nodes.length };
  }

  /** Newest first. */
  async listWorkflowVersions(): Promise<WorkflowVersionInfo[]> {
    const dir = await this.wfDir('history');
    const out: WorkflowVersionInfo[] = [];
    for (const f of (await fs.readdir(dir)).filter((x) => /^v-.*\.json$/.test(x))) {
      try {
        const v = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as { savedAt: string; reason: string; graph: WorkflowGraph };
        out.push({ id: f.slice(0, -5), savedAt: v.savedAt, reason: v.reason, steps: v.graph.nodes.length });
      } catch { /* skip an unreadable version */ }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async readWorkflowVersion(id: string): Promise<WorkflowGraph> {
    if (!/^v-[\w-]+$/.test(id)) throw new Error('Unknown workflow version.');
    const raw = JSON.parse(await fs.readFile(path.join(await this.wfDir('history'), `${id}.json`), 'utf8').catch(() => { throw new Error('That workflow version no longer exists.'); })) as { graph: unknown };
    return parseWorkflow(raw.graph);
  }

  async saveWorkflowTemplate(t: WorkflowTemplate): Promise<void> {
    await writeJsonAtomic(path.join(await this.wfDir('templates'), `${t.id}.json`), t);
  }

  async listWorkflowTemplates(): Promise<WorkflowTemplate[]> {
    const dir = await this.wfDir('templates');
    const out: WorkflowTemplate[] = [];
    for (const f of (await fs.readdir(dir)).filter((x) => x.endsWith('.json'))) {
      try {
        const t = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as WorkflowTemplate;
        out.push({ ...t, graph: parseWorkflow(t.graph) });
      } catch { /* skip an unreadable template */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async setAssetApproval(assetIds: string[], state: Asset['approval']): Promise<void> {
    await this.loadManifest();
    let changed = false;
    for (const a of this.manifest!.assets) if (assetIds.includes(a.id) && a.approval !== state) { a.approval = state; changed = true; }
    if (changed) await this.persist();
  }

  async saveWorkflow(g: WorkflowGraph): Promise<void> {
    const file = await this.workflowPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeJsonAtomic(file, parseWorkflow(g));
  }
}

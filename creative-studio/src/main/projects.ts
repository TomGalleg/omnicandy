// Each project is one portable, self-contained folder (see projectStore.ts for the layout).
// Projects made before Phase 2 live under <userData>/projects/<key>/; new ones go to the default
// project folder the user chose (Settings, Projects & Storage) or a per-project folder, and their
// location is recorded in the registry <userData>/projects.json. Changing the default folder never
// moves an existing project. Removing a project moves its folder to the Recycle Bin.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectManifest, ProjectSummary } from '@shared/types';
import { emptyGraph } from '@shared/workflow';
import { ProjectStore, sha256File, writeJsonAtomic } from './projectStore';
import { ensureSampleProject } from './sampleProject';

const KEY = /^[A-Za-z0-9_-]{1,64}$/;
export const SAMPLE_KEY = 'sample-project';

interface State { current: string; recent: string[]; defaultDir?: string; locations: Record<string, string>; /** The order the owner arranged the list in (empty = most recent first). */ order?: string[] }

export interface StorageInfo {
  /** Where new projects go unless a folder is chosen when creating one. */
  defaultDir: string;
  /** True when the user chose it (false = the built-in folder under the app data directory). */
  isCustom: boolean;
  builtInDir: string;
  freeBytes: number | null;
  totalBytes: number | null;
}

/** A name that is safe as a Windows folder name. */
export function folderNameFor(name: string): string {
  const n = name.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 60);
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n) || !n ? 'Untitled project' : n;
}

/** Throws a plain-language error unless `dir` exists (or can be created) and can be written to. */
export async function checkWritableFolder(dir: string): Promise<void> {
  if (!path.isAbsolute(dir)) throw new Error('Choose a full folder path, for example D:\\OmniCandi Projects.');
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.createcraft-write-test-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
  } catch {
    throw new Error(`OmniCandi can't write to "${dir}". Pick a folder you have permission to change, or reconnect the drive.`);
  }
}

async function* walk(dir: string, rel = ''): AsyncGenerator<{ rel: string; dir: boolean }> {
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    yield { rel: r, dir: e.isDirectory() };
    if (e.isDirectory()) yield* walk(dir, r);
  }
}

/** Copies a folder tree and verifies every file (size and SHA-256) before returning. Stored files stay read-only. */
async function copyVerified(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const files: string[] = [];
  for await (const e of walk(src)) {
    const to = path.join(dest, ...e.rel.split('/'));
    if (e.dir) { await fs.mkdir(to, { recursive: true }); continue; }
    await fs.copyFile(path.join(src, ...e.rel.split('/')), to);
    files.push(e.rel);
  }
  for (const rel of files) {
    const a = path.join(src, ...rel.split('/'));
    const b = path.join(dest, ...rel.split('/'));
    if ((await fs.stat(a)).size !== (await fs.stat(b)).size || (await sha256File(a)) !== (await sha256File(b))) {
      throw new Error(`The copy of "${rel}" did not match the original. Nothing was changed.`);
    }
  }
}

async function rmWritable(dir: string) {
  try {
    for await (const e of walk(dir)) if (!e.dir) await fs.chmod(path.join(dir, ...e.rel.split('/')), 0o666).catch(() => {});
  } catch { /* folder missing */ }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export class ProjectManager {
  private store: ProjectStore | null = null;
  private storeKey: string | null = null;
  private loading: Promise<ProjectStore> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly fixturesDir: string,
    private readonly stateFile: string,
    private readonly trash: (dir: string) => Promise<void>,
  ) {}

  private cached: State | null = null;

  private async readState(): Promise<State> {
    if (this.cached) return structuredClone(this.cached);
    let st: State;
    try {
      const s = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as Partial<State>;
      const locations: Record<string, string> = {};
      if (s.locations && typeof s.locations === 'object') {
        for (const [k, v] of Object.entries(s.locations)) if (KEY.test(k) && typeof v === 'string' && path.isAbsolute(v)) locations[k] = v;
      }
      st = {
        current: typeof s.current === 'string' && KEY.test(s.current) ? s.current : SAMPLE_KEY,
        recent: Array.isArray(s.recent) ? s.recent.filter((k) => typeof k === 'string' && KEY.test(k)) : [],
        defaultDir: typeof s.defaultDir === 'string' && path.isAbsolute(s.defaultDir) ? s.defaultDir : undefined,
        order: Array.isArray(s.order) ? s.order.filter((k): k is string => typeof k === 'string' && KEY.test(k)).slice(0, 1000) : undefined,
        locations,
      };
    } catch {
      st = { current: SAMPLE_KEY, recent: [], locations: {} };
    }
    this.cached = st;
    return structuredClone(st);
  }

  private async writeState(s: State) {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await writeJsonAtomic(this.stateFile, s);
    this.cached = structuredClone(s);
  }

  /** The folder of a project: its recorded location, or <userData>/projects/<key>. */
  private async dirOf(key: string): Promise<string> {
    if (!KEY.test(key)) throw new Error('Invalid project.');
    return (await this.readState()).locations[key] ?? path.join(this.baseDir, key);
  }

  /** The open project (the sample project on first run, or if the remembered one is gone). */
  current(): Promise<ProjectStore> {
    if (this.store) return Promise.resolve(this.store);
    this.loading ??= (async () => {
      const st = await this.readState();
      const sample = await ensureSampleProject(await this.dirOf(SAMPLE_KEY), this.fixturesDir);
      let key = st.current;
      let store = key === SAMPLE_KEY ? sample : new ProjectStore(await this.dirOf(key));
      if (!(await store.exists())) { key = SAMPLE_KEY; store = sample; }
      this.store = store;
      this.storeKey = key;
      return store;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async currentKey(): Promise<string> {
    await this.current();
    return this.storeKey!;
  }

  /** A project's store by key (for thumbnails of projects that are not open). */
  async storeFor(key: string): Promise<ProjectStore> {
    if (key === this.storeKey && this.store) return this.store;
    const s = new ProjectStore(await this.dirOf(key));
    if (!(await s.exists())) throw new Error('No such project.');
    return s;
  }

  async list(): Promise<ProjectSummary[]> {
    await this.current();
    const st = await this.readState();
    const out: ProjectSummary[] = [];
    const entries = new Map<string, string>();
    for (const e of await fs.readdir(this.baseDir, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory() && KEY.test(e.name)) entries.set(e.name, path.join(this.baseDir, e.name));
    }
    for (const [k, dir] of Object.entries(st.locations)) entries.set(k, dir);
    for (const [name, dir] of entries) {
      const e = { name };
      try {
        const m = await new ProjectStore(dir).loadManifest();
        // Thumbnail: the newest saved version if any, else the largest picture.
        const pics = m.assets.filter((a) => a.kind === 'image' || a.kind === 'vector');
        const area = (a: { width?: number; height?: number }) => (a.width ?? 0) * (a.height ?? 0);
        const thumb = pics.filter((a) => a.parentId && a.kind === 'image').at(-1) ?? pics.slice().sort((x, y) => area(y) - area(x))[0];
        out.push({
          id: e.name, name: m.name, assetCount: m.assets.length,
          originals: m.assets.filter((a) => !a.parentId).length, versions: m.assets.filter((a) => a.parentId).length,
          createdAt: m.createdAt, updatedAt: m.updatedAt, thumbAssetId: thumb?.id ?? null,
          isOpen: e.name === this.storeKey, isSample: e.name === SAMPLE_KEY, folder: dir, kind: m.kind, brief: m.brief,
        });
      } catch {
        // A registered project whose folder is gone (drive unplugged, folder moved): keep it listed so it can be located again.
        if (st.locations[name]) {
          out.push({ id: name, name: path.basename(dir), folder: dir, missing: true, assetCount: 0, originals: 0, versions: 0, createdAt: '', updatedAt: '', thumbAssetId: null, isOpen: false, isSample: false });
        }
      }
    }
    // Arranged by hand: that order, with projects added since at the top (newest first). Otherwise the open project first, then most recent.
    if (st.order?.length) {
      const pos = (k: string) => st.order!.indexOf(k);
      const rankNew = (k: string) => { const i = st.recent.indexOf(k); return i < 0 ? 1e6 : i; };
      return out.map((p) => ({ ...p, arranged: true })).sort((a, b) => (pos(a.id) < 0 ? -1 : pos(a.id)) - (pos(b.id) < 0 ? -1 : pos(b.id)) || rankNew(a.id) - rankNew(b.id) || b.updatedAt.localeCompare(a.updatedAt));
    }
    const rank = (k: string) => { const i = st.recent.indexOf(k); return i < 0 ? 1e6 : i; };
    return out.sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || rank(a.id) - rank(b.id) || b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Remembers the order the owner arranged the list in. Only known projects count; an empty list returns to most recent first. */
  async setOrder(keys: string[]): Promise<void> {
    const st = await this.readState();
    const known = new Set([...Object.keys(st.locations), ...(await fs.readdir(this.baseDir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && KEY.test(e.name)).map((e) => e.name)]);
    const order = [...new Set(keys.filter((k) => KEY.test(k) && known.has(k)))];
    await this.writeState({ ...st, order: order.length ? order : undefined });
  }

  async open(key: string): Promise<ProjectStore> {
    const store = await this.storeFor(key);
    this.store = store;
    this.storeKey = key;
    const st = await this.readState();
    await this.writeState({ ...st, current: key, recent: [key, ...st.recent.filter((k) => k !== key)].slice(0, 20) });
    return store;
  }

  /** Creates a project in `parentDir` (or the default project folder); returns its key (does not open it). */
  async create(name: string, parentDir?: string, meta?: Pick<ProjectManifest, 'kind' | 'brief' | 'objective'>): Promise<string> {
    const clean = name.trim().slice(0, 80) || 'Untitled project';
    const key = `p-${randomUUID().slice(0, 8)}`;
    const st = await this.readState();
    const parent = parentDir ?? st.defaultDir;
    let dir: string;
    if (!parent) {
      dir = path.join(this.baseDir, key);
    } else {
      await checkWritableFolder(parent);
      const base = folderNameFor(clean);
      dir = path.join(parent, base);
      for (let i = 2; await fs.access(dir).then(() => true, () => false); i++) dir = path.join(parent, `${base} ${i}`);
      await this.writeState({ ...st, locations: { ...st.locations, [key]: dir } });
    }
    const store = new ProjectStore(dir);
    await store.create(clean);
    if (meta && (meta.kind || meta.brief || meta.objective)) await store.setMeta(meta);
    await store.saveWorkflow(emptyGraph());
    return key;
  }

  async rename(key: string, name: string): Promise<void> {
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new Error('Give the project a name.');
    await (await this.storeFor(key)).rename(clean);
  }

  /** Moves a project's folder to the Recycle Bin (recoverable). The open project can't be removed. */
  async remove(key: string): Promise<void> {
    if (key === this.storeKey) throw new Error('Open another project first, then remove this one.');
    if (key === SAMPLE_KEY) throw new Error('The Sample Project stays; it is recreated anyway.');
    await this.storeFor(key);
    await this.trash(await this.dirOf(key));
    const st = await this.readState();
    const locations = { ...st.locations };
    delete locations[key];
    await this.writeState({ ...st, recent: st.recent.filter((k) => k !== key), order: st.order?.filter((k) => k !== key), locations });
  }

  async folder(key: string): Promise<string> { return this.dirOf(key); }

  /** Registers an existing project folder (from any drive) so it appears in the list; returns its key. */
  async addExisting(dir: string): Promise<string> {
    const abs = path.resolve(dir);
    if (!(await new ProjectStore(abs).exists())) throw new Error('That folder is not an OmniCandi project (no project.json).');
    const st = await this.readState();
    const known = Object.entries(st.locations).find(([, v]) => path.resolve(v).toLowerCase() === abs.toLowerCase());
    if (known) return known[0];
    if (path.resolve(path.dirname(abs)).toLowerCase() === path.resolve(this.baseDir).toLowerCase() && KEY.test(path.basename(abs))) return path.basename(abs);
    const m = await new ProjectStore(abs).loadManifest();
    const clash = (await this.list()).find((p) => !p.missing && p.folder !== abs && p.id && m.id && p.id === m.id);
    if (clash) throw new Error('A project with this identity is already in the list.');
    const key = `p-${randomUUID().slice(0, 8)}`;
    await this.writeState({ ...st, locations: { ...st.locations, [key]: abs } });
    return key;
  }

  /** Points a missing project at the folder where it now lives (must be the same project). */
  async relocate(key: string, dir: string): Promise<void> {
    const st = await this.readState();
    if (!st.locations[key]) throw new Error('This project is stored in the default location and does not need locating.');
    const target = new ProjectStore(path.resolve(dir));
    if (!(await target.exists())) throw new Error('That folder is not an OmniCandi project (no project.json).');
    await this.writeState({ ...st, locations: { ...st.locations, [key]: path.resolve(dir) } });
  }

  /** A full independent copy in `parentDir` (or beside the default), under a new name and identity. */
  async duplicate(key: string, parentDir?: string): Promise<string> {
    const src = await this.dirOf(key);
    const srcStore = await this.storeFor(key);
    const m = await srcStore.loadManifest();
    const st = await this.readState();
    const parent = parentDir ?? st.defaultDir ?? path.dirname(src);
    await checkWritableFolder(parent);
    const name = `${m.name} copy`.slice(0, 80);
    const base = folderNameFor(name);
    let dest = path.join(parent, base);
    for (let i = 2; await fs.access(dest).then(() => true, () => false); i++) dest = path.join(parent, `${base} ${i}`);
    await copyVerified(src, dest);
    const newKey = `p-${randomUUID().slice(0, 8)}`;
    const copy = new ProjectStore(dest);
    await copy.regenerateIdentity(name);
    const st2 = await this.readState();
    await this.writeState({ ...st2, locations: { ...st2.locations, [newKey]: dest } });
    return newKey;
  }

  /**
   * Moves a project to a new parent folder. The files are copied and checked (size and SHA-256)
   * under a temporary name, switched over atomically, and only then is the old folder sent to the
   * Recycle Bin. If anything fails or is interrupted, the original is untouched.
   */
  async move(key: string, parentDir: string): Promise<string> {
    if (key === this.storeKey) throw new Error('Open another project first, then move this one.');
    if (key === SAMPLE_KEY) throw new Error('The Sample Project stays where it is.');
    const src = await this.dirOf(key);
    await this.storeFor(key);
    await checkWritableFolder(parentDir);
    const dest = path.join(path.resolve(parentDir), path.basename(src));
    if (path.resolve(dest).toLowerCase() === path.resolve(src).toLowerCase()) throw new Error('The project is already in that folder.');
    if (path.resolve(dest).toLowerCase().startsWith(path.resolve(src).toLowerCase() + path.sep)) throw new Error('Choose a folder outside the project.');
    if (await fs.access(dest).then(() => true, () => false)) throw new Error(`A folder named "${path.basename(src)}" already exists there.`);
    const tmp = `${dest}.moving`;
    await fs.rm(tmp, { recursive: true, force: true });
    try {
      await copyVerified(src, tmp);
      await fs.rename(tmp, dest);
    } catch (e) {
      await rmWritable(tmp);
      throw e;
    }
    const st = await this.readState();
    await this.writeState({ ...st, locations: { ...st.locations, [key]: dest } });
    await this.trash(src).catch(() => { /* the copy is in place and registered; a leftover original is harmless */ });
    return dest;
  }

  async storageInfo(): Promise<StorageInfo> {
    const st = await this.readState();
    const dir = st.defaultDir ?? this.baseDir;
    let freeBytes: number | null = null;
    let totalBytes: number | null = null;
    try {
      await fs.mkdir(dir, { recursive: true });
      const s = await fs.statfs(dir);
      freeBytes = Number(s.bavail) * Number(s.bsize);
      totalBytes = Number(s.blocks) * Number(s.bsize);
    } catch { /* unknown (for example a disconnected network drive) */ }
    return { defaultDir: dir, isCustom: !!st.defaultDir, builtInDir: this.baseDir, freeBytes, totalBytes };
  }

  /** Sets the folder new projects go to (null = back to the built-in folder). Existing projects stay where they are. */
  async setDefaultDir(dir: string | null): Promise<StorageInfo> {
    const st = await this.readState();
    if (dir === null) {
      await this.writeState({ ...st, defaultDir: undefined });
    } else {
      await checkWritableFolder(dir);
      await this.writeState({ ...st, defaultDir: path.resolve(dir) });
    }
    return this.storageInfo();
  }
}

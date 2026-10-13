// All projects under <userData>/projects/<key>/ (one portable folder each: project.json,
// workflow.json, originals/, versions/, exports/, work/). Remembers the open project and recent
// order in <userData>/projects.json. Removing a project moves its folder to the Recycle Bin.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectSummary } from '@shared/types';
import { emptyGraph } from '@shared/workflow';
import { ProjectStore } from './projectStore';
import { ensureSampleProject } from './sampleProject';

const KEY = /^[A-Za-z0-9_-]{1,64}$/;
export const SAMPLE_KEY = 'sample-project';

interface State { current: string; recent: string[] }

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

  private dir(key: string) {
    if (!KEY.test(key)) throw new Error('Invalid project.');
    return path.join(this.baseDir, key);
  }

  private async readState(): Promise<State> {
    try {
      const s = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as Partial<State>;
      return { current: typeof s.current === 'string' && KEY.test(s.current) ? s.current : SAMPLE_KEY, recent: Array.isArray(s.recent) ? s.recent.filter((k) => typeof k === 'string' && KEY.test(k)) : [] };
    } catch {
      return { current: SAMPLE_KEY, recent: [] };
    }
  }

  private async writeState(s: State) {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, JSON.stringify(s, null, 2), 'utf8');
  }

  /** The open project (the sample project on first run, or if the remembered one is gone). */
  current(): Promise<ProjectStore> {
    if (this.store) return Promise.resolve(this.store);
    this.loading ??= (async () => {
      const st = await this.readState();
      const sample = await ensureSampleProject(this.dir(SAMPLE_KEY), this.fixturesDir);
      let key = st.current;
      let store = key === SAMPLE_KEY ? sample : new ProjectStore(this.dir(key));
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
    const s = new ProjectStore(this.dir(key));
    if (!(await s.exists())) throw new Error('No such project.');
    return s;
  }

  async list(): Promise<ProjectSummary[]> {
    await this.current();
    const st = await this.readState();
    const out: ProjectSummary[] = [];
    for (const e of await fs.readdir(this.baseDir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || !KEY.test(e.name)) continue;
      try {
        const m = await new ProjectStore(this.dir(e.name)).loadManifest();
        // Thumbnail: the newest saved version if any, else the largest picture.
        const pics = m.assets.filter((a) => a.kind === 'image' || a.kind === 'vector');
        const area = (a: { width?: number; height?: number }) => (a.width ?? 0) * (a.height ?? 0);
        const thumb = pics.filter((a) => a.parentId && a.kind === 'image').at(-1) ?? pics.slice().sort((x, y) => area(y) - area(x))[0];
        out.push({
          id: e.name, name: m.name, assetCount: m.assets.length,
          originals: m.assets.filter((a) => !a.parentId).length, versions: m.assets.filter((a) => a.parentId).length,
          createdAt: m.createdAt, updatedAt: m.updatedAt, thumbAssetId: thumb?.id ?? null,
          isOpen: e.name === this.storeKey, isSample: e.name === SAMPLE_KEY,
        });
      } catch { /* not a project folder */ }
    }
    const rank = (k: string) => { const i = st.recent.indexOf(k); return i < 0 ? 1e6 : i; };
    return out.sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || rank(a.id) - rank(b.id) || b.updatedAt.localeCompare(a.updatedAt));
  }

  async open(key: string): Promise<ProjectStore> {
    const store = await this.storeFor(key);
    this.store = store;
    this.storeKey = key;
    const st = await this.readState();
    await this.writeState({ current: key, recent: [key, ...st.recent.filter((k) => k !== key)].slice(0, 20) });
    return store;
  }

  async create(name: string): Promise<string> {
    const clean = name.trim().slice(0, 80) || 'Untitled project';
    const key = `p-${randomUUID().slice(0, 8)}`;
    const store = new ProjectStore(this.dir(key));
    await store.create(clean);
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
    await this.trash(this.dir(key));
    const st = await this.readState();
    await this.writeState({ ...st, recent: st.recent.filter((k) => k !== key) });
  }

  folder(key: string) { return this.dir(key); }
}

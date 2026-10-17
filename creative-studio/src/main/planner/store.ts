// Durable storage of planner projects, shared by CreateCraft and the planner MCP server (two processes, one folder):
//   <root>/projects/<id>/project.json     the whole current state (written atomically, never edited in place)
//   <root>/projects/<id>/history.jsonl    append-only activity log (who did what, at which revision)
//   <root>/projects/<id>/raw/<reportId>.txt   the original pasted response of an imported report
// Every change is read-modify-write under a lock file, so a connection and the app can never overwrite each other.
// A crash leaves either the old or the new project.json; the activity log is appended after the write and may lag by one entry.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type ActivityEntry, type Actor, canonical, type PlannerProject, type ProjectSummary, snapshotOf, summarize } from '@shared/planner';

export class PlannerError extends Error {
  constructor(readonly code: 'not_found' | 'forbidden' | 'conflict' | 'invalid' | 'claimed' | 'duplicate' | 'blocked' | 'stale', message: string, readonly details?: unknown) {
    super(message);
    this.name = 'PlannerError';
  }
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(5).toString('hex')}`;
const ID_RE = /^plan_[a-z0-9]{6,20}$/;

export interface LogFn { (kind: string, summary: string, opts?: { targetId?: string; planAffecting?: boolean }): void }

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PlannerStore {
  constructor(readonly root: string, private readonly now: () => Date = () => new Date()) {}

  dir(id: string): string {
    if (!ID_RE.test(id)) throw new PlannerError('invalid', 'That is not a project id.');
    return path.join(this.root, 'projects', id);
  }
  private file(id: string) { return path.join(this.dir(id), 'project.json'); }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const lock = path.join(this.dir(id), 'project.lock');
    for (let i = 0; ; i++) {
      try {
        const h = await fs.open(lock, 'wx');
        await h.writeFile(String(process.pid));
        await h.close();
        break;
      } catch (e) {
        // Windows reports EPERM/EBUSY/EACCES while another process is deleting or holding the lock file.
        if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
        // A lock older than 20 s belongs to a process that died.
        const age = await fs.stat(lock).then((s) => Date.now() - s.mtimeMs).catch(() => 0);
        if (age > 20_000) { await fs.rm(lock, { force: true }); continue; }
        if (i > 200) throw new PlannerError('conflict', 'The project is busy. Try again in a moment.');
        await sleep(15 + Math.random() * 25);
      }
    }
    try { return await fn(); } finally { await fs.rm(lock, { force: true }); }
  }

  async list(): Promise<ProjectSummary[]> {
    const base = path.join(this.root, 'projects');
    const names = await fs.readdir(base).catch(() => [] as string[]);
    const out: ProjectSummary[] = [];
    for (const n of names) {
      if (!ID_RE.test(n)) continue;
      try { out.push(summarize(await this.read(n))); } catch { /* a broken folder never hides the others */ }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async read(id: string): Promise<PlannerProject> {
    let text: string;
    try { text = await fs.readFile(this.file(id), 'utf8'); } catch { throw new PlannerError('not_found', 'No such project.'); }
    try { return JSON.parse(text) as PlannerProject; } catch { throw new PlannerError('invalid', 'The project file is damaged.'); }
  }

  /** Writes a brand-new project (id must be unused). */
  async create(project: PlannerProject, actor: Actor, first: string): Promise<PlannerProject> {
    const dir = this.dir(project.id);
    await fs.mkdir(dir, { recursive: true });
    project.planVersions = [{ planRevision: 1, at: project.createdAt, by: actor, reason: first, snapshot: snapshotOf(project) }];
    project.planRevision = 1;
    project.revision = 1;
    await this.withLock(project.id, async () => {
      if (await fs.stat(this.file(project.id)).then(() => true).catch(() => false)) throw new PlannerError('conflict', 'A project with that id already exists.');
      project.counters.activity = 1;
      await writeJsonAtomic(this.file(project.id), project);
      await this.append(project.id, [{ seq: 1, at: project.createdAt, actor, kind: 'project.created', summary: first, revision: 1, planAffecting: true }]);
    });
    return project;
  }

  private async append(id: string, entries: ActivityEntry[]) {
    if (!entries.length) return;
    await fs.appendFile(path.join(this.dir(id), 'history.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }

  /**
   * Applies `fn` to a copy of the project inside the lock. Nothing is written if it throws. The revision always bumps; the plan
   * revision bumps only when the accepted plan (its snapshot) actually changed, and that version is kept.
   */
  async mutate<T>(id: string, actor: Actor, fn: (p: PlannerProject, log: LogFn, now: Date) => T): Promise<T> {
    return this.withLock(id, async () => {
      const p = await this.read(id);
      const before = canonical(snapshotOf(p));
      const draft: PlannerProject = JSON.parse(JSON.stringify(p));
      const now = this.now();
      const entries: Array<Omit<ActivityEntry, 'seq' | 'revision' | 'actor' | 'at'>> = [];
      const result = fn(draft, (kind, summary, opts) => entries.push({ kind, summary, targetId: opts?.targetId, planAffecting: !!opts?.planAffecting }), now);
      if (!entries.length) return result;
      draft.revision = p.revision + 1;
      draft.updatedAt = now.toISOString();
      if (canonical(snapshotOf(draft)) !== before) {
        draft.planRevision = p.planRevision + 1;
        draft.planVersions.push({ planRevision: draft.planRevision, at: draft.updatedAt, by: actor, reason: entries[0]?.summary ?? '', snapshot: snapshotOf(draft) });
        for (const e of entries) e.planAffecting = true;
      }
      const log: ActivityEntry[] = entries.map((e) => ({ ...e, seq: ++draft.counters.activity, at: draft.updatedAt, actor, revision: draft.revision }));
      await writeJsonAtomic(this.file(id), draft);
      await this.append(id, log);
      return result;
    });
  }

  async history(id: string, sinceRevision = 0, limit = 500): Promise<ActivityEntry[]> {
    const text = await fs.readFile(path.join(this.dir(id), 'history.jsonl'), 'utf8').catch(() => '');
    const all: ActivityEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line) as ActivityEntry; if (e.revision > sinceRevision) all.push(e); } catch { /* a torn last line is ignored */ }
    }
    return all.slice(-limit);
  }

  async saveRaw(id: string, reportId: string, text: string) {
    const dir = path.join(this.dir(id), 'raw');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${reportId}.txt`), text.slice(0, 200_000), 'utf8');
  }
  async readRaw(id: string, reportId: string): Promise<string | null> {
    if (!/^rep_[a-z0-9]+$/.test(reportId)) return null;
    return fs.readFile(path.join(this.dir(id), 'raw', `${reportId}.txt`), 'utf8').catch(() => null);
  }
}

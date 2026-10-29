// Durable storage of planner projects, shared by OmniCandy and the planner MCP server (two processes, one folder):
//   <root>/projects/<id>/project.json     the whole current state (written atomically, never edited in place)
//   <root>/projects/<id>/history.jsonl    append-only activity log (who did what, at which revision)
//   <root>/projects/<id>/raw/<reportId>.txt   the original pasted response of an imported report
//   <root>/projects/<id>/chat.json        the planning conversation (+ chat.prev.json, the copy from before the last write)
//   <root>/projects/<id>/town.json        the project's town: team, businesses, workplaces, meetings (people and places, never the state of the work)
//   <root>/projects/<id>/canvas.json      where the cards sit (presentation only; never part of the plan, never touches a revision)
// Every change to the plan is read-modify-write under a lock file, so a connection and the app can never overwrite each other.
// A crash leaves either the old or the new project.json; the activity log is appended after the write and may lag by one entry.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type ActivityEntry, type Actor, canonical, type PlannerProject, type ProjectSummary, snapshotOf, summarize } from '@shared/planner';
import { defaultTown, townStateSchema, withDirectors, type TownState } from '@shared/town';
import { applyCanvasPatch, canvasLayoutSchema, CanvasLimitError, type CanvasLayout, type CanvasPatch, emptyCanvas } from '@shared/plannerCanvas';

export class PlannerError extends Error {
  constructor(readonly code: 'not_found' | 'forbidden' | 'conflict' | 'invalid' | 'claimed' | 'duplicate' | 'blocked' | 'stale', message: string, readonly details?: unknown) {
    super(message);
    this.name = 'PlannerError';
  }
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(5).toString('hex')}`;
const ID_RE = /^plan_[a-z0-9]{6,20}$/;

export interface LogFn { (kind: string, summary: string, opts?: { targetId?: string; planAffecting?: boolean }): void }

/** What the store tells a listener after it has written something (the event hub turns these into events for the windows). */
export type StoreWrite =
  | { kind: 'plan'; planId: string; revision: number; planRevision: number }
  | { kind: 'canvas'; planId: string; layoutRev: number }
  | { kind: 'chat'; planId: string; messages: number }
  | { kind: 'town'; planId: string; rev: number }
  | { kind: 'recovered'; planId: string; what: 'canvas' | 'chat' | 'town'; note: string };
export interface StoreOptions { onWrite?: (w: StoreWrite) => void }

export interface ChatMessage { role: 'user' | 'assistant'; text: string }
export interface ChatFile { messages: ChatMessage[]; provider?: string; model?: string; savedAt?: string }

/** The planning conversation keeps the newest messages only; each is cut to a bounded length. */
export const CHAT_KEEP_MESSAGES = 48;
export const CHAT_MAX_CHARS = 6000;
const KEEP_CORRUPT = 3;

/** The coordinator's conversation is `chat`; each worker has their own, `chat-<agentId>`. Only well-formed worker ids are accepted. */
function chatName(who?: string): string {
  if (who === undefined) return 'chat';
  if (!/^agent_[a-z0-9]{4,24}$/.test(who)) throw new PlannerError('invalid', 'That is not a worker id.');
  return `chat-${who}`;
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Windows reports EPERM/EBUSY/EACCES for a moment while another process holds a file; a few short retries ride that out. */
async function writeJsonRetry(file: string, data: unknown): Promise<void> {
  for (let i = 0; ; i++) {
    try { return await writeJsonAtomic(file, data); } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await sleep(10 + i * 10);
    }
  }
}

const exists = (f: string) => fs.stat(f).then(() => true, () => false);

/** Sets a damaged file aside (never deletes it) and keeps only the newest few. */
async function setAside(file: string, stamp: string): Promise<string> {
  const dir = path.dirname(file);
  const base = path.basename(file, '.json');
  const to = path.join(dir, `${base}.corrupt-${stamp}.json`);
  await fs.rename(file, to).catch(() => undefined);
  const old = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith(`${base}.corrupt-`)).sort();
  for (const n of old.slice(0, Math.max(0, old.length - KEEP_CORRUPT))) await fs.rm(path.join(dir, n), { force: true }).catch(() => undefined);
  return to;
}

function parseChat(text: string): ChatFile | null {
  let j: { messages?: unknown; provider?: unknown; model?: unknown; savedAt?: unknown };
  try { j = JSON.parse(text) as typeof j; } catch { return null; }
  if (!j || typeof j !== 'object' || (j.messages !== undefined && !Array.isArray(j.messages))) return null;
  const messages = (Array.isArray(j.messages) ? j.messages : [])
    .filter((m): m is ChatMessage => !!m && typeof m === 'object' && ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant') && typeof (m as { text?: unknown }).text === 'string')
    .slice(-CHAT_KEEP_MESSAGES);
  return { messages, ...(typeof j.provider === 'string' ? { provider: j.provider.slice(0, 80) } : {}), ...(typeof j.model === 'string' ? { model: j.model.slice(0, 80) } : {}), ...(typeof j.savedAt === 'string' ? { savedAt: j.savedAt } : {}) };
}

export class PlannerStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(readonly root: string, private readonly now: () => Date = () => new Date(), private readonly opts: StoreOptions = {}) {}

  dir(id: string): string {
    if (!ID_RE.test(id)) throw new PlannerError('invalid', 'That is not a project id.');
    return path.join(this.root, 'projects', id);
  }
  private file(id: string) { return path.join(this.dir(id), 'project.json'); }

  /** A listener must never be able to break a write that already happened. */
  private told(w: StoreWrite) { try { this.opts.onWrite?.(w); } catch { /* a listener's problem is not the store's */ } }

  /** One at a time per key inside this process (a file written by two parts of the app at once would lose one of the writes). */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return run;
  }

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
    this.told({ kind: 'plan', planId: project.id, revision: project.revision, planRevision: project.planRevision });
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
    let wrote: { revision: number; planRevision: number } | null = null;
    const result = await this.withLock(id, async () => {
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
      wrote = { revision: draft.revision, planRevision: draft.planRevision };
      return result;
    });
    if (wrote) this.told({ kind: 'plan', planId: id, ...(wrote as { revision: number; planRevision: number }) });
    return result;
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

  // ---- the planning conversation ---------------------------------------------------------------------------------
  /**
   * The planning conversation, kept with the plan so it is there when the project is opened again. An older file (no version) loads as it is.
   * A damaged file is set aside and the copy from before the last write is used; with neither, the conversation starts empty.
   */
  async readChat(id: string, who?: string): Promise<ChatFile> {
    const name = chatName(who);
    const file = path.join(this.dir(id), `${name}.json`);
    const prev = path.join(this.dir(id), `${name}.prev.json`);
    let text: string | null = null;
    try { text = await fs.readFile(file, 'utf8'); } catch { /* none yet */ }
    if (text !== null) {
      const ok = parseChat(text);
      if (ok) return ok;
      await setAside(file, this.now().toISOString().replace(/[:.]/g, '-'));
      this.told({ kind: 'recovered', planId: id, what: 'chat', note: 'The saved conversation was damaged and has been set aside.' });
    }
    const back = await fs.readFile(prev, 'utf8').then(parseChat, () => null);
    return back ?? { messages: [] };
  }

  /**
   * The Studio's conversation, which is also the General Manager's. Before the two were one, the General Manager's was kept apart: when the Studio's is
   * empty and theirs is not, theirs is brought across once, so nothing said is lost.
   */
  async readStudioChat(id: string): Promise<ChatFile> {
    const own = await this.readChat(id);
    if (own.messages.length) return own;
    try {
      const { town } = await this.readTown(id);
      const gm = town.agents.find((a) => a.director === 'general-manager' && !a.retired);
      const old = gm ? await this.readChat(id, gm.id) : null;
      if (old?.messages.length) { await this.writeChat(id, { messages: old.messages, provider: old.provider, model: old.model }); return await this.readChat(id); }
    } catch { /* no town yet: nothing to bring across */ }
    return own;
  }

  async writeChat(id: string, chat: { messages: ChatMessage[]; provider?: string; model?: string }, who?: string): Promise<void> {
    const name = chatName(who);
    await this.serial(`chat:${id}:${name}`, async () => {
      const dir = this.dir(id);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${name}.json`);
      if (await exists(file)) await fs.copyFile(file, path.join(dir, `${name}.prev.json`)).catch(() => undefined);
      const messages = chat.messages.slice(-CHAT_KEEP_MESSAGES).map((m) => ({ role: m.role, text: m.text.slice(0, CHAT_MAX_CHARS) }));
      await writeJsonRetry(file, { version: 2, messages, provider: chat.provider?.slice(0, 80), model: chat.model?.slice(0, 80), savedAt: this.now().toISOString() });
      this.told({ kind: 'chat', planId: id, messages: messages.length });
    });
  }

  /** Adds messages to the saved conversation (read, add, trim, write, one at a time), so a message is never lost to a stale full copy. */
  async appendChat(id: string, req: { messages: ChatMessage[]; provider?: string; model?: string }, who?: string): Promise<{ stored: number }> {
    return this.serial(`chatappend:${id}:${chatName(who)}`, async () => {
      const cur = await this.readChat(id, who);
      const messages = [...cur.messages, ...req.messages].slice(-CHAT_KEEP_MESSAGES);
      await this.writeChat(id, { messages, provider: req.provider ?? cur.provider, model: req.model ?? cur.model }, who);
      return { stored: messages.length };
    });
  }

  // ---- the canvas -----------------------------------------------------------------------------------------------------
  private canvasFile(id: string) { return path.join(this.dir(id), 'canvas.json'); }

  /** Where the cards sit. A missing file is an empty layout (nothing is written); a damaged or newer-format file is set aside, never overwritten blindly. */
  async readCanvas(id: string): Promise<{ layout: CanvasLayout; recovered: boolean }> {
    const file = this.canvasFile(id);
    let text: string;
    try { text = await fs.readFile(file, 'utf8'); } catch { return { layout: emptyCanvas(this.now()), recovered: false }; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    const ok = canvasLayoutSchema.safeParse(parsed);
    if (ok.success) return { layout: ok.data, recovered: false };
    const v = (parsed as { version?: unknown } | undefined)?.version;
    if (typeof v === 'number' && v > 1) {
      // A newer OmniCandy wrote this. Keep it exactly as it is and work from an empty layout.
      const keep = path.join(this.dir(id), `canvas.v${v}.json`);
      if (!(await exists(keep))) await fs.copyFile(file, keep).catch(() => undefined);
      this.told({ kind: 'recovered', planId: id, what: 'canvas', note: 'The layout was saved by a newer version of OmniCandy; a fresh layout is used.' });
      return { layout: emptyCanvas(this.now()), recovered: true };
    }
    await setAside(file, this.now().toISOString().replace(/[:.]/g, '-'));
    this.told({ kind: 'recovered', planId: id, what: 'canvas', note: 'The saved layout was damaged and has been set aside.' });
    return { layout: emptyCanvas(this.now()), recovered: true };
  }

  /**
   * Moves cards. This deliberately does not use `mutate`: no lock, no revision, no history line, no plan version, and nothing an execution
   * package is built from can change. Only this app writes the layout, so one-at-a-time inside the process is enough.
   */
  async patchCanvas(id: string, patch: CanvasPatch): Promise<{ layoutRev: number }> {
    if (!(await exists(this.file(id)))) throw new PlannerError('not_found', 'No such project.');
    return this.serial(`canvas:${id}`, async () => {
      const { layout } = await this.readCanvas(id);
      let next: CanvasLayout;
      try { next = applyCanvasPatch(layout, patch, this.now()); } catch (e) {
        if (e instanceof CanvasLimitError) throw new PlannerError('invalid', e.message);
        throw new PlannerError('invalid', 'That layout change is not valid.');
      }
      await writeJsonRetry(this.canvasFile(id), next);
      this.told({ kind: 'canvas', planId: id, layoutRev: next.layoutRev });
      return { layoutRev: next.layoutRev };
    });
  }

  // ---- the town ---------------------------------------------------------------------------------------------------------
  private townFile(id: string) { return path.join(this.dir(id), 'town.json'); }

  /**
   * The project's town. The first time it is asked for, the town is made (a Town Hall and a coordinator) and saved, so the same people keep the same
   * ids afterwards. A damaged file is set aside, never deleted, and a fresh town starts.
   */
  async readTown(id: string): Promise<{ town: TownState; recovered: boolean }> {
    if (!(await exists(this.file(id)))) throw new PlannerError('not_found', 'No such project.');
    return this.serial(`town:${id}`, async () => {
      const file = this.townFile(id);
      let text: string | null = null;
      try { text = await fs.readFile(file, 'utf8'); } catch { /* none yet */ }
      let recovered = false;
      if (text !== null) {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = undefined; }
        const ok = townStateSchema.safeParse(parsed);
        if (ok.success) {
          // A town made before the nine directors existed gets them now (and is saved, so they keep their ids).
          const cur = ok.data as TownState;
          const up = withDirectors(cur, this.now());
          if (up !== cur) { await writeJsonRetry(file, up); this.told({ kind: 'town', planId: id, rev: up.rev }); }
          return { town: up, recovered: false };
        }
        const v = (parsed as { version?: unknown } | undefined)?.version;
        if (typeof v === 'number' && v > 1) await fs.copyFile(file, path.join(this.dir(id), `town.v${v}.json`)).catch(() => undefined);
        else await setAside(file, this.now().toISOString().replace(/[:.]/g, '-'));
        recovered = true;
        this.told({ kind: 'recovered', planId: id, what: 'town', note: 'The saved town could not be read, so a fresh one was started. The old file was kept.' });
      }
      const town = defaultTown(this.now());
      await writeJsonRetry(file, town);
      this.told({ kind: 'town', planId: id, rev: town.rev });
      return { town, recovered };
    });
  }

  /** Changes the town: read, change (a pure function that may throw), write, one at a time. Nothing is written if the change throws. */
  async updateTown(id: string, fn: (t: TownState, now: Date) => TownState): Promise<TownState> {
    await this.readTown(id);
    return this.serial(`town:${id}`, async () => {
      const cur = townStateSchema.parse(JSON.parse(await fs.readFile(this.townFile(id), 'utf8'))) as TownState;
      const next = townStateSchema.parse(fn(cur, this.now())) as TownState;
      await writeJsonRetry(this.townFile(id), next);
      this.told({ kind: 'town', planId: id, rev: next.rev });
      return next;
    });
  }

  async saveRaw(id: string, reportId: string, text: string) {
    const dir = path.join(this.dir(id), 'raw');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${reportId}.txt`), text.slice(0, 200_000), 'utf8');
  }
  async readRaw(id: string, reportId: string): Promise<string | null> {
    if (!/^(rep|prop)_[a-z0-9]+$/.test(reportId)) return null;
    return fs.readFile(path.join(this.dir(id), 'raw', `${reportId}.txt`), 'utf8').catch(() => null);
  }
}

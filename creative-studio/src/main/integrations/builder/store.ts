// Private storage of builder projects, under <userData>/integrations/builder. Everything stays on this computer: there is no
// export, sharing or upload path. Each project keeps every package version it ever built, so a repair can always be rolled back.
//
//   projects/<id>/project.json            the record (status, research, decision, reports, log...)
//   projects/<id>/blueprint.json          the current blueprint
//   projects/<id>/versions/<v>/package.ccadapter, blueprint.json, reports.json
//   projects/<id>/verification.json       per command and per program version: only real runs write here
//   projects/<id>/proposal/               a repair waiting for the user's approval (package + blueprint + changes)

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BuilderProjectDetail, BuilderRequest, BuilderStage, BuilderStatus, CommandVerification, PipelineReport, RepairProposal, ResearchReport } from '@shared/builder';
import type { Blueprint } from './blueprint';

export interface VersionRecord { version: string; createdAt: string; reason: string; sha256: string; bytes: number }

export interface ProjectRecord {
  id: string;
  request: BuilderRequest & { fromInstalled: boolean };
  createdAt: string;
  updatedAt: string;
  status: BuilderStatus;
  stage: BuilderStage | null;
  error: string | null;
  adapterId: string | null;
  /** The version currently built / installed. */
  version: string | null;
  installedVersion: string | null;
  app: { installed: boolean; version: string | null; exePath: string | null; key: string | null };
  research: ResearchReport | null;
  decision: BuilderProjectDetail['decision'];
  author: { kind: 'claude' | 'scripted' | 'repair'; note?: string } | null;
  reports: PipelineReport[];
  versions: VersionRecord[];
  log: Array<{ at: string; stage: BuilderStage | null; text: string }>;
  nextSteps: string[];
  usage: { calls: number; costUsd: number };
  /** Permissions the user approved when installing (needed to reinstall a rolled-back version). */
  approvedPermissions: string[];
  docNames: string[];
  /** Documentation that was collected for this project (origin and version are CreateCraft's knowledge, not Claude's claim). */
  docs: Array<{ origin: string; title: string; url: string; versionNote: string; fetchedAt: string; bytes: number; outdated: boolean }>;
  proposal: RepairProposal | null;
}

const MAX_LOG = 200;

export class BuilderStore {
  private cache = new Map<string, ProjectRecord>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly root: string) {}

  dir(id: string): string { return path.join(this.root, 'projects', id); }
  versionDir(id: string, version: string): string { return path.join(this.dir(id), 'versions', version); }
  packagePath(id: string, version: string): string { return path.join(this.versionDir(id, version), 'package.ccadapter'); }
  proposalDir(id: string): string { return path.join(this.dir(id), 'proposal'); }

  async create(request: ProjectRecord['request']): Promise<ProjectRecord> {
    const id = `p${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const rec: ProjectRecord = {
      id, request, createdAt: now, updatedAt: now, status: 'researching', stage: 'checking', error: null, adapterId: null, version: null, installedVersion: null,
      app: { installed: false, version: null, exePath: request.exePath ?? null, key: null }, research: null, decision: null, author: null, reports: [], versions: [], log: [],
      nextSteps: [], usage: { calls: 0, costUsd: 0 }, approvedPermissions: [], docNames: [], docs: [], proposal: null,
    };
    this.cache.set(id, rec);
    await this.save(rec);
    return rec;
  }

  async get(id: string): Promise<ProjectRecord | null> {
    const hit = this.cache.get(id);
    if (hit) return hit;
    try {
      const rec = JSON.parse(await fs.readFile(path.join(this.dir(id), 'project.json'), 'utf8')) as ProjectRecord;
      this.cache.set(id, rec);
      return rec;
    } catch { return null; }
  }

  async list(): Promise<ProjectRecord[]> {
    const ids = await fs.readdir(path.join(this.root, 'projects')).catch(() => [] as string[]);
    const out: ProjectRecord[] = [];
    for (const id of ids) { const r = await this.get(id); if (r) out.push(r); }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async save(rec: ProjectRecord): Promise<void> {
    rec.updatedAt = new Date().toISOString();
    if (rec.log.length > MAX_LOG) rec.log = rec.log.slice(-MAX_LOG);
    const run = this.chain.then(async () => {
      await fs.mkdir(this.dir(rec.id), { recursive: true });
      const tmp = path.join(this.dir(rec.id), `project.${randomBytes(4).toString('hex')}.tmp`);
      await fs.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
      await fs.rename(tmp, path.join(this.dir(rec.id), 'project.json'));
    });
    this.chain = run.catch(() => undefined);
    await run;
  }

  async delete(id: string): Promise<void> {
    this.cache.delete(id);
    await fs.rm(this.dir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  async writeBlueprint(id: string, bp: Blueprint): Promise<void> {
    await fs.mkdir(this.dir(id), { recursive: true });
    await fs.writeFile(path.join(this.dir(id), 'blueprint.json'), JSON.stringify(bp, null, 2), 'utf8');
  }

  async readBlueprint(id: string, version?: string): Promise<Blueprint | null> {
    const file = version ? path.join(this.versionDir(id, version), 'blueprint.json') : path.join(this.dir(id), 'blueprint.json');
    try { return JSON.parse(await fs.readFile(file, 'utf8')) as Blueprint; } catch { return null; }
  }

  async writeVersion(id: string, version: string, bytes: Buffer, bp: Blueprint, reports: PipelineReport[]): Promise<void> {
    const d = this.versionDir(id, version);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, 'package.ccadapter'), bytes);
    await fs.writeFile(path.join(d, 'blueprint.json'), JSON.stringify(bp, null, 2));
    await fs.writeFile(path.join(d, 'reports.json'), JSON.stringify(reports, null, 2));
  }

  // ---- verification records: written only by real runs against the real program ----

  async verifications(id: string): Promise<CommandVerification[]> {
    try { return JSON.parse(await fs.readFile(path.join(this.dir(id), 'verification.json'), 'utf8')) as CommandVerification[]; } catch { return []; }
  }

  async recordVerification(id: string, v: CommandVerification): Promise<void> {
    const all = (await this.verifications(id)).filter((x) => !(x.commandId === v.commandId && x.appVersion === v.appVersion));
    all.push(v);
    await fs.mkdir(this.dir(id), { recursive: true });
    await fs.writeFile(path.join(this.dir(id), 'verification.json'), JSON.stringify(all, null, 2));
  }

  async clearVerifications(id: string, commandIds: string[]): Promise<void> {
    const keep = (await this.verifications(id)).filter((x) => !commandIds.includes(x.commandId));
    await fs.writeFile(path.join(this.dir(id), 'verification.json'), JSON.stringify(keep, null, 2));
  }
}

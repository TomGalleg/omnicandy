// Where a plan lives. Each OmniCandy project keeps its own plan INSIDE the project folder (<project>/Planner/projects/<planId>/...), so the plan
// is part of the project's data: it travels with Move and Duplicate, and reopening the project restores it. Plans made before this existed stay in
// the shared planner folder; they keep working, and can be copied into a project (the original is never changed).
//
// One service works over both places. A plan id is looked up in the open project first, then in the shared folder; a new plan goes to the open
// project. The stand-alone planner connection (MCP) reads whichever folder it is pointed at.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ProjectSummary } from '@shared/planner';
import { PlannerError, PlannerStore } from './store';

const ID_RE = /^plan_[a-z0-9]{6,20}$/;
export const PROJECT_PLANNER_FOLDER = 'Planner';

export class RoutedPlannerStore extends PlannerStore {
  private current: { root: string; ownerId: string } | null = null;

  /** `sharedRoot` is the older, shared planner folder (the app's data folder). */
  constructor(readonly sharedRoot: string, now?: () => Date) { super(sharedRoot, now); }

  /** Called whenever the open project changes. `null` = no project open. */
  setProject(projectRoot: string | null, ownerId: string | null): void {
    this.current = projectRoot && ownerId ? { root: path.join(projectRoot, PROJECT_PLANNER_FOLDER), ownerId } : null;
  }
  get projectRoot(): string | null { return this.current?.root ?? null; }
  get ownerId(): string | null { return this.current?.ownerId ?? null; }

  private has(root: string, id: string) { return fs.existsSync(path.join(root, 'projects', id, 'project.json')); }

  override dir(id: string): string {
    if (!ID_RE.test(id)) throw new PlannerError('invalid', 'That is not a project id.');
    if (this.current && this.has(this.current.root, id)) return path.join(this.current.root, 'projects', id);
    if (this.has(this.sharedRoot, id)) return path.join(this.sharedRoot, 'projects', id);
    return path.join((this.current?.root ?? this.sharedRoot), 'projects', id);
  }

  /** True when the plan is stored in the open project (not only in the shared folder). */
  inThisProject(id: string): boolean { return !!this.current && this.has(this.current.root, id); }

  /** The open project's plans first, then the older plans that have not been brought into it. */
  override async list(): Promise<ProjectSummary[]> {
    const mine = this.current ? await new PlannerStore(this.current.root, undefined).list() : [];
    const ids = new Set(mine.map((s) => s.id));
    const older = (await super.list()).filter((s) => !ids.has(s.id));
    return [...mine.map((s) => ({ ...s, inThisProject: true })), ...older.map((s) => ({ ...s, inThisProject: false }))];
  }

  /** The plan that belongs to the open project, if it has one (the newest, when a copied project holds more than one). */
  async projectPlan(): Promise<ProjectSummary | null> {
    if (!this.current) return null;
    const mine = await new PlannerStore(this.current.root, undefined).list();
    return mine[0] ?? null;
  }

  /**
   * Copies an older plan from the shared folder into the open project. The original stays exactly as it was. Returns the id (the same id: the
   * project's copy is found first from now on).
   */
  async copyIntoProject(id: string): Promise<string> {
    if (!this.current) throw new PlannerError('invalid', 'Open a project first.');
    if (!ID_RE.test(id)) throw new PlannerError('invalid', 'That is not a project id.');
    const from = path.join(this.sharedRoot, 'projects', id);
    if (!this.has(this.sharedRoot, id)) throw new PlannerError('not_found', 'That older plan could not be found.');
    if (this.has(this.current.root, id)) return id;
    if ((await this.projectPlan())) throw new PlannerError('conflict', 'This project already has a plan.');
    const to = path.join(this.current.root, 'projects', id);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, filter: (src) => !src.endsWith('project.lock') });
    // The copy records where it came from and which project it belongs to; the original file is not touched.
    const file = path.join(to, 'project.json');
    const p = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
    p.importedFrom = id;
    p.ownerProjectId = this.current.ownerId;
    await fsp.writeFile(file, JSON.stringify(p, null, 2), 'utf8');
    return id;
  }
}

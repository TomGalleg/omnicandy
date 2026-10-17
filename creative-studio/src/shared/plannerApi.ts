// What the Planner workspace may ask main to do (always as the user). Types only; main/planner/ipc.ts implements it.
import type {
  ActivityEntry, AppRef, ExecPackage, ItemStatus, ItemType, PlanAsset, PlanDrift, PlanItem, PlannerProject, PlanReport, PlanTask, Priority, ProjectInput, ProjectSummary, ReportDraft, Actor,
} from './planner';

export interface PlannerTaskInput {
  title: string; description?: string; priority?: Priority; parentId?: string | null; dependsOn?: string[]; checks?: Array<{ text: string; kind?: string }>;
  expectedOutputs?: string[]; assetIds?: string[]; milestoneId?: string | null; appRef?: AppRef | null;
}
export interface PlannerAssetInput { role: PlanAsset['role']; title: string; source: PlanAsset['source']; path?: string; url?: string; createcraft?: PlanAsset['createcraft']; note?: string; group?: string }

export interface PlannerConnectionInfo {
  folder: string;
  bundleFound: boolean;
  bundlePath: string;
  /** Ready-to-paste connection snippets. They never contain a secret: stdio needs none. */
  profiles: Array<{ id: 'brainstorm' | 'executor'; label: string; scopes: string[]; actor: string; claudeCode: string; json: string; geminiCli: string }>;
  http: string;
}

export interface PackageView { package: ExecPackage; markdown: string; json: string; drift: PlanDrift; tasks: Array<{ id: string; status: PlanTask['status']; claimedBy: string | null; blockedBy: string[] }> }

export interface PlannerApi {
  list(): Promise<ProjectSummary[]>;
  get(id: string): Promise<PlannerProject>;
  activity(id: string): Promise<ActivityEntry[]>;
  assetHealth(id: string): Promise<Record<string, 'ok' | 'missing' | 'n/a'>>;
  create(input: ProjectInput): Promise<PlannerProject>;
  update(id: string, patch: Partial<Pick<PlannerProject, 'title' | 'goal' | 'description' | 'scope' | 'constraints' | 'deliverables'>>, expectedMetaRev?: number): Promise<PlannerProject>;
  addItem(id: string, item: { type: ItemType; title: string; text?: string; reason?: string }): Promise<PlanItem>;
  updateItem(id: string, itemId: string, patch: Partial<Pick<PlanItem, 'title' | 'text' | 'reason' | 'answer'>>, expectedRev?: number): Promise<PlanItem>;
  setItemStatus(id: string, itemId: string, status: ItemStatus, opts?: { type?: ItemType; answer?: string; expectedRev?: number }): Promise<PlanItem>;
  removeItem(id: string, itemId: string): Promise<void>;
  addTask(id: string, task: PlannerTaskInput): Promise<PlanTask>;
  updateTask(id: string, taskId: string, patch: Partial<PlanTask>, expectedRev?: number): Promise<PlanTask>;
  setTaskStatus(id: string, taskId: string, status: 'todo' | 'in_progress' | 'blocked' | 'accepted' | 'cancelled', note?: string, expectedRev?: number): Promise<PlanTask>;
  removeTask(id: string, taskId: string): Promise<void>;
  releaseClaim(id: string, taskId: string): Promise<void>;
  addAsset(id: string, asset: PlannerAssetInput): Promise<PlanAsset>;
  /** Native picker; the files are linked by path, never copied. */
  pickAssets(id: string, role: PlanAsset['role']): Promise<PlanAsset[]>;
  removeAsset(id: string, assetId: string): Promise<void>;
  addMilestone(id: string, m: { title: string; due?: string }): Promise<void>;
  removeMilestone(id: string, msId: string): Promise<void>;
  decideProposal(id: string, proposalId: string, accept: boolean, only?: number[]): Promise<void>;
  createPackage(id: string, req: { taskIds: string[]; objective?: string; note?: string }): Promise<ExecPackage>;
  cancelPackage(id: string, pkgId: string): Promise<void>;
  packageView(id: string, pkgId: string): Promise<PackageView>;
  /** Saves the package as Markdown (and JSON beside it) through a native Save dialog. Returns the Markdown path or null. */
  savePackage(id: string, pkgId: string): Promise<string | null>;
  importReport(id: string, req: { packageId: string; taskId: string; executor: Actor; report: ReportDraft; uncertain?: string[]; rawText: string }): Promise<{ report: PlanReport; duplicate: boolean }>;
  reviewReport(id: string, reportId: string, decision: 'accept' | 'revise' | 'reject', note?: string, acknowledgeOutdated?: boolean): Promise<{ report: PlanReport; driftNow: PlanDrift; uncovered: number }>;
  rawReport(id: string, reportId: string): Promise<string | null>;
  exportProject(id: string, mode: 'reference' | 'bundle'): Promise<string | null>;
  importProject(): Promise<PlannerProject | null>;
  connectionInfo(): Promise<PlannerConnectionInfo>;
  openFolder(): Promise<void>;
}

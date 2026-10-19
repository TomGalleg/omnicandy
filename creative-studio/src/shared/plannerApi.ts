// What the Planner workspace may ask main to do (always as the user). Types only; main/planner/ipc.ts implements it.
import type {
  ActivityEntry, AppRef, ExecPackage, ItemStatus, ItemType, PlanAsset, PlanDrift, PlanItem, PlannerProject, PlanReport, PlanTask, Priority, ProjectInput, ProjectSummary, ReportDraft, Actor, Proposal, ProposalChange,
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

/** The plan of the project that is open, and the older plans (made before projects held their own plan) that could be brought in. */
export interface ProjectPlannerState {
  project: { id: string; name: string } | null;
  plan: PlannerProject | null;
  older: ProjectSummary[];
}

/** What a look at the project's own files found. Suggestions need the owner's tick; nothing is marked as done. */
export interface ProjectFindingsDto {
  projectName: string;
  lines: string[];
  changes: ProposalChange[];
  stats: { files: number; originals: number; versions: number; exports: number; workflowSteps: number; chatMessages: number; lastActivity: string | null };
}

export interface ChatProviderInfo { id: 'claude' | 'openai' | 'gemini'; label: string; cost: string; ready: boolean; note: string }

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
  /** Send to AI: reuses an identical open package instead of superseding it. */
  prepareSend(id: string, req: { taskIds: string[]; objective?: string; note?: string; destination?: 'createcraft' | 'tools' | 'chat'; forceInclude?: string[] }): Promise<{ package: ExecPackage; reused: boolean; replaced: number[] }>;
  /** Stores pasted AI suggestions as a pending proposal (never applied). */
  importSuggestions(id: string, req: { proposer?: Actor; note?: string; changes: ProposalChange[]; rawText: string }): Promise<Proposal>;
  /** The plan approved on Home becomes a Planner project with its steps as pending suggestions (never accepted automatically). */
  createFromHomePlan(input: { title: string; goal: string; kind?: string; steps: string[]; questions: string[] }): Promise<{ project: PlannerProject; proposal: Proposal }>;
  cancelPackage(id: string, pkgId: string): Promise<void>;
  packageView(id: string, pkgId: string): Promise<PackageView>;
  /** Saves the package as Markdown (and JSON beside it) through a native Save dialog. Returns the Markdown path or null. */
  savePackage(id: string, pkgId: string): Promise<string | null>;
  importReport(id: string, req: { packageId: string; taskId: string; executor: Actor; report: ReportDraft; uncertain?: string[]; rawText: string }): Promise<{ report: PlanReport; duplicate: boolean }>;
  reviewReport(id: string, reportId: string, decision: 'accept' | 'revise' | 'reject', note?: string, acknowledgeOutdated?: boolean): Promise<{ report: PlanReport; driftNow: PlanDrift; uncovered: number }>;
  rawReport(id: string, reportId: string): Promise<string | null>;
  exportProject(id: string, mode: 'reference' | 'bundle'): Promise<string | null>;
  importProject(): Promise<PlannerProject | null>;
  /** The planning chat beside the brief. Each call is one message the owner chose to send; nothing is written to the plan. */
  chatProviders(): Promise<ChatProviderInfo[]>;
  chatModels(provider: 'claude' | 'openai' | 'gemini'): Promise<string[]>;
  /** `mode`: "talk" (default) understands the idea; "chunks" breaks the project into chunks once the owner said yes. */
  chat(req: { projectId: string; provider: 'claude' | 'openai' | 'gemini'; model: string; messages: Array<{ role: 'user' | 'assistant'; text: string }>; mode?: 'talk' | 'chunks' }): Promise<{ text: string }>;
  /** The conversation kept with the plan (restored when the project is opened again). */
  chatLoad(id: string): Promise<{ messages: Array<{ role: 'user' | 'assistant'; text: string }>; provider?: string; model?: string; savedAt?: string }>;
  chatSave(id: string, chat: { messages: Array<{ role: 'user' | 'assistant'; text: string }>; provider?: string; model?: string }): Promise<void>;
  /** This project's plan (null when it has none yet) and the older plans that could be brought into it. */
  forProject(): Promise<ProjectPlannerState>;
  /** Starts this project's plan (a project has one). Title defaults to the project's name. */
  startPlan(input?: { title?: string; goal?: string }): Promise<PlannerProject>;
  /** Looks at the project's own files, exports, workflow and saved Claude conversation (read-only). */
  analyze(): Promise<ProjectFindingsDto>;
  /** Adds the ticked findings to the plan (indexes into analyze().changes). The scan is done again here; nothing from the page is trusted. */
  applyFindings(id: string, only: number[]): Promise<void>;
  /** The owner opened or worked on a chunk (for "Pick up where I left off"). */
  touchTask(id: string, taskId: string, what: string): Promise<void>;
  /** Copies an older plan into this project. The original is left as it was. */
  attachOlder(id: string): Promise<PlannerProject>;
  connectionInfo(): Promise<PlannerConnectionInfo>;
  openFolder(): Promise<void>;
}

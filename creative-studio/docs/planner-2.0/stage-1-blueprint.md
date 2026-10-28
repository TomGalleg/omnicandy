# OmniCandy Planner 2.0 — Stage 1 Implementation Blueprint

Status: **blueprint only. No application code was changed, nothing was committed or pushed, no AI was called.**
Written 2026-10-27 against `main` @ `bf7b6b5`. All paths are relative to `creative-studio/`. Every existing symbol below was read in the
current source (the audit in `docs/planner-redesign-audit/` is the companion; line numbers there and here are from the same tree).
Symbols marked **NEW** are proposals, not existing code.

Approved direction this blueprint serves: chat-first start · visual canvas as the primary plan · balanced AI autonomy · Studio Mode and
(later) Village Mode on one shared project state · one town per project (Stage 6, not built here).

---

## 0. The one-paragraph plan

Stage 1 changes **no field in `project.json`** and adds **no second database**. It adds four things next to the existing planner:
(1) a **pure, read-only `ProjectView`** derived from the existing `PlannerProject` (the shared view model both interfaces will render);
(2) a **sidecar `canvas.json`** that stores card positions/groups/view mode outside the accepted plan and outside `mutate()`, so layout can never
bump a revision, write history, or invalidate a package;
(3) a **push event channel** (`planner:event`) driven by the store's own writes plus a cheap main-side change check for external (MCP) writers, replacing the renderer's
3-second poll;
(4) a **thin `ProjectCoordinator`** that holds only `read`+`propose`+`package` scopes, so it can prepare proposals but is structurally unable to accept anything.
Chat persistence is hardened (append-before-send, versioned file, previous-copy recovery, bounded size). Interfaces for capabilities and execution
(`CapabilityPort`, `ExecutionPort`) are *declared* with null implementations so Stage 3 can plug into the existing agent harness without touching Stage 1 code.

---

## 1. Scope: essential Stage 1 vs later

| Item | Stage 1 (essential) | Later |
|---|---|---|
| `ProjectView` (nodes, edges, progress, needs-you, ghost previews of pending proposals) | ✅ | richer previews (Stage 5) |
| `canvas.json` sidecar + `canvasLoad/canvasPatch` + deterministic `autoLayout` | ✅ | canvas UI (Stage 2), timeline/dependency visuals (Stage 5) |
| Event channel `planner:event` + main-side change check + renderer `useProjectState` hook | ✅ | `run.*` events from execution (Stage 3), agent/team events (Stage 4), town events (Stage 6) |
| `ProjectCoordinator` (view, propose, deterministic next-step hints) | ✅ | AI-driven coordination, natural-language plan edits (Stages 3-5) |
| Chat durability (`appendChat`, v2 file, recovery) | ✅ | unified chat across Claude panel / agent (Stage 3-4) |
| Export/import carries `canvas.json` | ✅ | — |
| `CapabilityPort`, `ExecutionPort`, `Assignment`, `TeamView`, `TownRef` **types and null implementations** | ✅ (types only) | real implementations: Stage 3 (capabilities, execution), Stage 4 (team), Stage 6 (town) |
| Decouple `ClaudePartner.planChat` from the panel's busy state | ✅ optional (S1-9) | — |
| New Studio UI (chat + canvas) | ❌ | Stage 2 |
| Any change to the three-tab Idea/Plan/Work UI beyond swapping its data source | ❌ | Stage 2 |
| Agent teams, businesses, workplaces, Town Hall meetings | ❌ (names reserved only) | Stages 4 and 6 |
| Three.js / React Three Fiber | ❌ (no dependency added) | Stage 6 |

---

## 2. Principles, and how each one is enforced in code

| Rule | Enforcement in this design |
|---|---|
| One authoritative project state | `PlannerProject` in `Planner/projects/<planId>/project.json` stays the only plan record. `ProjectView` is a *function* of it (never stored). Studio and Village both call `buildProjectView` or the `view` IPC. |
| No second task database | No new task/agent/chunk store. "Chunk" is a *view* of existing `PlanTask` (see 4.2). |
| Layout never changes the plan | `canvas.json` is written by `PlannerStore.patchCanvas`, which does **not** call `mutate()`. Test proves `project.json` bytes, `revision`, `planRevision`, `history.jsonl` and `ExecPackage.contentKey` are unchanged after layout writes (T2). |
| Approvals stay authoritative | The coordinator's `Ctx` is `connectionCtx(actor, ['read','propose','package'])` (`service.ts:24`), which cannot hold `review`/`edit`; `decideProposal` (`need(c,'review')`, `service.ts:357`) stays UI-only. |
| MCP compatibility | `TOOLS` in `src/main/planner/mcp.ts:20` is not edited. No new scope. No change to `reportDraftSchema`/`changeSchema` shapes. |
| No paid calls | No new code calls a provider. Existing `PlannerChat.reply` runs only when the owner sends a message. All new tests use in-memory fakes/temp dirs. |
| No second agent loop | Stage 1 adds ports only; execution later goes through `runAgent` (`src/main/agentHarness/loop.ts:71`) / `ClaudePartner.send`. |
| Application-agnostic | `ProjectView` carries `AppRef` verbatim (`planner.ts:50`) and never branches on an app id. |
| Local-first, no tiers | All state in the project folder; no network, no feature flags. |

---

## 3. Exact existing files that must change

| File | Symbols touched | Change | Why |
|---|---|---|---|
| `src/main/planner/store.ts` | `PlannerStore` constructor, `create` (:81), `mutate` (:105), `readChat` (:139), `writeChat` (:146) | Add optional constructor option `{ onWrite?: (e: StoreWrite) => void }` invoked after `create`/`mutate` commit; add `readCanvas`, `patchCanvas`, `appendChat`; harden `readChat`/`writeChat` | Event source, canvas persistence, chat durability. Existing method signatures stay valid |
| `src/main/planner/routedStore.ts` | `RoutedPlannerStore` constructor (:21) | Accept and forward the same options object | `createPlanner` builds this class |
| `src/main/planner/ipc.ts` | `createPlanner` (:21), `Deps` (:59), `registerPlannerIpc` (:61), `methods` (:77) | Build the event hub, pass `onWrite`; spread new methods from `viewMethods.ts`; broadcast events to all windows | New IPC surface |
| `src/shared/plannerApi.ts` | `PlannerApi` (:40) | Add `view`, `canvasLoad`, `canvasPatch`, `chatAppend`, `proposeChanges`, `onEvent` | Typed contract |
| `src/shared/ipc.ts` | `IPC` const (near :215) | Add `plannerEvent: 'planner:event'` | Push channel name |
| `src/preload/index.ts` | `planner` object (:299) | Add the new method names to the generated list; add `onEvent` using the same `ipcRenderer.on` + unsubscribe pattern as `builder.onProgress` | Exposes the API |
| `src/main/planner/service.ts` | `exportProject` (:692), `importProject` (:719) | Include optional `canvas.json` zip entry; read it back if present | Layout travels with an exported plan; old importers ignore the extra entry |
| `src/shared/planner.ts` | `Proposal.source` (:139) | Add literal `'coordinator'` (additive) | Distinguish coordinator proposals from MCP ones; unknown values already render as "from a connection" in `ProposalCard` (`PlannerWork.tsx:338`) |
| `src/renderer/src/planner/PlannerWorkspace.tsx` | `refresh` (:50), poll effect (:65-74) | Replace the 3 s `list()` poll with `useProjectState`; **no visual change** | One subscription instead of per-component polling |
| `src/renderer/src/planner/PlannerChat.tsx` | `ask` (:100), `save` (:84) | Call `chatAppend` for the user message before `chat()`, and for the reply after | Never lose a user message on provider error/crash |
| `src/renderer/src/planner/PlannerWork.tsx` | `ProposalCard` source text (:338) | Add `'coordinator'` wording | Cosmetic |
| `src/main/claudePartner.ts` | `planChat` (:791) | (S1-9, optional) Use its own `AbortController`/no `this.status` writes | Planner chat no longer fails while the Claude panel works |
| `src/renderer/src/components/HomeWorkspace.tsx` | `createBlank` else-branch (~:67) | Replace the stale "always under More" log text | Planner is a top-level tab in both nav modes |

Not changed in Stage 1: `src/main/planner/mcp.ts`, `mcpMain.ts`, `projectPlanner.ts`, `projectContext.ts`, `chat.ts`, `src/main/agentHarness/*`, `src/main/ipc.ts` (the app-wide one, except nothing — `createPlanner`/`registerPlannerIpc` calls at `:123-126` keep their shape), every adapter, `projects.ts`, `projectStore.ts`.

---

## 4. Data model

### 4.1 No change to `project.json`

`PlannerProject` (`src/shared/planner.ts:209`) is **not modified**. Consequences:
* Every existing project (including `src/main/planner/__fixtures__/*.json`) opens exactly as before.
* No migration is needed, and no downgrade problem exists (an older build ignores the sidecar files).
* `snapshotOf` (:267) already ignores everything except goal/description/scope/constraints/deliverables and *accepted* requirement/decision items, so `idea`/`question`/`reference` items, tasks, assets, positions and layout never bump `planRevision`.

### 4.2 Mapping the Planner 2.0 objects onto what exists

| Planner 2.0 object | Stored as (existing) | Notes |
|---|---|---|
| Project | `PlannerProject` (+ OmniCandy `ProjectManifest` via `ownerProjectId`) | |
| Idea | `PlanItem {type:'idea', status:'open'}` | exists; no UI today (Stage 2 adds it through proposals and canvas cards) |
| Decision | `PlanItem {type:'decision', status:'accepted', reason}` | |
| Requirement / Question / Reference | `PlanItem` of those types | |
| **Chunk** | a top-level `PlanTask` (`parentId === null`) — today's UI word "chunk" already means this | `ViewNode.level = 'chunk'` |
| **Task** | a `PlanTask` with `parentId !== null` (validated by `validateTaskRefs`, `service.ts:216`) | `ViewNode.level = 'task'` |
| Milestone / group | `Milestone` (`planner.ts:96`) | rendered as a `group` node containing its tasks (`PlanTask.milestoneId`) |
| Resource | `PlanAsset` (`planner.ts:76`) | |
| Assignment | **not stored in Stage 1** — `ViewNode.assignee = null`; `PlanTask.appRef` (`AppRef`) passes through as `resourceHint` | stored in Stage 3/4 (additive optional field on `PlanTask`, owner-approved) |
| Result | `PlanReport` (`planner.ts:187`) + the report's `outputs[]` | |
| Capability | not stored (derived from `IntegrationManager` in Stage 3) | `CapabilityPort` declared |
| Idea previews from chat | pending `Proposal` (`planner.ts:130`) → **ghost nodes** | already exists as data; this is how "chat changes appear as previews" with zero new storage |

### 4.3 New shared types — `src/shared/projectView.ts` (**NEW**, pure, no Node/Electron)

```ts
import type { AppRef, PlannerProject, PlanReport, Proposal } from './planner';
import type { DisplayStatus } from './plannerView';

export type ViewNodeKind =
  | 'project' | 'idea' | 'question' | 'requirement' | 'decision' | 'reference'
  | 'milestone' | 'chunk' | 'task' | 'resource' | 'result' | 'ghost';

export interface ViewNodeRef { type: 'plan' | 'item' | 'task' | 'milestone' | 'asset' | 'report' | 'proposal'; id: string; rev?: number }

export interface ViewProgress { done: number; total: number; percent: number }   // leaf-only: see 4.4

export interface ViewNode {
  /** Entity id (task_…, item_…, ms_…, asset_…, rep_…), `project:<planId>`, or `ghost:<proposalId>:<changeIndex>`. Canvas layout is keyed by this. */
  id: string;
  kind: ViewNodeKind;
  level?: 'chunk' | 'task';
  title: string;
  summary: string;                       // first ~160 chars of description/text/reason, never secrets
  status: DisplayStatus | null;          // displayStatus(t, p) for tasks (plannerView.ts:29); null for non-tasks
  progress: ViewProgress | null;         // chunk/milestone/project only
  parentId: string | null;               // containment: project → milestone → chunk → task
  ref: ViewNodeRef;
  resourceHint: AppRef | null;           // PlanTask.appRef, untouched
  assignee: null;                        // reserved: Stage 3/4 (type widens to AssigneeRef | null)
  ghost?: { proposalId: string; changeIndex: number; by: string; op: string };  // pending, not yet part of the plan
  flags: { needsReview: boolean; stalled: boolean; planChanged: boolean; removed: boolean; waiting: boolean };
}

export interface ViewEdge { id: string; from: string; to: string; kind: 'dependsOn' | 'contains' | 'ghostDependsOn' }

export interface ProjectView {
  planId: string;
  projectId: string | null;              // PlannerProject.ownerProjectId
  title: string;
  revision: number; planRevision: number; metaRev: number;
  nodes: ViewNode[];
  edges: ViewEdge[];
  progress: ViewProgress;                // leaf-only over non-cancelled tasks
  needsYou: ReturnType<typeof import('./plannerView').needsYou>;   // { reports, suggestions, stalled, total }
  current: { taskId: string; title: string } | null;              // same rule as pickCurrent (PlannerWork.tsx:376), moved here
  pendingProposals: Array<Pick<Proposal, 'id' | 'note' | 'at' | 'source'> & { by: string; changes: number }>;
  awaitingReview: Array<Pick<PlanReport, 'id' | 'taskId' | 'outcome' | 'submittedAt'>>;
  /** Reserved, always null in Stage 1. Widened by later stages without changing existing fields. */
  capabilities: null; team: null; town: null; runs: null;
}

export function buildProjectView(p: PlannerProject, opts?: { now?: Date; focusTaskId?: string | null }): ProjectView;
export function currentTask(p: PlannerProject, focusTaskId?: string | null): PlannerProject['tasks'][number] | undefined; // extracted from pickCurrent; PlannerWork imports it
export function leafProgress(p: PlannerProject, scopeTaskIds?: readonly string[]): ViewProgress;
```

### 4.4 Rules baked into `buildProjectView` (all derived, none stored)

1. **Progress is leaf-only.** Today `progressOf` (`planner.ts:313`) counts every non-cancelled task, so a parent and its children would count twice. `leafProgress` counts only tasks without non-cancelled children; `progressOf` and `summarize` are **left unchanged** (project list numbers stay identical). A chunk whose children are all `accepted` shows 100% **but is not marked accepted** — the owner still accepts it (`setTaskStatus`), preserving "AI/derived completion ≠ approval".
2. **Ghosts**: for each pending proposal, each `add_task | add_item | add_milestone | update_task | update_item | set_brief` change becomes one `ghost` node (`ghost:<proposalId>:<index>`), with `ghostDependsOn` edges when `add_task.dependsOn` references real tasks. Accept/reject uses the existing `decideProposal(id, proposalId, accept, only?: number[])` (`service.ts:356`), whose `only` already supports per-change acceptance.
3. **Containment edges**: milestone → task via `milestoneId`; task → subtask via `parentId`; tasks with neither hang off the project node.
4. **Dependency edges** from `PlanTask.dependsOn`.
5. Cancelled tasks are included with `flags.removed = true` (the UI decides whether to show them).
6. Deterministic ordering: project, then milestones in stored order, then tasks in stored order. Same input → identical output (needed for tests and stable canvas diffs).
7. Cost: O(nodes + edges). The renderer memoizes by `(planId, revision)`; the main-side `view` IPC does not cache.

### 4.5 Canvas sidecar — `src/shared/plannerCanvas.ts` (**NEW**, pure)

File: `<planDir>/canvas.json` where `<planDir> = PlannerStore.dir(planId)` (`store.ts:36`; resolves to `<project>/Planner/projects/<planId>/`). It travels with Duplicate/Move (they copy the whole project folder: `copyVerified`, `projects.ts:58`) and with "bring older plan into project" (`routedStore.ts:70` uses `fsp.cp` of the plan folder).

```ts
export const CANVAS_LIMITS = {
  maxNodes: 10_000, maxGroups: 500, maxNotes: 500, maxLinks: 5_000,
  maxNoteChars: 2_000, maxTitleChars: 120, maxBytes: 2 * 1024 * 1024, maxCoord: 1_000_000,
} as const;

export type ViewMode = 'canvas' | 'cards' | 'board' | 'timeline' | 'list';
export interface CanvasNodePos { x: number; y: number; w?: number; h?: number; collapsed?: boolean; group?: string | null }
export interface CanvasGroup { title: string; x: number; y: number; w: number; h: number; color?: string }
export interface CanvasNote { text: string; x: number; y: number; color?: string }      // presentation-only sticky note, NOT plan content
export interface CanvasLink { from: string; to: string; label?: string }                // visual-only link; real dependencies stay in PlanTask.dependsOn

export interface CanvasLayout {
  version: 1;
  layoutRev: number;                  // bumps on every write; unrelated to PlannerProject.revision
  updatedAt: string;
  mode: ViewMode;                     // which presentation the owner last used; data is identical in every mode
  viewport: { x: number; y: number; zoom: number } | null;
  nodes: Record<string, CanvasNodePos>;
  groups: Record<string, CanvasGroup>;
  notes: Record<string, CanvasNote>;
  links: Record<string, CanvasLink>;
}

export interface CanvasPatch {
  baseLayoutRev?: number;             // informational; the merge is per-key last-writer-wins and never rejected
  mode?: ViewMode;
  viewport?: CanvasLayout['viewport'];
  upsertNodes?: Record<string, CanvasNodePos>;   removeNodes?: string[];
  upsertGroups?: Record<string, CanvasGroup>;    removeGroups?: string[];
  upsertNotes?: Record<string, CanvasNote>;      removeNotes?: string[];
  upsertLinks?: Record<string, CanvasLink>;      removeLinks?: string[];
}

export const canvasLayoutSchema: z.ZodType<CanvasLayout>;      // strict: ids match /^(?:[a-z]{2,10}_[a-z0-9]{4,24}|project:plan_[a-z0-9]{6,20}|ghost:[a-z]{2,10}_[a-z0-9]+:\d{1,3}|group_[a-z0-9]{4,24}|note_[a-z0-9]{4,24}|link_[a-z0-9]{4,24})$/
export const canvasPatchSchema: z.ZodType<CanvasPatch>;
export const emptyCanvas = (now: Date): CanvasLayout;
export function applyCanvasPatch(base: CanvasLayout, patch: CanvasPatch, now: Date): CanvasLayout;   // enforces CANVAS_LIMITS; throws CanvasLimitError
export function pruneOrphans(layout: CanvasLayout, view: ProjectView): CanvasLayout;                  // in memory only
export function autoLayout(view: ProjectView): Record<string, CanvasNodePos>;                         // deterministic, see 4.6
```
Security details: IDs are validated against the pattern above (no `__proto__`/`constructor`); finite numbers only, clamped to `±maxCoord`; strings length-bounded.

### 4.6 `autoLayout` (deterministic, Stage 1 scope)

Column = longest `dependsOn` path depth within the same container; row = stored order. Milestone groups are laid out as bands. Ghosts are placed adjacent to the node they modify, or in a "proposed" column. Used for any node without an entry in `canvas.json` (so an old project opens with a sensible layout and **no write**). Stage 5 may replace the algorithm; the function signature stays.

### 4.7 Reserved names (no code in Stage 1)

Inside the plan folder: `canvas.json` (Stage 1), `town.json` (Stage 6, presentation: building positions, style, camera), `team.json` (Stage 4: roles/agents/businesses — **configuration with cost/permission impact, so it will be written through `PlannerService`/`mutate` with approval, not as a free sidecar**). Types `AssigneeRef`, `TeamView`, `TownRef` are declared in `src/shared/plannerCoordination.ts` (4.8) only as widening points.

### 4.8 Ports for later stages — `src/shared/plannerCoordination.ts` (**NEW**, types + null objects)

```ts
import type { Permission } from './integrations';
import type { PlanTask } from './planner';

export interface CapabilityDescriptor {
  id: string;                               // stable: `${providerKind}:${providerId}:${commandId}`
  providerKind: 'native' | 'external' | 'agent' | 'workflow';
  providerId: string;                       // EDITOR_APPS id, adapter id ('blender' | 'unreal' | 'autodesk.fusion' | 'davinci.resolve' | …), workflow key
  label: string;
  produces: string[];                       // e.g. ['model.3d', 'image', 'video']
  requires: Permission[];                   // existing union in integrations.ts:15
  availability: 'verified' | 'declared' | 'unavailable';
  reversible: boolean | 'unknown';
  paid: boolean; destructive: boolean; headless: boolean | 'unknown';
  verifyWith?: string;                      // e.g. a TRUSTED_READBACK_COMMANDS entry (integrations/readback.ts)
}
export interface CapabilityMatch { capability: CapabilityDescriptor; why: string }
export interface TaskReadiness { taskId: string; state: 'ready' | 'needs-setup' | 'manual-only' | 'unknown'; matches: CapabilityMatch[]; problems: string[] }

export interface CapabilityPort {
  search(q: { intent: string; outputs?: string[] }): Promise<CapabilityMatch[]>;
  readiness(task: PlanTask): Promise<TaskReadiness>;
}
export interface DispatchRequest { planId: string; taskId: string; capabilityId?: string; budget?: { maxTurns?: number; maxToolCalls?: number; maxUsd?: number } }
export interface DispatchHandle { runId: string }
export interface ExecutionPort {
  readonly available: boolean;
  dispatch(req: DispatchRequest): Promise<DispatchHandle>;
  cancel(runId: string): Promise<void>;
}
export const NULL_CAPABILITIES: CapabilityPort;   // search → []; readiness → { state: 'manual-only', … }
export const NULL_EXECUTION: ExecutionPort;       // available:false; dispatch rejects with PlannerError('blocked', …)
export type AssigneeRef = never; export type TeamView = never; export type TownRef = never;   // widened in Stages 4 and 6
```
Stage 3 provides real implementations built on `IntegrationManager` (`src/main/integrations/manager.ts:54`), `runAgent`, and `TRUSTED_READBACK_COMMANDS`. Until then Studio shows "Do it yourself / copy to an AI" (today's `SendPanel` flow).

---

## 5. Events and state synchronisation

### 5.1 Problem today
No push channel for planner data. `PlannerWorkspace.tsx:65-74` polls `planner.list()` every 3 s per mounted workspace; the stand-alone MCP process (`out/planner-mcp.cjs`) and the app write the same folder, so the app only learns of external edits by polling. A second interface would add a second poller.

### 5.2 Design

**`src/shared/plannerEvents.ts` (NEW)**
```ts
export type PlannerEvent =
  | { type: 'plan.changed';   planId: string; revision: number; planRevision: number; origin: 'app' | 'external'; at: string }
  | { type: 'canvas.changed'; planId: string; layoutRev: number; origin: 'app' | 'external'; at: string }
  | { type: 'chat.changed';   planId: string; messages: number; at: string }
  | { type: 'plan.recovered'; planId: string; what: 'canvas' | 'chat'; note: string; at: string };   // a damaged sidecar was set aside
// Reserved, NOT implemented in Stage 1: 'run.*' (Stage 3), 'agent.*' (Stage 4), 'town.*' (Stage 6).
```
Events carry **no plan content** (only ids and revision numbers); consumers re-fetch with `get`/`view`. This keeps them cheap, ordered by revision, and safe to drop.

**`src/main/planner/events.ts` (NEW)**
```ts
export class PlannerEventHub {
  constructor(opts: { broadcast: (e: PlannerEvent) => void; now?: () => Date; pollMs?: number /* default 3000 */ });
  emitWrite(e: StoreWrite): void;                       // called by PlannerStore.onWrite (origin 'app')
  watch(resolve: () => Promise<{ planId: string; file: string } | null>): void;   // main-side check for external writers
  stop(): void;
}
export interface StoreWrite { planId: string; revision: number; planRevision: number; kind: 'plan' | 'canvas' | 'chat' }
```
* **Local writes**: `PlannerStore.mutate`/`create` (and `patchCanvas`, `appendChat`) call `onWrite` after the atomic rename succeeds. The hub records `lastRevision[planId]` and broadcasts (`origin:'app'`).
* **External writes** (MCP process, another instance): `watch()` runs one timer. Each tick resolves the *open project's* plan (`RoutedPlannerStore.projectPlan()`, `routedStore.ts:51`), `stat`s its `project.json`, and only when `mtimeMs` changed reads the file, compares `revision` with `lastRevision`, and emits `origin:'external'` if different. `ProjectPlanner.sync()` (`projectPlanner.ts:19`) is called first so "active project" is always current. One `stat` per tick for one plan; no `fs.watch` (avoids rename-replace and recursion edge cases on Windows/Linux).
* **Echo suppression**: a local write updates `lastRevision` first, so the tick does not re-emit it.
* **Broadcast**: `for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.plannerEvent, e)` — the pattern already used at `src/main/ipc.ts:232,434,531`. Includes pop-out windows.
* **Renderer**: preload `planner.onEvent(cb): () => void`. New hook `useProjectState(planId)` (5.3) is the only subscriber per window; Studio and, later, Village components read from it.
* **Reliability fallbacks**: renderer re-fetches (a) on window focus, (b) on a 30 s heartbeat comparing `revision`, (c) after any IPC error. An event lost or an unknown future `type` is ignored — correctness never depends on delivery.
* **Project switch**: events include `planId`; the hook ignores events for a plan that is not the one it holds. `App.tsx` already remounts `WorkspaceView` with `key={projectKey}`, resetting state.

### 5.3 Renderer state (NEW, small)
`src/renderer/src/planner/projectState.ts` — pure reducer/selectors (unit-testable in node): state `{ planId, plan: PlannerProject | null, view: ProjectView | null, canvas: CanvasLayout | null, revisionSeen, loading, error }`; actions `loaded`, `event`, `error`.
`src/renderer/src/planner/useProjectState.ts` — hook: initial `forProject()` + `get` + `canvasLoad`; subscribes to `onEvent`; on `plan.changed` with `revision > revisionSeen` re-fetches `get` and recomputes `buildProjectView` locally (no extra IPC); on `canvas.changed` with `origin:'external'` re-fetches `canvasLoad`. Local canvas edits are applied optimistically and sent through a **300 ms debounced** `canvasPatch`; a failure shows a notice and keeps local state until the next successful load.

### 5.4 Rule of one truth
Neither interface may keep its own copy of task status, approvals, assignments, or agent state. They hold *only*: the last fetched `PlannerProject`/`ProjectView`, the `CanvasLayout`, and transient UI state (selection, hover, camera).

---

## 6. Canvas persistence

* Storage: `PlannerStore` methods (keeps the plan folder resolution in one place; `export/import` and `copyIntoProject` need no special cases):
```ts
// store.ts (NEW methods)
async readCanvas(id: string): Promise<{ layout: CanvasLayout; recovered: boolean }>;
async patchCanvas(id: string, patch: CanvasPatch): Promise<{ layoutRev: number }>;
```
* **Not through `mutate()`.** Therefore: no `project.lock` taken, no `revision`/`planRevision` bump, no `history.jsonl` line, no `planVersions` entry, and `ExecPackage.contentHash`/`contentKey` (computed from plan snapshot, tasks, assets, objective — `service.ts:419-431`) cannot change.
* Write path: in-process per-plan mutex (a promise chain keyed by `planId`) → read current → `applyCanvasPatch` → `writeJsonAtomic` (`store.ts:25`) with up to 5 retries on `EPERM`/`EBUSY` (Windows rename races under frequent drags). Only the app writes the canvas; the MCP server never does, so no cross-process lock is needed.
* Bounds: `CANVAS_LIMITS` enforced in `applyCanvasPatch`; reject (`PlannerError('invalid', …)`) rather than truncate; file ≤ 2 MB. Orphaned keys (entities deleted from the plan) are ignored on load and pruned during a patch only when `nodes` exceeds 80 % of `maxNodes`.
* Missing file → `emptyCanvas` (no write). Layout for entities without an entry comes from `autoLayout`.
* **Recovery**: on JSON/schema failure, rename the file to `canvas.corrupt-<timestamp>.json` (keep the newest 3), return `emptyCanvas` with `recovered:true`, and emit `plan.recovered`. Never throws to the UI. Unknown `version` is treated the same way but is *not* renamed over (kept as `canvas.v<N>.json`) so a newer build's data is not destroyed.
* Cross-version: an older OmniCandy ignores `canvas.json`; a newer one reading an old project just auto-lays-out.

---

## 7. Chat persistence and continuity (reuse what exists)

Existing: `PlannerStore.readChat/writeChat` (`store.ts:139-149`) → `<planDir>/chat.json`, last 48 messages × 6,000 chars (so ≤ ~288 KB), atomic write, full overwrite from the renderer (`PlannerChat.save`, `PlannerChat.tsx:84`). Weaknesses: a user message is only saved after the AI replies; a corrupt file silently becomes an empty chat; two windows could overwrite each other.

Changes (all backward compatible; a v1 file loads unchanged):
```ts
// store.ts
async readChat(id: string): Promise<ChatFile>;                                    // tolerant: v1 or v2; falls back to chat.prev.json; quarantines a corrupt file
async writeChat(id: string, chat: ChatFileInput): Promise<void>;                  // kept (legacy callers); writes v2, keeps chat.prev.json
async appendChat(id: string, req: { messages: ChatMessage[]; provider?: string; model?: string }): Promise<{ stored: number }>;  // NEW: read-modify-write under the per-plan mutex, trims to 48 / 6000
interface ChatFile { version?: 2; messages: ChatMessage[]; provider?: string; model?: string; savedAt?: string }
```
* **Append-before-send**: `PlannerChat.ask` calls `chatAppend([userMsg])` first, then `chat()`, then `chatAppend([assistantMsg])`. A provider error or crash leaves the user's message saved.
* **Bounded**: unchanged limits plus `provider`/`model` ≤ 80 chars; messages > 6,000 chars are truncated on write exactly as today.
* **Safe recovery**: `chat.json` write = temp + rename (exists). Before overwrite, copy the previous good file to `chat.prev.json`. On read failure try `chat.prev.json`; if that also fails, move the bad file to `chat.corrupt-<ts>.json` (keep 3) and start empty, emitting `plan.recovered`.
* **Active project**: unchanged mechanism — `ProjectPlanner.sync()` before every planner call (`ipc.ts:160`) and `WorkspaceView key={projectKey}` reset. `ProjectView.projectId` exposes the owner so a UI can assert it.
* **Claude busy coupling (S1-9, optional)**: `ClaudePartner.planChat` (`claudePartner.ts:791`) throws "Claude is busy…" if the panel is `working` because it shares `this.status`/`this.abort`. Give `planChat` a local `AbortController` and stop writing `this.status` (keep `costUsd` accumulation). **Risk**: two concurrent SDK `query()` calls — verify manually with a mock `query` in a unit test before shipping; if unsafe, leave as is and only improve the error text.

---

## 8. Planning coordination layer — `src/main/planner/coordinator.ts` (**NEW**, thin)

```ts
import { connectionCtx, type Ctx, type PlannerService } from './service';
import type { ProjectPlanner } from './projectPlanner';

export const COORDINATOR_ACTOR: Actor = { kind: 'createcraft', name: 'Planning coordinator' };   // ACTOR_KINDS includes 'createcraft' (planner.ts:9)

export interface ProposalDraft { note: string; changes: ProposalChange[]; rawText?: string }
export interface NextStep { kind: 'review-report' | 'review-proposal' | 'retake-stalled' | 'continue-current' | 'add-first-chunk'; taskId?: string; proposalId?: string; text: string }

export class ProjectCoordinator {
  /** Built with connectionCtx(COORDINATOR_ACTOR, ['read','propose','package']) — cannot hold 'edit' or 'review'. */
  constructor(deps: { service: PlannerService; planner: ProjectPlanner; capabilities?: CapabilityPort; execution?: ExecutionPort; now?: () => Date });
  view(planId?: string): Promise<ProjectView>;                                     // planId omitted → the open project's plan
  proposeChanges(planId: string, draft: ProposalDraft): Promise<{ proposalId: string }>;   // service.propose(ctx, planId, note, changes, 'coordinator')
  nextSteps(planId: string): Promise<NextStep[]>;                                  // deterministic from ProjectView; no AI
  readiness(planId: string, taskId: string): Promise<TaskReadiness>;               // capabilities.readiness; default NULL → 'manual-only'
}
```
Rules:
* Uses **only** public `PlannerService` methods: `getProject`, `propose`, `getPackage`. No store access, no new business rules.
* `proposeChanges` validates with the existing `changeSchema` (`planner.ts:106`); the owner accepts via the existing `decideProposal`.
* No AI call anywhere in this class. (Later stages may *call* it with changes produced by the planning chat or an agent.)
* It does **not** replace `ProjectPlanner` (binding to the open project) or `PlannerChat`; it composes them.

`src/main/planner/viewMethods.ts` (**NEW**) exports `createViewMethods(deps): Record<string, (...a) => unknown>` with the new IPC methods (section 9). Extracting them into a separate factory means the table is unit-testable without Electron and `ipc.ts` only spreads it into `methods` (`ipc.ts:77`).

---

## 9. IPC and service signatures

All go through the existing single channel `planner:call` (`PLANNER_CALL`, `ipc.ts:18`) via the preload generator list (`preload/index.ts:299`), so they inherit `isTrustedSender` and the `sync()` call (`ipc.ts:156-160`). New arguments are validated with zod in `viewMethods.ts`.

```ts
// src/shared/plannerApi.ts — additions to PlannerApi
view(id: string): Promise<ProjectView>;                                                    // coordinator.view(id); same as buildProjectView(get(id))
canvasLoad(id: string): Promise<{ layout: CanvasLayout; recovered: boolean }>;
canvasPatch(id: string, patch: CanvasPatch): Promise<{ layoutRev: number }>;               // zod: canvasPatchSchema
chatAppend(id: string, req: { messages: Array<{ role: 'user' | 'assistant'; text: string }>; provider?: 'claude' | 'openai' | 'gemini'; model?: string }): Promise<{ stored: number }>;
proposeChanges(id: string, draft: { note: string; changes: ProposalChange[]; rawText?: string }): Promise<{ proposalId: string }>;
onEvent(cb: (e: PlannerEvent) => void): () => void;                                        // implemented in preload, not via planner:call
```
Existing methods `get`, `list`, `forProject`, `decideProposal`, `chat*`, `prepareSend`, `importReport`, `reviewReport`, … are **unchanged**. No MCP tool is added or altered.

Service layer: no new `PlannerService` rules. The only service edits are the optional `canvas.json` entry in `exportProject`/`importProject` and the additive `Proposal.source` literal. Errors keep using `PlannerError` codes (`store.ts:13`).

---

## 10. Error handling and recovery summary

| Failure | Behaviour |
|---|---|
| `canvas.json` invalid/oversized | set aside as `canvas.corrupt-<ts>.json`, auto-layout used, `plan.recovered` event; UI shows a dismissible note |
| `canvas.json` newer `version` | keep file untouched (copy to `canvas.v<N>.json`), run on auto-layout, do not overwrite |
| `chat.json` invalid | try `chat.prev.json`, else quarantine and start empty; `plan.recovered` |
| Rename race on Windows | retry ≤ 5× (EPERM/EBUSY/EACCES) with 10-30 ms backoff; then surface `PlannerError('conflict')` |
| Patch exceeds limits | `PlannerError('invalid', 'The canvas is too large…')`; nothing partially written |
| Event dropped / app asleep | focus + 30 s heartbeat re-fetch |
| Plan deleted/moved while open | `get` → `not_found`; hook shows "plan not found", offers reload; hub stops watching that id |
| Two windows move the same card | per-key last-writer-wins; both converge on the next `canvas.changed` |
| External MCP write during local edit | existing `rev` conflict path (`checkRev`, `service.ts:39`) is unchanged |
| Coordinator asked to do a reviewer action | impossible by construction: `need(c,'review')` throws `forbidden` |

---

## 11. Implementation tasks in dependency order

Each task is a separate small change that leaves the app working and all existing tests green (`npx vitest run src/main/planner src/shared/projectPlan.test.ts` currently passes 112 tests).

| ID | Task | Depends on | Files | Size |
|---|---|---|---|---|
| **S1-1** | Pure view model: `ProjectView`, `buildProjectView`, `leafProgress`, `currentTask` (extract rule from `pickCurrent`) | — | NEW `src/shared/projectView.ts`; `PlannerWork.tsx` imports `currentTask` | M |
| **S1-2** | Canvas types, schema, `applyCanvasPatch`, `autoLayout`, `pruneOrphans` | S1-1 | NEW `src/shared/plannerCanvas.ts` | M |
| **S1-3** | Canvas persistence in the store (`readCanvas`, `patchCanvas`, mutex, retries, quarantine) | S1-2 | `store.ts` | M |
| **S1-4** | Chat durability (`appendChat`, v2 file, `chat.prev.json`, quarantine) | — | `store.ts` | S |
| **S1-5** | Events: `PlannerEvent`, `onWrite` option, `PlannerEventHub` (emit + mtime check), channel constant, preload `onEvent` | S1-3, S1-4 | NEW `src/shared/plannerEvents.ts`, NEW `src/main/planner/events.ts`; `store.ts`, `routedStore.ts`, `ipc.ts` (planner), `shared/ipc.ts`, `preload/index.ts` | M |
| **S1-6** | Ports + coordinator + `Proposal.source 'coordinator'` | S1-1 | NEW `src/shared/plannerCoordination.ts`, NEW `src/main/planner/coordinator.ts`; `planner.ts` (one literal), `PlannerWork.tsx` (text) | M |
| **S1-7** | IPC methods + typed API (`view`, `canvasLoad`, `canvasPatch`, `chatAppend`, `proposeChanges`) | S1-3..S1-6 | NEW `src/main/planner/viewMethods.ts`; `planner/ipc.ts`, `shared/plannerApi.ts`, `preload/index.ts` | M |
| **S1-8** | Renderer state: `projectState.ts` reducer + `useProjectState`; swap `PlannerWorkspace` polling; `PlannerChat` uses `chatAppend` | S1-7 | NEW `src/renderer/src/planner/projectState.ts`, `useProjectState.ts`; `PlannerWorkspace.tsx`, `PlannerChat.tsx` | M |
| **S1-9** | (optional) Decouple `planChat` from the Claude panel busy state | — | `claudePartner.ts` | S, risky |
| **S1-10** | Export/import carries `canvas.json`; Home stale text; mark `docs/planner-simplification-plan.md` as superseded by this blueprint | S1-3 | `service.ts`, `HomeWorkspace.tsx`, docs | S |

S1-1, S1-2 and S1-4 can proceed in parallel; S1-5/S1-6 can proceed in parallel after their inputs.

---

## 12. Tests for each task

Test files go next to the code (`vitest.config.ts` includes `src/**/*.test.ts`, environment `node`, so renderer logic must be tested through pure modules; there are **no renderer component tests** today and Stage 1 does not add a DOM test stack). No test may call a provider; use temp dirs (`os.tmpdir()`), fake `Date`, and the existing fixtures in `src/main/planner/__fixtures__/`.

| Task | Test file | Must prove |
|---|---|---|
| S1-1 | `src/shared/projectView.test.ts` | every fixture (`fresh`, `mid-claim`, `outdated-report`, `superseded`) builds a view; node count = items + tasks + milestones + assets + reports(+ghosts) as specified; output is deterministic (deep-equal on two runs); `leafProgress` does not double-count a parent with children, and a parent with all children accepted is **not** reported `accepted`; pending proposals become ghosts with the right `changeIndex`; `currentTask` matches the old `pickCurrent` rule on the fixtures; no app-specific branching (a task with `appRef:{kind:'external', id:'made-up.app'}` works) |
| S1-2 | `src/shared/plannerCanvas.test.ts` | schema rejects bad ids (`__proto__`, long, non-finite); `applyCanvasPatch` enforces every `CANVAS_LIMITS` entry; patch is idempotent; `layoutRev` increments; `autoLayout` is deterministic, places dependents to the right of their prerequisites, handles 2,000 tasks in < 200 ms, and returns a position for every node |
| S1-3 | `src/main/planner/canvas.test.ts` | **invariant test**: create a plan, record `project.json` bytes + `history.jsonl` + `revision/planRevision` + an open package's `contentKey`; apply 50 canvas patches; assert all unchanged and `prepareSend` for the same tasks returns `reused:true`. Missing file → empty layout, **no file created**. Corrupt file → quarantined, empty layout, `recovered:true`. Two concurrent patches both land. Duplicate project (copy dir) keeps the layout. Oversized patch rejected with no partial write |
| S1-4 | `src/main/planner/chatStore.test.ts` | v1 file loads; `appendChat` adds, trims to 48/6000; interleaved appends (Promise.all) lose nothing; corrupt `chat.json` falls back to `chat.prev.json`; both bad → quarantine + empty; saved file contains no extra fields beyond the schema |
| S1-5 | `src/main/planner/events.test.ts` | `mutate` emits exactly one `plan.changed` with the new revision (origin `app`); a write by a **second `PlannerStore` instance on the same folder** is detected by `watch()` within one tick and emitted as `external` (fake timers / injected `pollMs`); a local write does not produce a duplicate external event; `stop()` ends timers; events carry no plan text |
| S1-6 | `src/main/planner/coordinator.test.ts` | `proposeChanges` creates a **pending** proposal and leaves `project.json` tasks/items unchanged; calling anything requiring `review`/`edit` through the coordinator's `Ctx` throws `forbidden`; actor shows as "Planning coordinator" in `history.jsonl`; invalid changes rejected by `changeSchema`; `nextSteps` order = reports, suggestions, stalled, then current; `readiness` returns `manual-only` with the null port; existing `mcp.session.test.ts` and `links.test.ts` still pass (MCP unchanged) |
| S1-7 | `src/main/planner/viewMethods.test.ts` | each method validates input with zod and rejects malformed patches; `view(id)` equals `buildProjectView(await service.getProject(...))`; `chatAppend` respects limits; methods run against a real `RoutedPlannerStore` in a temp project folder; unknown extra properties rejected |
| S1-8 | `src/renderer/src/planner/projectState.test.ts` (pure reducer) | ignores events for another `planId`; ignores events with `revision <= revisionSeen`; handles `plan.recovered`; re-fetch is requested only when needed; unknown event types are ignored. Manual checklist (recorded in the PR): open project → plan appears; edit through MCP CLI → UI updates ≤ 3 s without polling code; switch projects → no leakage; `npm run smoke:project-planner` (not run in this blueprint) |
| S1-9 | `src/main/claudePartner.planChat.test.ts` (with an injected fake `query`) | planChat while `send` is in progress does not throw busy and does not alter `status`; cancelling one does not abort the other; if this cannot be made safe, the task is dropped and only the error text improves |
| S1-10 | extend `src/main/planner/service.test.ts` | export zip with `canvas.json` imports with layout intact; zip without it imports as before; an old-format zip imports unchanged |
| Global | existing suites | `npx vitest run src/main/planner src/shared` green; `npm run typecheck` green; the 12 existing planner test files unchanged |

---

## 13. Acceptance criteria for Stage 1 (maps to the stated stage goals)

1. **An existing project opens unchanged**: opening and viewing a plan writes nothing (verified by file hash in T3), and `buildProjectView` works on all fixtures.
2. **The chat is restored**: `chat.json` v1 and v2 both load; a message sent before a simulated crash is present after restart (T4).
3. **A proposed plan can be reviewed**: coordinator/MCP/pasted proposals appear as ghost nodes in `ProjectView` and are accepted or rejected per change through the unchanged `decideProposal` (T1, T6).
4. **Restarting loses no approved work**: nothing in Stage 1 writes accepted-plan state except existing service methods (T3 invariant, existing `service.test.ts` restart test).
5. **Layout is free of side effects**: 50 moves leave revisions, history and package keys untouched (T3).
6. **One event path**: the renderer no longer polls; external edits arrive as `plan.changed` (T5, S1-8 checklist).
7. **MCP compatibility**: `mcp.roundtrip.test.ts` and `mcp.session.test.ts` pass untouched.

---

## 14. Risks and compatibility concerns

| # | Risk | Mitigation |
|---|---|---|
| 1 | Change-detection latency or missed external write (mtime resolution on some filesystems) | Compare `revision` after any mtime change; also stat size; 30 s renderer heartbeat; document that external edits can take up to one poll interval |
| 2 | Adding `Proposal.source: 'coordinator'` is a stored-value change | Additive literal; not zod-validated on read; UI default branch handles unknown values; older builds show "from a connection". If rejected, reuse `'connection'` and rely on the actor name |
| 3 | `leafProgress` differs from `progressOf` shown on Home/project list for nested plans | Flat plans (all current data) are identical; keep both and label which one a screen uses; migrate screens in Stage 2 |
| 4 | Concurrent SDK queries in S1-9 | Optional task with a fake-`query` test; drop if unsafe |
| 5 | Layout writes during drags hammering the disk / Windows rename races | 300 ms debounce, in-process mutex, retries on `EPERM/EBUSY` |
| 6 | `ProjectView` size for thousands of tasks | O(n) build, memoized by revision; ghosts capped (e.g. first 200 per proposal) |
| 7 | `RoutedPlannerStore.list()` builds inner `PlannerStore` instances (`routedStore.ts:44,53`) without `onWrite` | They only read; all writes go through the routed instance. Test asserts events fire for a routed project |
| 8 | Duplicate project copies `canvas.json` **and** `chat.json` **and** the encrypted agent checkpoint | Intended (a duplicate is a full copy); plan ownership re-bound by `adoptPlan` (`service.ts:146`); canvas keys are entity ids so they still match |
| 9 | `importProject` into a project that already has a plan can yield two plans (see audit doc 04 §5) | Out of scope for Stage 1; add a test and a guard in Stage 2 when the import UI is redesigned |
| 10 | Stage 1 leaves PlannerChat's one-click "Add these to my plan" (immediate `decideProposal`) | Unchanged on purpose (no UI redesign); Stage 2 switches chat output to ghost previews because the data path (pending proposal → ghosts) already exists |
| 11 | Renderer has no component tests | Keep logic in pure modules (`projectView`, `plannerCanvas`, `projectState`) which are testable; manual checklist for the hook |
| 12 | Lint gate (`npm run lint`) already fails repo-wide on generated `build-source/` | Lint changed files directly (`npx eslint <files>`); do not "fix" `build-source/` in this work |
| 13 | Future fields on `PlanTask` (assignment) | Additive and optional only; `exportProject`/`importProject` stay version 1 (`importProject` rejects other versions, `service.ts:728`), so a breaking shape change would need version 2 and a reader for both |

---

## 15. Visual direction received (for Stage 2/6; no Stage 1 work depends on it)

Five reference images were supplied and read. What they imply for the data we are preparing:
* **Cutaway rooms with characters around a table** (bear workshop with a map table; the detailed town cutaway with a worker at a desk): a workplace is a *room with N stations*. Stage 4/6 data needs `Business → Workplace → stations[]` where the number of stations follows the number of workers. Reserved only; nothing stored now.
* **Terraced isometric town / flat island village**: buildings cluster around a plaza (the Town Hall) with paths. Town layout is presentation data (`town.json`, Stage 6), separate from tasks, exactly like `canvas.json`.
* **Soft 3D person at a desk with a glowing AI buddy**: the Studio "creative partner" presence. A friendly, non-threatening agent avatar is a UI asset concern, not a data one.
* Style cues (warm wood, rounded chunky props, soft lighting, map and pins on a table) match the plan to show the **project canvas as a shared map table** in the Town Hall (the canvas rendered on the meeting-room board). That is why `ProjectView` and `CanvasLayout` are renderer-agnostic: the same data can draw as DOM cards (Studio) or as a texture/board in the 3D scene (Village).

---

## 16. What this blueprint deliberately does not decide
* The Studio chat+canvas component structure (Stage 2).
* How capabilities are scored and matched (Stage 3).
* Agent role/business/workplace schema and Town Hall meeting records (Stages 4 and 6) — only the extension points above are fixed.
* The 3D asset pipeline and village camera/controls (Stage 6; Three.js + React Three Fiber, per the approved direction, to be added as dependencies *then*, not now).

# 07. Technical problems and opportunities

Ranked by impact on **usability** (U) and **reliability** (R). Every item cites the evidence. "Verified" = I read the code or ran the
read-only commands listed in doc 01; "inferred" = follows from code but I did not watch it happen.

## A. Problems, most serious first

### 1. The planner cannot run work; "delegation" is copy and paste (U: critical, R: medium) — verified
* The whole send flow ends in text: `prepareSend` → `sendText` → clipboard, or a DOM event that only fills a chat box (`PlannerSend.tsx:90`, `ClaudePanel.tsx:52`). The planner says so itself: "nothing starts by itself" (`PlannerSend.tsx:44`).
* A chunk costs the owner ~7 manual steps: pick destination → copy → paste into an AI → AI works → copy its answer → paste back → classify/preview → review → accept. Even for "OmniCandy Claude" the owner must press Send and Claude must choose to call `planner_claim`.
* The independent agent cannot even see the planner tools until it calls `enable_tools {family:"planner"}` (`toolFamilies.ts:13`).
* Consequence for a Studio/Game redesign: there is no API like `runChunk(planId, taskId, agent)`; it must be created (doc 03, section 7).

### 2. A "done" chunk is not tied to evidence (U: high, R: high) — verified
* Reports carry self-reported `verification[]` and `changedFiles[]` (`planner.ts:172-182`); nothing attaches harness receipts, adapter results, saved-version ids or library assets (`outputs[].assetId` exists, never filled).
* The harness already computes better evidence (`evidence_verify`, `TRUSTED_READBACK_COMMANDS`, `saveVersionId`), but it lives in a different task model (`TaskPlan`) and a different store (encrypted checkpoint).
* The owner can also "Mark done" with no report at all (`PlannerWork.tsx:123-124`), so the progress bar means "owner clicked", not "work verified".

### 3. Three AI surfaces, two task models, no shared memory (U: high, R: high) — verified
* Planner chat (no tools), Claude panel (tools), independent agent (tools, different providers) share no conversation, no context, no history format (doc 03 §1, doc 06 §5).
* `PlanTask` (planner) vs `TaskPlan.steps` (harness) are unrelated; no mapping; a run's progress never updates a chunk.
* The Claude path is a single instance: planner chat and Claude panel block each other (`claudePartner.ts:792` "Claude is busy with another request").
* The independent agent cannot use Claude (`AGENT_PROVIDER_IDS = openai, gemini, local`).

### 4. The owner cannot author the plan's rules in the UI (U: high, R: low) — verified
* Requirements and decisions are what every package carries as "the rules", yet no UI creates/edits them; likewise the brief (goal/description/scope/constraints/deliverables), plan assets, items and the 7 planner templates (`PLANNER_TEMPLATES`, only reachable via `createProject({templates})` which no UI calls).
* Unreachable backend (14 of the 46 planner methods): `update, addItem, updateItem, setItemStatus, removeItem, addAsset, pickAssets, removeAsset, assetHealth, create, createPackage, packageView, savePackage, createFromHomePlan` + `claude.planProject` (doc 02 §5.2).
* Rules can only arrive as an AI proposal (chat chunk list sets `set_brief`; pasted/MCP proposals can add requirement/decision items). If the AI never proposes them, the "accepted rules" in packages are empty (`SendPanel` hides the rules section when none: `PlannerSend.tsx:64`).
* There is no UI to view or restore `planVersions`, only the activity log.

### 5. Hidden complexity leaks through the simple surface (U: medium-high) — verified
Packages with numbers/supersede/reuse, claim tokens and 8-hour leases, drift ("the plan changed since this was sent"), `planRevision` vs `revision` vs `metaRev`, scopes, proposals (all-or-nothing conflicts), "Unsend". The three-tab UI hides most, but they surface as errors and notices: `"Not applied: … Reject the proposal or deselect those changes"` (`service.ts:373`), "replaces the earlier brief(s) (n)" (`PlannerSend.tsx:81`), "Take back", stalled states (`displayStatus`), and a mandatory acknowledgement checkbox when accepting after the plan changed (`OutdatedGate`). `plainError()` (`plannerView.ts:80`) exists specifically to translate these.

### 6. Fragile synchronization (R: medium) — verified/inferred
* No push channel: 3 s polling of `list()` and a full `get()` on change (`PlannerWorkspace.tsx:65-74`). Edits from the stand-alone MCP process appear with ≤3 s delay; an open edit form is not told its record changed until save (then `rev` conflict).
* Two writer processes depend entirely on the lock file; a 20 s stale-lock takeover (`store.ts:54`) could break a long write (inferred; writes are short).
* `projectPlan()` returns the newest plan when a folder holds several (`routedStore.ts:51-55`); `importProject` can create a second plan in a project (doc 04 §5, ❓).
* The MCP connection snippet is bound to the project folder that was open when it was generated (`planner/ipc.ts:152`); switching projects does not rebind it (inferred).

### 7. Legacy routing and dead code raise the cost of every change (U: low, R: medium) — verified
* Two plan locations (project `Planner/` vs shared `<userData>/planner/`), `RoutedPlannerStore`, "older plans", `attachOlder`, `adoptPlan` (for Duplicate).
* Dead/stale: `PlainWords` false branches in `TaskRow` (always `true`, `PlannerWorkspace.tsx:90`); `TabId` values `overview|assets|history` (`plannerUi.tsx:5`); orphaned Home-plan pipeline (`projectPlan.ts` `parseProjectPlan/briefFromPlan`, `ClaudePartner.planProject`, `createFromHomePlan`, `seedPlanFromGoal`'s "Plan the user approved:" marker); HomeWorkspace copy says Planner is "under More".
* Documentation drift: `docs/planner-simplification-plan.md` still describes 6 tabs.
* `CreateCraft` vs `OmniCandy` naming residue in env vars, events, MCP names.

### 8. Weak persistence of "where I was" and of runs (U: medium) — verified
* The Planner always reopens on **Idea** (`PlannerWorkspace.tsx:62`); the compensation is the "Pick up where I left off" banner driven by `lastActive`.
* Chat history capped (48 stored, 24 sent); Claude panel and agent histories are separate; an agent run saves a minimal seed checkpoint before its first model call and the full one when it pauses or hits a limit (`ipc.ts:1434,1445`); a finished run's conversation is held in memory (`conversation`, `ipc.ts:1443`), so after a restart only a paused/limited run can be restored (inferred from `restoreAgent`).
* Background jobs are in memory (`jobLedger.ts` header): a restart loses their status.
* Plan versions saved but not restorable.

### 9. Concurrency limits block any "team of agents" (U: high for the new vision, R: low) — verified
One active agent task (`loop.ts:73`), one checkpoint per project, one `ClaudePartner.status`, one embedded external window (`ipc.ts` `liveExternal`), one open project. Claude and the independent agent also exclude each other: `prepareNewTask({claudeWorking})` refuses a new agent task while Claude is working (`ipc.ts:1419`). See doc 03 §5.

### 10. Cost is invisible at the planner level (U: medium) — verified
Claude reports `costUsd` (session total), the harness reports provider tokens, generation has an estimate ledger. None is attributed to a chunk or plan; the planner chat shows only a static "billed to your account" note (`PlannerChat.tsx:167`).

### 11. Engineering hygiene (R: low) — verified
`npm run lint` fails repo-wide (658 problems, mainly generated `build-source/` and `scripts/`), so `npm run check` (the documented gate in `CLAUDE.md`) does not pass as a whole even though typecheck and all 1,545 tests do.

## B. Poor separation of UI and logic (what blocks two interfaces)

| Logic currently inside React components | Where | Needed by a second UI |
|---|---|---|
| "Which chunk is current / next" | `pickCurrent` `PlannerWork.tsx:376` | yes |
| "What waits for the owner" assembly | `ReviewInbox` `PlannerWork.tsx:354` + `needsYou` (shared) | yes (partly shared) |
| Send flow state machine (destination, forced rules, redaction, copy) | `SendPanel` `PlannerSend.tsx:13` | yes |
| Planning-chat protocol handling (`[[READY]]`, chunk list adoption, `importSuggestions`+`decideProposal`) | `PlannerChat.tsx` | yes |
| Plan start flows (scan, apply, seed chat) | `PlannerStart` | yes |
| Polling/refresh | `PlannerWorkspace.tsx:50-74` | yes |
Good: types, status rules, context building, paste parsing, text builders are already pure and shared.

## C. Unused but valuable assets (reuse before building)

1. **The planner MCP server** (`mcp.ts`, `mcpMain.ts`): tested (`mcp.roundtrip.test.ts`, `mcp.session.test.ts`), scope-separated, provider-neutral. A natural agent-facing API.
2. `PLANNER_TEMPLATES` (7 task templates with completion checks) — complete, tested through `createProject`, no UI.
3. `analyzeProject` — read-only project scan used for start suggestions and AI context.
4. `buildContext` — rules budgeting per destination plus upstream results of finished prerequisite chunks.
5. `planDrift` / `snapshotOf` / `planVersions` — change-awareness; versions are stored but unused for restore/diff.
6. `PlanAsset` + `assetHealth` + export "bundle" — file linking with checksum; no UI.
7. `lastActive` + `touchTask` — the basis of "resume".
8. `CollabState`, `LiveSnapshot`, `AgentUiState`, `ExternalLiveState` — real activity streams already pushed to the UI.
9. `@xyflow/react` in `WorkflowEditor.tsx` — a themed node canvas.
10. `SoftwareWorkspace` + `shared/softwareList.ts` — a status board of every connectable program with next steps.
11. `PLANNER_CLIENTS` honesty table — a model for truthfully labelling capabilities ("verified/untested/unavailable").

## D. Architectural obstacles to supporting both Studio Mode and Game Mode

1. **No first-class "agent" entity.** Today an agent is an engine choice (Claude / OpenAI / Gemini / local) plus an `Actor {kind,name}` string in the log. Delegation, roster, state ("idle/working/blocked"), memory, and cost per agent do not exist as data.
2. **No orchestrator API** (doc 03 §7): needs `start run for chunk`, `observe run`, `stop`, `report` as typed calls plus events, over the existing harness / Claude loop.
3. **No event bus for planner/agent state** to drive a live "world" view; only the renderer-side polling and the separate per-surface streams.
4. **View-model logic lives in components** (table B).
5. **Native windows overlay the web UI** (embedded apps are separate OS windows positioned over a div): a full-screen game canvas must hide/dock them using `useOverlayOpen`, or show their state abstractly.
6. **Single-instance limits** (section A.9).
7. **Three conversation formats** (`chat.json`, `Claude/conversation.json`, encrypted agent checkpoint).
8. **Navigation** is one `WorkspaceId` switch; a second mode would need a mode switch above it (or a separate window/route) while sharing `PlannerService`.
9. **Truthfulness constraints are strong and should be kept**: owner-only acceptance, "an AI saying done ≠ done", drift detection. A game UI must not weaken them (e.g. auto-accepting animated "completions").

## E. Unnecessary user steps today (candidates to remove without losing safety)

* Choosing a destination every time (`createcraft | tools | chat`) — the app knows which engines are available.
* Copy → paste → paste back for an in-app agent (no longer needed if the app starts the run and receives the report itself).
* "Yes, make the plan" → tick list → "Add these to my plan" → plan tab — the proposal step is already auto-accepted; one click would do.
* Starting a plan: "Start with an idea" vs "Look at what is already here" when the Home "idea" path has already created the plan.
* Reviewing a report with a mandatory drift acknowledgement when nothing relevant changed (`OutdatedGate` appears whenever `planRevision` differs, even for unrelated rule edits — inferred from `service.ts:674`; the drift list does name what changed).

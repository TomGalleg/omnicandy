# 00. START HERE: OmniCandy planner redesign audit

**Purpose**: a verified technical foundation for designing a simpler, more capable planner with two front ends (Studio Mode, Game Mode)
over one core. This audit was written from the actual source tree (`E:\ClaudeCraft`, branch `main`, HEAD `bf7b6b5`, inspected 2026-10-27).
**Nothing in the application was modified.** The only files added are in `creative-studio/docs/planner-redesign-audit/`.
Read this page first, then follow the pointers. Where I am unsure I say so (❓).

## 1. What OmniCandy is today

A Windows-first Electron + React + TypeScript desktop app (`creative-studio/`, product name **OmniCandy**) where a "Creative Partner" AI works on
creative projects with 13 first-party "Craft" apps (photo, vector, sound, film, colour, effects, design, Word, PDF, spreadsheet, deck, UI, CAD)
and with third-party programs (real adapters for **Blender, Unreal Engine, Autodesk Fusion, DaVinci Resolve**; detection-only stubs for 12 more).
A project is a folder (`project.json` + library + per-app folders + a `Planner/` folder). Tabs: Home/Project, Media, Edit (with Color/Effects modes),
AI Generate, Software, Planner, Deliver; Simplified and Advanced menus. Details: docs 01 and 06.

## 2. How the planner actually works (verified)

* One **plan per project**, stored in `<project>/Planner/projects/<planId>/` (`project.json`, `history.jsonl`, `chat.json`). Single write path with a lock file, revisions and a history log (`src/main/planner/store.ts`).
* UI = three tabs: **Idea** (chat with Claude/OpenAI/Gemini, no tools) → **Plan** (editable "chunks" = tasks) → **Work** (one chunk at a time).
* AI output never changes the plan on its own: it becomes a **proposal** the owner accepts; an AI "report" never marks work done — only the owner accepts (`src/main/planner/service.ts`).
* **"Work" is a hand-off, not execution.** The Work tab builds an execution package and *copies text* (or prefills the Claude panel's input box). Whoever receives it (Claude in the panel, Claude Code via MCP, ChatGPT by paste) works elsewhere and reports back by tool call or by the owner pasting the answer. The planner never starts an AI and never touches project files (doc 02 §4, doc 03 §6).
* The same rules are exposed as an **MCP server** (11 tools, scopes `read/propose/package/execute`), used by Claude Code or by OmniCandy's own Claude (doc 03).
* Tests: 12 planner test files, 112 tests, all passing. No renderer component tests exist for the planner.

## 3. Biggest architectural problems (ranked; details in doc 07)

1. **No planner → agent execution API.** Delegation is copy/paste; there is no "run this chunk with agent X" call and no run events (doc 03 §7).
2. **Completion is not tied to evidence.** Reports contain self-reported checks; the harness's real evidence (read-backs, receipts, saved-version ids, asset ids) is not attached. "Mark done" needs no evidence at all.
3. **Three separate AI surfaces and two task models** (planner chat / Claude panel / independent agent; `PlanTask` vs the harness `TaskPlan`), sharing no conversation, context or provider layer. Claude's single instance makes planner chat and Claude panel block each other.
4. **The plan's rules cannot be authored in the UI.** Requirements, decisions, brief, plan assets and the 7 planner templates have working backend code but **14 of the 46 planner IPC methods have no UI caller**; rules arrive only through AI proposals.
5. **Single-instance execution**: one agent task, one checkpoint per project, one embedded external window, one open project. Hard limits for any multi-agent or "team" idea.
6. **No event stream for planner state** (the UI polls every 3 s) and view-model logic embedded in React components, which would be duplicated by a second UI.

## 4. Biggest usability problems

* A chunk takes ~7 manual steps (choose destination → copy → paste into an AI → wait → copy answer → paste back → review → accept).
* Hidden complexity leaks into errors and notices: package numbers, supersede, claim leases, drift acknowledgements, all-or-nothing proposal conflicts.
* The Planner reopens on Idea every time; the Home screen text still says the Planner lives "under More".
* Two ways to start a plan (idea vs scan) and a legacy "older plans" mechanism add choices a new user does not need.

## 5. What can be reused as is (doc 05 §5, doc 07 §C)

`PlannerService` + `PlannerStore` (rules, locking, history) · the MCP tool contract · `buildContext` (what an AI is told) · `analyzeProject` · `planDrift`/`planVersions`
· `lastActive` · the harness: `runAgent`, `ToolRegistry`, tool families, checkpoint/recovery/job ledger, `evidence_verify` + `TRUSTED_READBACK_COMMANDS` · `IntegrationManager`
(permissions, approvals, jobs, audit) and all four real adapters · live state streams (`LiveSnapshot`, `CollabState`, `ExternalLiveState`, `AgentUiState`) · Software tab status board ·
`@xyflow/react` canvas · themed CSS variables · the three-tab Idea/Plan/Work *vocabulary* (chunk, Needs you).

## 6. Facts a Game Mode designer must know

* There is **no canvas/WebGL/game library** in the project; animation is CSS only; the only graph canvas is `@xyflow/react` (doc 06 §7).
* ArtCraft apps and Blender/Unreal/Fusion/Resolve are **native windows drawn over the web page**; a full-screen overlay must hide or dock them (`useOverlayOpen`).
* "Agent" is not a data object today: only an engine choice plus an `Actor {kind,name}` in the log. Multi-agent features **do not exist** (doc 03 §5).
* Real activity is observable today via `LiveSnapshot`, `AgentUiState`, `ClaudeState`, `ExternalLiveState`, planner `history.jsonl`; there is no combined feed.
* Truthfulness rules to preserve: owner-only acceptance; AI claims ≠ accepted; plan-drift warnings; approvals for paid or external actions.

## 7. Which source files matter most

Tier 1 (read all): `src/shared/planner.ts`, `src/main/planner/service.ts`, `store.ts`, `routedStore.ts`, `projectPlanner.ts`, `ipc.ts`, `mcp.ts`,
`src/shared/plannerApi.ts`, `src/renderer/src/planner/{PlannerWorkspace,PlannerWork,PlannerChat,PlannerSend}.tsx`, `src/main/projects.ts`, `projectStore.ts`,
`src/main/agentHarness/loop.ts`, `src/main/claudePartner.ts`, and the planner/agent ranges of `src/main/ipc.ts`. Full tiered list with reasons: doc 10.
Implementation-level map (file → symbols → tests → retain/modify/replace): doc 09.

## 8. What is still missing or unverified

* **No live run of anything.** I did not launch the app, did not run `smoke:*` scripts, did not call any AI, and did not run any external program. Claims about runtime behaviour are from code and the unit tests (all green).
* Whether Claude (panel or Claude Code) reliably *chooses* to call the planner tools — `plannerClients.ts` itself says this was never run live because it costs money.
* Revit: tests, an add-in folder (`addins/revit`) and docs exist; I did not trace which registers a working adapter. FreeCAD: stub only (confirmed by the Software screen).
* `importProject` into a project that already has a plan (possible two plans in one project) — read, not exercised.
* Internal details of `liveApps.ts` (1,444 lines), `CreateWorkspace.tsx`/AI Generate internals, `docs/research/*`, `addins/*`, `src/shared/claudeHistory.ts` constants and the older planner docs (`project-planner.md`, `planner-explained.md`, `planner-first-run-checklist.md`) were not read in full.
* The Mermaid diagrams (doc 08) were written by hand and not rendered by a tool here.
* `npm run lint` fails repo-wide on generated `build-source/` and `scripts/`; the documented `npm run check` gate therefore does not pass as a whole today (typecheck and tests pass).

## 9. Reading order for ChatGPT

`00` → `09` (map) → `02` (planner) → `03` (execution gap) → `07` (problems) → `04` (storage) → `05` (integrations) → `06` (UI) → `01` / `08` (reference) → source files per `10`.

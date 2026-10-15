# CreateCraft: current progress (review package)

Date: 2026-10-14 · Branch: `main` (local only, not pushed) · Last commit: Phase 1.3-1.4

CreateCraft is a Windows desktop app (Electron + React + TypeScript) that embeds and drives the
seven installed ArtCraft apps (PhotoCraft, VectorCraft, SoundCraft, FilmCraft, LightCraft,
EffectCraft, DesignCraft) with Claude as a Creative Partner.

**Status labels used below**

| Label | Meaning |
|---|---|
| **WORKING** | Implemented and verified against the real installed apps or services on this PC (tests and/or end-to-end smoke runs listed). |
| **PARTIAL** | Implemented but with known gaps, or only verified in part. |
| **MOCK** | Present in the UI but backed by a labelled mock; no real work is done. |
| **NOT IMPLEMENTED** | Not built yet. |

Evidence for each integration (exact commands, versions and test results) is in
`docs/integration-audit.md` (the "Integration truth table"). Note: `README.md` is out of date (it
still describes "Phase 2, steps 1–2"); this file and the audit are the current picture.

**Resume here (new conversation):** follow Tomas's Master Development Instructions (phases 0–10).
Phase 0 audit, Phase 1, Phase 2 and Phase 3 (3.1-3.4, plus the two gap fixes below) are done (see "Master plan status" below). Phase 4 (Simplified / Advanced navigation) is done too. Phase 5 (parts 1 and 2: Claude builds, runs and monitors workflows on the shared engine; pause, manual control, rerun of affected steps, versions, templates) is done; Phase 6 (real image generation, spending limit, Workflow AI step) is done and verified; **Phase 7 (AI video) is done for Veo and verified; Runway and Luma are not built; Phase 8 (templates) is done.** Keep work in small milestones and replies short.

## Master plan status (Phase 0 audit, 2026-10-14)

Verified against the code at `fab6ab7` plus the Phase 1 commit. Baseline before changes: lint 0,
typecheck 0, Vitest 135 passed / 14 skipped (opt-in live tests).

| Phase | Item | Status | Depends on | Acceptance test |
|---|---|---|---|---|
| 1.1 | Header status chips moved out of the header | **WORKING** | none | `scripts/smoke-docks.mjs` |
| 1.1 | Settings dialog: Appearance, Integrations (ArtCraft, Claude, AI keys), Advanced diagnostics | **WORKING** | none | `smoke-docks.mjs` |
| 1.2 | Vertical Media tab (far left) and Claude tab (left edge of Claude panel); collapse/expand, resize, remembered width and state, Ctrl+Shift+M / Ctrl+Shift+C, aria labels | **WORKING** | none | `smoke-docks.mjs` 15/15; embedded app follows: `smoke-live.mjs` |
| 1.3 | Collapsible inspector, metadata in an expandable section, smaller Activity panel, plainer labels | **WORKING** | 1.2 | `smoke-docks.mjs`; screenshots 01, 42-45 |
| 1.4 | Workflow Editor: collapsible side panels, Fit/auto layout, running-node highlight, approval expands | **WORKING** | 1.2 | `smoke-workflow.mjs` 7/7, `workflowLayout.test.ts`; screenshots 95-96 |
| 2.1 | Default project folder in Settings, Projects & Storage (Browse, Open folder, write check, free space, per-project folder when creating) | **WORKING** | 1 | `projects.test.ts`, `smoke-projects.mjs` |
| 2.2 | Self-contained project folder layout (Assets/, Versions/, Exports/, Workflows/, per-app folders...) | **WORKING** for new projects; older projects keep their layout | 2.1 | `projectStore.test.ts`, `projects.test.ts` |
| 2.3 | Open existing project from any folder, Duplicate, verified Move, Locate a missing project | **WORKING** (relink of individual missing files: n/a, files are copied into the project) | 2.1 | `projects.test.ts` |
| 2.4 | Virtual collections (All, Originals, AI, Favorites, Versions, Workflows, Deliverables) | **WORKING** | 2.2 | `collections.test.ts` |
| 3.1 | Prompt-first Project Home: prompt, Create with Claude, New blank project, Open existing, recent project cards with type/brief, search | **WORKING** (Templates button enabled in Phase 8) | 2 | `smoke-projects.mjs` 13/13 |
| 3.2 | AI-first creation: real Claude call returns name, type, finished output, apps, AI tools, steps, questions; user approves; project created in chosen/default folder; optional reference import; opens matching workspace | **WORKING** (one real Claude call verified) | 3.1 | `smoke-home-ai.mjs` 6/6 (real Claude, Sonnet 5.5) |
| 3.3 | Blank project: name, type (5 categories), folder | **WORKING** | 3.1 | `projects.test.ts`, `smoke-projects.mjs` |
| 3.4 | Project Overview: brief, objective, progress, latest artwork, items to review, recent versions/exports, Continue creating, workspace + selected file restored | **WORKING**: Claude chat is saved in the project folder and restored on reopen (see "Phase 3 gaps closed") | 3.1 | `projects.test.ts`, `projectStore.test.ts`, `smoke-home-ai.mjs`, screenshots 46-47 |
| 4 | Simplified / Advanced navigation | **WORKING** | 1, 3 | `navigation.test.ts`, `smoke-nav.mjs` 7/7 |
| 5 | Claude builds and runs workflows (shared engine) | **WORKING** (paid AI Generate steps stay blocked until Phase 6) | 1.4 | `workflowPlan.test.ts`, `workflowControl.test.ts`, `workflowVersions.test.ts`, `smoke-claude-workflow.mjs` 9/9, `smoke-workflow-control.mjs` 32/32 (real Claude + real PhotoCraft) |
| 6 | Real Gemini / OpenAI image generation; spending limits; Workflow AI node | **WORKING / VERIFIED** (2026-10-14): one approved real image from each provider (OpenAI `gpt-image-2.5-flare`, Gemini `gemini-nano-banana-2.1`), 1024x1024, in the library with prompt/model/estimate; spending limit + ledger; Workflow AI step on the real path. Costs are estimates, not confirmed charges. | user's keys + OK | done |
| 7 | AI video providers (Veo, Runway, Luma) | **WORKING / VERIFIED (Veo)** 2026-10-14: one approved real clip (Veo 3.1 Lite, 16:9, 4 s, 720p, est. $0.20) came back as a 1280x720 4 s mp4 in the library with provenance and ledger entry. Runway built but not live-tested; Luma not built. | 6 | one approved real Veo clip |
| 8 | Templates | **WORKING** (2026-10-14): nine built-in templates on the shared workflow engine, Home Templates panel, Claude recommendation, user templates. Not run end to end with real files in this phase. | 5 | `templates.test.ts`, `smoke-templates.mjs` 6/6 |
| 9 | README / docs refresh, status vocabulary | PARTIAL (README out of date) | any | review |
| 10 | Installer, first run, backup, recovery | NOT IMPLEMENTED | 2 | manual |

Phase 1 tests (2026-10-14): `npm run check` lint 0, types 0, 135 passed / 14 skipped (unchanged);
`smoke-docks.mjs` 15/15 (new); `smoke-live.mjs` 22/22 with real PhotoCraft, VectorCraft and SoundCraft
windows, including the embedded app following the Claude and Media tabs; `smoke-projects.mjs` 10/10
(its stale "9 originals" check now accepts the current 11). Other smokes only had their header
selectors updated (Settings button, `.side-tab.right`) and were not re-run. New screenshots:
`docs/screenshots/40-45` (settings, side tabs).

Phase 1.3-1.4 (2026-10-14):
* Media dock: the Inspector is now **Details** and folds to its header (Hide/Show, remembered). Basic facts
  (type, size, file size, derived from, prompt, added) stay visible; origin, source, settings, cost,
  references, licensing, stored path, checksum (SHA-256) and the read-only note are under **More details**.
  Kind labels are plain (Picture, Vector art, Sound, Video, Layout, App document); filter gained Layouts.
* Bottom panel: a slim **Activity** strip by default (13%), taller (26%) when it shows a timeline; each
  context remembers its own height and can be folded to its header (Hide/Show; when folded, the latest
  activity line shows in the header). Log sources read as names (Project, Workflow, PhotoCraft...), and
  workflow log lines name the step instead of its internal id. The old `cs-center` saved layout is no
  longer used.
* Workflow Editor: toolbar split into "Add a step" and "View" groups: **Fit workflow**, **Tidy layout**
  (left-to-right by run order, `src/shared/workflowLayout.ts`), and toggles for Step settings, File results
  and the Map (MiniMap now off by default); all remembered. Thicker connections with arrowheads; done
  connections turn green, connections into the running step animate. The running step glows (pulse,
  off for reduced motion), a step waiting for approval is outlined, statuses read "waiting / running /
  needs you / done". While an approval is waiting, the approval panel gets the room (up to 62%) and the
  settings and results panels step aside; they come back after the decision.
* Tests: `npm run check` lint 0, types 0, **138 passed / 14 skipped** (+3 `workflowLayout.test.ts`);
  `smoke-docks.mjs` 15/15; `smoke-workflow.mjs` 7/7 (real LightCraft headless run + approval).
  `scripts/smoke.mjs` stops at its workflow part ("Approve" button never appears for its old demo graph);
  it fails the same way on `bb89719` without these changes, so it is a stale smoke, not a regression.

Phase 2.1-2.2 (2026-10-14):
* Settings has **Projects & Storage**: shows the folder new projects go to (built-in
  `%APPDATA%\creative-studio\projects` until changed), free/total space (`fs.statfs`, "not available"
  if unknown), **Browse...** (native dialog), **Open folder**, **Use built-in default**. A folder is
  accepted only after a real write test (plain-language error otherwise). Changing it never moves
  existing projects. Settings, keys and the registry (`projects.json`: current, recent, `defaultDir`,
  `locations` key -> absolute folder) stay in app data. Home's New project has **Choose folder...** for
  a per-project location (folder named after the project, " 2", " 3" if taken).
* New projects use layout 2 (`"layout": 2` in project.json): `Assets/{Originals,Generated,Audio,Video,
  Documents}`, `Versions`, `Exports`, `Workflows/workflow.json`, `Previews`, `Checkpoints`, one folder per
  ArtCraft app (live working files go in `<App>/work`), and `work/` scratch. AI generations go to
  `Assets/Generated`. Paths stay relative; hashes, lineage, provenance and read-only storing are unchanged.
  Projects without `layout` (Sample Project and anything older) keep `originals/`, `versions/`, `exports/`,
  `workflow.json` exactly as before, so nothing needs migrating.
* Not done yet: `Previews/` and `Checkpoints/` are created but unused; app folders hold only live scratch.
* Tests: `npm run check` lint 0, types 0, **142 passed / 14 skipped** (+3 projects, +1 legacy layout);
  `smoke-projects.mjs` 10/10 on a fresh build. Live-app and workflow smokes not re-run (not touched
  beyond the live work-folder path; do it with 2.3).

Phase 2.3-2.4 (2026-10-14):
* Home: **Open existing...** (pick any project folder; added to the list, nothing copied), **Duplicate...**
  (full copy with new identity and name "<name> copy", into a folder you pick), **Move...** (copy, check size
  and SHA-256 of every file under a `.moving` name, rename into place, register, then old folder to the
  Recycle Bin; any failure leaves the original; refused for the open project and the Sample Project),
  **Locate...** for a registered project whose folder is gone (shown as "Folder not found", same
  project identity needed). Rename still renames the project, not its folder.
* Media dock: **Collection** selector with counts: All Assets, Originals (imported, not AI), AI Generations
  (provider-made), Favorites (4+ stars), Versions, Workflows (made by workflow runs), Deliverables
  (lists the Exports folder). Computed from the manifest (`src/shared/collections.ts`); no files move.
* Not done: AI tagging (no AI integration for it yet); no dedicated UI test of the Browse dialogs
  (native dialogs; logic covered by unit tests).
* Tests: lint 0, types 0, **146 passed / 14 skipped**; `smoke-projects.mjs` 10/10, `smoke-docks.mjs` 15/15.

Phase 3 (2026-10-14):
* Home opens first (default workspace is Home). Big prompt "What would you like to create?"; **Create with Claude**
  makes ONE real Claude call (`ClaudePartner.planProject`, Agent SDK, no tools, no files, no generation) that returns
  a JSON plan (`src/shared/projectPlan.ts`, validated, with the five project types). The plan card lets the user edit
  name and type, answer Claude's questions (re-plans), and tick "add reference files"; nothing is created until
  **Approve and create project**. No mocked output: if Claude is signed out or fails, the error is shown. Claude is
  told which image models are set up and only recommends from them; no paid generation can start from planning.
* Project meta in `project.json` (all optional, older projects unaffected): `kind`, `brief`, `objective`, `view`
  (last workspace + selected file; saved quietly, does not change "last edited"). Opening a project restores its view.
* Blank projects: name + one of Image / Photography, Graphic Design, Video / Animation, Audio, Mixed Media + optional folder.
  Recent projects: cards show type and the brief's first line; search filters by name, brief and type.
* Overview: type chip, brief, Claude's objective (first plan step; it is not updated by Claude yet), progress
  checklist, latest artwork, "Waiting for your review" (new versions / AI images not yet approved), recent versions,
  workflow, recent exports, **Continue creating**. Nothing billable or destructive resumes on opening.
* Not done: Claude updating the objective itself, Templates (Phase 8). (History restore and pre-creation references were added in "Phase 3 gaps closed".)
* Tests: lint 0, types 0, **149 passed / 14 skipped** (+1 projects, +2 projectPlan); `smoke-projects.mjs` 13/13;
  `smoke-home-ai.mjs` 6/6 with real Claude (about one Sonnet call). Other smokes not re-run; the ones that type into
  "New project name" need the new "New blank project" step (only smoke-projects was updated).
  Screenshots: `46-home-claude-plan.png`, `47-project-overview-brief.png`, refreshed `40`, `41`.

Phase 3 gaps closed (2026-10-14):
* **Conversation history:** each project's Claude chat is saved to `<project>/Claude/conversation.json` (last 200
  items, written atomically, debounced; never in app settings), so Move and Duplicate carry it. The Claude panel
  restores it when the project is reopened. "New chat" clears the saved chat. A new session after reopening sends Claude
  only a short deterministic summary (up to 8 earlier requests, 120 chars each) plus the last 6 messages (400 chars
  each); no extra model call, and it is skipped while the live session continues. Approving a plan seeds the new
  project's chat with the request and plan. Code: `src/shared/claudeHistory.ts`, `ClaudePartner.ready/seed`.
* **Reference files:** **Add reference files...** on the Home prompt keeps only the chosen paths in main (renderer never
  supplies paths; max 12). Claude sees names/types/sizes and up to 3 small images (each at most 3 MB) in the one planning
  call. Nothing is copied until **Approve**; then they are imported to `Assets/Originals` (or Audio/Video/Documents)
  as read-only files with SHA-256, `origin: imported`, `role: "reference"`, original path in provenance. They are
  ordinary library files, so workflow Files steps and Claude (`list_files` flags `reference_from_user`) can use them as
  source images. Duplicates (same hash) are not copied twice.
* **Bug fixed on the way:** `ProjectStore.loadManifest` could create two manifest objects when first called
  concurrently, silently losing an import (seen as a flaky smoke). Now one shared object.
* Tests: lint 0, types 0, **153 passed / 14 skipped** (+3 claudeHistory, +1 projectStore); `smoke-home-ai.mjs` 11/11
  (real Claude, Sonnet 5.5, 3 consecutive runs; now also covers reference import after approval and chat restore),
  `smoke-projects.mjs` 13/13, `smoke-docks.mjs` 15/15. No generation was started. Not covered: the native file
  dialog itself (stubbed in the smoke) and a UI test of Move/Duplicate carrying the chat (logic is a whole-folder copy).

Phase 4 (2026-10-14):
* Header has two configurations, same project files and workflow system. **Simplified** (default): Project, Create,
  AI Generate, Deliver, **More** (menu: Media, Workflow, Effects, Color, Audio; More shows "More: <tool>" while one is open).
  **Advanced**: full navigation (Home, Media, Edit, AI Generate, Workflow, Effects, Color, Audio, Deliver). A header
  button switches modes at any time; the open workspace stays open; the choice is remembered (localStorage `cs-nav-mode`).
  Claude opening a file in Color/Effects/Audio still moves there in both modes. Code: `src/shared/navigation.ts`, `Header.tsx`.
* Timelines now show only while editing time-based media in Edit/Effects/Color/Audio (`shouldShowTimeline(kind, workspace)`),
  not in Project, Media, AI Generate, Workflow or Deliver.
* Not done: specialist tools are not auto-promoted to the main row by project type (always under More in Simplified).
* Tests: lint 0, types 0, **156 passed / 14 skipped** (+3 navigation); `smoke-nav.mjs` 7/7 (new), `smoke-docks.mjs` 15/15,
  `smoke-projects.mjs` 13/13. Other smokes click header tabs by name and now start in Simplified: they need the
  Advanced mode (or `More`) and were not updated or re-run. Screenshots `48-nav-simplified-more.png`, `49-nav-advanced.png`.

Phase 5 part 1 (2026-10-14):
* **Step A, smokes:** the older smokes (`apps`, `audio-deliver`, `claude-apps`, `claude-generate`, `generate`, `multiclip`,
  `workflow`) now switch to Advanced navigation at start (`localStorage cs-nav-mode`) and were re-run: workflow 7/7,
  generate 16/16, claude-generate 5/5, apps 20/20, multiclip 8/8, audio-deliver 17/17, claude-apps 15/15 (real Claude); also
  docks 15/15, nav 7/7. Fixed stale checks on the way: generated files now live in `Assets/Generated`, the video overview
  waveform needs the Edit tab (timelines only show while editing), duplicate option matches after the Details panel, and
  the export "no app window" check compares against windows already open. Not re-run: `smoke.mjs` (known stale), `smoke-live`,
  `smoke-theme`.
* **Claude plans workflows:** two new Claude tools. `workflow_catalog` (step types, every app with its edits and settings,
  connection rules) and `plan_workflow` (title, plain explanation, steps with readable keys, connections). Code:
  `src/shared/workflowPlan.ts`. It builds a normal `WorkflowGraph` for the existing engine: every connection goes through
  `validateConnection`, the whole graph through `validateGraph`; apps, edits and settings are checked with `checkEditValues`,
  files by exact library name, export presets against Deliver presets, image models and settings against the model table,
  and nodes are laid out with `autoLayout`. Problems come back to Claude as plain sentences so it can fix and retry.
* **What the user sees:** a card at the top of the Workflow tab with Claude's explanation, the steps, a cost estimate
  (paid generation per run, estimated with the existing price tables; free when nothing is paid), what they will be asked to
  approve, and warnings (missing API key, no approval step, app may not open a file type). **Use this workflow** (or
  **Replace my workflow**) saves it; a non-empty existing workflow is first kept as
  `Workflows/workflow-before-claude-<time>.json`. **Dismiss** discards it. Proposing saves, runs and generates nothing;
  Claude cannot run workflows. The pending plan is held in main (reset when switching projects).
* **Honest limits:** a paid AI Generate step can be planned and priced, but running paid generation inside workflows is
  still blocked (Phase 6); the plan says so as a warning. AI nodes carry `providerId`, `modelId`, `prompt`, `count`,
  `settings`; the runner still uses only the mock path. Import steps use library files only (no folder picking by Claude).
  Plan card appears in the Workflow tab; if the user is elsewhere it waits there (Claude tells them in chat).
* Tests: lint 0, types 0, **161 passed / 14 skipped** (+5 `workflowPlan.test.ts`); `smoke-claude-workflow.mjs` 9/9 (new,
  real Claude, Sonnet 5.5: plan appeared, nothing saved until applied, nothing generated, no ArtCraft window).
  Screenshots `53-claude-workflow-plan.png`, `54-claude-workflow-applied.png`.

Phase 5 part 2 (2026-10-14):
* **One engine, two drivers.** The editor and Claude both go through the same run controller in main (`ipc.ts startRun`);
  nothing is duplicated. Claude's tools: `workflow_status` (steps, state, per-step status, problems per file, what waits for
  the user, which steps changed; `wait_seconds` to watch), `run_workflow` / `rerun_workflow` (a native dialog asks the user
  first, Cancel is the default; the run then goes in the background), `pause_workflow`, `resume_workflow`, `cancel_workflow`,
  `change_workflow_step` (same validation as planning), `list_workflow_versions`, `restore_workflow_version`,
  `save_workflow_template`. Claude has no tool to approve or reject results: that stays with the user.
* **User controls** (Workflow tab): Pause / Resume (holds before the next step, never mid-step), **Take manual control**
  (pauses; Claude cannot change, run or resume anything until **Give control back to Claude**), Cancel, edit steps while
  paused then **Apply changes and continue** (finished steps keep results; only affected steps run again), per-step
  **Rerun from this step**, **Rerun N changed steps** (changed steps + what follows; shown as "will rerun" on the nodes),
  Approve / reject per file (as before), banner when Claude is running it.
* **Rerun of affected steps only:** `src/shared/workflowControl.ts` (`changedNodes`, `affectedNodes`, `reusableOutputs`);
  the runner takes `reuse` (kept steps are reported "Kept from the earlier run") and returns each finished step's outputs.
  A step is kept only if everything upstream is kept. Moving a node counts as no change.
* **Approved assets are protected:** approving marks the files `approved` (rejecting marks `rejected`) in the manifest. A
  rerun never asks about an already approved file again; reruns only add new versions, so approved versions are never
  overwritten (there is no delete path for versions in the app).
* **Versions:** `Workflows/history/v-<time>.json` is written before each run, plan apply, Claude change, template use and
  restore (identical consecutive graphs are not duplicated; last 50 kept). **Versions** panel restores one (the current one is
  kept first). **Templates:** `Workflows/templates/<id>.json`; only a workflow that ran successfully and is unchanged since can
  be saved; file choices are dropped; **Use** puts it in place (previous workflow kept as a version).
* **Honest limits:** paid generation is still blocked inside workflows (Phase 6); a run Claude starts is monitored through
  main's event stream, so it is not resumable after an app restart (state is in memory; versions and templates are on disk);
  templates have no gallery/starters yet (Phase 8); change_workflow_step edits one step's settings (no adding/removing steps:
  Claude proposes a new plan for that); the UI warns nothing about a rerun that has no earlier run (it just runs everything).
* Tests: lint 0, types 0, **171 passed / 14 skipped** (+10: `workflowControl.test.ts` 9, `workflowVersions.test.ts` 1);
  `smoke-workflow-control.mjs` 32/32 (new; real Claude Sonnet 5.5 and real PhotoCraft headless: pause/resume, approval,
  rerun kept steps and made no new versions, changed edit asked again while the earlier approval stayed, versions, template,
  Claude run via dialog, monitor, change step, rerun, template, refusal under manual control, no paid generation);
  `smoke-workflow` 7/7, `smoke-claude-workflow` 9/9 (its "use plan" wait now waits for the apply instead of racing),
  `smoke-docks` 15/15, `smoke-nav` 7/7. Two existing runner tests now use `toMatchObject` because the run result also
  carries `outputs`. Screenshots `55`-`59`. Not re-run: the other older smokes (they do not touch the changed paths).

Phase 6 part 1 (2026-10-14):
* **Spending limit:** per project (`<project>/spending.json`, never contains keys). AI Generate shows the limit field and the
  estimated total so far. A paid request that would pass the limit is refused before the approval dialog and before any
  network call; the approval dialog also shows the limit and the estimate so far. Every successful paid generation is
  recorded in the ledger as an **estimate** (CreateCraft's price tables), not a confirmed charge; the UI says so. Actual
  billing is only in the provider's console.
* **Workflow AI Generate step is no longer a mock** when the node has a model: it calls the same `GenerationService`
  (approval dialog in main, spending limit, ledger, provenance, reference image from the upstream file when the model can edit).
  Declining stops that branch with nothing charged. Old nodes without a model still use the offline mock. Claude's plans
  and prompt were updated (the "not enabled yet" warning is gone).
* **Verified (user ran both, approval dialog shown):** a real OpenAI image (est. $0.0132) and a real Gemini image (est. $0.0346). Earlier note: a real OpenAI or Gemini image was not yet verified. The user saved both keys and the free connection tests passed in their own
  app (2 of 2 and 4 of 4 models listed). I could not decrypt their keys from a second launched instance, so the real
  generation test is theirs to run once in AI Generate (approval dialog); then the files and provenance can be inspected.
  My launch also overwrote their stored "last test" status with a failure; pressing Test connection restores it.
* Tests: lint 0, types 0, **174 passed / 14 skipped** (+3: `spending.test.ts`, 2 workflow AI step tests);
  `smoke-generate-workflow.mjs` 7/7 (new, offline), `smoke-generate` 16/16, `smoke-claude-generate` 5/5, `smoke-workflow` 7/7.
  The "over the limit" behaviour is covered by the unit test; the smoke profile has no key so it stops earlier.

Phase 6 incident (2026-10-14): a second app instance I launched while the user's app was closing saw `project.json` as missing and
recreated the Sample Project list (11 sample files), dropping 9 entries from the list (files stayed on disk). Recovered by rebuilding
the list from the folder (backup: `project.json.bak-before-recovery`; lineage and generation settings best-effort). Guard added in
`ensureSampleProject`: retries, then refuses to recreate a project whose folder still has files. Unexplained: the running app did not
rewrite `project.json` after generation or a rating change; restart showed all 20 items. Tests 174 passed / 14 skipped.

Phase 7 (2026-10-14):
* **Recommendation: Veo first.** The user already has a saved Gemini key (the vault lists `gemini` and `openai` only), and Veo
  uses that same key. Runway and Luma each need a new key and their API docs could not be fully read here (Runway endpoints:
  `/v1/text_to_video`, `/v1/image_to_video`, `GET`/`DELETE /v1/tasks/{id}`; Luma `/generations`; prices unconfirmed), so they are
  listed as "planned" in `VIDEO_PROVIDERS` and not built. Midjourney stays a manual import.
* **Veo (Gemini API):** models `veo-3.1-lite|fast|(standard)-generate-preview`; text-to-video and image-to-video (starting
  picture), aspect 16:9 / 9:16, 4/6/8 s, 720p (1080p and 4k only at 8 s; Lite has no 4k). Estimates use Google's published
  per-second prices (Lite $0.05/$0.08, Fast $0.10/$0.12/$0.30, Veo 3.1 $0.40/$0.40/$0.60); they are estimates, not charges.
  Code: `src/shared/video.ts`, `src/main/videoApis.ts`, `src/main/videoGeneration.ts`, `VideoPanel.tsx` (AI Generate tab).
* **Same safety path as images:** key from the vault only, project spending limit (counts running jobs too) checked before the
  dialog, native approval dialog (video wording, Cancel default), ledger entry when the video lands, provenance on the asset.
* **Jobs:** saved in `<project>/work/video/jobs.json`; polled every 10 s in the background (30 min max); listing the jobs after a
  window change or restart resumes any still-running job from its saved operation (Google keeps the file 2 days). The finished
  mp4 is downloaded with the key, imported to `Assets/Generated`, and shown under "Video jobs" (Show in library / Open in Edit).
* **Honest limits:** Veo has no documented cancel call, so "Stop waiting" only stops CreateCraft and warns that Google may still
  bill it. Verified live: text-to-video, polling, download, import. Image-to-video also verified live. Request fields for image-to-video (`instances[0].image.bytesBase64Encoded/mimeType`) and the response path
  (`response.generateVideoResponse.generatedSamples[0].video.uri`) follow Google's docs but image-to-video is **unverified against the live API**. Claude has no video tool yet; Workflow AI step is images only; no resume of a job whose app was closed beyond 2 days.
* **Finish-up (same day):** (1) Media list now refreshes when a video job finishes (bug found in the real run). (2) **Runway built**
  (`gen4.5` text or picture, `gen4_turbo` picture only; header `X-Runway-Version 2024-11-06`; poll `/v1/tasks/{id}`; DELETE cancels;
  1 credit = $0.01, 12 and 5 credits/s; output link downloaded without the key; key test reads `/v1/organization` for the credit
  balance). **Unverified with a real Runway key and clip**; the base64 data-URI picture upload and `/v1/organization` are
  assumptions from the docs. (3) **Claude tools** `list_video_models` and `generate_video` (same approval dialog, spending limit;
  returns when submitted, the clip arrives later). (4) **Luma not built**: its docs give no price and its image-to-video needs
  an already-hosted image URL (no upload API). **Veo image-to-video verified** (2026-10-14 23:47): a library picture + prompt gave a 4 s 1280-wide mp4 with the reference recorded in provenance (est. $0.20).
* Tests after finish-up: lint 0, types 0, **183 passed / 14 skipped** (+2 Runway); `smoke-generate` 16/16 (provider count 3),
  `smoke-claude-generate` 5/5.
* Tests: lint 0, types 0, **181 passed / 14 skipped** (+7 `videoGeneration.test.ts`: price and rules, request mapping, decline sends
  nothing, spending limit, full job to library asset + ledger, restart resume, failure and stop-waiting); `smoke-generate` 16/16,
  `smoke-generate-workflow` 7/7, `smoke-docks` 15/15. No paid call was made.

Phase 8 (2026-10-14):
* **Nine built-in templates** (`src/shared/templates.ts`), each a real `WorkflowGraph` built through the same planner checks as Claude's workflows
  (apps, edits, presets, models validated) with file choices left empty: Cinematic poster, Photo restoration, Image enhancement, AI image variations,
  Animated artwork, Short cinematic video, Video sequence with music, Logo and vector illustration, Photo book or publication. Every one has an approval step.
* **Honest labels:** *Ready* (local ArtCraft apps only: Cinematic poster, Image enhancement), *Uses paid AI (asks first)* (AI image variations: Gemini
  Nano Banana 2.1, 3 images; the Workflow AI step keeps the approval dialog and project spending limit; nothing starts on its own) and *Partly manual*
  (limits stated on the card). Limits: restoration is tone/clarity/sharpen only (no scratch repair); animated artwork and the two video templates need a
  clip (no workflow video-generation step; Veo clips are made in AI Generate with their own approval); the sequence-with-music template only prepares
  clips, joining clips and music is done on the FilmCraft timeline by you or Claude; logo/vector needs an existing SVG (no raster-to-vector, no logo
  drawing); photo book is one DesignCraft layout per run (text replace, PDF/PNG), not page assembly.
* **UI:** Home **Templates** button opens a panel with the templates (plus templates saved in the open project); **Start a project with this** creates
  a project of the right type, fills in the workflow and opens the Workflow tab. Built-ins also appear in the Workflow tab's Templates list (Use).
  **Saving your own** is the existing Phase 5 feature (workflow must have run successfully and be unchanged). Claude's project plan now has an optional
  `template` id (validated against the catalogue); the plan card shows a ticked "Start from Claude's recommended template" that is applied on approval.
* **Tests:** lint 0, types 0, **186 passed / 14 skipped** (+3 `templates.test.ts`; one `videoGeneration` test failed once under full-suite load and
  passes alone and on re-run); `smoke-templates.mjs` 6/6 (new, offline), `smoke-projects.mjs` 13/13 (Templates check updated), `smoke-workflow.mjs` 7/7.
  Not run: a template applied to real files end to end, and the Claude recommendation live (needs one real Claude call; no paid generation was made).
  Screenshots `97-templates-home.png`, `98-template-applied.png`.

Free local video, Stage A + B (2026-10-14):
* **Stage A (research only, nothing run):** `docs/local-video-compatibility.md` has the model/backend matrix and recommendation.
  Key finding: AMD's Windows ROCm requirements list RX 7000/9000, Radeon PRO and Ryzen AI only; **RX 6000 (incl. 6650 XT) is
  unsupported**, so AMD RX 6650 XT is *unproven* and only a DirectML experiment could change that. Recommended first local engine:
  LTX-Video 2B distilled via a small diffusers runner (ComfyUI optional). No hardware is claimed to work.
* **Stage B (verified):** **Motion Effects**, a free non-AI camera move on one picture rendered by FilmCraft's headless engine:
  zoom in/out, pan L/R/U/D, strength, 16:9 / 9:16 / 1:1, 720p/1080p, 24/30 fps, 2-20 s. Saved as a new version of the picture,
  labelled "not AI-generated", no cost/ledger. Panel in AI Generate (below Video). Code: `src/shared/motionEffects.ts`,
  `src/main/motionEffects.ts`, `MotionPanel.tsx`; IPC `motion:render` / `motion:cancel`.
* Not built: parallax/depth, multi-picture crossfade sequences, overlays, title animation, Claude tool, workflow node, the
  Cloud / Free Local AI / Motion Effects source selector (Motion Effects is just its own panel for now).
* Tests: lint 0, types 0, **196 passed / 14 skipped** (+10: `motionEffects.test.ts` x2, incl. a real FilmCraft render);
  `smoke-generate` 16/16. `videoGeneration` Runway test is flaky under full-suite load (passes alone); not caused by this change.
* **Stage C part 1 (2026-10-15, verified on this PC):** read-only hardware check + **Free local AI video** setup card in AI Generate
  (`src/shared/localAi.ts`, `src/main/hardware.ts`, `LocalAiPanel.tsx`, IPC `localai:status`). Detects OS, CPU, RAM, GPUs with real VRAM
  (registry value, not the 4 GB WMI cap), free disk, and backends found (CUDA, ROCm/HIP, DirectML, CPU; all "untested"). Tier is a memory
  ceiling. Model registry (LTX-Video 2B distilled, Wan 2.2 5B) keeps availability apart from `verified` (empty). On this PC: i5-12600K,
  31.8 GB RAM, RX 6650 XT 8 GB + UHD 770, tier Standard, DirectML runtime present, no CUDA/ROCm; LTX "could be tried", Wan not offered.
  **Not built:** download manager, runner, self-test, generation, Claude/workflow integration. AMD is still unverified.
  Tests: 203 passed / 14 skipped (+7 `hardware.test.ts`, fake Windows output), smoke-generate 16/16.
* **Stage C part 2 (2026-10-15):** model download manager (`src/main/modelDownloads.ts`, tests with a fake server). Consent is a native
  dialog in main (license, size, folder; Cancel default); resume by HTTP Range, per-file SHA-256 when published, disk check with 2 GB
  margin, cancel keeps partials, remove, custom model folder (`local-ai.json`, write-tested). UI in the Free local AI card.
  **Correction:** the LTX-Video 2B distilled download is about **27 GB** (6.3 GB model + 19 GB text encoder + 1.7 GB VAE, sizes and
  hashes from the Hugging Face listing), not 8 GB as I said earlier. No real download has been made; needs Tomas's explicit yes naming
  model and size. Still unbuilt: runner, self-test, generation, Claude tool, workflow node. Tests 211 passed / 14 skipped (+9).
* **Requirement added by Tomas:** Free Local AI must have a built-in, self-service setup inside CreateCraft (guided: check this PC, pick a model, consent, download, self-test, status and repair/remove). The user must not need to install Python or ComfyUI by hand.
* Next (needs Tomas's OK): Stage C hardware detection, then model download and a real inference test.

Phase 1 note: the old `integrationStatus().claude` field in `src/main/ipc.ts` still says "not
configured in this build" (stale); Settings now shows Claude's real sign-in state instead.

---

## 1. Features implemented and working

| Area | Status | Notes |
|---|---|---|
| Project library (import, read-only originals, versions with lineage, ratings, provenance, SHA-256) | **WORKING** | Originals are copied and never modified; every edit or save creates a new version with a parent link. |
| Media tab (browser, inspector, image/vector/video/audio preview, video thumbnails) | **WORKING** | Video thumbnails and real waveforms are decoded from the files. |
| Edit tab: files open in their ArtCraft app embedded in CreateCraft | **WORKING** | PhotoCraft, VectorCraft, SoundCraft, FilmCraft (video), DesignCraft (layouts). The app window sits over the Edit area; pop-out / put-back; hidden when you leave the tab. |
| Color tab (LightCraft), Effects tab (EffectCraft), Audio tab (SoundCraft) | **WORKING** | Same embedding; each tab opens the selected file in its app. |
| Quick edits per app (one-click, verified commands only) | **WORKING** | Every quick edit offered was verified against the real app (live tests). |
| Edit lock / Pause / Take control / resync | **WORKING** | Shared by the user, automation and Claude. |
| Save as new version from any live app | **WORKING** | PhotoCraft .pcraft+PNG, VectorCraft SVG+PNG, SoundCraft WAV, FilmCraft MP4, LightCraft full-size image, EffectCraft MP4/PNG, DesignCraft .designcraft+PNG. Unchanged saves make no duplicate. |
| FilmCraft timeline under the Edit area | **WORKING** | Live tracks/clips, playhead, clip select; multi-clip: add clip, add music, reorder, remove; crossfades, music volume, fades, trim, speed, looks. |
| SoundCraft timeline under the Audio tab | **WORKING** | Clips with real waveform, gain, fades, playhead; history from SoundCraft's own undo list. |
| Deliver tab (export queue) | **WORKING** | 24 presets across pictures, vector, audio, video and layouts, run headless by each app's CLI (no windows); queue with progress and cancel; never overwrites; `exports/manifest.json` records source, version history, preset, SHA-256; Show in folder. No MP3 (SoundCraft cannot write it). |
| Workflow tab (batches across apps) | **PARTIAL** | See section 8. |
| Claude Creative Partner | **WORKING** | See section 7. |
| AI image generation (BYOK) | **PARTIAL** | Real code, tested with mocked HTTP; no real paid call made yet. See section 9. |
| Themes and ArtCraft app theme sync | **WORKING** | See section 5. |
| Window capture (screenshots of app windows as a service) | **NOT IMPLEMENTED** | Interface only; the UI says "not connected". |

## 2. Project Home and new project creation

**WORKING** (Phase 3 made it prompt-first; see "Phase 3" above). The Home tab lists all projects (thumbnail, file count) with New project, Open,
Rename, Show folder and Remove (moves the folder to the Windows Recycle Bin after confirmation).
The open project has an Overview (files by kind, recent versions, workflow, exports, Import
files…, Show folder). Switching projects resets live sessions, Claude's session and per-project
queues. A Sample Project is created on first run and gains new sample files from later versions
once (current samples: photos, SVGs, a .pcraft, two sounds, two short videos made from the apps'
built-in demos, a DesignCraft flyer). Tests: `projects.test.ts`, `projectStore.test.ts`,
`scripts/smoke-projects.mjs`.

## 3. User-selected project storage and multi-project management

* Multi-project management (create, open, switch, rename, remove, remembered across restarts): **WORKING**.
* **User-selected storage location: NOT IMPLEMENTED.** All projects live under
  `%APPDATA%\creative-studio\projects\<key>\` (one folder per project: `originals/`, `versions/`,
  `work/`, `exports/`, manifest and workflow JSON). There is no folder picker for where projects are
  stored, and no "open project from folder" or move-project feature yet.

## 4. Simplified and Advanced navigation

**WORKING** since Phase 4 (see above). Before that there was one navigation layout: a header with nine workspace tabs (Home, Media,
Edit, AI Generate, Workflow, Effects, Color, Audio, Deliver) and a Settings button (no status chips
since Phase 1.1); the media browser + inspector docks on the left behind a vertical Media tab, a
context bottom panel (timeline for audio/video, activity log otherwise), and the Claude panel docks
on the right behind a vertical Claude tab (Phase 1.2). There is no Simplified/Advanced mode switch.

## 5. Themes: ArtCraft Match, Studio Dark, Light, System

| Theme | Status |
|---|---|
| ArtCraft Match (palette measured from PhotoCraft's "proMedium" theme) | **WORKING** |
| Studio Dark (original CreateCraft palette) | **WORKING** |
| Light | **WORKING** |
| System (follows Windows light/dark; the dark choice is configurable) | **WORKING** |
| Accent colour (presets + custom) | **WORKING** |
| ArtCraft app theme sync (open app follows CreateCraft's theme) | **WORKING** for all seven apps, each through its own official setting and read back: PhotoCraft (`ui.set theme`), VectorCraft (`uiBrightness`), SoundCraft (`ui_set theme`), FilmCraft (`appearance.colorTheme`), LightCraft (`appearanceMode`), EffectCraft (`appearance.appearanceMode`), DesignCraft (`ui_set brightness`). Can be switched off. |

Tests: `theme.test.ts`, `settingsStore.test.ts`, `scripts/smoke-theme.mjs`, theme checks in `scripts/smoke-apps.mjs`.

## 6. Live control of PhotoCraft, VectorCraft and SoundCraft

**Yes, all three are controlled live (WORKING),** and so are FilmCraft, LightCraft, EffectCraft and DesignCraft.

| App | How | Safety |
|---|---|---|
| PhotoCraft | `photocraft.exe --control <port>` + `photocraft-cli mcp --bridge` | Control token file + automation read/write roots (verified: wrong token and outside paths are refused); command allowlist. |
| VectorCraft | `vectorcraft --control <port>` + `vectorcraft-cli mcp --connect` | Automation read/write roots. No token exists in VectorCraft; random loopback port. |
| SoundCraft | `soundcraft --control <port>` + `soundcraft-cli mcp --connect` | No token or roots in SoundCraft; CreateCraft only sends commands from its own table and only writes to the project's work folder. |
| FilmCraft, LightCraft, EffectCraft, DesignCraft | Same pattern (see audit) | LightCraft uses a throwaway in-memory session (your library is never opened); EffectCraft uses automation roots; FilmCraft/DesignCraft have no token (fixed command tables only). |

Live behaviour: open, quick edits, undo, history (including hand edits), save as new version,
theme sync, embedding in the tab, pop-out. Tests: `liveApps.live.test.ts`, `photocraftLive.test.ts`
(opt-in: `CS_LIVE_TESTS=1`, they open real windows and close them), `scripts/smoke-live.mjs`,
`scripts/smoke-apps.mjs` (20/20), `scripts/smoke-audio-deliver.mjs` (13/13 + Claude checks 4/4).

## 7. Claude Creative Partner

**WORKING** (verified with real requests; the user's own Claude Code sign-in through the Claude
Agent SDK; no API key stored by CreateCraft; models: Claude Opus 5.5 default, Claude Sonnet 5.5).

Claude gets no shell, file or web tools: only CreateCraft's in-process tools, all under the same
edit lock, allowlists and versioning as the user:

* `get_status` (open file, app, history, lock, available edits, every app and its file types, plus app details such as the FilmCraft timeline or DesignCraft page text)
* `look_at_document` (picture of the document, frame or composition)
* `open_file` (any library file, in any suitable app; hands off between apps, e.g. PhotoCraft → LightCraft; the window follows to that app's tab)
* `apply_edit` (any verified quick edit of the open app), `photocraft_command` (allowlisted PhotoCraft adjustments/filters), `undo`, `save_version`
* `timeline_add`, `timeline_move_clip`, `timeline_remove_clip` (build multi-clip videos with music in FilmCraft)
* `list_export_formats`, `export_file` (Deliver presets, same queue and manifest)
* `list_files`, `list_image_models`, `generate_image` (each paid call needs the user's approval in a native dialog)

Verified with real requests: one request per app (7/7) plus a PhotoCraft → LightCraft hand-off;
multi-clip video with music and crossfades; export a layout to PDF; audio fade in the Audio tab.
Claude correctly refuses to discard unsaved edits without permission. Total Claude usage for all
verification runs today: about $5.

Claude can propose workflows (`workflow_catalog`, `plan_workflow`) for the user to apply, and after the user's approval run, monitor, pause, change and rerun them (see Phase 5 part 2).

## 8. Workflow node execution

| Node | Status | Notes |
|---|---|---|
| Files (Import) | **WORKING** | One file, several library files, or every supported file in a folder (copied into the library; folder only read; up to 200 files, no subfolders). |
| App step (ArtCraft Edit) | **WORKING** | Any of the 7 apps with its verified quick edits, run in the background with **no window**: PhotoCraft/VectorCraft/SoundCraft through their headless CLIs, FilmCraft/LightCraft/EffectCraft/DesignCraft through their CLI's own MCP engine. Each file gets new versions; a file the app cannot open stops alone. Older "PhotoCraft engine command" steps still run. |
| Approval | **WORKING** | Shows every file's result as a thumbnail; approve all, some (ticked) or reject. |
| Export | **WORKING** | Any of the 24 Deliver presets; formats that don't fit a file are skipped; same queue and manifest (marked "workflow"). |
| AI Generate | **MOCK** | Only the mock provider; no image, no network call. Real providers come in Workflow step two. |
| Batch execution | **WORKING** | Every file goes through each step in turn; per-file progress table under the canvas. |

Limits: one Files step per workflow; a straight chain per file (no merging files, e.g. placing a
photo into a layout); no saved named workflows or starter templates yet; Claude cannot build or
run workflows yet. Tests: `workflowRunner.test.ts`, `workflow.test.ts`, `headlessApps.test.ts`,
`workflowSteps.test.ts` (real cross-app workflows), `scripts/smoke-workflow.mjs` (7/7, no ArtCraft
window opened).

## 9. AI generation providers

| Item | Status |
|---|---|
| OpenAI (GPT Image 2.5 Flare / Sunburst) and Google Gemini (Nano Banana 2.1, Gemini 3.1 Flash Lite Image, 3.1 Flash Image, 3 Pro Image) | **PARTIAL**: request/response code is implemented and unit-tested with mocked HTTP. **No real generation has been made** (needs the user's key and explicit OK). A fake OpenAI key was tested and the real API answered 401, shown as "the key was rejected". |
| Keys | **WORKING**: encrypted with Windows DPAPI (Electron `safeStorage`) in the main process only; read from the clipboard and then cleared; never sent to the renderer, logs, project files or Claude. |
| Approval before every paid call | **WORKING**: native dialog in main with provider, model, prompt, settings and estimated price; Cancel is the default. Verified with the dialog stubbed to Cancel (nothing sent). |
| Mock provider | **MOCK** (labelled in the UI). |
| Claude `generate_image` | **WORKING** through the same approval path (verified with mock + a cancelled OpenAI request). |
| Workflow AI Generate node | **MOCK** (not connected to the real providers yet). |
| Midjourney | Folder import only (by policy). |

## 10. Known bugs, incomplete features and next milestones

**Known issues**

* `README.md` is out of date (Phase 2 text) and some fixture/README strings show mis-encoded dashes (`â€"`).
* FilmCraft timeline panel: with music added, the music track can be below the fold of the bottom panel (scrolls).
* Multi-clip video: clips are appended and moved one step at a time (no drag-and-drop on the strip); pictures last 3 s; music cannot loop or run longer than its file.
* Deliver: no MP3 export; progress is per job (no percentage within one export).
* DesignCraft text edits only offer black or white text.
* Live apps without a control token (VectorCraft, SoundCraft, FilmCraft, DesignCraft) rely on a random loopback port plus CreateCraft's fixed command tables.
* Live/smoke tests that open app windows are opt-in and must be run on a PC with the ArtCraft apps installed.
* The renderer console logs a harmless warning that the CSP `frame-ancestors` directive is ignored in a `<meta>` tag.

**Incomplete / not implemented**

* User-selected project storage location; open/move project folders.
* Simplified / Advanced navigation modes.
* Window capture service.
* Workflow step two: real AI Generate node, saved/named workflows with starters, Claude building and running workflows, merging files (e.g. photo into a layout).
* A real paid AI generation (awaiting the user's key and OK).
* Windows installer / packaging, first-run guide; code not yet pushed to a remote.

**Recommended next milestones**

1. Workflow step two (AI node with approval, saved workflows and starters, Claude builds/runs workflows).
2. Project storage choice (pick a folder, open existing project folders) and Simplified/Advanced navigation.
3. Place library pictures into DesignCraft layouts (by hand and by Claude), enabling photo → flyer → PDF pipelines.
4. Packaging: Windows installer, first-run guide, README refresh; push to a private remote for backup.
5. One real AI generation test with the user's key, then enable the Workflow AI node.

---

## Test results (run for this package, 2026-10-14)

`npm run check` (ESLint + TypeScript for main/preload and renderer + Vitest): **all passed.**

* Lint: 0 problems. Typecheck: 0 errors.
* Unit/integration tests: **19 files passed, 2 skipped; 135 tests passed, 14 skipped.**
  The 14 skipped tests are the opt-in live tests that open real app windows
  (`liveApps.live.test.ts`, `photocraftLive.test.ts`; run with `CS_LIVE_TESTS=1`).
  Several of the passing tests drive the real installed ArtCraft command-line tools headlessly
  (no windows): `deliver.test.ts` (all 24 export presets), `headlessApps.test.ts`,
  `workflowSteps.test.ts` (real cross-app workflows), `appEditors.test.ts`, `photocraftCli.test.ts`.

| Test file | Passed |
|---|---|
| src/shared/appSteps.test.ts | 10 |
| src/shared/collaboration.test.ts | 8 |
| src/shared/generation.test.ts | 4 |
| src/shared/photocraftOps.test.ts | 5 |
| src/shared/theme.test.ts | 10 |
| src/shared/workflow.test.ts | 6 |
| src/shared/workflowRunner.test.ts | 8 |
| src/main/appEditors.test.ts | 7 |
| src/main/deliver.test.ts | 12 |
| src/main/generation.test.ts | 11 |
| src/main/headlessApps.test.ts | 4 |
| src/main/imageApis.test.ts | 4 |
| src/main/liveTask.test.ts | 17 |
| src/main/media.test.ts | 4 |
| src/main/photocraftCli.test.ts | 5 |
| src/main/projects.test.ts | 5 |
| src/main/projectStore.test.ts | 8 |
| src/main/settingsStore.test.ts | 3 |
| src/main/workflowSteps.test.ts | 4 |
| src/main/liveApps.live.test.ts | 12 skipped (opt-in) |
| src/main/photocraftLive.test.ts | 2 skipped (opt-in) |

The window-opening tests were not re-run for this package (they open the ArtCraft apps). Their most
recent results from today: live app tests all passed; smokes: apps 20/20, Claude across apps 15/15,
Audio + Deliver 13/13 (+ Claude checks 4/4), multi-clip 8/8, workflow 7/7.

## What is in this ZIP

* `README.md` (out of date, see above), `CURRENT_PROGRESS.md`, `package.json`, `package-lock.json`
* `src/main/`, `src/renderer/`, `src/shared/`, `src/preload/` (all source and tests)
* `docs/` (`architecture.md`, `integration-audit.md` from the repository's top-level `docs/`, and all screenshots)
* Configuration: `tsconfig.node.json`, `tsconfig.web.json`, `electron.vite.config.ts`, `eslint.config.mjs`, `vitest.config.ts`, `.gitignore`, `.gitattributes`
* `resources/` (window tracker script, icons) and `scripts/` (end-to-end smoke tests and fixture helpers)

Excluded: `node_modules/`, `out/`, `dist/`, `build/`, caches, sample media fixtures, credentials,
keys, tokens and `.env` files (none exist in the source; the only key-shaped strings are obvious fake
values in unit tests, e.g. `AIzaTEST…`).

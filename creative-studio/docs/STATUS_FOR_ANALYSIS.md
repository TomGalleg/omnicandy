# CreateCraft: status snapshot for outside analysis

Written 2026-10-17 from the repository at `E:\ClaudeCraft` (git `main`, local only, **no remote, nothing pushed**, 85 commits; latest `34a4d0d`).
Primary sources inside the repo: `creative-studio/CURRENT_PROGRESS.md` (long, dated log), `creative-studio/docs/*.md` (one per subsystem),
`creative-studio/README.md`. Status words used here: WORKING (verified on this PC), PARTIAL, MOCK, UNTESTED, NOT BUILT.
Caveat: `README.md` and `CURRENT_PROGRESS.md` were written in many sessions; the progress file's top paragraphs are partly stale (they still
describe the 2026-10-14 state), the dated sections at the bottom are current.

## 1. What it is

A Windows-first Electron + React + TypeScript desktop app (electron-vite, zod, React Flow, react-resizable-panels, Vitest, Playwright `_electron`
for smoke tests). It is a "professional AI-assisted creative production" shell that embeds and drives 13 first-party "Craft" apps
(PhotoCraft, VectorCraft, SoundCraft, FilmCraft, LightCraft, EffectCraft, DesignCraft, WordCraft, PDFCraft, GridCraft, DeckCraft, FigCraft,
CADCraft) with Claude (Claude Agent SDK) as a "Creative Partner", plus third-party software through an adapter framework. The owner (Tomas) works
through a series of Claude Code sessions, each given a long brief; this snapshot is the result of those sessions.

Process model: `main` (privileged: IPC with zod validation, stores, app control, SDK), `preload` (contextBridge exposing only `window.studio`),
`renderer` (React, talks only to `window.studio`), `shared` (pure TS, unit-tested). Persistence is JSON files (atomic writes), no database.
Credentials: Windows DPAPI via Electron `safeStorage`, never in project folders.

## 2. Feature areas and status

**Core app (WORKING, verified earlier against the real installed apps):** project storage in user-chosen folders with a self-contained layout,
multiple projects (open, duplicate, verified move, locate), virtual collections, prompt-first Home with Claude-created projects (one real Claude
call verified), Simplified/Advanced navigation, docked Media and Claude panels, themes (ArtCraft Match, Studio Dark, Light, System), live
control of ArtCraft apps with edit locks and manual takeover, multi-clip video and audio editing and export, Deliver queue, visual node workflow
editor with a single shared execution engine (Claude can plan, run, pause, rerun affected steps, version and template workflows; user approves
paid steps), nine workflow templates.

**Paid AI generation (VERIFIED once each, 2026-10-14):** OpenAI image and Gemini image (one approved real image each), Veo video (one approved
clip, about $0.20). Spending limit + ledger exist. Runway built but not live-tested; Luma not built. Local free video (Wan via sd.cpp/Vulkan) and
a free local "motion" camera-move render exist; verified on this PC's GPU for the listed models only.

**Universal Application Integration Framework (external third-party software):** adapter SDK, `.ccadapter` packages (hashes, optional Ed25519
signature, review, permission ceiling, child-process isolation using Node's permission model, not an OS sandbox), discovery, Universal Connect
wizard, manifest v2 (external / internal / hybrid), plugin installer with rollback, named-pipe plugin bridge with HMAC auth.
Real-software results: Blender 4.0.2 (verified), FreeCAD 1.1.4 (verified, 9 commands, outputs re-opened independently), Autodesk Revit 2027
(real C# add-in, verified install/load/read/one reversible edit), DaVinci Resolve (adapter exists, **commands never live-verified**: scripting
refused on this PC, Free edition or setting). Adobe/Autodesk profiles other than Revit are data + docs only ("groundwork").

**AI Adapter Builder (2026-10-16):** Claude researches a program (official docs collected with fallbacks and citation verification) and returns
a strict JSON blueprint; CreateCraft templates build a private unsigned `.ccadapter`; four-stage pipeline (static, security, mock-simulated,
live); verification recorded per command and per program version; repair/rollback. Proven on real FreeCAD with a scripted (not live-Claude)
blueprint. The in-app live-Claude author path is only exercised by an opt-in test that spends Claude usage. Mock-limited results are never
reported as live.

**Project Planner (2026-10-16/17, this session):** new Planner workspace (More menu; Home has a "Plan a project" button).
* Data: per project goal/description/scope/constraints/deliverables, ideas, references, questions, accepted requirements and decisions (with
  reasons), tasks (subtasks, dependencies without cycles, priority, completion checks, expected outputs, optional native-app or external
  integration reference), assets (linked by path/URL/CreateCraft asset id, never copied; output versions), milestones, activity history
  naming the actor, and a kept version of the accepted plan every time it changes. Templates (software, art, document, research, video/audio,
  engineering, blank) only seed editable defaults and can be mixed.
* Round trip: proposals (stored apart from the plan) -> user accepts -> immutable hashed execution package -> executor claims a task (8 h
  lease, expired claims can be taken over) -> structured report -> user reviews. A report saying "complete" is never acceptance; only the user
  accepts, asks for changes, or rejects. Non-complete reports cannot be accepted as done.
* Consistency: revision vs plan revision; plan drift (added/changed/removed requirements etc.) shown on packages and reports, accepting an
  outdated report needs an explicit acknowledgement; per-entity revisions refuse conflicting edits; proposals that edit changed items are refused;
  duplicate reports and double claims prevented; atomic writes under a lock file so the app and the MCP server can write concurrently.
* Copy and paste: package as Markdown/JSON; paste JSON or Markdown report; preview first with a list of guesses; original text kept.
* Export/import zip with referenced vs bundled files (<=50 MB each), claims stripped, import never overwrites.
* MCP server `out/planner-mcp.cjs` (stdio; optional 127.0.0.1 HTTP with bearer token and Origin check). Scopes `read`, `propose`, `package`,
  `execute`; editing the plan and accepting work cannot be given to a connection. CreateCraft's own Claude gets four `planner_*` tools through
  the same session.
* Client status (docs checked 2026-10-16): Claude Code **verified** for handshake and health (its own `claude mcp list`, isolated config, no
  model call); a model-driven session was NOT run. Gemini CLI untested (not installed). Cowork, ChatGPT, Gemini app: cannot reach a local server
  (need remote HTTPS connectors), copy and paste is the route; those findings come from third-party guides, not the vendors' own pages.
  CreateCraft's own Claude: handlers tested against the real service, no live session.

## 3. Test and verification state

* `npm run check` (eslint + both tsc projects + Vitest) passes: 602 passed, 62 skipped (skipped = opt-in live tests needing installed apps, a
  running Resolve, network, or paid Claude calls). Run 2026-10-16 after the Planner work.
* Planner: 20 targeted tests (real service; real MCP server processes over stdio and HTTP) and `scripts/smoke-planner.mjs` 22/22 in the real
  Electron window with a real MCP executor process (screenshots `docs/screenshots/140-149`). `smoke-nav.mjs` 7/7 re-run after adding Planner.
* Earlier smoke scripts (docks, projects, workflow, live apps, connect, builder, adapters) passed when written; only `smoke-nav` and
  `smoke-planner` were re-run after the latest changes. Two older live PhotoCraft SVG tests are known failures when live tests are enabled
  (unchanged for days). A human has not clicked through the native confirmation dialogs; smokes answer them by script.
* External spend in the Planner session: $0.

## 4. Known gaps and risks (candid)

1. **Nothing is pushed or backed up remotely** (no `origin`). All work is local commits plus the untracked test-project folders.
2. **Planner has been exercised only by automated runs**; the owner has not yet used it by hand. No model-driven Claude Code/Cowork/ChatGPT/Gemini
   session has used the MCP tools. No remote hosting, OAuth or tunnel exists for cloud chat clients. Linking a CreateCraft asset stores ids but
   does not open it. Planner UI has no due dates per task, no drag-and-drop board, no comments.
3. **Packaging**: `electron-builder` NSIS config exists and `dist:dir` was prepared, but no installer was built or signed in the latest work; first-run
   setup, backup and update strategy (master plan Phase 10) are not built. The planner MCP server in an installed app is meant to run with
   `ELECTRON_RUN_AS_NODE=1`; tried only with the dev Electron binary.
4. **Docs drift**: README and the top of CURRENT_PROGRESS.md are partly out of date; many numbers in older sections are historical.
5. **Security model limits**: adapter isolation is Node's permission model, not an OS sandbox; generated adapters are unsigned and ask before every
   command; the MCP HTTP bearer token is a single shared secret; planner data is stored unencrypted on disk (it holds no credentials by design).
6. **Integration coverage**: only Blender, FreeCAD, Revit are verified against real software; Resolve unverified; Adobe untouched beyond profiles.
7. **Known product gaps from earlier phases**: DesignCraft text color limited to black/white; multi-clip strip has no drag-and-drop; no MP3 export;
   Luma video not built; Runway untested live.
8. Large single files (`ipc.ts` ~1,250 lines, big renderer components) and the CRLF/LF mix on Windows checkouts are maintainability concerns.

## 5. Suggested questions for the reviewing AI

* Is the proposal/package/report state machine sound (see `src/main/planner/service.ts`, tests in `service.test.ts`), and are there races between
  the app and the MCP process beyond the lock-file protocol in `store.ts`?
* Is the permission split (no `edit`/`review` for connections) enforceable end to end, including the HTTP mode and the in-app Claude tools?
* What is the shortest path to a trustworthy first release: installer, signing, backup/recovery, a hand-run of the Planner, a live Claude Code run?
* Where is the architecture over-built for a single-user desktop tool (adapter builder, bridge, hybrid installer) and what should be cut or frozen?

## 6. Where to look

`src/main/planner/` (store, service, MCP, IPC), `src/shared/planner*.ts`, `src/renderer/src/planner/`, `docs/project-planner.md`;
`src/main/integrations/` (framework, builder, bridge, install), `docs/external-integration-sdk.md`, `docs/ai-adapter-builder.md`,
`docs/universal-installer.md`; `src/main/ipc.ts` (wiring), `src/main/claudePartner.ts` (Claude tools and system prompt), `src/shared/workflow*.ts`
(shared workflow engine), `scripts/smoke-*.mjs` (UI smoke tests), `docs/screenshots/`.

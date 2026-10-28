# 05. Application integrations

Paths relative to `creative-studio/`. ✅ read in code · 🟡 partial/experimental · ❓ not verified at runtime in this audit (no program was launched; no live test was run).

## 1. Two completely separate integration systems

| System | Covers | Entry points | Contract |
|---|---|---|---|
| **A. Native "Craft" apps** (13) | PhotoCraft, VectorCraft, SoundCraft, FilmCraft, LightCraft, EffectCraft, DesignCraft, WordCraft, PDFCraft, GridCraft, DeckCraft, FigCraft, CadCraft | `src/main/liveApps.ts`, `liveTask.ts`, `editWorkspace.ts`, `photocraftLive.ts`, `photocraftCli.ts`, `nativeCommand*.ts`; UI: `components/EditWorkspace.tsx`, `components/live/*`, `useLive.ts` | `EDITOR_APPS` table (`src/shared/appEditors.ts`): per app `id, tab, name, formats[], quickEdits[], open:'live'` (all 13 are `'live'`), `defaultFor` |
| **B. External third-party programs** | Blender, Unreal Engine, Autodesk Fusion, DaVinci Resolve (real adapters); Revit, AutoCAD, Inventor, 3ds Max, Photoshop, Illustrator, Premiere, After Effects, InDesign, FreeCAD, Godot, Unity (**stubs**: detected, no commands) | `src/main/integrations/*` | `ExternalAdapter` SDK (`integrations/sdk.ts`) + `IntegrationManager` (`manager.ts:54`); contract types in `src/shared/integrations.ts` (stated header: "never routed through here" for native apps) |

Add-on routes: **Universal Connect** (`integrations/connect.ts`, attaches to programs that expose a command interface), **installable connector packages** (`loader.ts`, `packageStore.ts`, `packageRunner.ts`, `install/`), a **bridge** for in-program add-ins (`integrations/bridge/*`, repo `addins/revit`), and an **AI adapter builder** (`integrations/builder/*`, UI `renderer/src/builder/*`, `components/BuildPanel.tsx`) that has Claude write a new connector (user reviews and approves in Settings > Integrations).

## 2. Built-in external adapters (registered in `integrations/index.ts:14-19`)

| Adapter id | File | Maturity (manifest) | Control method | Notes verified in code |
|---|---|---|---|---|
| `blender` | `adapters/blender.ts` (+ `blenderBatch.ts`, `blenderScript.ts`, `blenderScene.ts`, `blenderExport.ts`, `blenderLive.ts`, `blenderViewport.ts`, specs) | **verified** (`blender.ts:55`) | Python scripting in background/live Blender | Live window docked into the Software tab (`setBlenderLiveHooks`, `src/main/ipc.ts` near line 812); edits saved to the project file after each step (`SoftwareWorkspace.tsx:35` text); batch + script recovery journal |
| `davinci.resolve` | `adapters/resolve.ts` (+ `resolveBridge.ts`, `resolveFiles.ts`, `resolveLive.ts`) | experimental (`resolve.ts:115`) | Resolve's Python scripting API | Needs Resolve running and the Studio edition with External scripting = Local (`resolve.ts:345-356`); read-back commands `app.info, project.list, project.inspect` |
| `unreal` | `adapters/unreal.ts` (+ `unrealTools.ts`, `unrealFiles.ts`, `unrealLive.ts`, `unrealProject.ts`) | experimental (`unreal.ts:257`) | Epic's built-in MCP server at `http://127.0.0.1:8000/mcp` via `src/main/mcpHttpClient.ts` | Tiered tool access (read / edit / restricted / script sandbox asked every time); version must be 5.8+ ("Incompatible version" for 5.4); `project.create`, `editor.launch` are `offline` commands; **no undo tool** (`unreal.ts:13`). Not reachable until the editor runs with Unreal MCP + All Toolsets plugins and Auto Start (the status users see: "Scripting not available") |
| `autodesk.fusion` | `adapters/fusion.ts` (+ `fusionLive.ts`) | experimental (`fusion.ts:207`) | Autodesk Fusion's MCP server at `http://127.0.0.1:27182/mcp` | Needs Fusion open and Preferences > General > API > "Fusion MCP Server" on. (This is **Autodesk** Fusion; Blackmagic Fusion is not covered.) |
| stubs (`vendors.ts:13-24`) | `adapters/vendors.ts` `vendorStubs` | `stub` | none | `validateManifest` forbids a stub declaring commands (`sdk.ts:110`) |

Revit: `integrations/revit.test.ts`, `revit.live.test.ts`, `addins/revit`, `docs/revit-integration.md` exist, and `vendors.ts` also has an `autodesk.revit` stub. I did **not** trace which of these actually registers a working Revit adapter ❓ (probably through the bridge/package route).
FreeCAD: `integrations/freecad*.test.ts` and `builder/hosts.ts` reference it, but the registered adapter is a stub whose Software row says "Deep integration is planned but not built yet" (confirmed by the screenshot the user shared in this session).

## 3. Command registry and tool discovery

* **Declaration**: `AdapterManifest.commands: CommandSpec[]` (`shared/integrations.ts:48-100`): `id, label, description, params{type,description,required,default,min,max}`, `permissions[]` from {`read-info, launch, open-files, read-project, modify-project, write-files, execute-scripts, ui-automation, network`}, flags `destructive, idempotent, timeoutMs, longRunning, confirmEveryTime, preview, offline`, `platforms`.
* **Discovery of programs**: `integrations/discovery.ts` (registry, shortcuts, common dirs, PATH, running processes, user locations) → `IntegrationManager.scan()` (`manager.ts:139`) → `list()` → `ExternalAppInfo` with `status` ∈ detected, available, connected, limited, unsupported, needs-repair, incompatible, not-running, api-unavailable.
* **Discovery of commands**: Claude/agent call `external_apps` then `external_commands`/`external_command` (agent) or `external_apps`/`external_run`/`external_job` (Claude) (`agentHarness/externalTools.ts`; Claude description at `claudePartner.ts:47`). `commandDiscovery.ts` and `commandSchemaInspection.ts` supply descriptions/schemas; Unreal's `tools.search`/`tool.read` expose its ~830 toolset tools; Unreal's `app.info` text starts "START HERE".
* **Execution**: `IntegrationManager.execute(key, commandId, params, {background})` (`manager.ts:353`): validates app exists, adapter exists, OS support, command declared, `availableCommands()` (add-in narrowing), param validation (`validateParams`:511, `json` params only for built-ins and checked by `validateJson`), permission ceiling for packages, **asks the user** unless granted (once / session / always, per app+permission; destructive and unsigned always ask), connects (or a transient offline session), runs with a timeout and an `AbortSignal`, records an audit entry (`log()`, ≤200 entries), and checks outputs exist and are non-empty.
* **Jobs**: `longRunning` commands return a job id; `manager.jobs()/job()/cancelJob()`; jobs live **in memory only** and are lost on restart (`jobLedger.ts` header documents this).

## 4. Live application state, launching, takeover

| Concern | Native Craft apps | External programs |
|---|---|---|
| Launch / connect | "Open in OmniCandy" starts the app on the selected file (`live.open`, `liveApps.ts`); Software tab list (`SoftwareWorkspace.tsx`) "Open in OmniCandy / Own window" via `launchApp` | `IntegrationManager.connect/disconnect/repair/autoConnect`; commands marked `offline` (`app.launch`, `editor.launch`, `project.create`) work before connecting; `openBlank.ts` "Open in OmniCandy" for Blender, Unreal, Resolve, Fusion starts them on a blank document |
| Live state | `LiveSnapshot` (`shared/live.ts:30`): `appId, status('stopped'|'starting'|'ready'|'error'), asset, history, collab, steps, stepIndex, needsReplanConfirm, savedVersionIds, poppedOut, appTheme, openedBy`; pushed to the renderer, consumed by `useLive.ts` | `ExternalLiveState {name, pid}` pushed on `IPC.extLive`; the window is embedded (`embeddedApp.ts`, `dockedPanel.ts`) into the Software tab; `LiveStage` in `SoftwareWorkspace.tsx:15` |
| Human takeover / resume | `CollabState` (`shared/collaboration.ts:26`): `phase`, `lockOwner`, `activeOperation`, `takeoverPending`, `needsSync`; events plan/start/pause/take control/resume; the agent loop refuses to act while the user owns control (`loop.ts:27`) | No pause/takeover state for external programs; their window is just shown and the user can work in it. Approval dialogs are the control point |
| Progress and events | `liveTask.ts` step runner (`steps`, `stepIndex`), `onProgress` events, `BottomPanel` activity/timeline | `ProgressEvent {opId, appKey, commandId, stage, fraction}` (`shared/integrations.ts:192`), job reports (`externalJobReport`), live stage text |
| Verification | native: read-back commands (`NATIVE_READBACK_COMMANDS`, `agentHarness/nativeReadback.ts`) + `evidence_verify`; `save_version` returns a confirmed version id | `integrations/readback.ts`: **host-trusted read-back list** `TRUSTED_READBACK_COMMANDS` = blender (`scene.inspect, scene.inspect_detail, discover.search`), davinci.resolve (`app.info, project.list, project.inspect`), unreal (`app.info, level.inspect, assets.find`). Everything else (every edit command) is an execution receipt, not proof. Adapter-set `verified` is never trusted by the host |

## 5. What the planner could reuse for real work (no redesign of these needed)

1. **The tool surface**: all of `external_*`, native app tools, `generate_*`, workflow tools already exist inside Claude's and the agent's registries. The planner only needs a way to *scope* them per chunk (e.g. a registry built from a chunk's `appRef`, `ToolRegistry` snapshot, `toolFamilies`).
2. **Permissions and approvals**: `IntegrationManager.execute` approval flow, paid-generation approval cards, spending limit — already per call; usable as-is for planner-driven runs.
3. **Verification primitives**: `TRUSTED_READBACK_COMMANDS`, `evidence_verify`, `ApplicationReceipt` ids (`taskPlan.ts:26`), saved-version ids, `Asset.sha256`. These are the natural source for a chunk's `completionChecks` results, replacing self-reported `verification[]`.
4. **Collab/takeover**: `CollabState` + `userControlActive` already model "pause", "take control" and "awaiting approval" for live documents.
5. **Library provenance**: `AssetProvenance` + `parentId` + `ProjectStore.addDerivedFile` for attaching outputs to a chunk (report schema already has `outputs[].assetId`).
6. **Job ledger / recovery**: `AgentJobLedger`, `EditIntentJournal`, checkpoint — the machinery for "resume this chunk after a crash".
7. **The Software tab** already shows each program's real status and (new this week) a "Next:" line per unreachable program (`shared/softwareList.ts`) — a ready component for a "world/stations" overview.

## 6. Limits that affect a planner-driven design

* External programs need to be **running with their server enabled** for Unreal (8000) and Fusion (27182); Resolve needs Studio; otherwise the status is `api-unavailable`/`not-running` and commands fail with a clear message. The planner has no pre-flight "can this chunk run?" check.
* Only **one** embedded external window is shown at a time (`liveExternal` single record in `ipc.ts`).
* Jobs are volatile (in memory), so "background work in progress" is not durable across restarts.
* Unreal has no undo; native apps have undo + versions; Blender saves after each step.
* Adapter maturity is mostly `experimental` (3 of 4 real adapters); `verified` only for Blender.
* ❓ Whether Revit works end-to-end today was not traced.

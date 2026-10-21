# Handoff: model-independent agent harness prototype

Status: investigation only. No code was changed, nothing was installed, no API was called. No secret values appear here (file paths and key *names/ids* only).
Written 2026-10-20 against `main` at `bf3b062`. All paths are relative to `creative-studio/` unless they start with `docs/` at the repo root. Line numbers are approximate anchors and will drift.

## 0. One-paragraph conclusion

Claude is wired in through **one file, `src/main/claudePartner.ts`**. It hands the Claude Agent SDK an in-process MCP server (`createSdkMcpServer`) whose ~45 tool handlers are closures inside `ClaudePartner.tools()`. Almost every *app-control* handler is a one-line call into **`LiveTaskController`** (`src/main/liveTask.ts`), which already contains everything that matters for safety: the edit lock, pause/take-control, approval dialogs, command allow-lists, hand-edit detection and versioning. `LiveTaskController` knows nothing about Claude's SDK. So a different model can control any of the 13 Craft apps by **calling the same `LiveTaskController.claude*` methods** from a new loop: no new application-control system is needed. What does not exist is (a) a provider abstraction for *tool-calling* (the only multi-provider code, `src/main/planner/chat.ts`, is text-only), (b) a model-neutral tool registry (the tool schemas are zod objects fused to the SDK's `tool()` helper), and (c) a model-neutral conversation store. The prototype is therefore **new files only**; changing zero existing files is possible, and one small, optional wiring edit (`src/main/ipc.ts`) is needed only to expose it inside the running app.

---

## 1. Dependency diagram

```
 Renderer (ClaudePanel.tsx) ──IPC claude:send──► ipc.ts handle(IPC.claudeSend) ──► ClaudePartner.send()
                                                                                     │
        ┌────────────────────────────────────────────────────────────────────────────┤
        │ query()  (@anthropic-ai/claude-agent-sdk)  ← Anthropic-only; Claude Code subprocess
        │    options: tools:[], settingSources:[], mcpServers:{createcraft: tools()}, permissionMode:'dontAsk',
        │             allowedTools: mcp__createcraft__*, env: ClaudeAuth.env(), resume: sessionId
        ▼
  ClaudePartner.tools() = createSdkMcpServer({ tool(name, desc, zodShape, handler) × ~45 })   [claudePartner.ts:306-701]
        │
        ├─ app control ──► LiveTaskController.statusForClaude / preview / claudeQuickEdit / claudeAppCommand /
        │                   claudePhotoCraftCommand / claudeUndo / saveVersion / claudeTimelineEdit / appCommandList / open
        │                       │  gate: claudeGate() → collabReducer (shared/collaboration.ts) lock + version check
        │                       │  policy: shared/appCommands.ts, shared/photocraftOps.ts, shared/appEditors.ts
        │                       │  approval: deps.approveCommand → ipc.ts → approvalWindow.ts (native modal)
        │                       ▼
        │                   LiveDoc (interface, photocraftLive.ts:22)  ◄── LivePhotoCraft / LiveAppBase subclasses (liveApps.ts)
        │                       ▼
        │                   McpClient (mcpClient.ts, JSON-RPC over stdio) ──► `<app>-cli mcp ...` ──► Craft app (GUI or headless)
        │
        ├─ library/files ─► ProjectStore (projectStore.ts)            list_files, open_file, export_file (DeliverQueue)
        ├─ paid generation ► ipc.ts closures (runGeneration, video.submit)  + approval dialog + spending ledger
        ├─ workflows ──────► ipc.ts closures (startRun, workflowControl)    + WorkflowExecutor
        ├─ external apps ──► IntegrationManager.execute (integrations/manager.ts) + adapter approval dialog
        └─ planner ────────► McpSession (planner/mcp.ts) in-process

  Credentials: SafeStorageVault (credentialVault.ts) ◄── ClaudeAuth (claudeAuth.ts) builds the SDK env;
               PlannerChat (planner/chat.ts) borrows openai/gemini keys via vault.withKey for TEXT-ONLY chat.
```

Prototype shape (new, parallel to Claude, nothing in the left column is touched):

```
 AgentHarness.run(goal)  ──►  ModelProvider.complete(messages, toolDefs)   (ScriptedProvider | OpenAI-compatible | Gemini)
        │ tool_call{name,args}
        ▼
 ToolRegistry.call(name,args) ──► the SAME LiveTaskController methods ClaudePartner uses
        │ result text / error text / (optional) image
        ▼
 loop until final text, max-steps, abort, or lock lost  →  finally: ctl.claudeDone()
```

---

## 2. Component inventory

Legend: **Reuse** = can be imported/called as-is. **Limit** = what affects a model-independent harness.

### 2.1 Claude integration

| File | Key symbols | Connects to | Reuse? | Limits |
|---|---|---|---|---|
| `src/main/claudePartner.ts` (873 lines) | `class ClaudePartner`; `send()` (l.810); `tools()` (l.306–701); `SYSTEM_PROMPT` (l.32); `TOOL_NAMES` (l.68); `interface ClaudePartnerDeps` (l.84); `planProject()` (l.707), `planChat()` (l.769); auth helpers `checkAuth/signIn/authFailure` | `@anthropic-ai/claude-agent-sdk` (`query`, `tool`, `createSdkMcpServer`, dynamically imported); `LiveTaskController`; `ProjectStore`; `ClaudeAuth`; `buildResumeContext` | **No** (do not modify, do not import `ClaudePartner`). **Yes** for reading as the reference behaviour; `SYSTEM_PROMPT` is a `const` that is **not exported**. | Tool handlers are closures inside a private method, welded to SDK `tool()` and zod. Session continuity is the SDK's `resume: sessionId` (Claude Code owns the transcript) — a harness must keep its own message list. `model` is typed `ClaudeModelId` and `setModel` rejects anything not in `CLAUDE_MODELS`. `send()` ignores `m.type==='user'` messages, so tool calls and results are never surfaced to the app, only the final text + `activity` lines. `startedFresh` static clears the first loaded chat each launch. |
| `src/main/claudeAuth.ts` | `ClaudeAuth` (`mode`, `env`, `billing`, `scrub`), `signInEnv`, `ANTHROPIC_VAULT_ID='anthropic'` | `SafeStorageVault`; `claudeAuth.json` in userData (`{mode}` only, no secrets) | **Partly.** `scrub(text)` (redacts the Anthropic key) is reusable; `env()` is Claude-only. | Strips inherited `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` by design. |
| `src/shared/claude.ts` | `CLAUDE_MODELS` (closed list: `claude-opus-5-5`, `claude-sonnet-5-5`), `ClaudeChatItem {id, role:'user'\|'claude'\|'activity'\|'error', text, at}`, `ClaudeState` | Renderer + main | `ClaudeChatItem` yes. `CLAUDE_MODELS` is Claude-specific. | Role `'claude'` is hard-coded in UI; a second model's replies would render as "Claude". |
| `src/shared/claudeHistory.ts` | `parseHistory`, `buildResumeContext(items)`, `HISTORY_FILE='conversation.json'`, `HISTORY_FOLDER='Claude'`, `MAX_SAVED_ITEMS=200` | `ProjectStore.readClaudeHistory/writeClaudeHistory` | Yes (pure). | The prompt text is Claude-worded ("Latest messages: Claude: …"). |
| `src/main/ipc.ts` (1376 lines) | `registerIpc`; `claude()` factory (l.~955) builds `ClaudePartner` with every dependency closure; `handle(IPC.claudeSend …)` (l.1167); `live()` (l.~358) builds `LiveTaskController`; `approveCommand` (l.~397) | everything | Pattern yes; file is the **composition root**, not a library. | All shared singletons (`live`, `runGeneration`, `startRun`, `external`, `deliver`, `vault`) are closures local to `registerIpc` — unreachable from a new module unless passed in. |
| `src/shared/ipc.ts`, `src/preload/index.ts` | `IPC.claude*` channel names; `StudioApi.claude` (l.~361) | renderer | Only if a UI entry point is wanted. | Not needed for the prototype. |
| `src/renderer/src/components/ClaudePanel.tsx` | Chat UI | `window.studio.claude` | Not for prototype | Single provider. |

**Initialisation:** `ClaudePartner` is lazily created per project by `claude()` in `ipc.ts` (`partner ??= new ClaudePartner({...})`, reset on project switch via `resetters`). The SDK is imported dynamically inside `send()`/`tools()`; nothing starts at boot. Auth is checked by spawning `claude auth status` (`checkAuth`). The in-process MCP server is **rebuilt on every `send()`**.

**Session management:** `sessionId` captured from the SDK `system/init` message; passed back as `resume`. Reset by `reset()` and `authChanged()`. After a restart there is no SDK session, so `buildResumeContext(items)` injects a short text recap into the first prompt. Per-turn cap `maxTurns: 300`. Concurrency: one turn at a time (`status==='working'` rejects). Cancel: `AbortController` via `stop()`.

**Response processing:** the `for await (const m of q)` loop in `send()` handles only: `system/init` (store session id), `assistant` (join `text` blocks → one chat item), `result` (add cost; map "not logged in"/"invalid api key" to an auth error; `is_error` → error item). Tool use/results are executed *inside* the SDK; the app never sees them.

**Tool-call handling:** SDK-side. The model calls `mcp__createcraft__<name>`; the SDK validates args with the zod shape, runs the handler, which returns `{content:[{type:'text'|'image',…}], isError?}`. Pattern in every handler: `try { const r = await ctl.X(...); activity(r); return text(r) } catch (e) { activity('… refused: …'); return fail(e) }` where `fail` returns `isError:true` with `Error: <message>`. **Errors are returned to the model as text; they never throw out of a tool.** This is the contract a new harness must preserve.

### 2.2 Application tools (the 13 Craft apps and external adapters)

There is **one generic command surface for all 13 apps**, not 13 tool sets. The model uses ~8 generic tools; app specifics arrive as data.

| File | Key symbols | Role | Reuse? |
|---|---|---|---|
| `src/shared/appEditors.ts` (665 lines) | `EditorAppId` (13 ids), `EDITOR_APPS: Record<EditorAppId, EditorApp>` (name, blurb, `formats`, `quickEdits: QuickEdit[]` with typed `ParamSpec` number/select/text), `checkEditValues(op, raw)`, per-app step builders (`wordcraftSteps`, `gridcraftSteps`, `pdfcraftSteps`, `deckcraftSteps`, …), `BLANK_FILES` | Declarative catalogue of each app's "quick edits" (id + typed settings) and file formats | **Yes, unmodified** (pure, no Electron). Source of truth for per-app tool schemas. |
| `src/shared/appCommands.ts` | `appCommandTier(id)` → `free\|approval\|never`; `checkAppCommand(cmd, params, {approved})` | Policy for the generic engine-command path (all apps except PhotoCraft). Approval-tier = anything matching open/save/export/import/place/script/action/plugin/batch/run/…; never-tier = prefs/settings/`createcraft`. Rejects path-like param values unless approved. | **Yes** |
| `src/shared/photocraftOps.ts` | `commandTier`, `checkPhotoCraftOp`, `checkParamValues`, `PHOTOCRAFT_PRESETS` | Same, stricter, PhotoCraft prefix allow-list | **Yes** |
| `src/main/photocraftLive.ts` | `interface LiveDoc` (l.22): `open, run(op), history, writeVersion, undo?, listCommands?, quickEditSteps?, preview?, screenshot?, describe?, timeline*?`; `LivePhotoCraft` (token file + automation roots), `versionOf`, `freePort`, `waitForPort` | The seam between controller and app | **Yes.** `LiveDoc` is the right fake-able interface (used by tests). |
| `src/main/liveApps.ts` (1431 lines) | `abstract LiveAppBase` (spawn `<app> --control <port>` or headless `<app>-cli mcp`, `listCommands` via `<app>-cli commands/describe`), `LiveVectorCraft, LiveSoundCraft, LiveFilmCraft, LiveLightCraft, LiveEffectCraft, LiveDesignCraft, LiveWordCraft, LivePdfCraft, LiveGridCraft, LiveDeckCraft, LiveFigCraft, LiveCadCraft`; option `headless:true` runs with **no window** | One driver per app, all implement `LiveDoc` | **Yes.** `headless:true` makes WordCraft/GridCraft/PdfCraft/etc. controllable without a GUI (ideal for the prototype). PhotoCraft/VectorCraft/SoundCraft have no headless mode in this file. |
| `src/main/mcpClient.ts` | `McpClient.start(exe,args)`, `callTool`, `request`, `close`; wire trace via env `CS_MCP_TRACE=<file>` | stdio JSON-RPC to each app's CLI | **Yes** |
| `src/main/liveTask.ts` | `LiveTaskController` (see 2.3) | Everything below | **Yes** |
| `src/main/integrations/manager.ts` (502 lines) + `sdk.ts` + `shared/integrations.ts` | `IntegrationManager.scan/list/connect/execute(key, commandId, params, {background})`, `job/cancelJob`; `ExternalAdapter`, `AdapterManifest.commands: CommandSpec[]` (typed params, `permissions`, `destructive`, `long_running`), `CommandResult {ok, verified, message, evidence, outputs, error:{kind,message}}`, `validateParams` | Third-party software (Blender, FreeCAD, Revit, Resolve). Manifest-declared commands only; per-command permission grants; approval via `deps.approve` | **Yes** (call `execute`) — but the instance lives inside `registerIpc`. | Out of scope for the first prototype; the tool mapping is 3 calls (`external_apps`, `external_run`, `external_job`) already written in `claudePartner.ts` l.537–547, 589–594 and `ipc.ts` l.~1005–1030. |
| `src/main/integrations/bridge/*`, `addins/revit/*` | plugin bridge (loopback server for in-app add-ins) | Revit-class "internal" integrations | Not needed | — |

**How capabilities reach Claude today** (generic, discoverable):

| Tool (claudePartner.ts) | Maps to | Notes |
|---|---|---|
| `get_status` (l.317) | `ctl.statusForClaude()` | JSON: open file/app, `apps[]` (id, name, tab, fileTypes), history, lock state, `edits[]` = the app's quick edits with typed settings (derived from `EDITOR_APPS`), optional `details` from `LiveDoc.describe()` |
| `look_at_document` (l.320) | `ctl.preview(1024)` | returns **image/png base64** content block |
| `apply_edit` (l.328) `{edit_id, settings}` | `ctl.claudeQuickEdit` | simplest, fully typed, validated by `checkEditValues` |
| `app_commands` (l.340) `{filter}` | `ctl.appCommandList` → `LiveDoc.listCommands` | live discovery via the app's own CLI |
| `app_command` (l.345) `{command, params}` | `ctl.claudeAppCommand` | any engine command, tiered |
| `photocraft_command` (l.334) | `ctl.claudePhotoCraftCommand` | `app_command` forwards here when PhotoCraft is open, so it is redundant for the prototype |
| `undo`, `save_version` | `ctl.claudeUndo`, `ctl.saveVersion` (after a lock check, l.356) | |
| `list_files`, `open_file`, `new_document` | `ProjectStore.loadManifest` + `openAsset`/`newBlankFile` deps | `openAsset` and `newBlankFile` are closures in `ipc.ts` (`openLive`, blank-file copy) |
| `timeline_*`, `export_file`, `list_export_formats` | `ctl.claudeTimelineEdit`, `DeliverQueue` | |
| image/video generation, workflows (≈20 tools), `planner_*` | closures in `ipc.ts` | Paid/stateful; **exclude from prototype** |

### 2.3 Execution system

All in `src/main/liveTask.ts` (`LiveTaskController`) + `src/shared/collaboration.ts` (`collabReducer`, `CollabState`, `CollabEvent`: `plan, planReady, start, beginOperation, endOperation, requestPause, takeControl, releaseControl, resume, syncVersion, complete, cancel`).

- **Dispatch:** `claudeQuickEdit` / `claudeAppCommand` / `claudePhotoCraftCommand` / `claudeTimelineEdit` → `claudeRun(label, steps)` (l.435) → `claudeGate()` (l.408) → `dispatch(beginOperation)` → `doc.run(step)` for each step → `dispatch(endOperation{ok,version})`.
- **Permissions enforced (all before the app is touched):**
  1. Lock/phase (`claudeGate`): refuses if `manual` (user took control), `pausing/paused`, an automation loop runs, or `awaiting_approval`. Error text tells the model to stop and wait.
  2. Hand-edit detection: compares `versionOf(history)` to `collab.knownVersion`; mismatch → pauses and throws.
  3. Command tier (`appCommandTier`/`commandTier`): `never` rejected; `approval` calls `deps.approveCommand` (native modal in `ipc.ts` → `approvalWindow.ts`, answerable only by the user) and re-checks with `{approved:true}`; `free` runs.
  4. Parameter checks: no path-like values for free commands; length/depth limits.
  5. App-level: each app is launched with automation read/write roots so it refuses file access outside the project (set in `ipc.ts` `live()` and each `Live*` driver).
  6. Versioning: the opened library file is never overwritten; `saveVersion()` writes a new derived file with lineage and dedupes identical content.
- **Results returned:** a string: `"<label> applied."` plus `Result: <lastResult JSON, ≤6000 chars>` if the app returned data. If the user paused/took control during the op, the string appends "stop and wait".
- **Errors:** thrown `Error`s with model-directed plain text (`'The user declined "x". Nothing was run.'`, `'... paused you ... do not retry'`). Wrapped to `isError` text by the tool layer.
- **Turn end:** the caller **must** call `ctl.claudeDone()` (ClaudePartner does it in `finally`, l.864). It ends Claude's task and releases the lock; forgetting it leaves the lock in `running/claude`.
- **Timeouts:** `McpClient.request` default 60 s; `run` uses 300 s; `open` race of 120 s (`openTimeoutMs`).

`LiveTaskController` deps: `connect(app)→LiveDoc`, `store: ProjectStore`, `emit(snapshot)`, `writeDir(app)`, optional `approveCommand`, `stepDelayMs`, `openTimeoutMs`. With **no `approveCommand`**, approval-tier commands are refused ("needs the user's approval, which is not available here"), which is the safe default for tests and the prototype.

### 2.4 Project context (projects, files, conversations, progress)

| File | Symbols | Notes |
|---|---|---|
| `src/main/projectStore.ts` | `ProjectStore` (`create`, `loadManifest`, `importFile`, `addDerivedFile`, `resolveAssetPath`, `appWorkDir`, `workDir`, `readClaudeHistory/writeClaudeHistory`, `snapshotWorkflow`), `writeJsonAtomic`, `sha256File` | Manifest JSON per project (`ProjectManifest.assets[]` with `id,name,kind,relPath,sha256,sourceFormat,provenance,parentId`); folders `originals/ versions/ exports/ work/` or layout 2 per-app folders. Library file names are the model-facing identifiers (`list_files`). **Reuse: yes.** |
| `src/main/projects.ts` | `ProjectManager` | Project list/open/move/duplicate. Not needed. |
| `Claude/conversation.json` (inside project) | `{version:1, items: ClaudeChatItem[≤200]}` | Chat text only. **No tool calls, no tool results, no task progress.** First load per app launch is discarded (`startedFresh`). A harness must **not** write here; use a sibling file (e.g. `Claude/agent-harness-<runId>.json`), because `reset()`/`seed()` and Move/Duplicate treat this folder as Claude's. |
| Task progress | `LiveSnapshot` (`shared/live.ts`: `status, collab, steps, stepIndex, history, savedVersionIds, message`) pushed on every change via `deps.emit` | Ephemeral, in memory. Workflow run state is separate (`ipc.ts`, `shared/workflowControl.ts`) and stored as workflow JSON + versions. |
| Planner | `src/main/planner/*`, `shared/planner.ts` | Separate store under userData/planner; `McpSession` is an existing, provider-neutral MCP server (stdio/HTTP) — a precedent for exposing tools to any client. |

### 2.5 AI provider configuration

| Concern | Where | Reality |
|---|---|---|
| API key storage | `src/main/credentialVault.ts` `SafeStorageVault` — files `<userData>/secrets/providers/<id>.key` (DPAPI/safeStorage blob) + `<id>.json` metadata; `status(id)`, `save`, `remove`, **`withKey(id, fn)`** lends the key to `fn` and redacts it from any thrown error | Provider id regex `^[a-z][a-z0-9-]{1,31}$`. Ids in use: `anthropic`, `openai`, `gemini`, `runway`. **Reuse: yes** (`withKey` is exactly the right primitive). |
| Key entry UI | `ipc.ts` `keyProvider = z.enum(['openai','gemini','runway'])` (l.510) | Only those three can be saved from the UI (clipboard paste flow). Anthropic has its own handler (`claudeAuthPasteKey`). A new provider id (e.g. local server) needs this enum widened — **avoid in the prototype** (use openai/gemini ids already present, or an env var). |
| Model selection | Claude: `CLAUDE_MODELS` + `ClaudePartner.model` in memory (not persisted). Image/video: `IMAGE_MODELS`, `VIDEO_MODELS` in `shared/generation.ts`/`video.ts`. Planner chat: `PlannerChat.models(provider)` lists text models live from the provider (`textModels()`), model string validated `/^[\w.:-]{1,80}$/` | No persisted text-model preference. |
| Provider abstraction | `shared/contracts.ts` `GenerationProvider` (images/video, `billable` flag, `estimate`, `submit`); `planner/chat.ts` `PlannerChat.reply({system, provider:'claude'\|'openai'\|'gemini', model, messages})` | `PlannerChat` is the **only** text-LLM multi-provider code: raw `fetch` to `OPENAI_BASE/chat/completions` and `GEMINI_BASE/models/<m>:generateContent` (constants in `generation.ts`), `AbortSignal.timeout(120_000)`, error mapper `failure()`. **Text only — no `tools`/`tool_calls`/`functionDeclarations`.** `openaiChatBody`, `parseOpenAIChat`, `geminiChatBody`, `parseGeminiChat` are exported pure functions with tests (`planner/chat.test.ts`), usable as templates; they cannot be reused for tool calling. |
| Non-secret settings | `SettingsStore` (`settingsStore.ts`) = appearance only (`appearance.json`). `claudeAuth.json` = `{mode}`. `userData` has no general key/value config. | A harness needs its own tiny config (see §5). |
| Spending control | `GenerationService`/`spending` ledger, `approveGeneration` dialog | Applies to image/video only. **LLM token spend by non-Claude providers is not metered anywhere** — add a hard `maxSteps`/`maxTokens` in the harness. |
| SDK dependency | `package.json`: `@anthropic-ai/claude-agent-sdk ^0.3.296`; **no** `openai`, Gemini, Ollama or LangChain packages in `node_modules` | Use global `fetch` (Node 22/Electron 44) like `chat.ts`; no install needed. |

### 2.6 Testing

| Layer | Files | Use for the prototype |
|---|---|---|
| Unit (Vitest 4, `vitest.config.ts`: `src/**/*.test.ts`, alias `@shared`) | `npm test` = `vitest run`; `npm run check` = eslint + both tsc + vitest | Gate for the new code. |
| **Fake app document** | `src/main/liveTask.test.ts`: `class FakeDoc implements LiveDoc` (history array, `run`, `undo`, `writeVersion`, `quickEditSteps`), real `ProjectStore` in a temp dir, real fixture `fixtures/sample-project/photocraft-smoke.png`; test at l.199 "Claude edits through the lock" exercises `claudeQuickEdit`, approval refusal, pause, take-control, hand-edit pause, `claudeDone` | **The template for the prototype's primary test.** Zero apps, zero network, zero cost. |
| Driver-level fakes | `src/main/liveDrivers.test.ts` `withFake(driver, reply)` replaces `driver.mcp` with an object having `alive/callTool/close` | Test tool→driver wiring without any app. |
| Real app, **no window** | `src/main/headlessApps.test.ts`: `new LiveWordCraft({installDir, readRoot, writeRoot, headless:true})`, `ensureStarted()`, `open`, quick edits, `writeVersion`, skipped via `it.skipIf(!installed(app))` when the CLI is absent. Fixtures: `quarterly-report.docx` (replace "Sunset Over the Sea" → "Evening Tide", add paragraph), `region-sales.xlsx`, `quarterly-summary.pdf`, `northern-lights.deckcraft`, … | **The "different model controls a real application" proof**, safely: a WordCraft document in a temp project, headless, no GUI, no network. |
| Live/conformance (opt-in) | `*.live.test.ts`, `*.conformance.test.ts` need `CS_LIVE_TESTS=1` and installed apps (they open windows) | Skip. |
| Mocking the SDK | `claudePartner.auth.test.ts` uses `vi.mock('@anthropic-ai/claude-agent-sdk', …)` | Shows the existing convention for provider mocks. |
| Playwright smoke (`scripts/smoke-*.mjs`, `smoke-claude-apps.mjs`) | Launches Electron; `smoke-claude-*` spend Claude usage | Not for the prototype. |
| Linux | WSL workflow in `docs/linux-compatibility.md` (see project memory): Craft apps do not exist on Linux, so only fake-doc tests apply there. | Run the fake-doc test on both OSes after changes. |

---

## 3. Facts the implementer must not get wrong

1. **Do not re-implement app control.** Call `LiveTaskController.claude*`. Re-implementing would bypass the lock, approval, allow-lists and versioning.
2. **Tool errors are data.** Catch, return `Error: <message>` to the model, never crash the loop. Preserve the model-directed phrases ("stop and wait; do not retry").
3. **Always `ctl.claudeDone()` in `finally`**, including on abort/exception/max-steps. Honour pause/take-control: when a result contains "taken control"/"paused you", or `ctl.snapshot().collab.lockOwner==='user'` / `phase` ∈ `manual|pausing|paused`, stop calling tools and end the run.
4. **Approvals stay human.** Never auto-approve. In tests omit `approveCommand`; in the app the same native modal appears (text says "Claude wants to run…" — cosmetic; parameterising it is a later edit to `ipc.ts`).
5. **The tool contract is the SDK's `{content:[{type:'text'|'image'}], isError?}`.** `look_at_document` returns an image block (PNG base64). Non-vision models need a fallback (omit the tool, or return a text description from `get_status.details`).
6. **Model-facing ids are names, not uuids** (`list_files` names; `open_file({name})`).
7. **Do not touch `Claude/conversation.json`, `CLAUDE_MODELS`, `ClaudeState`, `IPC.claude*`.** Separate namespace: `agent:*`, `Claude/agent-harness-*.json`.
8. **No new dependencies.** Use global `fetch`; model providers speak plain HTTPS JSON.
9. `SYSTEM_PROMPT` in `claudePartner.ts` is private and Claude-worded and references ~45 tools. The prototype needs its own short prompt covering only the registered tools (copy the relevant sentences from l.34–40; do not export or edit the original).
10. A full `get_status` can be large (13 apps × edits). Truncate tool results (e.g. 8 000 chars) for small-context models.

---

## 4. Proposed prototype (smallest thing that proves the point)

**Scope:** one goal, one app, ~9 tools, one real provider adapter, one scripted provider.

### 4.1 Tool set (all thin wrappers over existing `LiveTaskController`/`ProjectStore` calls)

| Neutral tool | Args | Calls |
|---|---|---|
| `get_status` | – | `ctl.statusForClaude()` → JSON string |
| `list_files` | – | `store.loadManifest()` → same projection as `claudePartner.ts` l.425 |
| `open_file` | `name`, `app?` | find asset by name → `ctl.open(asset.id, app, 'claude')` then `ctl.snapshot()` (the Claude handler calls the `openAsset` dep, which is `ipc.ts openLive`; calling `ctl.open` directly is equivalent minus UI embedding) |
| `apply_edit` | `edit_id`, `settings?` | `ctl.claudeQuickEdit` |
| `app_commands` | `filter?` | `ctl.appCommandList` |
| `app_command` | `command`, `params?` | `ctl.claudeAppCommand` |
| `undo` | – | `ctl.claudeUndo` |
| `save_version` | – | lock check, then `ctl.saveVersion()` → `.message` |
| `look_at_document` | – | `ctl.preview(1024)`; image block, optional via `supportsVision` |

Each tool: `{name, description, parameters: JSON Schema, run(args) → Promise<{text?: string, imagePng?: Buffer, isError?: boolean}>}`. Copy descriptions from `claudePartner.ts` (they are model-neutral prose). Validate args with **zod** (already a dependency) and derive the JSON Schema with `z.toJSONSchema` (zod ^4).

### 4.2 Provider interface (new)

```ts
interface ModelProvider {
  id: string;                       // 'scripted' | 'openai' | 'gemini' | 'openai-compatible'
  supportsVision: boolean;
  complete(req: { system: string; messages: Msg[]; tools: ToolDef[]; signal: AbortSignal }):
    Promise<{ text?: string; toolCalls: Array<{ id: string; name: string; args: unknown }>; usage?: { in: number; out: number } }>;
}
type Msg = { role: 'user' | 'assistant' | 'tool'; text?: string; toolCalls?: ...; toolCallId?: string };
```

Adapters: `ScriptedProvider` (a fixed list of responses; for tests); `OpenAiChatProvider` (`POST {base}/chat/completions` with `tools:[{type:'function',function:{name,description,parameters}}]`, reads `choices[0].message.tool_calls`, replies with `role:'tool'` messages; `base` configurable so any OpenAI-compatible server — local or hosted — works); optional `GeminiProvider` (`functionDeclarations`, `functionCall`/`functionResponse` parts). Key via `vault.withKey('openai'|'gemini', …)`; never log request headers; run all error text through `redact`. **Verify the current request/response field names against the provider's own documentation before coding the real adapter; they are not in this repo.**

### 4.3 Loop (new)

`runAgent({provider, registry, ctl, goal, maxSteps=20, signal, onEvent})`: build system+user messages → repeat { `complete` → if no tool calls: final text, stop → run each call sequentially via registry (catch → error result) → append results → check lock state / abort / step cap } → `finally { ctl.claudeDone() }`. Emit `onEvent` records (`{kind:'model'|'tool'|'result'|'error', …}`) and persist them as a JSON transcript in the project (`Claude/agent-harness-<ts>.json`, via `writeJsonAtomic`) — this is the missing tool-level audit trail.

### 4.4 Proof plan (no paid calls, no installs)

1. **Unit test with `FakeDoc`** (copy from `liveTask.test.ts`): `ScriptedProvider` emits `get_status` → `apply_edit blackWhite` → `save_version` → final text. Assert `doc.ran`, a new library asset exists, lock released (`collab.lockOwner !== 'claude'`), the opened asset is unchanged.
2. **Safety tests:** scripted provider calls `app_command {command:'file.saveAs'}` (no `approveCommand` ⇒ refused, run continues); `ctl.takeControl()` mid-run ⇒ loop stops, no further `doc.run`; unknown tool name ⇒ error result; malformed args ⇒ error result; `maxSteps` reached ⇒ stops and releases lock; abort signal ⇒ releases lock.
3. **Provider adapter test with a stubbed `fetch`** (as `planner/chat.test.ts` does): assert request body shape and tool-call parsing from canned JSON; assert no key in thrown messages.
4. **Optional real-app test** (skipped unless installed, mirrors `headlessApps.test.ts`): `LiveWordCraft` headless on a temp copy of `fixtures/sample-project/quarterly-report.docx` + `ScriptedProvider` replaying `app_command`/`apply_edit replaceText {find:'Sunset Over the Sea', replace:'Evening Tide'}` + `save_version`; assert the saved `.docx` text changed. This proves a non-Claude *loop* controls a real Craft app. Substituting a real remote model for the scripted one is a deliberate, user-approved later step (it spends the user's money).

---

## 5. Smallest set of files to change / add

**New (all under `src/main/agentHarness/`, nothing existing is edited):**

| File | Content |
|---|---|
| `types.ts` | `ModelProvider`, `Msg`, `ToolDef`, `ToolResult`, `AgentEvent` |
| `tools.ts` | `buildToolRegistry({ctl, store}) → ToolDef[]` (§4.1), result truncation |
| `loop.ts` | `runAgent(...)` (§4.3) |
| `providers/scripted.ts` | `ScriptedProvider` |
| `providers/openaiChat.ts` | OpenAI-compatible tool-calling adapter (pure body builder + parser exported for tests; `fetch` injected) |
| `agentHarness.test.ts` (+ `providers/openaiChat.test.ts`) | §4.4 tests |

**Existing files — none required for the prototype.** Needed only to run it inside the app (separate, later milestone):

| File | Edit | Why |
|---|---|---|
| `src/main/ipc.ts` | add `agentHarness` factory next to `claude()` (~l.955) passing `live`, `d.project`, `vault`; one `handle('agent:run', …)` | `live`, `vault` are closure-private |
| `src/shared/ipc.ts`, `src/preload/index.ts` | add `agent:*` channel + `StudioApi.agent` | renderer entry |
| a small panel in `src/renderer/src/components/` | provider/model picker + goal box | UI |
| `src/main/credentialVault.ts` / `ipc.ts` `keyProvider` enum | only if a provider id beyond `openai`/`gemini` is wanted | key entry |

Explicitly **do not edit**: `claudePartner.ts`, `claudeAuth.ts`, `shared/claude.ts`, `liveTask.ts`, `liveApps.ts`, `photocraftLive.ts`, `shared/appCommands.ts`, `shared/photocraftOps.ts`, `shared/appEditors.ts`.

Optional later refactor (separate decision, touches the Claude integration): extract the tool handlers out of `ClaudePartner.tools()` into a shared registry that both `createSdkMcpServer` and the new loop consume, eliminating duplicated descriptions. Not recommended for the prototype.

---

## 6. Limitations and risks affecting a model-independent harness

1. **Tool schema coupling:** schemas live as zod shapes passed to the SDK's `tool()`; they cannot be read back out. The prototype duplicates the ~9 it needs (drift risk; mitigate by copying descriptions verbatim and testing against `EDITOR_APPS`).
2. **Behaviour tuned for Claude:** `SYSTEM_PROMPT` and tool descriptions assume Claude-quality instruction following (e.g. "call get_status first", "look before and after"). Weaker models may loop or hallucinate ids — hence `maxSteps`, argument validation and error-as-data.
3. **Vision:** `look_at_document` returns PNG. Provide a text fallback for non-vision models.
4. **Single global lock/session:** one `LiveTaskController` per project, one open document, one agent at a time. Do not run the Claude panel and the new harness concurrently (`claudeGate` treats `claudeActive` as one owner; both would share it). The harness should refuse to start while `ClaudePartner.state().status==='working'` once wired.
5. **Cost visibility:** `ClaudeState.costUsd` comes from the SDK; other providers report tokens only if the response includes usage. No money meter exists for text LLMs.
6. **Persistence gap:** no tool-call transcript exists today for any model; the harness must create its own.
7. **Composition-root closures:** generation, workflows, export queue, external adapters, planner tools are only reachable from `ipc.ts`; they are intentionally out of the prototype.
8. **Windows-first:** real-app tests run only on Windows with Craft apps installed; the fake-doc tests run everywhere (also in WSL).
9. **Security:** the new network adapter must (a) take the key only through `vault.withKey`, (b) never log bodies/headers, (c) pass thrown text through `redact`, (d) allow only `https` bases except an explicit localhost opt-in, (e) never forward `external_run`/generation tools without their approval dialogs (they are not in the prototype).
10. **Unknowns to verify before coding the real adapter:** the exact tool-calling wire format and current model identifiers of the chosen provider (not discoverable from this repo; model ids in this codebase are app-specific and must not be guessed).

---

## 7. Suggested build order (for the implementing AI)

1. `types.ts`, `providers/scripted.ts`, `tools.ts`, `loop.ts` + the `FakeDoc` tests (§4.4 1–2). Run `npx vitest run src/main/agentHarness` then `npm run check`.
2. `providers/openaiChat.ts` with stubbed-fetch tests (§4.4 3).
3. Optional headless WordCraft test (§4.4 4), `it.skipIf` the CLI is missing.
4. Stop. Report. Wiring into `ipc.ts`/UI and any real remote model run are separate, user-approved steps.

# 02. Planner deep dive

Legend: ✅ works as designed and tested · 🟡 partial · ⛔ present in code but not reachable from the UI · ❓ not verified.
Paths are relative to `creative-studio/`.

## 1. The planner in one paragraph

A project has **one plan** (a `PlannerProject`). The plan holds a brief, "plan items" (idea / reference / question / requirement /
decision), tasks (called **chunks** in the UI), milestones, linked assets, **proposals** (AI suggestions waiting for the owner),
**execution packages** (a frozen brief handed to an AI), **reports** (what an AI says it did), plan versions, and a counter. Everything
an AI produces is data waiting for the owner; only the owner can accept (`need(c,'review')`). The planner does **not** run work: it
prepares text/packages and receives reports. Actually doing the work happens in some other AI (OmniCandy's Claude panel, Claude Code
over MCP, or a chat the user pastes into). See doc 03.

## 2. Component inventory

### 2.1 Pure rules and data model (no Node, no Electron)

| File | Key exports | Responsibility | Notes |
|---|---|---|---|
| `src/shared/planner.ts` (413 lines) | `PlannerProject` (:209), `PlanTask` (:53), `PlanItem` (:24), `PlanAsset` (:76), `Proposal` (:130), `ExecPackage` (:148), `PlanReport` (:187), `PlanVersion` (:207), `ActivityEntry` (:246), `ProjectSummary` (:257); `changeSchema` (:106, the 6 proposal ops), `reportDraftSchema` (:172); `snapshotOf` (:267), `planDrift` (:277), `unmetDependencies` (:293), `wouldCycle` (:297), `isClaimLive` (:310), `progressOf` (:313), `summarize` (:319), `uncoveredChecks` (:329), `canonical` (:334); `PLANNER_TEMPLATES` (:347, 7 templates); `ACTOR_KINDS`, `SCOPES` | The whole vocabulary and the pure rules. ✅ | Task statuses (7): `todo,in_progress,blocked,reported,revision,accepted,cancelled` (:40). Scopes (6): `read,propose,package,execute,edit,review`; connections can only hold the first four (:17). |
| `src/shared/plannerView.ts` (95) | `displayStatus` (:29), `needsYou` (:69), `describeWorkflowRun` (:56), `plainError` (:80), `SIMPLE_STATUSES` | Collapses 7 stored statuses into 5 plain labels (To Do, In Progress, Needs Review, Done, Blocked) and a "stalled" state | ✅ tested (`main/planner/plannerView.test.ts`) |
| `src/shared/plannerContext.ts` (148) | `buildContext` (:69), `upstreamResults` (:52), `planSummary` (:101), `CHUNK_FORMAT` (:122), `brainstormText` (:139), `RULE_BUDGET` (:12), `Delivery` (:19) | Decides which accepted rules go to which destination (chat is budgeted at 6000 chars; tools/createcraft are not) and what upstream finished results a task gets | ✅ `context.test.ts` |
| `src/shared/plannerHandoff.ts` (165) | `packageToMarkdown` (:29), `reportInstructionsFor` (:7), `parseReportText` (:106), `ReportImportPreview` (:58) | Package → Markdown; tolerant parser turning a pasted AI answer (JSON or headed Markdown) into a report draft | ✅ tested in `service.test.ts`/`send.test.ts` |
| `src/shared/plannerPaste.ts` (247) | `parseSuggestionText` (:139), `classifyPaste` (:222), `describeChange` (:235), `changesThePlan` (:247) | Reads a pasted answer as *report*, *suggestions* or *unclear*; renders a change as a sentence | ✅ `fillPlan.test.ts` |
| `src/shared/plannerChat.ts` (95) | `chatSystemPrompt` (:67), `chunkPlan` (:82), `isReady`, `READY_MARK`, `MAKE_PLAN_REQUEST`, `CHAT_PROVIDERS`, limits `MAX_CHAT_MESSAGES=24`, `MAX_CHAT_MESSAGE_CHARS=6000`, `MAX_REPLY_TOKENS=3000` | The planning-chat protocol: the AI ends a message with `[[READY]]` when it understands; the user's "Yes, make the plan" asks for chunks in `CHUNK_FORMAT`; `chunkPlan()` parses that reply (≥2 `add_task` changes) | ✅ `chat.test.ts` |
| `src/shared/plannerSend.ts` (61) | `DESTINATIONS` (:9: `createcraft`, `tools`, `chat`), `sendText` (:36), `redactPaths` (:27), `listPaths`, `lastActive` | The three "who does it" destinations and the text copied for each; removes `C:\...` paths for cloud chats | ✅ `send.test.ts` |
| `src/shared/plannerClients.ts` (40) | `PLANNER_CLIENTS` | Honest status table per AI client (verified / untested / unavailable) | ✅ data |
| `src/shared/plannerApi.ts` (101) | `PlannerApi`, `ProjectPlannerState`, `ProjectFindingsDto`, `PackageView`, `PlannerConnectionInfo` | Typed renderer↔main contract (always "as the user") | ✅ |
| `src/shared/projectPlan.ts` (68) | `PROJECT_KINDS`, `projectPlanSchema`, `parseProjectPlan`, `briefFromPlan` | The **older Home "Create with Claude" plan** (name, kind, finishedOutput, steps ≤8, questions ≤3, template) | ⛔ see 5.2: the producer (`claudePartner.planProject`) is not called by the renderer any more; `PROJECT_KINDS` is still used by Home |

### 2.2 Main-process planner

| File | Key symbols | Responsibility | Persists to |
|---|---|---|---|
| `src/main/planner/store.ts` (160) | `PlannerStore` (:33): `list`, `read` (:74), `create` (:81), `mutate` (:105), `history`, `readChat` (:139), `writeChat` (:146), `saveRaw`, `readRaw`; `PlannerError` (:13), `withLock` (:42) | **The only write path.** Read-modify-write under a lock file; temp+rename atomic write; append-only `history.jsonl`; bumps `revision` always and `planRevision` only when the accepted-plan snapshot changed (and stores that `PlanVersion`) | `<root>/projects/<id>/{project.json, history.jsonl, chat.json, raw/<rep|prop>_*.txt, project.lock}` |
| `src/main/planner/routedStore.ts` (79) | `RoutedPlannerStore` (:17): `setProject`, `dir` (:32), `list`, `projectPlan` (:51), `copyIntoProject` (:61), `PROJECT_PLANNER_FOLDER='Planner'` | Makes the plan live **inside the open OmniCandy project** (`<project>/Planner/...`); falls back to the older shared folder for plans made before that | project folder, else `<userData>/planner` |
| `src/main/planner/dir.ts` (11) | `defaultPlannerDir` | Shared folder resolution for the app **and** the stand-alone MCP server | — |
| `src/main/planner/service.ts` (755) | `PlannerService` (:49); contexts `userCtx` (:22), `connectionCtx` (:24); methods: project (`createProject` :84, `updateProject` :113, `touchTask` :134, `adoptPlan` :146), items (:159-:198), tasks (`addTask` :224, `updateTask` :235, `setTaskStatus` :250, `removeTask` :265), assets (:277-:305), milestones (:315-:325), proposals (`propose` :336, `decideProposal` :356), packages (`createPackage` :462, `prepareSend` :477, `cancelPackage` :495, `getPackage` :508), claims (`claimTask` :516, `releaseClaim` :539, `reportProgress` :549), reports (`submitReport` :589, `importReport` :603, `reviewReport` :663), imports (`createFromHomePlan` :620, `importSuggestions` :645), `exportProject` :692, `importProject` :719, `assetHealth` :747 | **Every rule lives here** and is enforced for the UI and for MCP connections alike | via `PlannerStore.mutate` |
| `src/main/planner/projectPlanner.ts` (81) | `ProjectPlanner` (:14): `sync` (:19), `forProject` (:31), `startPlan` (:42), `analyze` (:53), `applyFindings` (:59), `attachOlder` (:69), `chatContext` (:76) | Ties a plan to the open OmniCandy project: points the store at the project folder before every call, starts a plan, adopts a duplicated project's plan | project folder |
| `src/main/planner/projectContext.ts` (87) | `analyzeProject` (:42) | Read-only scan of the project manifest/exports/workflow/Claude history → plain-language "what's already here" lines, `set_brief` suggestions (goal from `objective`, description from `brief`) and `aiContext` (names and counts only) | none (read-only) |
| `src/main/planner/chat.ts` (100) | `PlannerChat` (:57): `providers`, `models`, `reply`; `textModels`, `openaiChatBody`, `geminiChatBody` | One no-tools chat request to Claude (via `ClaudePartner.planChat`), OpenAI or Gemini. Keys come from the vault per call | none |
| `src/main/planner/ipc.ts` (163) | `createPlanner` (:21), `connectionInfo` (:33), `registerPlannerIpc` (:61), `methods` table (:77-:154), channel `PLANNER_CALL='planner:call'` | Maps 46 named methods onto the service; native dialogs for pick/save/export/import; builds the copy-paste MCP connection snippets | — |
| `src/main/planner/mcp.ts` (134) | `TOOLS` (:20, 11 tools), `McpSession` (:89), `toolsFor`, `actorKindFor`, `SUPPORTED_PROTOCOLS` | Provider-neutral JSON-RPC 2.0 MCP server over the service. **No logic of its own.** Tools: `list_projects, get_project_context, get_changes_since, list_packages, get_package, propose_changes, create_execution_package, claim_task, report_progress, submit_report, release_claim` | — |
| `src/main/planner/mcpMain.ts` (93) | stdio and `--http` (127.0.0.1, bearer token) entry; built to `out/planner-mcp.cjs` | The stand-alone connection external tools start | the shared planner folder |

### 2.3 Renderer planner (`src/renderer/src/planner/`)

| File | Key components | What the user sees |
|---|---|---|
| `PlannerWorkspace.tsx` (268) | `PlannerWorkspace` (:31), `HeaderMenu` (:122), `HistoryPanel` (:146), `PlannerStart` (:159), `Milestones` (:228), `IdeaTab` (:244), `PlanTab` (:260); `TABS` (:15) | Three tabs **Idea / Plan / Work**. Start screen if the project has no plan. "Pick up where I left off" banner. ⋯ menu: What changed, Connect an AI tool, Export, Export with linked files, Import, Open folder, older plans |
| `PlannerChat.tsx` (172) | `PlannerChat` (:58), `ChunkList` (:17) | The Idea conversation, provider/model pickers (Claude / OpenAI / Gemini), "Yes, make the plan", tick-list of chunks → "Add these to my plan" |
| `PlannerWork.tsx` (421) | `TaskForm` (:18), `TaskRow` (:92), `TasksTab` (:135), `ReportCard` (:154), `PastePanel` (:206), `ConnectPanel` (:295), `ProposalCard` (:325), `ReviewInbox` (:354), `pickCurrent` (:376), `CurrentChunk` (:385), `WorkTab` (:410) | Chunk list/editor; the Work tab: "Needs you" inbox, current chunk, "Do this chunk" send panel, "Bring the result back" paste panel |
| `PlannerSend.tsx` (112) | `SendPanel` (:13), `AskPanel` (:104) | Pick who does it (OmniCandy Claude / Claude Code or Gemini CLI / any chat) → "Copy the instructions" (calls `prepareSend`); optional file-path redaction; Unsend |
| `plannerUi.tsx` (73) | `useAction`, `Section`, `StatusChip`, `CopyButton`, `PlainWords` context, `TabId` | Shared bits. `TabId` still lists `'overview' | 'assets' | 'history'` (dead values) |

## 3. How state is managed

* **Source of truth**: `project.json` of the plan, written only through `PlannerStore.mutate` (copy → mutate → write temp → rename).
* **Concurrency**: lock file `project.lock` (create-exclusive; stale after 20 s; up to ~200 retries) so the app and an external MCP process cannot
  clobber each other. Verified in `store.ts:42-61`.
* **Conflicts**: items/tasks/assets carry `rev`; the brief carries `metaRev`; proposals record `baseRev`/`baseMetaRev`; `decideProposal` is
  **all-or-nothing** — if any picked change is stale the whole acceptance is refused (`service.ts:367-373`).
* **Renderer state**: `PlannerWorkspace` keeps `state`, `project`, `tab`, `sendSel`, `focusTaskId`, `panel`; children call `reload()` after each action (`useAction`).
  A 3-second timer polls for external changes (`PlannerWorkspace.tsx:65`). Chat messages are local component state, also saved to `chat.json`
  (`chatSave`) and the provider choice is in `localStorage` (`cs-planner-chat-provider`, `cs-planner-chat-model-*`).
* **History**: `history.jsonl` records `{seq, at, actor, kind, summary, targetId, revision, planAffecting}`; "What changed" reads it.

## 4. The complete user workflow, traced in code

1. **Create a project** — Home (`components/HomeWorkspace.tsx`) `createBlank('idea')` (:56-:67): `window.studio.projects.create` → `projects.open` → `onSwitched(key)` → `planner.startPlan({title})` → `onGoto('planner')`.
   (`startPlan` → `ProjectPlanner.startPlan` → `PlannerService.createProject(..., {ownerProjectId})`, `projectPlanner.ts:42`.) A project can also be created without a plan; the Planner tab then shows `PlannerStart`.
2. **Planner start screen** (only if there is no plan): "Start with an idea" (`startPlan`) or "Look at what is already here" (`analyze` → tick suggestions → `startPlan` + `applyFindings` + `chatSave` seeding the chat with the findings) (`PlannerWorkspace.tsx:159-:208`). Older plans can be brought in (`attachOlder`).
3. **Idea tab**: user chats. Each message → `planner:call chat` → `PlannerChat.reply` → `ClaudePartner.planChat` (Claude), or OpenAI/Gemini through the vault. System prompt = `chatSystemPrompt(plan, projectContext, mode)`; the plan summary (no file paths) and project facts (names, counts) are included.
   Alternative path: "Use ChatGPT, Gemini or another AI instead": copy `brainstormText(p)` out, then paste the answer in (`PastePanel`).
4. **"Ready?"**: AI ends with `[[READY]]` → button "Yes, make the plan" sends `MAKE_PLAN_REQUEST` with `mode:'chunks'` → reply is parsed by `chunkPlan`.
5. **Chunks → plan**: `ChunkList` shows ticks; "Add these to my plan" → `importSuggestions` (creates a pending `Proposal`, source `pasted`, proposer "Planning chat") then immediately `decideProposal(accept, all)` — so the "proposal" step is invisible for this path. `set_brief` changes are tied to `p.metaRev`.
6. **Plan tab**: edit/add/remove chunks (`TaskForm`, `addTask`/`updateTask`/`removeTask`), milestones, "Work on this".
7. **Work tab** (`WorkTab`): `pickCurrent` chooses the chunk (focused → last active → first ready → first open). `SendPanel` with `only=<chunk>`:
   * choose destination; `buildContext` shows how many accepted rules/decisions the AI will see; "Copy the instructions" → `prepareSend` (creates or **re-uses** an identical open package; sets task `packageId`; one open package per task) → text copied (`sendText`).
   * `createcraft` destination → button "Put it in the Claude panel" fires DOM event `createcraft:claude-prefill`, which `ClaudePanel.tsx:52` and `IndependentAgent.tsx:76` listen for (it only fills the input box).
8. **Execution (outside the planner)**: whichever AI receives the text calls `planner_get_package` → `planner_claim` (8 h lease) → works → `planner_report` (MCP names: `get_package`, `claim_task`, `submit_report`). Or the user pastes a report back.
9. **Bring the result back**: `PastePanel` → `classifyPaste` → preview → `importReport` (`status 'submitted'`, task → `reported` when `outcome==='complete'`; partial → `in_progress`; blocked → `blocked`; failed → `todo`).
10. **Review**: `ReviewInbox`/`ReportCard` → `reviewReport(accept | revise | reject)`. Accept requires `outcome==='complete'`; if the accepted plan changed since the package the user must tick an acknowledgement; "Ask for changes" sets `revision`. Only then `task.status='accepted'`; `progressOf` counts only accepted.
    The shortcut "Mark done" (`setTaskStatus 'accepted'`) lets the owner accept with no report at all.

## 5. What works, what is partial, what is unreachable

### 5.1 Works (tests green: 12 files, 112 tests)
✅ Atomic store + lock + history · ✅ revision/drift/conflict rules · ✅ proposal accept/reject with all-or-nothing conflicts · ✅ package create/reuse/cancel/supersede ·
✅ claim/lease/progress/report/review state machine · ✅ MCP tool surface and scope enforcement (`mcp.roundtrip.test.ts`, `mcp.session.test.ts`) · ✅ per-project plan storage and adoption on Duplicate (`projectPlanner.test.ts`, `links.test.ts`) · ✅ paste parsing (`fillPlan.test.ts`) · ✅ planning chat protocol (`chat.test.ts`).

### 5.2 Present in code but not reachable from the UI (⛔)
Measured by listing every `api().<method>` the planner UI calls (`grep` over `src/renderer/src/planner`) against the 46 methods in `main/planner/ipc.ts`:

| Backend capability | Method(s) | UI caller? |
|---|---|---|
| Edit goal/description/scope/constraints/deliverables directly | `update` | **none** (only via a proposal's `set_brief`, e.g. from the chat's chunk plan) |
| Add/edit/answer/remove **plan items** (idea, reference, question, requirement, decision) | `addItem, updateItem, setItemStatus, removeItem` | **none** — items only arrive through accepted proposals (`add_item`) |
| Link **assets/files** to the plan, check them | `addAsset, pickAssets, removeAsset, assetHealth` | **none** (`PlanAsset` has no UI) |
| Create a package by hand; view/save it | `createPackage, packageView, savePackage` | **none** (the Send panel uses `prepareSend`) |
| Create a plan directly / from the Home plan | `create, createFromHomePlan` | **none** |
| Old Home plan generator | `claude.planProject` (preload/IPC exist) | **none in the renderer** (`grep` finds no caller) |

Consequences: requirements and decisions — the things that go into every package as "the rules" — cannot be created or edited by the owner in the current
UI; they can only come from an AI proposal the owner accepts. Plan "assets" never appear in the UI, though `buildPackage` still includes any that exist.
`seedPlanFromGoal` (`main/agentHarness/taskPlan.ts:226`) turns text beginning "Plan the user approved:" into the agent's task plan, but nothing in the
current renderer produces that text.

### 5.3 Partial / fragile (🟡)
* Plan item types, milestones, `appRef`, `parentId` sub-tasks, `expectedOutputs`, `assetIds` exist in the model; only `appRef` (the "Uses" select), `dependsOn` and milestones are editable in `TaskForm`.
* `TaskRow` has two vocabularies; the `!plain` branches (`PlannerWork.tsx` lines ~111-118) are **dead** because `PlannerWorkspace.tsx:90` always provides `PlainWords value={true}`.
* `PlannerStart` / HomeWorkspace log text says "Its Planner is always under More" (`HomeWorkspace.tsx`, `createBlank`, the `else` branch near line 67), but Planner is a top-level tab in both nav modes (`src/shared/navigation.ts`).
* The planning chat for Claude and the Claude panel share one `ClaudePartner` instance and one `status`: `planChat` throws "Claude is busy with another request" if the panel is working (`claudePartner.ts:792`).
* Chat persistence keeps the last 48 messages, 6,000 chars each (`store.ts:142,148`); only 24 are sent per request (`plannerChat.ts:25`).

### 5.4 Not verified (❓)
* A live model-driven round trip (Claude panel actually using `planner_*` tools; Claude Code over MCP). `plannerClients.ts` itself says these were never run live because they cost money.
* `npm run smoke:planner` / `smoke:project-planner` (Electron + Playwright) were not run.

# 03. AI and agent architecture, and how (or whether) a planner task becomes an action

Paths relative to `creative-studio/`. ✅ implemented and tested · 🟡 partial · ❌ not implemented · ❓ not verified.

## 1. There are three separate AI surfaces, not one

| Surface | Used for | Engine | Tools? | Code |
|---|---|---|---|---|
| **A. Planner chat** (Idea tab) | Talk an idea through; produce chunks | Claude (`ClaudePartner.planChat`, Agent SDK, one turn, `tools: []`), OpenAI or Gemini (plain chat completion with a vault key) | **None**. Reads the plan summary and project facts; writes nothing (`main/planner/chat.ts:1-3`) | `src/main/planner/chat.ts`, `src/shared/plannerChat.ts`, `claudePartner.ts:791` |
| **B. "Claude" in the Creative Partner panel** | Do work in the open file / apps; also planner packages | Claude via `@anthropic-ai/claude-agent-sdk` `query()` using the **user's Claude Code sign-in** (or an Anthropic API key, chosen in Settings) | Yes, an in-process MCP server named `createcraft` with 46 named tools in `TOOL_NAMES` (`claudePartner.ts:72`) plus the families defined further down in that file, `permissionMode:'dontAsk'` + explicit `allowedTools`, `maxTurns:300`, `resume: sessionId` | `src/main/claudePartner.ts` (`send` :832), panel `renderer/src/components/ClaudePanel.tsx` |
| **C. Independent AI agent** | Same kinds of work, on OpenAI / Gemini / a local model | Own loop `runAgent` + `ModelProvider` interface | Yes, `ToolRegistry` of native-app, external-program, export and shared tools | `src/main/agentHarness/*`, UI `components/IndependentAgent.tsx` (mounted inside `ClaudePanel` when another engine is picked, `ClaudePanel.tsx:72-82`) |

The three share neither conversation, memory, session store nor task model. Surface A's Claude path and surface B share one `ClaudePartner`
object, one `status` and one `abort` (`claudePartner.ts:150-158`), so a planner chat message fails with "Claude is busy with another request"
while the panel is working (`claudePartner.ts:792`).

## 2. Provider abstraction

* **Planner chat**: `CHAT_PROVIDER_IDS = ['claude','openai','gemini']` (`shared/plannerChat.ts:12`); models listed live from each provider (`chat.ts:70`).
* **Independent agent**: `AGENT_PROVIDER_IDS = ['openai','gemini','local']` (`shared/agentProvider.ts:2`; defaults `gpt-4.1-mini`, `gemini-2.5-flash`; local = loopback OpenAI-compatible URL only). **Claude is not an agent-harness provider.**
  `ModelProvider` (`agentHarness/types.ts:11`): `complete({system, messages, tools, signal}) → {text, toolCalls, usage?}`. Implementations: `providers/openaiCompatible.ts`, `providers/gemini.ts`, `providers/localCompatible.ts`, `providers/scripted.ts` (tests), `providers/retry.ts`.
  `withAgentProvider` (`providerFactory.ts:19`) lends the key from the vault for one call.
* **Keys**: `credentialVault.ts` + `platform/secureStorage.ts` (Electron `safeStorage`); keys never reach the renderer or checkpoints. ✅ (design and tests in `providerFactory`/`checkpoint` tests)

## 3. The agent harness (surface C)

| Concern | Implementation | Status |
|---|---|---|
| Loop | `runAgent` (`agentHarness/loop.ts:71`): model turn → tool calls → results; budgets clamp to `maxTurns` (default 60, max 100) and `maxToolCalls` (default 150, max 250) (`shared/agentBudget.ts`, `executionBudget.ts`) | ✅ |
| Two modes | **Relaxed ("Claude-style")** is the default; **strict verification** (UI checkbox `strictVerification`) adds a task-plan and evidence gate on finishing (`loop.ts:92`, `ipc.ts:1436`) | ✅ |
| Tool registry | `ToolRegistry` (`registry.ts`): name regex, per-call re-validation; `ToolDef.readOnly` host classification | ✅ |
| Tools | native apps (`nativeTools.ts`, `unifiedApplicationTools.ts`), external programs (`externalTools.ts`: `external_apps`, `external_commands`, `external_command`, jobs), export (`exportTools.ts`), and Claude's own handlers re-used via `claude().agentToolDefs(SHARED_CLAUDE_TOOL_NAMES)` (`ipc.ts:1343-1357`) | ✅ |
| Optional families | `toolFamilies.ts:12`: `planner`, `workflow`, `generation`, `local_media` are hidden until the model calls `enable_tools {family}` (token saving). The planner family = `planner_packages, planner_get_package, planner_claim, planner_report, planner_propose` | ✅ |
| Task plan | `taskPlan.ts`: model-written `task_plan` (steps `pending/active/completed/blocked`) + `evidence_receipts` / `evidence_verify` (a step completes only with a passing read-back from this run). **This is a second task model, unrelated to planner tasks.** | ✅ |
| Verification | A mutation (`external_command`, `photocraft_command`, `timeline_*`, non-readback `app_command`) sets "unverified" until a passing `evidence_verify` after it (`loop.ts:37-69`) | ✅ |
| Session persistence | Encrypted per-project checkpoint `.omnicandy-agent-checkpoint.enc` (messages ≤4 MB, plan, provider selection, budget, usage, jobs) (`taskCheckpoint.ts`); a minimal seed is saved before the first model call and the full state when the run pauses or hits a limit (`ipc.ts:1434,1445`); "Continue Task" resumes; checkpoint is **per project, one at a time** | ✅ |
| Crash/uncertain-edit recovery | `editIntentJournal.ts`, `crashRecovery.ts`, `recoveryPresentation.ts`, `recoveryIpcState.ts`: a failed or interrupted write locks further edits until a fresh read-back resolves it | ✅ tested (many `*Recovery*.test.ts`) |
| Background jobs | `jobLedger.ts` stops a resumed task from re-launching a long command whose status is unknown | ✅ |
| Error handling | provider 429/5xx → status `limit` ("Nothing was lost… press Continue Task") (`loop.ts:142`); `failedCalls` guard against repeating an identical failed call | ✅ |
| Human control | `userControlActive` (`loop.ts:27`): the agent will not start or edit while the user holds control, paused, or an approval is pending (`CollabPhase` in `shared/collaboration.ts`: `idle, planning, ready, running, pausing, paused, manual, awaiting_approval, completed, failed, cancelled`) | ✅ |
| Concurrency | Exactly **one** agent task at a time: `active` set + `"Another application task is already running."` (`loop.ts:73`); one checkpoint file per project; a new agent task is also refused while Claude is working (`prepareNewTask`, `ipc.ts:1416-1420`) | ✅ (a limitation, see below) |
| Tokens/cost | Provider-reported usage only ("never estimate", `loop.ts:100`), summed across resumes (`sumUsage`). Claude path: `costUsd` from SDK result messages, shown in the panel; Claude plan usage bars (`planUsage.ts`); paid image/video generation: per-project spend ledger with estimate + limit (`ProjectStore.spending/recordSpend`) | 🟡 three unconnected meters; none per planner task |

## 4. Claude (surface B) specifics

* Session continuity: the SDK `session_id` is kept in memory (`sessionId`); a re-opened project starts a **new** SDK session seeded with `buildResumeContext(items)` (a short summary + last messages) rather than the whole chat (`claudePartner.ts:836`). The visible chat is persisted per project (`ProjectStore.writeClaudeHistory`).
* Project context: Claude gets `cwd = workDir()` and the open file's status through tools (I did not find the manifest `brief`/`objective` being injected into its prompt in `claudePartner.ts`). It has no automatic access to the planner's plan unless it calls `planner_*` (see 6).
* Planner tools in Claude: `planner_packages`, `planner_get_package`, `planner_claim`, `planner_report`, `planner_propose` (`claudePartner.ts:539-569`; all five are in `TOOL_NAMES`, so always available here, unlike surface C). They call one shared `McpSession` created at `src/main/ipc.ts:124` with scopes **`read, propose, execute`** and actor `{kind:'createcraft', name:'OmniCandy Claude'}`; the bridge is `planner.call` at `ipc.ts:1192-1199`.
* Approvals: Claude is not given a blanket permission. Each external-program command asks the user (`ipc.ts:800-808`: Allow once / Allow for this session / Always allow, depending on destructive/untrusted/needed permissions); paid generation asks with a price card (`approvalWindow.ts`, `generation.ts`); saving is "Nothing is saved until you say so" (panel text).

## 5. Multi-agent capability: **not implemented** ❌

* No sub-agents, no delegation tool, no orchestrator, no agent-to-agent messaging, no agent registry, no role definitions. A grep for `subagent|multi-agent|delegate|orchestrat` over `src/` finds only unrelated comments (Unreal's tool-sandbox wording, a code scanner regex).
* What does exist that a multi-agent design could build on:
  1. The planner's `Actor`/`claim` model: several external executors could in principle claim different tasks of one package (`service.ts:516`: one live claim per task, an 8 h lease renewed by progress calls) — designed for external clients (Claude Code via MCP), never exercised with two at once in this code.
  2. `CollabState` lock owner (`user | claude`) for live documents.
  3. `ToolRegistry` snapshots and tool families (a role could be "a registry with a subset").
* Hard single-agent constraints: one `ClaudePartner` status, one harness `active` set, one checkpoint per project.

## 6. How a planner task can become an executable AI action **today**

```
PlanTask (todo)                                   [PlannerService, project.json]
  └─ SendPanel "Copy the instructions" → prepareSend(taskIds, destination)
        builds ExecPackage (frozen accepted plan + task + completion checks + assets + reportInstructions)
        sets task.packageId; text produced by sendText(pkg, title, dest)
  ├─ dest = createcraft → text = one sentence: "Work on the OmniCandy planner brief pkg_… Use planner_get_package … planner_claim … planner_report"
  │        "Put it in the Claude panel" → window event 'createcraft:claude-prefill' → fills the input box (does NOT send)
  │        User presses Send. Claude (B) or the independent agent (C: must first enable_tools planner)
  │        → planner_get_package → planner_claim (task → in_progress, 8 h lease, claimToken)
  │        → does the work with whatever app/external tools it has (these are NOT chosen by the plan)
  │        → planner_report (status 'submitted'; task → reported if outcome complete)
  ├─ dest = tools   → one pasted line for Claude Code / Gemini CLI that use the stand-alone MCP server
  └─ dest = chat    → full Markdown brief copied; user pastes it into ChatGPT/Gemini/etc., pastes the answer back (PastePanel → importReport)
Owner reviews (ReviewInbox) → accept | ask for changes | reject  → task.status 'accepted' etc.
```

Facts about this path:
* The planner **never starts an AI, never calls a tool, never touches a project file** (`PlannerWork.tsx:382` comment; `mcp.ts:5-7`).
* Even with "OmniCandy Claude", a human presses Send; Claude only claims when asked (tool description says "Claim only a task the user asked you to do").
* `PlanTask.appRef` (`native|external|workflow` + note) is only **displayed and written into the package text** (`plannerHandoff.ts:49`), plus a read-only `WorkflowStatus` line for workflow refs. It is not resolved to a tool, a command or an adapter.
* The report's `verification[]` and `changedFiles[]` are **self-reported text by the AI**. They are not wired to the harness's own receipts/evidence (`task_plan` receipts `r1..`, `v1..`), to adapter results with `verified:true`, to saved-version ids, or to library asset ids. `ReportDraft.outputs[].assetId` exists in the schema (`planner.ts:175`) but nothing fills it.
* Dependencies (`dependsOn`) are enforced at send time (`checkSendable`) and claim time, not by any scheduler. "Run the next ready chunk" does not exist.

## 7. Missing connections between planning and execution (verified gaps)

1. **No planner → agent API.** Only a text hand-off via copy or a DOM event; no call that starts a run with a package as input.
2. **Two task models** (planner `PlanTask` vs harness `TaskPlan` steps) with no mapping; progress inside a run does not update the chunk, and a chunk's status does not seed the run (`seedPlanFromGoal` only parses legacy "Plan the user approved:" text).
3. **Evidence is not shared**: harness receipts/verification and adapter `verified` flags are not attached to reports; the owner reviews prose.
4. **No project-file linkage**: reports cannot reference library assets or saved versions (schema field exists, unused); `PlanAsset` has no UI; produced assets are not auto-linked to the task (the only link is `lastActive`).
5. **App targeting**: `appRef` is cosmetic. Nothing translates "uses Blender" into enabled tools or a connected adapter.
6. **Progress/events**: no event stream from a running agent to a chunk; the planner is polled every 3 s and only sees what the AI writes via `planner_report`.
7. **Provider split**: planner chat can use Claude/OpenAI/Gemini; the agent harness only OpenAI/Gemini/local; Claude's tool loop is a separate code path. A "Studio Mode" or "Game Mode" agent roster would have to pick one of these engines per agent.
8. **Concurrency**: one task at a time (harness `active`, Claude `status`, one checkpoint) blocks parallel delegation.
9. **Approval is not planner-aware**: approvals are per external command/paid call, not per chunk or per plan.
10. **Rollback is per app, not per chunk**: see 8.

## 8. Undo, rollback, versioning (what exists)

| Where | Mechanism | Verified |
|---|---|---|
| ArtCraft apps | `undo` tool; `save_version` writes a **new library asset** (originals read-only, `parentId` lineage); "Save as new version" button | ✅ (tests `appEditors.test.ts`, `liveTask.test.ts`) |
| Library | Originals are copied in read-only; derived files get `parentId` (`ProjectStore.addDerivedFile`) | ✅ |
| Workflow graph | `snapshotWorkflow`, `listWorkflowVersions`, `restore` tool (`ProjectStore`, Claude `restore_workflow_version`) | ✅ |
| Blender | steps saved to the project file after each step (live stage text in `SoftwareWorkspace.tsx:35`); batch/script recovery journal | ✅ |
| Unreal | **no undo tool**: `src/main/integrations/adapters/unreal.ts:13` says "There is NO undo tool. Recovery is the user's Ctrl+Z in the editor" | ✅ (comment read) |
| Planner | every plan change is a revision; `planVersions` keep a snapshot per accepted-plan change; history log; no "restore plan version" UI (`planVersions` is read-only data) | ✅ data, ⛔ no restore UI |

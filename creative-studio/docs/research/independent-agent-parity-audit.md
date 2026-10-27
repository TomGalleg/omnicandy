# Independent Agent vs Claude Agent SDK: Parity Audit

Read-only source audit. No code changed, no tests rerun (existing results not re-verified; test status is **Unverified** here).

## 1. Current baseline

- Branch `main`, HEAD `f17d5de` "checkpoint: autonomous recovery engine through R2C3D3".
- Tracked change: `src/main/ipc.ts` (imports `recoveryIpcState`, replaces the inline restore block in `restoreAgent`).
- Untracked, relevant: `src/main/agentHarness/recoveryIpcState.ts` + `.test.ts`, `docs/research/native-command-security-audit.md`, `docs/research/universal-command-schema-audit.md`. The rest is handoff zips, integration test dirs and `WebSite/`.
- **R2C3D4: not committed. Its apparent content (`recoveryIpcState` extraction and IPC wiring) is present in the working tree only.** No commit or doc names "R2C3D4". Whether it is complete or passing is unverified.
- Harness modules (`src/main/agentHarness/`):
  - Loop and safety: `loop.ts` (`runAgent`)
  - Planning and verification: `taskPlan.ts` (`registerTaskPlan`, `task_plan`, `evidence_verify`, `evidence_receipts`)
  - Persistence: `taskCheckpoint.ts` (`TaskCheckpointStore`), `editIntentJournal.ts` (`EditIntentJournal`)
  - Recovery: `crashRecovery.ts` (`restoreRecoveryState`), `recoveryPresentation.ts`, `recoveryIpcState.ts`, `commandPreflight.ts`
  - Tools: `registry.ts`, `nativeTools.ts`, `externalTools.ts`, `unifiedToolRegistry.ts`, `unifiedApplicationTools.ts`, `unifiedProviderRouting.ts`, `optInUnifiedAgent.ts`
  - Providers: `providers/openaiCompatible.ts`, `gemini.ts`, `localCompatible.ts`, `scripted.ts`

## 2. Capability comparison

Claude path: `ClaudePartner` in `claudePartner.ts` (SDK `query()`, `createSdkMcpServer`, `maxTurns: 300`, in-memory `sessionId` resume). Independent path: `runAgent` in `loop.ts`, driven by `IPC.agentRun` and `IPC.agentResume` in `ipc.ts` (~L1228-1314).

| # | Capability | Status | Evidence |
|---|---|---|---|
| 1 | Planning / autonomous execution | **Partial** | Independent has a structured `task_plan` (`registerTaskPlan`) and a completion gate in `runAgent`. Budget is `maxTurns` 20 / `maxToolCalls` 50 by default (`loop.ts` L44-45). `ipc.ts` passes neither, so every run uses these defaults. Claude gets 300 turns. Claude has `plan_workflow` and the workflow engine; the Independent path has none. |
| 2 | Tools / tool-call handling | **Reduced access** | Shared: `get_status`, `list_files`, `open_file`, `new_document`, `look_at_document`, `apply_edit`, `app_commands`, `app_command`, `undo`, `save_version`, `external_apps`, `external_commands`, `external_command`. Claude-only (`TOOL_NAMES`, `claudePartner.ts` L68): `photocraft_command`, `export_file`, `list_export_formats`, `timeline_*`, all `*_workflow` tools, `generate_image`/`generate_video`/`list_*_models`, `make_local_video`, `make_motion_video`, `local_video_status`, `request_model_download`, `external_job`, `integration_builder_*`, `planner_*`. |
| 3 | Project-file / workspace access | **Reduced access** | `list_files`/`open_file` and `new_document` exist (`nativeTools.ts`). Missing: export, import of reference files, and `photocraft_command`. Claude's `workDir` is only a cwd for the SDK, not a file tool surface. |
| 4 | Application command discovery | **Implemented and shared** | `app_commands` (`ctl.appCommandList`, `appendNativeCapabilityInspection`); `external_commands` with `inspectExternalCommand`, `compactParameterHints`. The Independent path adds `preflightExternalParams`. |
| 5 | Editing and result verification | **Implemented and shared** (verification is Independent-only) | Edits go through `ctl.claudeAppCommand` and `IntegrationManager.execute`. `evidence_verify` and `evidence_receipts` are Independent-only and stronger than anything on the Claude path. |
| 6 | Error recovery / safe retries | **Partially implemented** | `runAgent` has `failedCalls`, `classifyCommandError` hints and the `uncertainEdit` lock. The lock releases only when `expectedEditIntent` matches `photocraft.shape.edit.rect` (`editIntentJournal.ts` `expectedRectSchema`). Any other uncertain edit can never auto-resolve, so the task stays blocked. |
| 7 | Checkpoint / session restoration | **Implemented** (Independent stronger) | `TaskCheckpointStore` (encrypted, atomic), `EditIntentJournal`, `restoreRecoveryState`. Claude's `sessionId` is memory-only, with `buildResumeContext` as fallback. Limits: 4 MB cap, then the save is skipped (`save()` returns false). Images dropped. |
| 8 | Manual takeover / resumption | **Implemented and shared** | Both paths go through `LiveTaskController` collab state (`paused()` in `loop.ts`). `IPC.agentResume` requires released control. `IPC.agentPlanUpdate` allows user plan edits while paused. |
| 9 | Native / external app orchestration | **Partial** | `externalTools.ts` L44 rejects `spec.longRunning` ("not supported in this prototype"). There is no `external_job` and no background execution. Claude has `external_run`, `external_job` and the workflow runner. |
| 10 | Model / provider compatibility | **Partial** | `ipc.ts` L1247 and L1286 hard-wire `OpenAICompatibleProvider` to `api.openai.com` and the vault key `'openai'`. `GeminiProvider` and `createLocalModelProvider` exist but are referenced only by their own files. `runOptInUnifiedAgent` and `buildUnifiedApplicationTools` are never called from `ipc.ts`. |
| 11 | Token / context management | **Missing** | `loop.ts` has no use of `reply.usage`, no history trimming and no summarization. `messages` grow every turn until the 4 MB checkpoint ceiling, and tool result text is not size-capped before being appended. Claude gets SDK context management. |
| 12 | Final completion / output verification | **Partial** | The plan gate blocks completion only if a plan exists. If the model never calls `task_plan`, prose alone returns `completed` (`loop.ts` L93). `look_at_document` is optional. No final read-back is required. |

Not covered: live behavior of any capability (no app commands run) and current test pass state. Both are **Unverified**.

**Confirmed missing or partial: 8 of 12** (rows 1, 2, 3, 6, 9, 10, 11, 12).

## 3. Confirmed missing functionality

1. Export and delivery tools (`export_file`, `list_export_formats`) on the Independent path.
2. Long-running and background external commands, and job status/cancel.
3. Provider selection: Gemini and local providers are built and tested but not wired into IPC or the key vault.
4. Context budgeting: token accounting, tool-output caps, history compaction.
5. A completion rule that does not depend on the model choosing to create a plan.
6. Recovery lock resolution for edit types other than the PhotoCraft rectangle.
7. Configurable turn and tool-call budgets (default 20/50 vs Claude's 300 turns).
8. Workflow, timeline, generation, planner and integration-builder tools (many carry cost or approval semantics; see risks).

## 4. Existing components that must be reused

- `runAgent` and its recovery hooks `onEditBegin`, `onEditSettled`, `onRecoveryResolved`. Extend them; do not fork.
- `ToolRegistry` and `tool()`/`validated()` in `registry.ts`, `UnifiedToolRegistry` and `buildUnifiedApplicationTools`.
- `LiveTaskController` for locks, approvals and takeover. No tool may bypass it.
- `IntegrationManager.execute` as the only external backend.
- `TaskCheckpointStore`, `EditIntentJournal`, `restoreRecoveryState` and `recoveryIpcState`.
- `ModelProvider` interface (`types.ts`) and `usage` already returned by `parseResponse`.
- Claude path's existing handlers in `claudePartner.ts` (`export_file`, `external_job`, workflow tools). Share their underlying `this.d.*` dependencies instead of reimplementing them.

## 5. Prioritized backlog

| Pri | Task | Depends on |
|---|---|---|
| P0 | Commit and verify the R2C3D4 working tree (`recoveryIpcState` + `ipc.ts`) as its own change. | none |
| P1 | **Completion gate**: `completed` requires a plan or at least one passing `evidence_verify` for any run that made a mutation. | P0 |
| P2 | **Context management**: cap tool-result text, record `usage`, compact old tool results beyond a threshold while keeping tool-call/result pairing. Keep checkpoints under the 4 MB cap. | none |
| P3 | **Provider wiring**: provider factory in `ipc.ts` for OpenAI, Gemini, local; per-provider vault key and `supportsVision`. Use `buildUnifiedApplicationTools` as the registry source. | P0 |
| P4 | **Budgets**: pass `maxTurns` and `maxToolCalls` from a setting, with a hard upper bound already enforced in `runAgent` (100/250). | none |
| P5 | **Export tools**: read-only `list_export_formats` first, then `export_file`, sharing the Claude path's implementation. | P3 |
| P6 | **External jobs**: lift the `longRunning` rejection by adding `external_job` status/cancel on top of `IntegrationManager`. Journal job starts as mutations. | P0 |
| P7 | **Generalized recovery intents**: `expectedEditIntent` variants for other read-back verifiable commands. | P1 |
| P8 | Remaining tools (timeline, workflow, planner, generation) one family at a time. Paid generation stays human-approved. | P3, P5 |

## 6. Proposed automated tests

All with `ScriptedProvider` and fakes; no network and no paid calls.

- Loop: a mutation followed by prose-only completion with no plan or evidence returns `limit`, not `completed` (P1).
- Loop: 200 KB tool output is truncated before entering `messages`; a long scripted transcript compacts but every `toolCalls` id retains a matching `tool` message (P2).
- Checkpoint: a compacted transcript round-trips through `TaskCheckpointStore` and stays under `MAX_BYTES`.
- IPC: provider factory returns OpenAI/Gemini/local from the setting; a missing key fails before any `onEditBegin` (P3).
- Budget: `ipc` forwards settings; values above the bounds clamp (P4).
- External: a `longRunning` command returns a job id; `external_job` cancel works; a crash mid-job leaves a journal entry that blocks edits until resolved (P6).
- Recovery: a non-rect uncertain edit resolves only with a matching passing `evidence_verify` (P7).
- Takeover: every new tool refuses while `paused()` is true, and returns the `stopText` pattern.
- Regression: the existing `agentHarness`, `crashRecovery`, `recoveryRestoration.integration` and `unifiedToolRegistry` suites must pass unchanged.

## 7. Risks

- **Security:** new tools widen the surface. Each must call through `LiveTaskController` or `IntegrationManager`, keep Zod `.strict()` schemas and go through approval. Do not expose a path or shell tool. Provider wiring adds more keys: the vault `withKey` pattern must remain the only access, and keys must never enter renderer state or checkpoints. Paid generation must keep the human price approval.
- **Manual takeover:** compaction must never drop a stop, pause or denial message, since `loop.ts` treats those as final. Background jobs must stop or pause when the user takes control, and `IPC.agentResume` must still require released control.
- **Backward compatibility:** checkpoint `version: 1` must stay readable. Compaction changes the message shape, so it must happen before saving, not by changing the schema. Tightening the completion gate changes outcomes for existing sessions (some become `limit`). Raising default budgets increases spend on the paid OpenAI path; make it an explicit, bounded setting.
- **R2C3D4:** the uncommitted `ipc.ts` change touches the crash-recovery path. Land it separately before anything else builds on it.

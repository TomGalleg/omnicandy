# 09. Implementation reference map

All paths are relative to `creative-studio/`. **Decision** is my recommendation for a planner redesign that must keep Studio Mode and
Game Mode on one core: **Retain** (leave as is), **Modify** (extend/refactor), **Replace** (rewrite), **Remove** (delete after confirming it is dead).
"Tests" lists files that exercise the item; names only, I ran the planner set (112 tests pass) and the full suite earlier (1,545 pass).
**There are no renderer component tests for the planner** (renderer tests are only `ErrorBoundary.test.ts` and `components/recoveryUiFixture.test.ts`), so
UI changes there are unprotected except by manual use and the Playwright smoke scripts (`scripts/smoke-planner.mjs`, `smoke-project-planner.mjs`; not run).

## 1. Planner core (data, rules, persistence)

| Subsystem | File | Key symbols | Important types | Tests | Impact of redesign | Decision |
|---|---|---|---|---|---|---|
| Plan data model | `src/shared/planner.ts` | `PlannerProject`, `PlanTask`, `PlanItem`, `Proposal`, `ExecPackage`, `PlanReport`, `changeSchema`, `reportDraftSchema`, `snapshotOf`, `planDrift`, `progressOf`, `PLANNER_TEMPLATES` | `TaskStatus`, `ItemType`, `Actor`, `Scope`, `AppRef`, `TaskClaim` | `service.test.ts`, `baseline.test.ts`, `projectPlan.test.ts` (indirect) | Add run/agent linkage (e.g. `PlanTask.run`, report evidence refs, assigned agent), keep statuses/drift rules | **Modify** (additive) |
| Store (only write path) | `src/main/planner/store.ts` | `PlannerStore.mutate/read/create/history/readChat/writeChat`, `withLock`, `PlannerError` | `ActivityEntry`, `LogFn` | `service.test.ts`, `send.test.ts` (two services, one folder), `mcp.roundtrip.test.ts` | Core of reliability; add change notifications (emit after write) instead of polling | **Retain**, **Modify** (emit event) |
| Per-project routing | `src/main/planner/routedStore.ts`, `src/main/planner/dir.ts` | `RoutedPlannerStore`, `setProject`, `copyIntoProject`, `projectPlan`, `defaultPlannerDir` | `ProjectSummary.inThisProject` | `projectPlanner.test.ts`, `links.test.ts` | Drop legacy shared-folder path only after deciding to abandon "older plans" | **Retain** (simplify later) |
| Service (all rules) | `src/main/planner/service.ts` | `PlannerService` (all methods), `userCtx`, `connectionCtx`, `LEASE_MINUTES` | `Ctx`, `TaskInput`, `AssetInput` | `service.test.ts`, `send.test.ts`, `context.test.ts`, `links.test.ts`, `mcp.*.test.ts`, `baseline.test.ts` | Becomes the single backend for both modes; add run orchestration entry points that still pass through `need(c, scope)` | **Retain**, **Modify** |
| Project binding | `src/main/planner/projectPlanner.ts` | `ProjectPlanner.sync/forProject/startPlan/analyze/applyFindings/attachOlder/chatContext` | `OpenProject`, `ProjectPlannerState` | `projectPlanner.test.ts` | Keep; call `sync()` for any new IPC channel | **Retain** |
| Project scan | `src/main/planner/projectContext.ts` | `analyzeProject` | `ProjectFindings` | `projectPlanner.test.ts` | Reuse for "what is in this world/project" views | **Retain** |
| Planner IPC | `src/main/planner/ipc.ts` | `registerPlannerIpc`, `methods` (46), `connectionInfo`, `createPlanner`, `PLANNER_CALL` | `PlannerApi` | none direct | Add typed channels for runs/events; consider splitting the 46-method table | **Modify** |
| Chat provider calls | `src/main/planner/chat.ts` | `PlannerChat.reply/providers/models`, `textModels` | `ChatDeps`, `ChatProviderState` | `chat.test.ts` | Unify with agent provider layer (one provider abstraction) | **Modify** |
| MCP surface | `src/main/planner/mcp.ts`, `mcpMain.ts`, `scripts/build-planner-mcp.mjs` | `TOOLS` (11), `McpSession`, `toolsFor`, stdio/HTTP servers | `ToolDef` | `mcp.roundtrip.test.ts`, `mcp.session.test.ts` | The agent-facing contract; add tools for runs/evidence only with new scopes | **Retain**, **Modify** |

## 2. Planner shared helpers

| Subsystem | File | Key symbols | Tests | Impact | Decision |
|---|---|---|---|---|---|
| Status presentation | `src/shared/plannerView.ts` | `displayStatus`, `needsYou`, `plainError`, `describeWorkflowRun` | `plannerView.test.ts` | Reuse as the view-model for both modes | **Retain**, extend |
| Context for AI | `src/shared/plannerContext.ts` | `buildContext`, `planSummary`, `brainstormText`, `CHUNK_FORMAT`, `RULE_BUDGET` | `context.test.ts` | Keep as how agents get rules | **Retain** |
| Handoff text | `src/shared/plannerHandoff.ts` | `packageToMarkdown`, `parseReportText`, `reportInstructionsFor` | `service.test.ts`, `send.test.ts` | Needed only for external AIs; in-app agents should not need text | **Retain** (for chat/tools destinations) |
| Paste parsing | `src/shared/plannerPaste.ts` | `parseSuggestionText`, `classifyPaste`, `describeChange` | `fillPlan.test.ts`, `chat.test.ts` | Keep for importing external plans | **Retain** |
| Send destinations | `src/shared/plannerSend.ts` | `DESTINATIONS`, `sendText`, `redactPaths` | `send.test.ts` | Collapse to "in-app agent / external" | **Modify** |
| Chat protocol | `src/shared/plannerChat.ts` | `chatSystemPrompt`, `chunkPlan`, `READY_MARK`, `MAKE_PLAN_REQUEST` | `chat.test.ts` | Core of idea → chunks; keep format | **Retain** |
| Client honesty table | `src/shared/plannerClients.ts` | `PLANNER_CLIENTS` | none | Keep pattern | **Retain** |
| Renderer↔main contract | `src/shared/plannerApi.ts` | `PlannerApi`, DTOs | type-check only | Must be updated with any API change | **Modify** |
| Old Home plan | `src/shared/projectPlan.ts` | `PROJECT_KINDS`, `parseProjectPlan`, `briefFromPlan` | `projectPlan.test.ts` | `PROJECT_KINDS` still used by Home; the rest is orphaned | **Modify** (keep kinds), **Remove** rest after check |

## 3. Planner UI (renderer)

| Subsystem | File | Key components | Tests | Impact | Decision |
|---|---|---|---|---|---|
| Planner shell | `src/renderer/src/planner/PlannerWorkspace.tsx` | `PlannerWorkspace`, `PlannerStart`, `HeaderMenu`, `HistoryPanel`, `IdeaTab`, `PlanTab`, `TABS` | none | Studio Mode surface; extract state into a shared hook/store used by both modes | **Replace/Modify** |
| Chat UI | `src/renderer/src/planner/PlannerChat.tsx` | `PlannerChat`, `ChunkList` | none | Merge with the Creative Partner chat model | **Modify** |
| Work UI | `src/renderer/src/planner/PlannerWork.tsx` | `TaskForm`, `TaskRow`, `ReportCard`, `PastePanel`, `ReviewInbox`, `pickCurrent`, `WorkTab`, `ConnectPanel` | none | Largest simplification target; move `pickCurrent`/inbox logic to shared view-model | **Replace** |
| Send UI | `src/renderer/src/planner/PlannerSend.tsx` | `SendPanel`, `AskPanel` | none | Replace with "assign to agent / run" | **Replace** |
| UI helpers | `src/renderer/src/planner/plannerUi.tsx` | `useAction`, `Section`, `StatusChip`, `PlainWords`, `TabId` | none | Drop `PlainWords`, dead `TabId` values | **Modify** |
| Styles | `src/renderer/src/styles.css` (`.pl-*`, 109 rules) | — | none | Reuse tokens (`--accent`, `--surface`…) | **Modify** |
| Home start | `src/renderer/src/components/HomeWorkspace.tsx` | `createBlank('idea')`, `Overview`, template cards | none | Entry into the planner; fix stale "under More" text | **Modify** |
| Navigation | `src/shared/navigation.ts`, `src/renderer/src/components/Header.tsx`, `src/renderer/src/App.tsx` (`go`, `showApp`) | `SIMPLE_NAV`, `ADVANCED_NAV`, `routeWorkspace` | `src/shared/navigation.test.ts` | A mode switch (Studio/Game) belongs above `WorkspaceId` routing | **Modify** |

## 4. Projects and storage

| Subsystem | File | Key symbols | Data types | Tests | Impact | Decision |
|---|---|---|---|---|---|---|
| Registry / lifecycle | `src/main/projects.ts` | `ProjectManager.create/open/rename/remove/duplicate/move/addExisting/relocate/list/setDefaultDir` | `State`, `StorageInfo`, `ProjectSummary` | `src/main/projects.test.ts` | Unchanged; plans already ride Duplicate/Move | **Retain** |
| One project | `src/main/projectStore.ts` | `ProjectStore` (`loadManifest`, `importFile`, `addDerivedFile`, `setMeta`, `readClaudeHistory`, `spending`, workflow versions), `PROJECT_FOLDERS` | `ProjectManifest`, `Asset`, `AssetProvenance` | `src/main/projectStore.test.ts` | Add where run records live (e.g. `Runs/`) | **Modify** (additive) |
| Manifest types | `src/shared/types.ts` | `ProjectManifest`, `Asset`, `WorkspaceId` | — | via store tests | Add fields carefully (zod parse `parseManifest`) | **Modify** |
| Sample project | `src/main/sampleProject.ts` | `ensureSampleProject` | — | `samples.test.ts` | Demo data for the redesign | **Retain** |

## 5. AI and agent execution

| Subsystem | File | Key symbols | Types | Tests | Impact | Decision |
|---|---|---|---|---|---|---|
| Claude (SDK) | `src/main/claudePartner.ts` | `ClaudePartner.send/planChat/agentToolDefs`, `TOOL_NAMES`, `planner_*` tools (:539-569) | `ClaudeState`, `ClaudeChatItem` | `claudeAuth.test.ts`, `claudePartner.auth.test.ts`, `claudePartner.install.test.ts`, `claudePartner.settings.test.ts` | Needs a way to run a chunk with a package as input and to report progress as events; single-instance state is the main obstacle | **Modify** |
| Agent loop | `src/main/agentHarness/loop.ts` | `runAgent`, `hasUnverifiedChanges`, `userControlActive` | `AgentOutcome`, `Message` | `agentHarness.test.ts`, `stabilization.test.ts`, `followUp.test.ts`, `crashRecovery.test.ts` (42 harness test files) | Candidate execution engine for non-Claude agents; single `active` guard blocks parallel agents | **Retain**, **Modify** |
| Providers | `src/main/agentHarness/providerFactory.ts`, `providers/*.ts`, `src/shared/agentProvider.ts` | `withAgentProvider`, `OpenAICompatibleProvider`, `GeminiProvider` | `ModelProvider` | `packageB.providers.test.ts`, `providers/*.test.ts`, `unifiedProviderRouting.test.ts` | Unify with planner chat providers; add Claude as a harness provider if wanted | **Modify** |
| Tools | `src/main/agentHarness/registry.ts`, `nativeTools.ts`, `externalTools.ts`, `exportTools.ts`, `toolFamilies.ts`, `sharedClaudeTools.ts`, `unified*.ts` | `ToolRegistry`, `registerSharedTools`, `OPTIONAL_TOOL_FAMILIES` | `ToolDef`, `ToolResult` | `packageB.tools.test.ts`, `externalTools.test.ts`, `unifiedToolRegistry.test.ts` | Per-chunk tool scoping builds on these | **Retain** |
| Task plan / evidence | `src/main/agentHarness/taskPlan.ts`, `evidencePath.ts`, `nativeReadback.ts` | `registerTaskPlan`, `evidence_verify`, `seedPlanFromGoal` | `TaskPlan`, `ApplicationReceipt`, `EvidenceCheck` | `taskPlan.test.ts`, `evidenceVerify.test.ts`, `seedPlan.test.ts` | Map planner `completionChecks` to evidence checks | **Modify** |
| Persistence / recovery | `taskCheckpoint.ts`, `crashRecovery.ts`, `editIntentJournal.ts`, `jobLedger.ts`, `recoveryIpcState.ts`, `recoveryPresentation.ts` | `TaskCheckpointStore`, `restoreRecoveryState`, `EditIntentJournal`, `AgentJobLedger` | `TaskCheckpoint` | `taskCheckpoint.test.ts`, `crashRecovery.test.ts`, `recoveryRestoration.integration.test.ts`, `uncertainRecovery.test.ts` | Reuse for "resume a chunk run"; per project single checkpoint must become per run | **Modify** |
| IPC wiring | `src/main/ipc.ts` | `buildAgentRegistry` :1343, `runAgentTask` :1413, `restoreAgent` :1369, planner session :123-126, `planner.call` :1192, external approval :800 | — | `src/main/shutdown.test.ts` (partial) | Large file; add runs here or in a new module | **Modify** |
| Agent UI | `src/renderer/src/components/ClaudePanel.tsx`, `IndependentAgent.tsx`, `src/shared/agentHarness.ts`, `agentBudget.ts`, `unifiedAgentPresentation.ts` | `IndependentAgent`, `AgentUiState` | `AgentUiEvent` | `src/shared/agentChat.test.ts`, `unifiedAgentPresentation*.test.ts` | Source of "observe activity" data for either mode | **Modify** |
| Cost | `src/main/planUsage.ts`, `ProjectStore.recordSpend`, harness `usage` | — | `PlanUsage`, `SpendEntry` | `spending.test.ts` | Needs aggregation per chunk/run | **Modify** |

## 6. Integrations and live apps

| Subsystem | File | Key symbols | Tests | Impact | Decision |
|---|---|---|---|---|---|
| Manager | `src/main/integrations/manager.ts`, `sdk.ts`, `connect.ts`, `discovery.ts`, `index.ts` | `IntegrationManager.scan/connect/execute/jobs`, `ExternalAdapter`, `createIntegrationManager` | `integrations.test.ts`, `connect.test.ts`, `discovery.test.ts`, `reliability.test.ts` | Reuse unchanged for real execution | **Retain** |
| Contracts | `src/shared/integrations.ts` | `CommandSpec`, `AdapterManifest`, `Permission`, `IntegrationStatus`, `ExternalAppInfo` | via above | Source of command lists for `appRef` resolution | **Retain** |
| Read-back trust | `src/main/integrations/readback.ts` | `TRUSTED_READBACK_COMMANDS`, `isTrustedReadbackCommand` | `evidenceVerify`, `externalTools.test.ts` | Basis for verified completion checks | **Retain** |
| Adapters | `adapters/blender*.ts`, `resolve*.ts`, `unreal*.ts`, `fusion*.ts`, `vendors.ts` | factories | `blender*.test.ts`, `resolve.test.ts`, `unreal.test.ts`, `fusion.test.ts` (+ `*.live.test.ts` skipped) | Do not change for the planner | **Retain** |
| Native Craft apps | `src/main/liveApps.ts`, `liveTask.ts`, `src/shared/appEditors.ts`, `collaboration.ts`, `live.ts` | `LiveTaskController`, `EDITOR_APPS`, `CollabState` | `liveTask.test.ts`, `appEditors.test.ts`, `collaboration.test.ts`, `liveDrivers.test.ts` | State streams for "real activity" | **Retain** |
| Software tab | `src/renderer/src/components/SoftwareWorkspace.tsx`, `src/shared/softwareList.ts` | `groupInstalls`, `nextStep` | `softwareList.test.ts` | Reusable "status board" | **Retain** |
| Open blank | `src/main/openBlank.ts` | blank-document starters | `openBlank.test.ts` | Quick-start for app-backed chunks | **Retain** |
| Embedded windows | `src/main/embeddedApp.ts`, `windowTracker.ts`, `dockedPanel.ts`, `src/renderer/src/overlay.ts` | `useOverlayOpen` | none found | Constrains any full-screen/canvas UI | **Retain** |

## 7. Not planner, but a redesign may touch

| Item | File | Why |
|---|---|---|
| Workflow engine and editor | `src/main/ipc.ts` (run control), `src/renderer/src/components/WorkflowEditor.tsx`, `src/shared/workflow*.ts` | `appRef.kind==='workflow'` already points at a project's workflow; read-only status in the planner |
| Generation (paid) | `src/main/generation.ts`, `videoApis.ts`, `studioJobs.ts` | Approval and spending; cost attribution |
| Settings/keys | `src/renderer/src/components/SettingsDialog.tsx`, `src/main/credentialVault.ts` | Where provider keys live |
| Theme | `src/renderer/src/useAppearance.ts`, `src/shared/theme.ts` | CSS variables for both modes |

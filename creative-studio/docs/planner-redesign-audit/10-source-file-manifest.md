# 10. Source file manifest for ChatGPT

All paths relative to `creative-studio/`. Line counts are from `wc -l`. Read in the order given inside each tier.
Tier 1 is roughly **6,000 lines** if the `ipc.ts` ranges are read selectively; it is deliberately the smallest set that lets someone redesign the planner without guessing.

## Tier 1: Essential (read all of these before directing any implementation)

| # | File | Lines | Why it matters |
|---|---|---|---|
| 1 | `src/shared/planner.ts` | 413 | The entire data model and pure rules: task statuses, proposals, packages, reports, drift, scopes, templates. Everything else hangs off these types. |
| 2 | `src/main/planner/service.ts` | 755 | Every business rule (accept/propose/package/claim/report/review, conflicts, export/import). Both UI and MCP go through it. A redesign adds to this file, not around it. |
| 3 | `src/main/planner/store.ts` | 160 | The only write path: lock file, atomic write, revisions, history, chat persistence. Defines reliability. |
| 4 | `src/main/planner/routedStore.ts` | 79 | Per-project plan location and the legacy shared folder. Needed to understand where a plan lives. |
| 5 | `src/main/planner/projectPlanner.ts` | 81 | Binds a plan to the open OmniCandy project (`sync`, `startPlan`, `analyze`). |
| 6 | `src/main/planner/ipc.ts` | 163 | The 46-method renderer API, native dialogs, MCP connection snippets. Shows exactly what the UI can and cannot do. |
| 7 | `src/shared/plannerApi.ts` | 101 | Typed contract between the planner UI and main. |
| 8 | `src/main/planner/mcp.ts` | 134 | The agent-facing tool contract (11 tools, scopes). The natural seam for delegation. |
| 9 | `src/renderer/src/planner/PlannerWorkspace.tsx` | 268 | Current Idea / Plan / Work shell, start screen, polling. |
| 10 | `src/renderer/src/planner/PlannerWork.tsx` | 421 | Chunk editing, review inbox, send/paste flow, `pickCurrent`: the most complex UI and the main simplification target. |
| 11 | `src/renderer/src/planner/PlannerChat.tsx` | 172 | The planning conversation and `[[READY]]` → chunk list → plan protocol. |
| 12 | `src/renderer/src/planner/PlannerSend.tsx` | 112 | How a chunk is "sent": proves that nothing is executed by the planner. |
| 13 | `src/shared/plannerChat.ts` | 95 | Chat prompt, limits and the chunk parser. |
| 14 | `src/shared/plannerSend.ts` | 61 | Destinations and text produced for each. |
| 15 | `src/shared/plannerContext.ts` | 148 | Which rules/results an AI receives; `CHUNK_FORMAT`. |
| 16 | `src/shared/plannerHandoff.ts` | 165 | Package → Markdown and report parsing. |
| 17 | `src/shared/plannerPaste.ts` | 247 | How outside AI answers are read (used for importing external plans). |
| 18 | `src/shared/plannerView.ts` | 95 | Status labels and "needs you" rules. |
| 19 | `src/main/projects.ts` | 362 | Project registry and lifecycle (create/open/duplicate/move). |
| 20 | `src/main/projectStore.ts` | 425 | One project's manifest, assets, history, spending, folders. |
| 21 | `src/shared/types.ts` | 117 | `ProjectManifest`, `Asset`, `WorkspaceId`. |
| 22 | `src/main/agentHarness/loop.ts` | 286 | The only autonomous execution loop in the app, with the verification gate and takeover rules. |
| 23 | `src/main/claudePartner.ts` | 894 | Claude's chat/tools; the `planner_*` tools (lines 539-569), `planChat` (791), `send` (832). |
| 24 | `src/main/ipc.ts` (lines 120-130, 800-830, 1185-1200, 1329-1500) | 1,788 total | Where the planner session is created, external approvals are asked, `planner.call` bridges Claude to the planner, and the agent run/resume is wired. Read those ranges; the rest is unrelated handlers. |

## Tier 2: Important

| File | Lines | Why |
|---|---|---|
| `src/main/agentHarness/types.ts` | 15 | `ModelProvider`, `ToolDef`, `Message`, `AgentOutcome`: the provider/tool contract. |
| `src/main/agentHarness/registry.ts` | 48 | `ToolRegistry` snapshotting and validation. |
| `src/main/agentHarness/toolFamilies.ts` | 85 | Optional tool families (`planner` is one) and `enable_tools`. |
| `src/main/agentHarness/sharedClaudeTools.ts` | 22 | Which Claude tools the harness reuses. |
| `src/main/agentHarness/providerFactory.ts` + `providers/openaiCompatible.ts`, `gemini.ts`, `localCompatible.ts` | 50 + 62 / 86 / 10 | Provider abstraction and key lending. |
| `src/shared/agentProvider.ts`, `src/shared/agentBudget.ts`, `src/main/agentHarness/executionBudget.ts` | 33 / 19 / 15 | Providers and budgets (60 turns / 150 calls defaults). |
| `src/main/agentHarness/taskPlan.ts` | 233 | The harness's own task plan, evidence receipts, `seedPlanFromGoal`. |
| `src/main/agentHarness/taskCheckpoint.ts`, `crashRecovery.ts`, `editIntentJournal.ts`, `jobLedger.ts` | 76 / 52 / 101 / 59 | Persistence and recovery of an agent run. |
| `src/main/agentHarness/externalTools.ts`, `nativeTools.ts`, `unifiedApplicationTools.ts` | 236 / 73 / 28 | What an agent can do to apps. |
| `src/shared/agentHarness.ts` | 37 | UI state shape for the agent (`AgentUiState`). |
| `src/main/integrations/manager.ts` | 537 | Command execution, permissions, jobs, audit. |
| `src/main/integrations/sdk.ts` | 115 | Adapter contract and manifest validation. |
| `src/shared/integrations.ts` | 366 | `CommandSpec`, `Permission`, `IntegrationStatus`, `ExternalAppInfo`. |
| `src/main/integrations/readback.ts` | 42 | Which read-backs the host trusts as evidence. |
| `src/main/integrations/adapters/blender.ts`, `unreal.ts`, `fusion.ts`, `resolve.ts` (headers and manifests only) | large | Real capabilities and limits; read the top comments and `manifest` blocks. |
| `src/main/liveTask.ts`, `src/main/liveApps.ts`, `src/shared/appEditors.ts`, `src/shared/collaboration.ts`, `src/shared/live.ts` | 656 / 1,444 / 665 / 189 / 52 | Native Craft apps and the pause / takeover state machine. |
| `src/shared/ipc.ts`, `src/preload/index.ts` | 647 / 306 | The full renderer↔main surface; how the planner API is exposed. |
| `src/renderer/src/App.tsx`, `components/Header.tsx`, `components/Workspaces.tsx`, `src/shared/navigation.ts` | 327 / 75 / 160 / 57 | Navigation, mode switching, where a second mode would attach. |
| `src/renderer/src/components/ClaudePanel.tsx`, `IndependentAgent.tsx` | 189 / 193 | The existing agent interaction UI (three chat surfaces, doc 06). |
| `src/renderer/src/components/HomeWorkspace.tsx` | 353 | Project creation / entry into the planner. |
| `src/renderer/src/components/SoftwareWorkspace.tsx`, `src/shared/softwareList.ts` | 160 / 42 | Existing status board of connected programs. |
| `src/renderer/src/useLive.ts`, `useAppearance.ts` | 44 / 42 | Live-state hook and theme application. |
| `src/main/planner/projectContext.ts`, `chat.ts`, `mcpMain.ts` | 87 / 100 / 93 | Project scan, chat provider calls, stand-alone MCP entry. |
| `src/main/index.ts` | 169 | App bootstrap, user-data paths, registry wiring. |

## Tier 3: Supporting

| File / area | Why |
|---|---|
| `src/main/planner/*.test.ts` (11 files, 112 tests), `src/main/planner/__fixtures__/*.json` | Executable specification of every planner rule: `service.test.ts` (round trip), `send.test.ts` (package reuse, concurrency), `mcp.roundtrip.test.ts` (real processes), `projectPlanner.test.ts` (project binding), `context.test.ts`, `chat.test.ts`, `fillPlan.test.ts`, `links.test.ts`, `plannerView.test.ts`, `baseline.test.ts`. |
| `src/main/agentHarness/*.test.ts` (42 files) | Behavioural contract of the agent loop, recovery, tools, providers. Skim names; open `agentHarness.test.ts`, `taskPlan.test.ts`, `crashRecovery.test.ts`. |
| `src/main/projects.test.ts`, `projectStore.test.ts` | Project lifecycle guarantees. |
| `src/shared/navigation.test.ts`, `softwareList.test.ts`, `collaboration.test.ts` | Navigation and state-machine contracts. |
| `src/renderer/src/styles.css` (841), `components/aiStudio.css`, `aiStudioWorkspace.css`, `quickAi.css`, `sampleMedia.css`, `src/shared/theme.ts` | Styling system; planner rules are the `.pl-*` block starting near line 639. |
| `package.json`, `electron.vite.config.ts`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts`, `eslint.config.mjs` | Build, alias (`@shared`), lint and test configuration. |
| `scripts/build-planner-mcp.mjs`, `scripts/smoke-planner.mjs`, `scripts/smoke-project-planner.mjs` | How the MCP bundle is built and how the planner is smoke-tested (not run in this audit). |
| `CLAUDE.md`, `docs/architecture.md`, `docs/project-planner.md`, `docs/planner-explained.md`, `docs/planner-simplification-plan.md` | Intent and history. **Verify against code**: the simplification doc describes 6 tabs; the app has 3. |
| `docs/integration-audit.md` (repo root `docs/`) and `docs/external-integration-sdk.md` | Integration background. |
| `CURRENT_PROGRESS.md` | Status snapshot (not used as a source here). |

## What to give ChatGPT first (suggested bundle, in this order)

1. `docs/planner-redesign-audit/00-START-HERE.md` and `09-implementation-reference-map.md`
2. `src/shared/planner.ts`, `src/main/planner/service.ts`, `src/main/planner/store.ts`
3. `src/main/planner/ipc.ts`, `src/shared/plannerApi.ts`, `src/main/planner/mcp.ts`
4. `src/renderer/src/planner/PlannerWorkspace.tsx`, `PlannerWork.tsx`, `PlannerChat.tsx`, `PlannerSend.tsx`
5. `src/main/agentHarness/loop.ts`, `types.ts`, `toolFamilies.ts`, and the ranges listed for `src/main/ipc.ts`
6. `docs/planner-redesign-audit/03-agent-and-execution.md` and `07-problems-and-opportunities.md`

Files that are **not** worth sending: anything under `build-source/`, `release/`, `out/`, `node_modules/`, the `*.zip` handoff files in `creative-studio/`, and `docs/research/`.

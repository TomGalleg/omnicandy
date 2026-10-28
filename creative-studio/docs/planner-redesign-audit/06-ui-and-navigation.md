# 06. Current user interface and navigation

Paths relative to `creative-studio/`. Facts from source; no screenshots were taken in this audit.

## 1. Window layout (`src/renderer/src/App.tsx`, 327 lines)

```
┌ Header (components/Header.tsx) ─ brand · Project: <name> ▾ · NAV TABS · Simplified/Advanced · Settings ┐
├────────────┬──────────────────────────────────────────────┬───────────────┤
│ LEFT dock  │ CENTER: <WorkspaceView> (one workspace)      │ RIGHT dock    │
│ "Media"    │                                              │ "Creative     │
│ AssetBrowser├─────────────────────────────────────────────┤  Partner"     │
│ (library)  │ BOTTOM: BottomPanel (timeline or activity log)│ ClaudePanel   │
└────────────┴──────────────────────────────────────────────┴───────────────┘
```
Docks use `react-resizable-panels` (`Group/Panel/Separator`, layout persisted via `useDefaultLayout`, `useDock`, `useBottom`; shortcuts Ctrl+Shift+M media, Ctrl+Shift+C partner).
The **Creative Partner dock is always mounted** (hidden when collapsed), so its event listeners (e.g. `createcraft:claude-prefill`) work while it is closed.
There is also a pop-out panel app (`PanelApp.tsx`) for a live app's controls.

## 2. Navigation (`src/shared/navigation.ts`; renders in `Header.tsx`)

| Mode (default Simplified) | Tabs |
|---|---|
| Advanced (`ADVANCED_NAV`) | Home · Media · Edit · AI Generate · Software · Planner · Deliver |
| Simplified (`SIMPLE_NAV`) | Project · Edit · AI Generate · Software · Planner · Deliver · More▾ (More = Media, from `MORE_NAV`) |

* `WorkspaceId` (`src/shared/types.ts:104`) still has 11 ids: `home, media, edit, generate, workflow, effects, color, audio, deliver, planner, software`.
  `workflow` is hidden (`HIDDEN_WORKSPACES`); `effects/color/audio` are legacy ids that `routeWorkspace()` (`navigation.ts`) sends into Edit modes (`EditMode`).
* `App.tsx` `go()` / `showApp()` are the only places that switch workspaces; the saved "where I was" (`ProjectManifest.view`) and Claude's "open this file" events go through them.
* The Planner is a **top-level tab in both modes** (`PlannerWorkspace`, `Workspaces.tsx`). The hidden `workflow` workspace is a node editor (`WorkflowEditor.tsx`, `@xyflow/react`); it has no tab (any request for it lands on Home), but its engine is live (Claude tools `run_workflow`, `workflow_status` etc. in `toolFamilies.ts`; workflow templates on Home).

## 3. Screens and where the logic is

| Screen | Component | Size | Business logic location | Notes |
|---|---|---|---|---|
| Home / Project | `HomeWorkspace.tsx` | 353 | `window.studio.projects.*`, `planner.startPlan`; template/workflow starters | Project list, create (blank / "idea" which starts the Planner / from template), overview checklist; stale log text about Planner "under More" |
| Media | `MediaWorkspace` in `Workspaces.tsx` | ~100 | `importFiles.ts`, `appsForFormat` | Library list with "Open in <app>" buttons per file type |
| Edit | `EditWorkspace.tsx` | ~200 | `appEditors.ts` (`appForTab`, `modesFor`), `useLive` | Embeds the live ArtCraft app; `Edit | Color | Effects` strip; "Open with" for PDFs; 3D model card → Software |
| AI Generate | `GenerateHub.tsx` → `AiStudio.tsx` (233), `CreateWorkspace.tsx` (375), `GenerateWorkspace.tsx` (206), `ModelGallery.tsx`, `HiggsfieldForm.tsx`, `LocalAiPanel.tsx`, `VideoPanel.tsx`, `MotionPanel.tsx`, `ProvidersCard.tsx` | big | main: `generation.ts`, `imageApis.ts`, `videoApis.ts`, `higgsfield.ts`, `studioJobs.ts`, spending ledger | Paid calls always show an approval card with price |
| Software | `SoftwareWorkspace.tsx` | 160 | `window.studio.external.*`, `launchApp`; pure helpers `shared/softwareList.ts` | ArtCraft app list + external programs list with Connect / Open in OmniCandy / Next steps |
| **Planner** | `planner/PlannerWorkspace.tsx` (+ `PlannerChat`, `PlannerWork`, `PlannerSend`, `plannerUi`) | ~1,050 total | `src/main/planner/*` via one IPC channel; pure rules in `src/shared/planner*.ts` | See doc 02. Good separation: components render and call `api()`, rules are in shared/service |
| Deliver | `DeliverWorkspace.tsx` | 197 | `main/deliver.ts`, `shared/deliver.ts` (presets) | Export presets per file kind |
| Creative Partner | `ClaudePanel.tsx` (189) → `IndependentAgent.tsx` (193), `ClaudeAuthCard.tsx` | | `claudePartner.ts`, `agentHarness/*` | One panel, engine selector at top: "Claude (Claude Code)" or OpenAI / Gemini / Local |
| Bottom | `BottomPanel.tsx` (185) + `Waveform.tsx` | | `useLive`, app log | Timeline for video/audio while editing; otherwise an activity log |
| Settings | `SettingsDialog.tsx`, `ProvidersCard.tsx`, `ClaudeAuthCard.tsx`, `IntegrationPackages.tsx`, `connect/*` | | `credentialVault`, `settingsStore`, `connect.ts` | Keys, theme, connectors |
| Build integration | `BuildPanel.tsx`, `builder/*` | | `integrations/builder/*` | AI-written connector flow |

## 4. Planner UI, as it is organised

* `PlannerWorkspace` (state owner) → `PlannerStart` (no plan yet) or the three-tab body `IdeaTab` / `PlanTab` / `WorkTab` plus the ⋯ menu and the history/connect panels.
* All planner state is local React state; updates come from user actions (`useAction` → call → `reload()`) and the 3 s poll. No planner events from main.
* Style classes: `.pl-*` (109 rules) in the shared `styles.css`; they use the app's CSS variables (`--bg`, `--surface`, `--text`, `--accent`, `--border`, `--radius-sm`…).
* Terminology: the UI says **chunk** for `PlanTask`, **Idea/Plan/Work** for the three tabs, "Needs you" for review inbox, "Do this chunk" for the send panel. The data model and MCP use *task*, *package*, *claim*, *report*, *proposal*.

## 5. AI chat interfaces (three, all different)

1. Planner chat (`PlannerChat.tsx`): per-plan, no tools; provider/model chosen in the component; history in `chat.json`.
2. Claude panel chat (`ClaudePanel.tsx`): per project, with tools and live activity messages ("Claude is working…"); history in `Claude/conversation.json`; Pause/Take Control controls for the live document.
3. Independent agent (`IndependentAgent.tsx`): a "task + chat" panel with plan steps editable when paused/limited, budget (max turns/tool calls), "strict verification", recovery panel and presentation (`shared/unifiedAgentPresentation.ts`, `shared/agentHarness.ts`).
Any "agent interaction component" a Game Mode needs (talking to an agent, delegating, observing) would have to choose among these three; they share no components or message model.

## 6. Theme and styling

* `src/renderer/src/styles.css` (841 lines) is the global stylesheet; extra CSS files: `components/aiStudio.css`, `aiStudioWorkspace.css`, `quickAi.css`, `sampleMedia.css`.
* Theme: `useAppearance.ts` + `src/shared/theme.ts` (`PALETTES`, `resolveTheme`, `accentForeground`): sets `data-theme`, `data-scheme` and CSS custom properties on `<html>`; user accent colour; modes system/dark/light; "ArtCraft" vs "studioDark" dark variants; optional sync of the open ArtCraft app's theme (`live.appTheme`).
* No component library, no CSS-in-JS, no Tailwind; plain CSS classes + a few inline styles.

## 7. Existing animation / canvas / visual technology (inventory)

| Technology | Where | Relevance to a game-like mode |
|---|---|---|
| CSS `@keyframes` (spin, sheen, bob, progress, node-pulse, slide) | `aiStudio.css:35`, `aiStudioWorkspace.css:36,100`, `styles.css:464,521,809` | Only simple effects |
| SVG | `Waveform.tsx:46` (waveform) | minimal |
| `@xyflow/react` node graph | `WorkflowEditor.tsx` (`.node-pulse` highlights a running node) | A ready node/edge canvas with zoom/pan; already themed; could host an "agents and tasks" map |
| `<canvas>`, WebGL, three.js, game engine, sprite/tween library | **none found** | A Game Mode would add a new dependency or use DOM/SVG/xyflow |
| Embedded native windows (ArtCraft apps, Blender, Unreal…) | `embeddedApp.ts`, `windowTracker.ts` (native child windows laid over a placeholder `div`) | Native windows are drawn *over* the web page: any overlay UI (modals, game HUD) must hide them (`useOverlayOpen()`, `overlay.ts`), as `EditWorkspace`/`SoftwareWorkspace` already do |

## 8. Where a second interface could attach without duplicating business logic

Already shared, UI-agnostic (keep and reuse):
1. `src/shared/planner*.ts` — pure rules, types, parsers, text builders, view helpers (`displayStatus`, `needsYou`, `progressOf`, `buildContext`).
2. `PlannerService` + `PlannerStore` (main) — every rule, scope check and conflict check. Any UI must call it through `planner:call` (or a new typed channel) as the user.
3. The MCP tool list (`TOOLS`) — an agent-facing contract that already separates `read / propose / package / execute`.
4. Live state streams (`LiveSnapshot`, `ExternalLiveState`, `AgentUiState`, `ClaudeState`) — "observe real activity" data already exists as push events.
5. Approval functions (`approvalWindow.ts`, external approval dialog) — human-in-the-loop for real actions.

Not shared / would be duplicated by a second UI today:
1. The three AI chat surfaces (5 above) and their separate state.
2. Planner view-model logic embedded in components: `pickCurrent` (`PlannerWork.tsx:376`), the "needs you" assembly (`ReviewInbox`), send-flow state (`SendPanel`), `PlannerStart` flow, `PlannerChat`'s ready/chunks protocol handling — all in React components, not in a reusable hook/module.
3. Polling in `PlannerWorkspace` (no subscription API); a second UI would add a second poller.
4. Navigation is a single `WorkspaceId` switch in `App.tsx`; the planner tab owns its own sub-navigation.

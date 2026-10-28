# 04. Project management and storage

Paths relative to `creative-studio/`. ✅ read and consistent with tests · ❓ not verified at runtime.

## 1. Two different things are both called "project"

| | OmniCandy **project** | Planner **plan** (`PlannerProject`, ids `plan_…`) |
|---|---|---|
| Type | `ProjectManifest` (`src/shared/types.ts:48`) in `<project>/project.json` | `PlannerProject` (`src/shared/planner.ts:209`) in `<project>/Planner/projects/<planId>/project.json` |
| Key / id | registry key `p-xxxxxxxx` (or `sample-project`), manifest `id` = random UUID | `plan_` + 10 hex chars; `ownerProjectId` = the manifest `id` |
| Written by | `ProjectStore` (`src/main/projectStore.ts`), atomic temp+rename with a per-file write queue (`writeJsonAtomic`) | `PlannerStore.mutate` (`src/main/planner/store.ts:105`), lock file + atomic write |
| Cardinality | many, one **open** at a time | exactly one plan per project is the intended rule (`startPlan` refuses a second: `projectPlanner.ts:44`); older plans from the shared folder can be copied in |

Do not confuse the Planner's `title/goal` with the manifest's `name/brief/objective`: they are separate fields. The only automatic bridge is the
Planner's "Look at what is already here" scan, which proposes `set_brief` changes from the manifest's `objective` (→ goal) and `brief` (→ description)
(`projectContext.ts:73-76`).

## 2. How OmniCandy projects are created, opened, saved, closed

`ProjectManager` (`src/main/projects.ts:83`), registry file `<userData>/projects.json` (`State`: `current`, `recent[≤20]`, `defaultDir`, `locations{key→dir}`, `order`).

| Action | Function | Behaviour |
|---|---|---|
| First run / nothing remembered | `current()` :133 | Creates/uses the **Sample Project** (`ensureSampleProject`, `sampleProject.ts`), key `sample-project` |
| Create | `create(name, parentDir?, meta?)` :219 | Key `p-<8 hex>`. With no folder chosen: `<userData>/projects/<key>`. With a default or chosen parent: `<parent>/<folderNameFor(name)>` (numbered if taken) recorded in `locations`. Creates the layout-2 folders (`PROJECT_FOLDERS`, `projectStore.ts:51`: `Assets/{Originals,Generated,Audio,Video,Documents,Models}`, one folder per ArtCraft app, `Workflows`, `Previews`, `Versions`, `Exports`, `Checkpoints`), writes `project.json`, an empty workflow. `meta` = `{kind, brief, objective}` |
| Choose a directory | `checkWritableFolder` :37 (write-probe), `setDefaultDir` :352, `storageInfo` :337 (free/total bytes) | Changing the default never moves existing projects |
| Open | `open(key)` :209 | Swaps the single in-memory `ProjectStore`; updates `current` and `recent` |
| "Save" | There is no explicit save. Every `ProjectStore` mutation persists the manifest; "Save as new version" writes a new asset | ✅ |
| Close | No close concept: switching projects *is* closing. The renderer resets per-project UI (`PlannerWorkspace` `useEffect` on `projectKey`, `WorkspaceView key={projectKey}`) | ✅ |
| Rename / remove | `rename` :241; `remove` :248 sends the folder to the Recycle Bin via injected `trash`; refuses the open project and the sample | ✅ |
| Register existing folder | `addExisting(dir)` :262 (needs a `project.json`; refuses a duplicate identity) | ✅ |
| Missing drive | `list()` keeps a registered-but-missing project with `missing:true`; `relocate(key, dir)` :278 | ✅ |
| Duplicate | `duplicate(key, parentDir?)` :287: `copyVerified` (size + SHA-256 of every file), new key, `regenerateIdentity` (new manifest UUID and name "… copy") | ✅ copies the whole tree **including `Planner/`, `Claude/`, and the encrypted agent checkpoint** |
| Move | `move(key, parentDir)` :312: copy+verify under `*.moving`, rename, then Recycle Bin the old | ✅ |
| Order in lists | `setOrder` :202; otherwise open first then most recent | ✅ |

Manifest fields that matter to planning (`types.ts:48-65`): `schemaVersion:1`, `layout?:2`, `id`, `name`, `createdAt`, `updatedAt`, `assets[]`, `kind?`, `brief?`, `objective?`,
`view?: {workspace, assetId?}`. `Asset` (`types.ts:29`): `id, name, kind, relPath, sha256, bytes, sourceFormat, width/height/durationSec, rating, approval('none'|'approved'|'rejected'), provenance{origin,source,prompt,provider,model,createdAt,estimatedCostUsd,requestedBy,referenceAssetIds,role,originalPath}, parentId`.
`AssetKind` = image, video, audio, vector, design, project, document, sheet, deck, ui, cad, model.

## 3. How plans connect to projects

* `RoutedPlannerStore` (`src/main/planner/routedStore.ts:17`) keeps `current = {root: <project>/Planner, ownerId: manifest.id}`. `ProjectPlanner.sync()` (`projectPlanner.ts:19`)
  re-points it **before every planner IPC call** (`ipc.ts:160`) — so "which project is open" is read fresh each time, not cached by the planner.
* Lookup rule for a plan id (`routedStore.ts:32`): the open project's `Planner/projects/<id>` first, then the shared folder `<userData>/planner/projects/<id>`, otherwise where a *new* plan would go (the open project).
* A plan copied by **Duplicate** keeps the old `ownerProjectId`; `ProjectPlanner.forProject` notices (`plan.ownerProjectId !== cur.id`) and calls `adoptPlan` (`service.ts:146`) to re-own it. ✅ (`projectPlanner.test.ts`)
* Older plans made before this design stay in the shared folder; `copyIntoProject` (`routedStore.ts:61`) copies a folder (minus `project.lock`), sets `importedFrom` and `ownerProjectId`; the original is untouched. A project that already has a plan refuses (`conflict`).
* The stand-alone MCP server (`mcpMain.ts`) is pointed at **one folder** with `--dir` / `CREATECRAFT_PLANNER_DIR`; `connectionInfo()` (`planner/ipc.ts:33`) hands out the open project's `Planner` folder when one is open (`d.store.projectRoot ?? d.dir`, `ipc.ts:152`). So an external executor's connection is **bound to the project that was open when the snippet was generated**; opening another project does not move it. (Behaviour read from code; ❓ not exercised live.)

## 4. Planner storage layout and rules

```
<project>/Planner/projects/<planId>/
  project.json     entire plan state (PlannerProject) — only written through PlannerStore.mutate
  history.jsonl    one JSON ActivityEntry per line, append-only; may lag project.json by one entry after a crash
  chat.json        planning conversation: last 48 messages × ≤6000 chars + provider, model, savedAt
  raw/<rep_*|prop_*>.txt   original pasted text of an imported report/suggestion (≤200,000 chars)
  project.lock     transient create-exclusive lock holding the pid; >20 s old = stale and removed
  assets/<assetId>/…       only after importing a "bundle" export
```

* **Tasks, decisions, items, milestones, assets, proposals, packages, reports, plan versions, counters** are all arrays inside `project.json` (`planner.ts:209-241`). There are no per-task files.
* **Decisions** are `PlanItem`s of type `decision` with `status 'accepted'` and a `reason`; accepted ones are never deleted, only superseded (`service.ts` `removeItem`).
* **Revisions**: `revision` (every change), `planRevision` (accepted plan snapshot changed), `metaRev` (brief edits), per-record `rev`. `planVersions[]` holds a full `PlanSnapshot` for each plan revision (`store.ts:116-119`).
* **Planning conversation**: `chat.json` (above). Note the **Claude panel's** conversation is separate: `<project>/Claude/conversation.json` (`ProjectStore.readClaudeHistory`, `HISTORY_FOLDER/HISTORY_FILE`; I did not open the constants, so the exact folder/file name is from the doc-comment at `projectStore.ts:230`).
* **Agent conversation** (independent agent): inside the encrypted checkpoint only (and only when paused/limited), not a readable history.
* **"Project files and attachments"**: `PlanAsset` (`planner.ts:76`) = linked file path / web link / `{projectKey, assetId}` of an OmniCandy asset, with `sha256` recorded when added by file picker; `assetHealth` reports `ok|missing|n/a`. **No UI creates or shows plan assets** (doc 02, 5.2).

## 5. Getting externally produced plans in

| Route | Code | Result | Approval |
|---|---|---|---|
| Paste a ChatGPT/Gemini/other answer on the Idea tab ("Use ChatGPT, Gemini or another AI instead" → "Paste the answer") | `PastePanel` (`PlannerWork.tsx:206`) → `classifyPaste` (`plannerPaste.ts:222`) → `parseSuggestionText` (:139) → `importSuggestions` (`service.ts:645`) | A **pending `Proposal`** (`source:'pasted'`), original text saved in `raw/` | Owner ticks changes → `decideProposal` |
| Paste a *report* in the Work tab | `parseReportText` (`plannerHandoff.ts:106`) → `importReport` (`service.ts:603`) | A `PlanReport` `submitted` + proposals for its `proposedChanges`/questions | Owner reviews (`reviewReport`) |
| External AI connected over MCP | `propose_changes` (`mcp.ts:41`), scope `propose`; `submit_report` scope `execute` | Same pending proposal / report, actor from the MCP `clientInfo` | Owner decides |
| Accepting the AI chat's chunk list | `ChunkList` (`PlannerChat.tsx:17`) | `importSuggestions` + immediate `decideProposal` (one click for the owner) | One button |
| Export / import a whole plan | `exportProject` (`service.ts:692`) writes a ZIP `planner.json` (`format:'createcraft-planner-export'`, `version:1`) + optional bundled files ≤50 MB each; `importProject` (:719) | Creates a **new** plan `"<title> (imported)"` with a new id, claims removed, `planVersions` reset | Owner action (menu) |

Gaps: there is no accepted *schema* an outside AI can be told to produce for a whole-project plan other than `CHUNK_FORMAT` (`plannerContext.ts:122`) and the report format in `reportInstructionsFor`; the importer is tolerant (guesses) and says so via `uncertain[]`. ❓ `importProject` copies the exporting project's `ownerProjectId` along (`{...src}`); when the importing project already has a plan, two plans end up in that project's `Planner` folder and `projectPlan()` returns `list()[0]` (newest by `updatedAt`) — not tested by me.

## 6. Tracking project assets

* `ProjectStore.importFile / addDerivedFile / addGeneratedFile` copy files in (originals read-only, exact duplicate by SHA-256 detected), record provenance, and persist the manifest.
* Versions are assets with `parentId`; "approved/rejected" is `Asset.approval`.
* `analyzeProject` (`projectContext.ts:42`) summarises counts, notable files (those with saved versions first), exports, workflow steps, saved Claude messages for the Planner. It **never marks a chunk done** because a file exists (stated in the file header and the UI copy).

## 7. Restoring active work after restart

| What | Mechanism | Verified |
|---|---|---|
| Which project | `projects.json.current` | ✅ (`projects.test.ts`) |
| Which tab/file | `ProjectManifest.view` saved 800 ms after changes (`App.tsx` effect → `setProjectMeta({view})`), restored in `loadCurrent(restore=true)` via `shownWorkspace`/`routeWorkspace` | ✅ |
| Planner position | `PlannerWorkspace` always opens on the **Idea** tab (`setTab('plan')` on project change, :62); `lastActive` → "Pick up where I left off" banner if the last activity is before this session (:88) | ✅ |
| Planner content | everything in `Planner/projects/<id>/` | ✅ |
| Planning chat | `chat.json` via `chatLoad` | ✅ |
| Claude panel chat | `Claude/conversation.json`; a new SDK session is seeded with `buildResumeContext` | ✅ |
| Independent agent | encrypted checkpoint, "Continue Task" (`restoreAgent`, `src/main/ipc.ts:1369`); uncertain-edit journal blocks further edits until reconciled | ✅ (recovery tests) |
| Live document state (open app/file, timeline) | `liveApi.resync()` after switching (`App.tsx onSwitched`); the apps' own documents are not auto-reopened ❓ | ❓ |
| External MCP claims | persisted in `project.json` (`claim` with lease); 8 h; claims survive restart; the UI shows "Take back" when stalled (`displayStatus`) | ✅ |

## 8. Multiple projects

One open project at a time (`ProjectManager.store`). The renderer drops all planner state on a project change and the planner re-reads the folder (`sync()`). Plans do not link across projects except `AppRef`/`PlanAsset.createcraft` which can name another project's key (shown as "A workflow in another OmniCandy project"). Home lists projects (`projects.list`) with thumbnails, kind, brief; the Planner shows only the open project's plan.

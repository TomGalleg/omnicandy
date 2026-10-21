# Native app capability audit (research only, no code changed, no app run)

Paths are relative to `creative-studio/`. **CONFIRMED** = read directly in source. **LIKELY** = inferred from docs/code, not run.

## 1. Main finding

`app_commands` calls `LiveTaskController.appCommandList` (`src/main/liveTask.ts:486-490`), which throws `"<App> can't list its commands."` when the open document driver has no `listCommands`. `listCommands` is implemented only on the `LiveAppBase` subclasses in `src/main/liveApps.ts` (base at :109; overrides EffectCraft :594, PdfCraft :894). **`LivePhotoCraft` (`src/main/photocraftLive.ts:97`) is a separate class, does not extend `LiveAppBase`, and implements no `listCommands`** (the optional member exists on the `LiveDoc` interface, `photocraftLive.ts:35`). So PhotoCraft always fails discovery. CONFIRMED.

Claude Code has the same hole: its `app_commands` (`src/main/claudePartner.ts:340`) calls the same `appCommandList`. Claude gets by because its system prompt and the `photocraft_command` description (`claudePartner.ts:334`) hard-code example command ids (`image.adjustments.levels`, `filter.blur.gaussianBlur`, `type.create`, …), and it has the 10 PhotoCraft quick edits through `apply_edit`. The independent harness has neither of those hints, so a GPT model cannot learn PhotoCraft's 892 commands. CONFIRMED (code); the Claude workaround is inferred from the prompt text.

The data source exists: `docs/integration-audit.md:33,71` records `photocraft-cli commands` / `commands --json` = 892 commands, verified.

## 2. Tool comparison

| | Claude (`claudePartner.ts`, 46 tools, all listed in `TOOL_NAMES`) | Independent harness (`src/main/agentHarness/`) |
|---|---|---|
| Status/see | `get_status`, `look_at_document` | `get_status` only (`nativeTools.ts` comment: no vision yet) |
| Edit | `apply_edit`, `app_command`, `app_commands`, `photocraft_command`, `undo`, `save_version` | `apply_edit`, `app_command`, `app_commands`, `undo`, `save_version` (`photocraft_command` redundant: `claudeAppCommand` forwards to PhotoCraft at `liveTask.ts:494`) |
| Files | `list_files`, `open_file`, `new_document` | `list_files`, `open_file` (**no `new_document`**) |
| Timeline | `timeline_add`, `timeline_move_clip`, `timeline_remove_clip` | none |
| Export | `list_export_formats`, `export_file` | none |
| Generation | image, video, local video, motion, model download (7 tools) | none |
| Workflow | `workflow_*`, `plan_workflow`, templates (~11) | none |
| External | `external_apps`, `external_run`, `external_job`, builder start/status | `external_apps`, `external_commands`, `external_command` (**no job tracking**; long-running refused, `externalTools.ts`) |
| Planner | `planner_*` (4) | none |
| Guidance | 7-paragraph `SYSTEM_PROMPT` (`claudePartner.ts:32`, per-app hints, `tool:` ids, hand-off rules) | short prompt (`loop.ts`) + external paragraph |

Both use the same backend for shared tools (`ctl.claude*`), so locks, approvals, allow-lists and versioning are identical. Confirmed harness gaps vs Claude: vision, `new_document`, timeline edits, export, generation, workflows, planner, external jobs, per-app guidance.

## 3. How commands reach the model (all 13 apps)

Three layers, same for all apps:
1. **Quick edits** (`src/shared/appEditors.ts`, `EDITOR_APPS`): typed id + settings, listed by `get_status` (`liveTask.ts:536`), run by `claudeQuickEdit`.
2. **Engine commands**: `app_commands` → `LiveDoc.listCommands`; `app_command` → `claudeAppCommand` (`liveTask.ts:493`) → tier check (`appCommandTier`, `src/shared/appCommands.ts`; PhotoCraft uses `commandTier`, `src/shared/photocraftOps.ts`): free runs, approval asks a native dialog, never is refused.
3. **App-specific helpers**: `describe()` (shown in `get_status`), `preview()`/`screenshot()`, `timeline*`/`timelineSteps` (FilmCraft, SoundCraft timeline), `writeVersion`.

Base discovery (`liveApps.ts:109`): `<app>-cli describe <id>` for one id, else `<app>-cli commands` (JSON list or plain lines), filtered and capped at 80 rows.

## 4. Per-app table

Quick edits = ids in `EDITOR_APPS` (copy-only edits are not live). Driver lines are in `src/main/liveApps.ts` unless noted.

| App | Driver | Quick edits | Command discovery path | Gap |
|---|---|---|---|---|
| PhotoCraft | `LivePhotoCraft` `photocraftLive.ts:97` | 10 | **none** (not a `LiveAppBase`) | **CONFIRMED**: `app_commands` always errors |
| VectorCraft | `LiveVectorCraft` :150 | 5 | base `commands`; audit lists `commands` (`integration-audit.md:34`) | none expected; no `describe`, no headless mode |
| SoundCraft | `LiveSoundCraft` :206 | 4 (+2 copy-only) | base; plain-text output handled; audit lists `commands` (:38) | none expected; no headless mode |
| FilmCraft | `LiveFilmCraft` :330 | 8 | base `commands`; **audit CLI ops (:39) do not list `commands`** | **LIKELY** discovery failure; timeline add/move/remove tools missing in harness (CONFIRMED) |
| LightCraft | `LiveLightCraft` :496 | 8 | base; audit lists `commands` (:35) | none expected; no `describe` |
| EffectCraft | `LiveEffectCraft` :558 | 6 | override :594: MCP `tools/list` + base (errors swallowed) | none expected; `tool:<name>` id convention only in Claude's prompt (LIKELY minor) |
| DesignCraft | `LiveDesignCraft` :656 | 2 | base; audit lists `commands`, `describe` (:37) | none expected |
| WordCraft | `LiveWordCraft` :736 | 2 | base `commands`; audit CLI ops (:159) list `info,text,inspect,render,run`, **not `commands`** (617 commands counted via MCP) | **LIKELY** |
| PdfCraft | `LivePdfCraft` :812 | 6 | override :894: `<app>-cli tools`, blocklist `PDF_BLOCKED_TOOLS` | none expected (`tool:<name>` ids) |
| GridCraft | `LiveGridCraft` :1104 | 2 | base; audit CLI ops (:161) omit `commands` (341 via MCP) | **LIKELY** |
| DeckCraft | `LiveDeckCraft` :1173 | 2 | base; audit CLI ops (:160) omit `commands` (234 via MCP) | **LIKELY** |
| FigCraft | `LiveFigCraft` :1261 | 2 | base; audit CLI ops (:157) omit `commands` | **LIKELY** |
| CADCraft | `LiveCadCraft` :1356 | 2 | base; audit CLI ops (:157) omit `commands` (426 via MCP) | **LIKELY** |

The LIKELY rows rest on one fact: the base `listCommands` shells out to `<app>-cli commands`, and the audit's verified CLI subcommand lists for FilmCraft, WordCraft, GridCraft, DeckCraft, FigCraft and CADCraft do not include a `commands` subcommand. Their MCP servers do report command counts, so the data exists elsewhere (the EffectCraft and PdfCraft overrides already use MCP/`tools`). No test in the repo covers `listCommands` for any app (`liveDrivers.test.ts` and `headlessApps.test.ts` do not call it). **Must be verified by running `<app>-cli commands` once per app** (not done here).

## 5. Other capability differences affecting the harness

- **Vision**: `look_at_document` absent; the provider message type is text-only (`agentHarness/types.ts`). Every driver already has `preview()`.
- **Blank documents**: `new_document` (`claudePartner.ts:674`) + `BLANK_FILES` (`appEditors.ts:661`) + `newBlankFile` closure in `ipc.ts`. Without it the harness cannot start from nothing.
- **Timeline media**: `claudeTimelineEdit` / `timelineStepsFor` (`liveTask.ts:577-609`) resolve library files safely; generic `app_command timeline.place` with a file path would be approval-tier.
- **Export/hand-off**: `DeliverQueue` via `deliver` dep in `ipc.ts`.
- **Prompt guidance**: Claude's prompt carries per-app hints; the harness prompt does not.
- **Discovery output is not tier-aware**: lists every command, including ones the tier tables will refuse (`never`) or put behind a dialog; the model only learns this on error.

## 6. Code to reuse for the fixes (no new control system)

| Need | Reuse |
|---|---|
| PhotoCraft listing | Same logic as `LiveAppBase.listCommands` (`liveApps.ts:97-135`: `cliText`, `describe`, JSON/plain parsing, filter, 80-row cap) pointed at `photocraft-cli` (`binName('photocraft-cli')` in `o.installDir`, as `LivePhotoCraft` already does for `mcp`). Alternatively the bridge tool `command_list`. Implement on `LivePhotoCraft` so `ctl.appCommandList` and Claude both benefit; keep `ctl` unchanged. |
| Non-PhotoCraft gaps | The EffectCraft/PdfCraft override pattern (MCP `tools/list`) as fallback inside `LiveAppBase.listCommands` when `-cli commands` fails. |
| Safe listing | Tag rows with `commandTier` (`photocraftOps.ts:33`) / `appCommandTier` (`appCommands.ts`) and omit `never` rows. Execution paths stay as they are. |
| Missing tools | Thin wrappers over `ctl.preview`, `ctl.claudeTimelineEdit`, `store`/`openAsset`/`newBlankFile`, `DeliverQueue`, same as `claudePartner.ts` handlers; `nativeTools.ts` is the place. |
| Tests | `FakeDoc` in `liveTask.test.ts`; `withFake` driver fake in `liveDrivers.test.ts`; `headlessApps.test.ts` (WordCraft headless, skipped if absent). |
| Prompt | Copy only the per-app hint sentences from `SYSTEM_PROMPT` (`claudePartner.ts:32-51`) that name tools the harness actually registers. |

## 7. Verification still needed (nothing was run)

1. `photocraft-cli commands --json` output shape vs what `listCommands` parses.
2. `<app>-cli commands` for FilmCraft, WordCraft, GridCraft, DeckCraft, FigCraft, CADCraft (and VectorCraft/LightCraft/DesignCraft/SoundCraft to confirm the audit).
3. Whether the MCP `tools/list` / `command_list` route works for those six apps.

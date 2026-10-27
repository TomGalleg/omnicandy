# Native command security audit (Patch 8E, read-only, 2026-10-20)

Method: ran `<app>-cli commands` (PhotoCraft: `--json`) for each installed app, classified every id with the committed `appCommandTier` (`src/shared/appCommands.ts`; PhotoCraft with its own `commandTier` in `photocraftOps.ts`, which is what the PhotoCraft path uses), then screened ids, labels and parameter text for file writes, external reads and code/plugin execution. Nothing was executed. Heuristic screening was followed by manual reading of the descriptions of the candidates below.

**Checked: 6,793 commands in 12 apps.** Unavailable: PdfCraft (no `commands` subcommand). Tier totals (free/approval/never): PhotoCraft 642/137/139, VectorCraft 663/105/17, SoundCraft 413/31/36, FilmCraft 588/105/8, LightCraft 309/60/2, EffectCraft 615/89/27, DesignCraft 461/45/15, WordCraft 596/32/1, GridCraft 317/19/5, DeckCraft 295/21/5, FigCraft 491/63/15, CADCraft 388/27/11.

Note: free-tier parameters are also filtered by `checkParamValues` (keys `file`,`path`,`dir`,`folder`,`url`,`source`,`document`,`script`... and path-like strings are rejected). Gaps below are marked **mitigated** where a required path key makes that filter block the call, and **open** where no path key is needed or the key is not on the list.

## 1. File-writing / overwriting / destructive, classified free
| App | Command | Evidence | Status |
|---|---|---|---|
| LightCraft | `photo.convertToDng` | "write each raw photo…" as DNG; params `{ids?}` only | **open** |
| LightCraft | `photo.editExternal` | makes a copy for an external editor | **open** |
| LightCraft | `library.xmpPreferences`, `library.toggleAutoWriteXmp` | turn on sidecar (.xmp) writing for the library | **open** |
| LightCraft | `library.smartPreviewsLocation` `{path?}`, `folder.synchronize` `{path,…}` | writes under a chosen folder | mitigated when `path` given; default location open |
| CADCraft | `refclose` | "Save Reference Edits": writes the referenced drawing | **open** |
| SoundCraft | `session.revert` | discards unsaved session edits | **open** (destructive) |
| SoundCraft | `track.bounce` | renders audio into the session (no external path) | likely fine |
| VectorCraft | `links.unembed` `{id?, path?}` | writes image pixels to `path` | mitigated if `path` is passed; default open |
| DesignCraft | `links.copyTo` `{dir,…}` | writes placed files to `dir` and relinks | mitigated (`dir` key blocked) |
| PhotoCraft | `layer.exportAs` `{path}`, `swatches.export` `{path?}` | writes files; PhotoCraft's own table marks both free | `path` blocked; `swatches.export` without `path` returns base64 only |

## 2. External file reads, classified free
Heuristic matches: ~380 (most are false positives, e.g. an optional `from`/`source` word). Confirmed examples, all with path keys the filter blocks unless noted: VectorCraft `swatch.library.load {path|data}`, `links.relink {folder}`; DesignCraft `links.relinkFolder {dir}`; FilmCraft `media.relink`; LightCraft `photo.reload`, `folder.synchronize`. **Open** (no blocked key): any of these called with `data`/`dataBase64` payloads, which carry content rather than a path; and commands whose directory argument is named something not on the filter list (`output`, `dest`, `to`, `from`, `name`).

## 3. Script, code or plugin execution not classified `never`
| App | Commands | Current tier |
|---|---|---|
| VectorCraft | `plugin.run` | approval |
| FigCraft | `plugin.run`, `plugins.runLast` | approval |
| GridCraft | `view.macros` (approval); `home.addIns` (loads add-ins) | approval / **free** |
| WordCraft | `tools.recordMacro`, `tools.macros` (approval); `fields.setCode` (field codes) | approval / **free** |
| EffectCraft | `prop.setExpression` (expression source), `scriptui.click`/`set`/`get`/`mouse`/`close` (drive script windows) | **free** |
| FigCraft | `widget.insert`, `widget.click` (run widget plugin code) | **free** |
| CADCraft | `lisp`, `appload` | never (fixed in 8D) |

## 4. Ordinary editing commands requiring approval (likely false positives)
~117 approval-tier ids were flagged by the screen. The clear false positives are the `new`/`replace`/`recovery` families that are in-document edits: FilmCraft `file.newBin`, `file.newSequence`, `file.newColorMatte`, `file.newBlackVideo` …; EffectCraft `file.newCompFromSelection`, `file.replaceWithSolid`, `file.replaceWithPrecomp`; DeckCraft `insert.actionButton`, `file.recovery.list`; DesignCraft `file.new*`; LightCraft `print.layout.newPage`; VectorCraft `file.newPresets.delete`. Many other `file.new*` ids create a fresh document and arguably should stay approval.

## Summary
- Checked: 6,793; unavailable: PdfCraft.
- Confirmed open gaps: LightCraft `photo.convertToDng`, `photo.editExternal`, `library.xmpPreferences`/`toggleAutoWriteXmp`; CADCraft `refclose`; SoundCraft `session.revert`; free-tier code surfaces in EffectCraft (`prop.setExpression`, `scriptui.*`), FigCraft (`widget.*`), GridCraft `home.addIns`, WordCraft `fields.setCode`; plugin/macro runners are approval, not never.
- Likely false positives: the bulk of the ~380 "read" and ~126 "write" heuristic hits, and ~100 of the 117 "approval" hits.
- PhotoCraft uses a separate table (`photocraftOps.ts`) that Patch 8D did not change.

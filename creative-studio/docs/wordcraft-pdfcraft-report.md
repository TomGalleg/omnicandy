# WordCraft verification and PdfCraft integration: report

Date: 2026-10-15 · PC: Windows 11, the same machine as the earlier audits · Branch `main` (local commit, not pushed)
Apps: WordCraft 0.7.0 (`wordcraft-cli 0.7.0`), PdfCraft 0.8.0 (`pdfcraft-cli 0.8.0`; the earlier audit saw 0.7.1).
Cost: no paid API and no downloads. Real Claude panel use through the existing local Claude Code sign-in: **$0.826** for the one smoke run.
Nobody else's windows were touched: the user's CreateCraft was not running; every CreateCraft instance used a scratch profile
(`CS_USER_DATA_DIR`) and every app window the tests opened was closed afterwards. One stray PdfCraft window opened by an
exploratory `pdfcraft.exe --help` (it has no CLI mode) was closed immediately; it was not the user's.

## What PdfCraft exposes (probe results, 2026-10-15)

| Surface | Finding |
|---|---|
| Headless CLI | `info`, `render`, `text`, `edit`, `combine`, `extract`, `split`, `check`, `audit`, `batch`, `tools`, `run <tool> | --script`, `mcp`, `ui` |
| Automation engine | `pdfcraft-cli mcp --root DIR` (stdio MCP, **163 tools**, e.g. `doc_open`, `doc_save`, `text_paragraphs`, `text_edit`, `page_*`, `doc_watermark`, `doc_export_office`, `doc_reduce`, `render_preview`). `--root` is the only file confinement and may be given once, so work happens in a work folder copy |
| Window control | `pdfcraft.exe --control FILE` writes `{pid, port, token}` to FILE. Loopback JSON-RPC, first message `auth {token}`; then **only** `ui.state, ui.inspect, ui.click, ui.focus, ui.resize, ui.quit, ui.move, ui.drag, ui.type, ui.key, ui.command, ui.commands, ui.set, ui.open, ui.screenshot`. No document tools on that port, and `ui.command` ignores parameters |
| Consequence | The window cannot be edited through its own port. CreateCraft edits a working copy with the CLI's engine and keeps the window showing that copy |
| Native / project format | `.pdf` is the only format; there is no separate project file. The source PDF is kept in the library and every save is a new version next to it |

## VERIFIED

Evidence is a command and a count; all on the real installed apps.

**WordCraft (task 1)**
- Native conformance, 6/6: `CS_LIVE_TESTS=1 npx vitest run src/main/wordcraft.conformance.test.ts` (new file). Covers version detect, connect, open,
  read, edit, undo, edit again, save (.docx + PNG, original byte-identical), **reopen the saved version in a fresh window and find the edits**,
  **all 7 export presets** (PDF `%PDF`, PNG, TXT, MD, HTML contain the edited text, ODT `PK`, RTF `{\rtf`), and the error path.
- Existing live test (`liveApps.live.test.ts` WordCraft) 1/1, `headlessApps.test.ts` WordCraft engine 1/1, `deliver.test.ts` documents 1/1,
  `workflowSteps.test.ts` Word workflow 1/1.
- **Edit-tab embedding and UI** (previously NOT verified): `npm run smoke:docs`, new `scripts/smoke-docs.mjs`, scratch profile, 12/12.
  WordCraft sits inside the Edit area within 1 px, quick edit shows in history, Save as new version creates `quarterly-report-live1.docx`
  and keeps the original. Screenshot `docs/screenshots/80-edit-wordcraft.png`.
- Real Claude request through the panel: opened `quarterly-report.docx` in WordCraft and replaced the phrase (history `["Open","Replace All"]`,
  lock released). `scripts/smoke-claude-apps.mjs` with `CLAUDE_APPS_ONLY=WordCraft,PdfCraft,Doc`.

**PdfCraft (tasks 2-3)**
- Native conformance, 9/9 on the real window + engine: `CS_LIVE_TESTS=1 npx vitest run src/main/pdfcraft.conformance.test.ts`.
  Covers version detect, library kind, connect and read (page count, text, window shows exactly one clean tab, `ui.screenshot` is a PNG),
  edit / undo / edit again with the window following each step, all six quick edits, **an edit made by hand in the window being picked up as
  "Edit in PdfCraft" and undone**, save (.pdf + PNG, original byte-identical, **replaced text is not present anywhere in the saved bytes**),
  reopen the saved version (title and text persisted), **all 6 export presets**, and errors (not a PDF, password-protected PDF).
- Headless engine used by workflows: `headlessApps.test.ts` PdfCraft 1/1 (every quick edit runs with no window, `pid` is null).
- Deliver presets against the real CLI: `deliver.test.ts` "PDFs: PNG, text, DOCX, HTML, RTF and a smaller PDF" 1/1.
- Real workflow: `workflowSteps.test.ts` "a PDF: replace text and add a watermark in the background, then smaller PDF + plain text" 1/1.
- **Hand-off both ways with the real apps**: `CS_LIVE_TESTS=1 npx vitest run src/main/docHandoff.live.test.ts` 3/3.
  Word .docx -> PDF -> kept in the library -> opened and edited in PdfCraft -> saved; and PDF -> .docx -> kept in the library -> opened and
  edited in WordCraft -> saved (the text and "Sunset Over the Sea" phrase survive the conversion).
- **Edit-tab embedding and UI smoke**: `npm run smoke:docs` 12/12 (PdfCraft within 1 px of the Edit area; WordCraft is minimized while PdfCraft
  is shown; edits, undo, save, Deliver text + DOCX, "Add to library"). Screenshots `81-edit-pdfcraft.png`, `82-deliver-pdf.png`.
- **Claude panel path**, 7/7, $0.826: "replace the phrase and add the text Approved at the bottom of page 1" in PdfCraft
  (history `["Open","Replace text","Add text"]`); "export the Word document as a PDF, keep it in the library, open it" (Claude used
  `export_file` with `add_to_library`, then `open_file` -> PdfCraft). Locks released after each turn.
- Unit tests added (all pass): `appSteps.test.ts` PdfCraft steps (4), `deliver.test.ts` PdfCraft commands (1) + hand-off (2) + real presets (1),
  `workflowSteps.test.ts` (1), `headlessApps.test.ts` (1), `templates.test.ts` (eleven templates), `projectStore.test.ts` / `projects.test.ts`
  (fixture counts 13).
- Gates: `npm run lint` 0 problems; `npm run typecheck` 0 errors; `npm test` **240 passed / 33 skipped** (baseline was 228 passed / 15 skipped
  after the WordCraft commit; the skipped count rose because the live suites I added are opt-in).
- With `CS_LIVE_TESTS=1`: the WordCraft, PdfCraft, hand-off and existing live suites 31/31.
- Other smokes still passing: `smoke-apps` 20/20, `smoke-workflow` 7/7, `smoke-templates` 6/6 (now eleven templates), `smoke-nav` 7/7.

## FAILED

- `npm test` (default, not live) is **not always green**: `videoGeneration.test.ts` "Runway ... can cancel" times out (5 s) or hits an EPERM
  rename when the whole suite runs under load; it passes alone (9/9) and in a re-run of the full suite (240/240). The progress doc already lists
  this flake. Not caused by this work.
- Running **every** test with `CS_LIVE_TESTS=1` shows 3 failures that are not caused by this work: `photocraftLive.test.ts` x2
  ("PhotoCraft can't open SVG files", and the token test) fail identically on the commit before my changes (checked with `git stash`);
  `projects.test.ts` "opens an existing project from any folder" hit a 5 s timeout/ENOTEMPTY once under live load (passes in the normal run).
- `scripts/smoke.mjs` still stops at its old "Approve" step (listed as known stale in the progress doc; unchanged).
- One real bug found and fixed by the new tests: my first `describe` for PdfCraft read `text_extract` as a flat string (empty text) and
  used the wrong paragraph key (`paragraph`, not `number`). Both fixed before commit.

## BLOCKED

- **Theme sync for PdfCraft is not possible** through its control port: `ui.set` exists but no theme setting was found/verified, so PdfCraft is
  listed as "manual" like WordCraft.
- **No parametered commands in the live window**: `ui.command` ignores parameters, so Claude and the quick edits cannot drive the *window's* tools.
  The window is therefore a live view of the working copy that CreateCraft refreshes after each edit (a short reload each time, and scroll
  position is not kept), not the engine that makes the change. This is the honest ceiling of what PdfCraft 0.8.0 exposes.
- No PDF **project** format exists, so "keep the source project file next to the exported PDF" is satisfied by the library: the original PDF and
  each saved version stay as files with lineage, and Deliver records the source versions in `exports/manifest.json`.

## NOT TESTED

- Scanned PDFs / OCR (`ocr_recognize` exists; not wired as a quick edit). Forms, signatures, redaction, combine, compare: not exposed as quick edits.
- Very large PDFs (the fixture is 2 pages / 1.3 KB). Non-Latin text: `page_add_text` refuses non-WinAnsi characters (the driver reports the
  app's own message); `text_edit` may use fallback fonts.
- Re-running a hand edit while Claude is mid-task (the controller's replan flow is covered by unit tests with a fake document, not with PdfCraft).
- Thumbnails: an imported PDF shows a "PDF" tile until a version is saved (same as .docx before); a page-1 rendition at import is not built.
- PdfCraft version drift: the probe warns when major.minor differs from 0.8; no other version was available to try.
- Windows other than this PC and DPI settings other than 100%.

## Behaviour worth knowing

- Saved PDFs are a **full rewrite** (`doc_save full`), so replaced or deleted text is not left behind in an earlier revision.
- `Smaller PDF` writes an unchanged copy (with a note in the queue) when the file cannot be made smaller, instead of failing.
- "Add to library" (Deliver tab button and Claude's `export_file` `add_to_library`) copies a finished export into the library as
  `<name>-from-<source ext>.<ext>`, with the source as parent and provenance "hand-off". The file in `exports/` stays.
- PDFs now import as asset kind `document` (they were `vector`); existing library entries keep their stored kind and still work because the
  Edit tab picks the app by file extension. `.pdf` opens in PdfCraft by default; VectorCraft still lists it (choose it with `open_file app`).
- Two fixtures were added to the sample project (`fixtures.json`, `since: 4`): `quarterly-report.docx` and `quarterly-summary.pdf`.
  Existing Sample Projects get them once on next start.

## Files changed

Shared code touched: **no change to `LiveAppBase`** (PdfCraft overrides `ensureStarted` in its own subclass). Shared files that did change
because a new app and file kind had to be registered, or a new hand-off path added: `src/main/liveApps.ts` (new class appended; one
import and one type added), `src/main/deliver.ts` + `src/shared/deliver.ts` (new group, presets, `jsonScript`, `copyIfNoOutput`, `addToLibrary`,
`presetsFor` now unions groups), `src/shared/appEditors.ts` (new app, `defaultFor`, `pdfcraftSteps`, `parsePageList`),
`src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/ipc.ts` (one new IPC `deliver:keep`), `src/main/claudePartner.ts`
(enum, prompt, `export_file add_to_library`), `src/main/liveTask.ts` (app list), `src/main/workflowSteps.ts` (engine map), `src/main/media.ts`
(pdf kind), `src/main/artcraftProbe.ts` (entry + version note). Not touched: GridCraft, DeckCraft, FigCraft, CADCraft, or any ArtCraft app code.

Modified:
`CURRENT_PROGRESS.md`, `package.json` (`smoke:docs`), `fixtures/sample-project/fixtures.json`, `scripts/smoke-claude-apps.mjs`,
`scripts/smoke-templates.mjs`, `src/main/artcraftProbe.ts`, `src/main/claudePartner.ts`, `src/main/deliver.ts`, `src/main/deliver.test.ts`,
`src/main/headlessApps.test.ts`, `src/main/ipc.ts`, `src/main/liveApps.ts`, `src/main/liveTask.ts`, `src/main/liveTask.test.ts`, `src/main/media.ts`,
`src/main/projectStore.test.ts`, `src/main/projects.test.ts`, `src/main/workflowSteps.ts`, `src/main/workflowSteps.test.ts`,
`src/preload/index.ts`, `src/renderer/src/components/AssetBrowser.tsx`, `BottomPanel.tsx`, `DeliverWorkspace.tsx`, `EditWorkspace.tsx`,
`WorkflowEditor.tsx`, `src/shared/appEditors.ts`, `src/shared/appSteps.test.ts`, `src/shared/appTheme.ts`, `src/shared/deliver.ts`,
`src/shared/ipc.ts`, `src/shared/templates.ts`, `src/shared/templates.test.ts`, `../docs/integration-audit.md`.

Added:
`docs/wordcraft-pdfcraft-report.md`, `fixtures/sample-project/quarterly-summary.pdf`, `scripts/smoke-docs.mjs`,
`src/main/wordcraft.conformance.test.ts`, `src/main/pdfcraft.conformance.test.ts`, `src/main/docHandoff.live.test.ts`,
`docs/screenshots/73-claude-wordcraft.png`, `74-claude-pdfcraft.png`, `80-edit-wordcraft.png`, `81-edit-pdfcraft.png`, `82-deliver-pdf.png`.

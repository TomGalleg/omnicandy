# WordCraft and FigCraft open timeouts: diagnosis, fixes, results (2026-10-15)

Method: isolated copy of the repo built to its own `out/`, scratch Electron profiles (`CS_USER_DATA_DIR`), the real
installed apps, no commits, no pushes, your running OmniCandi untouched. Legend: VERIFIED / FAILED / BLOCKED / NOT TESTED.

## 1. Root causes (VERIFIED by instrumentation and by turning each factor on and off)

Instrumentation added: opt-in wire trace `CS_MCP_TRACE=<file>` (every MCP request, response, stderr line, timeout, plus every
command sent to and state received from the window tracker, per tracker). Without it the two failures were indistinguishable
("tools/call timed out").

| App | What actually hung | Cause | Evidence |
|---|---|---|---|
| WordCraft | Not `open_document` (it answered in ~20 ms). The **next** call, `edit.undoHistory`, never returned; so the open looked "stuck in starting" | OmniCandi hid the app window (`ShowWindow(SW_HIDE)`) the instant it appeared, because the Edit area had not reported its size yet. A window hidden before its first frame leaves WordCraft's control channel unanswered (even after the window is shown again) | Trace of a failing run: `target` -> `found` -> `hide` -> `#3 undoHistory` never answered. Standalone, early hide hung 2 of 14 launches; the same launches without the hide hung 0 of 24; cloaking/off-screen only 0 of 20 |
| FigCraft | `open_file` on an already-running FigCraft (reopening a file after switching away). Even a second, independent control connection got no answer, while the process reported Responding=True | "Putting away" a window by `unembed -> uncloak -> minimize`, then restoring it with `embed -> move -> show` for the next open, wedged FigCraft's control channel | Bisected in the real app flow by dropping single tracker commands: dropping `hide` still hung 2 of 2; dropping `minimize` passed 4 of 4 (also with `hide` dropped too) |

Why it looked intermittent / time dependent: both are races against the app's first frame or its restore from minimized, so
they depend on machine load. Earlier runs the same afternoon passed; the failures began when launches got slower.
Things ruled out with evidence: window cloak, off-screen parking, minimize/hide alone in a standalone harness, 12 parallel
instances, stale `control-key.local-*` files, leftover Recovery folders, dirty document before open, opening the same path twice,
baseline file deleted after `save_file`, binary versions (nothing changed on disk since 14 Oct).

## 2. Fixes (files and methods)

- `src/main/embeddedApp.ts`
  - `prepare()` / `apply()`: a window that was caught when it appeared and has not been placed yet is no longer hidden
    (`unplaced` flag). It is already off-screen, so there is nothing to hide.
  - `release(minimize=true)`: the previous app is now handed back with its frame and **hidden** (`unembed, uncloak, hide`)
    instead of minimized. The order matters: hiding before `unembed` made the framed window visible again (caught by
    `smoke-apps` / `smoke-docs`).
  - Trade-off: a put-away app no longer sits in the taskbar; it comes back by selecting its file again or "Open in its own window".
- `src/main/liveApps.ts` `LiveWordCraft.writeBaseline` (new): saves the just-opened document so unchanged/undone saves are comparable.
- `src/main/zipDigest.ts` `semanticZipDigest`: for `docProps/core.xml` the per-save `cp:revision` and `dcterms:modified` are
  ignored (title, author etc. still count). Needed because a .docx re-saved with no change differed only in those two fields
  (measured: A.docx vs B.docx identical except core.xml). This is the one change to the shared digest, justified by that measurement.
- `src/main/liveTask.ts` `saveVersion`: besides the open-time baseline, a save identical in content to the **version saved last**
  in this session is skipped ("Nothing changed since X was saved"). Fixes: save, save again, or edit-undo-save after a save.
- `src/main/mcpClient.ts`, `src/main/windowTracker.ts`: the opt-in trace described above (no behaviour change without `CS_MCP_TRACE`).
- `src/main/liveApps.ts` DeckCraft history fix kept as it was (uncommitted).

## 3. Tests added or corrected

- `src/main/liveDrivers.test.ts` (new): DeckCraft history as one string / list / null / missing; WordCraft baseline.
- `src/main/zipDigest.test.ts`: Office core.xml stamps ignored, real property and body changes not.
- `src/main/liveApps.live.test.ts` (live, `CS_LIVE_TESTS=1`): DeckCraft history assertions no longer encode the letter-per-entry bug.
- `scripts/smoke-reopen.mjs` (new, `npm run smoke:reopen`): per round and per app, in the real OmniCandi: open (timed, fails over 20 s),
  quick edit, save version, save again unchanged (no version), edit+undo+save (no version), real edit (new version), switch to the
  other app, reopen the **saved** version. Edits are tagged per run so duplicate content is not mistaken for a failure.
  On a hang it prints process responsiveness and whether an independent control connection is answered.
- `scripts/smoke-claude-apps.mjs`: every scenario now also requires status ready, no error, an open asset, and no admission such as
  "timed out / could not open" in Claude's reply. WordCraft and FigCraft scenarios ask Claude to edit **and save**, then read the saved
  package from disk: new version exists, original untouched, new text present in `word/document.xml` / `document.json` `characters`, old text gone.
  (Old WordCraft scenario passed while Claude reported the open timeout.)
- `scripts/smoke-live.mjs`: stale locator fixed (Edit lives under More in Simplified navigation, so the script now selects
  Advanced like the other smokes) and one stale option name. `scripts/smoke-docks.mjs`: "13 of 13", was "of 7".
- `fixtures/sample-project/fixtures.json`: added `region-sales.xlsx`, `northern-lights.deckcraft`, `login-screen.figcraft`,
  `bracket-drawing.dxf` (since 5; contents checked: sheet strings, "Northern Lights", "Welcome back", "FRONT VIEW"). Existing
  Sample Projects receive them once, as the earlier fixtures do; nothing existing is touched. `projects.test.ts` and
  `projectStore.test.ts` expectations updated (13 -> 17 originals).

## 4. Results (final build, same code)

| Check | Result |
|---|---|
| WordCraft opens via Edit tab and Claude panel | VERIFIED: smoke-reopen on the final code: 54/54 (clean profile, 3 rounds), 36/36 x2 (clean, 2 rounds); on the code before the final hide-order tweak 54/54 x2 (one reused profile, 3 rounds); smoke-docs 12/12 on the final code |
| FigCraft opens original and saved version, Edit tab and Claude panel | VERIFIED: same runs; Claude panel scenario reads the saved file |
| WordCraft: unchanged save, undo-then-save, real edit | VERIFIED: no version / no version / new version, in the real app |
| FigCraft: same three | VERIFIED (same script) |
| Claude panel (all 11 scenarios incl. 2 hardened) | VERIFIED 23/23 |
| Original seven + PdfCraft: smoke-apps | VERIFIED 20/20 |
| smoke-live (was a stale locator) | VERIFIED 22/22 |
| smoke-docks | VERIFIED 15/15 |
| Live driver tests, all 13 apps incl. Grid, Deck, Cad, Pdf, Word, Fig | VERIFIED 20/20 (+ wordcraft/pdfcraft conformance, docHandoff 3 files all pass) |
| Unit suite | VERIFIED 261 passed, 40 skipped, 0 failed; lint and typecheck clean |
| Clean and reused scratch profiles | VERIFIED (reused profile: 2 consecutive runs, 3 rounds each) |

## 5. Limitations and not tested

- Root causes are inferred from controlled on/off experiments in the real flow; the apps' own source is not available, so
  *why* a hidden-before-first-frame or minimize-restored window wedges the control channel is not explained.
  I could not reproduce either hang outside OmniCandi with a synthetic window host (only inside the real Electron flow).
- A put-away app is hidden, not minimized: no taskbar entry. If OmniCandi crashes, a hidden app process may stay running until ended in Task Manager.
- Saved versions made in separate sessions are both named `...-live1.*` (the counter restarts per open); `smoke-reopen`
  reopens by name so it may pick the older of two. Not changed here.
- GridCraft, DeckCraft, CADCraft, PdfCraft were verified through the live driver tests, smoke-apps (PdfCraft via smoke-docs) and
  the Claude panel (PdfCraft). Grid/Deck/Cad were **not** re-run through `smoke-reopen` (it covers Word and Fig only).
- `smoke-claude-apps` reported "Claude usage $5.463" for the full run and $0.27 / $0.15 for the two focused runs: these are
  the Claude Code session's own estimates on your signed-in account (no API key, no provider key used); I did not spend any
  other paid API. You may still want to know that the full suite is not free of usage.
- DWG: NOT TESTED (no DWG fixture). Nothing committed or pushed.

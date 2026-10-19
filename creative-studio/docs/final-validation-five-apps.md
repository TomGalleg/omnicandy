# Final validation: WordCraft, GridCraft, DeckCraft, FigCraft, CADCraft (2026-10-15)

Method: isolated copy of the repo built to its own `out/` (your instance's build untouched), scratch profile via
`CS_USER_DATA_DIR`, real ArtCraft apps, real Claude requests through OmniCandi's Claude panel. $0 API spend.
The harness is `scripts/smoke-five.mjs` (kept only in the scratch copy; not added to the repo).

Legend: PASS / FAIL / BLOCKED / NOT TESTED

| Feature | Word | Grid | Deck | Fig | CAD |
|---|---|---|---|---|---|
| Edit-tab embedding (window inside Edit area) | PASS (earlier runs) / BLOCKED later | PASS | PASS | PASS | PASS |
| Quick edit shows in history | PASS (earlier run) | PASS | PASS | PASS | PASS |
| Save as new version, original untouched | PASS (earlier run) | PASS | PASS | PASS | PASS |
| Saved file contains the edit (persistence) | NOT TESTED (see below) | PASS | PASS | PASS | PASS |
| Reopen saved version after switching away | PASS (earlier run) | PASS | PASS | FAIL (open timeout, 3 of 3 runs) | PASS |
| Unchanged save makes no version | FAIL | PASS | PASS | PASS | PASS |
| Undo-then-save makes no version (documentDigest) | FAIL | PASS | PASS | PASS | PASS |
| Intentional failure, Edit tab | PASS | PASS | PASS | PASS | PASS |
| Claude panel: open/read/edit/save/export | FAIL (open timed out) | PASS | PASS | FAIL (open timed out) | PASS |
| Claude panel: intentional failure reported accurately | PASS | PASS | PASS | PASS (reported the open failure honestly) | PASS |

Cross-app: deck -> PDF -> PdfCraft add text: PASS. CAD -> PDF: export + library PASS; Claude declined to open it in PdfCraft because
the previous PdfCraft document had unsaved edits (unsaved-change guard working; my scenario didn't save first) = NOT re-run.
DXF: PASS (undo-then-save, unchanged save, save, reopen). DWG: NOT TESTED (no DWG fixture; export preset not exercised in a reopen).
ZIP-based formats (.xlsx, .deckcraft, .figcraft): PASS. .docx: FAIL (see below).

Regression: original seven + PdfCraft: `smoke-apps` 20/20 PASS; `smoke-claude-apps` 21/21 (its WordCraft line passes
although Claude reported open timeouts; that check is weak); `smoke-live` FAIL on a stale locator timeout (script, not product,
not investigated); unit suite 256 passed / 1 failed (`videoGeneration` Runway test, the known load flake) / 40 skipped;
lint and typecheck clean. WordCraft headless conformance 6/6 and its live-window integration test pass.

## Confirmed problems
1. **DeckCraft history showed one letter per entry** (`["Open","S","e","t"," ","T","e","x","t"]`): `inspect_document.undo` is a single
   label string, not a list. FIXED in `src/main/liveApps.ts` (`LiveDeckCraft.history`), verified live. Uncommitted.
2. **WordCraft: unchanged save and undo-then-save each create a version.** `LiveWordCraft` has no `writeBaseline`, so
   `documentDigest` has no baseline. An added baseline could not be verified because of problem 3, so it was reverted. Not fixed.
3. **WordCraft and FigCraft intermittently fail `open` with "tools/call timed out"** when started/reopened from OmniCandi
   (WordCraft worked in earlier runs today and passes the direct live test and a manual `open_document`; from OmniCandi it began
   timing out consistently around 17:28 and the existing `smoke:docs` fails the same way). Cause not found; not an OmniCandi
   regression from the digest change (reproduced with it removed). Next step: trace what OmniCandi calls before `open_document`
   (window hide/minimise before open is the main suspect).

## Not done
Nothing pushed or committed. Your own OmniCandi was not touched (it was closed when I started the launches).

# CreateCraft quality, reliability and user-experience audit

Date 2026-10-19. Scope: `creative-studio` at commit `2b81b5b` plus the 73 uncommitted changes in the working tree. Audit only: no fixes were made, nothing was installed, nothing was pushed, no paid API call was made.

Evidence labels used throughout:

* **Confirmed (run)**: reproduced by running code or a test during this audit.
* **Confirmed (code)**: the defect is visible in the cited source; I did not run it.
* **Risk**: plausible from the code but not reproduced or not proven to be reachable. These are kept apart in section 3.

## 1. Executive summary

The app is in good shape. The project store is careful (atomic writes, read-only stored files, SHA-256 de-duplication, verified copy on Move). The AI path is well fenced (no built-in tools, a 46-tool allowlist that exactly matches the 46 registered tools, native approval dialogs for anything outside the open document, Claude can never overwrite the opened file). Typecheck and build pass, 707 unit tests pass on Windows and 624 on Linux with no failures, production dependencies have no known vulnerabilities, and the built app starts in about 3 s and idles at about 0 % CPU.

I found **no Critical issue**. I found **five High issues**, all of which are narrow and cheap to fix:

1. `claudeUndo` can leave the collaboration lock stuck, which blocks Claude and the Save button until the user cancels (Confirmed, code).
2. Concurrent writes to `project.json` collide on one temp file and fail with `ENOENT` (Confirmed, run: 5 of 12 parallel imports rejected).
3. The renderer has no error boundary, so any render exception blanks the whole window (Confirmed absent; impact is a risk).
4. `npm run lint` (and so `npm run check`) fails: 189 errors, 186 of them from scanning the `release/` build output (Confirmed, run).
5. `npm run release:check` reports NOT RELEASABLE because both bundled adapters are signed with a non-official key (Confirmed, run). This is the gate working as designed, but it blocks any distribution.

Smallest safe first group: section 7, "First group".

## 2. Confirmed bugs and their locations

### High

**H1. `claudeUndo` leaves the operation open if the undo throws.** Confirmed (code); no test covers it.
`src/main/liveTask.ts:506-514` dispatches `beginOperation`, then awaits `doc.undo()` with no `try/catch`. If the app's undo throws (app busy, window closed), `endOperation` is never dispatched. `collabReducer` then refuses every later `beginOperation` ("Another operation is active", `src/shared/collaboration.ts`), `claudeDone()` will not complete the task while `activeOperation` is set (`liveTask.ts:526`), and `saveVersion` throws "Wait for the current step to finish" (`liveTask.ts:314`). Compare `claudeRun` (`liveTask.ts:442-446`), which handles the same failure correctly. User-visible result: Claude says it is blocked and Save stops working until Cancel is pressed. No test mentions `claudeUndo`.

**H2. Overlapping manifest writes collide on one temp file.** Confirmed (run).
`src/main/projectStore.ts:28-32` writes `project.json.<pid>.tmp`. The name is the same for every write in the same process, and `persist()` (`:104-108`) has no queue. Two overlapping writes: the second `rename` finds the temp file already moved and throws `ENOENT`. Probe (temporary test, since deleted): 12 `importFile` calls in parallel on one store, 5 rejected with `ENOENT: rename ... project.json.<pid>`, while all 12 files were already copied into the project and the final manifest on disk contained all 12. So the data survives but the caller is told the save failed. A second probe: the same file imported twice in parallel produced two assets with the same hash (`storeFile` checks for duplicates before its first `await` finishes, `:155-160`).
Reachability: the Import button is sequential (`ipc.ts:155`), so the user does not hit this by dragging files. The realistic triggers are two independent writers at once: a video job finishing while an import or live save runs (`videoGeneration.ts:233`, `liveTask.ts:336`), or two Claude tool calls. The worst case is a paid generation whose file is stored but reported as failed (`generation.ts:170`). I did not reproduce that exact sequence. The same unique-name problem exists in `projects.ts:119-125` (`projects.json.tmp`), `credentialVault.ts:60-63`, `settingsStore.ts:21-24`.

**H3. No React error boundary.** Confirmed absent (grep for `ErrorBoundary`, `componentDidCatch`, `onerror`, `unhandledrejection` in `src/renderer` returns nothing). A throw during render in any workspace unmounts the whole tree, leaving a blank window with no message and no way back except restarting. Whether a specific render throw exists today is not proven.

**H4. The documented quality gate is red.** Confirmed (run).
`eslint.config.mjs:7` ignores only `out/`, `dist/`, `node_modules/`. On this PC `release/win-unpacked/resources/planner-mcp.cjs` (a generated 648 MB build folder, git-ignored) is linted and produces 186 errors. Three real errors remain in source: `claudePartner.ts:19` (`BLANK_FILES` unused), `integrations/adapters/blender.ts:251` (`_f` unused), `shared/appCommands.ts:36` (`_ignored` unused). Because `npm run check` is `lint && typecheck && test`, it stops at lint.

**H5. Release gate fails.** Confirmed (run). `node scripts/release-check.mjs resources` prints `NOT RELEASABLE`: `autodesk.revit-1.0.0.ccadapter` and `freecad-1.0.0.ccadapter` are signed with key `E970 10FE 35FE 418C BDEB 5A19 79DC C0EC`, which is not in `trust/release-publishers.json`. This is the intended safeguard (`docs/release-signing.md`), so it is not a code bug, but `npm run dist` cannot succeed until the release key signs them.

### Medium

**M1. Duplicate connect creates two adapter sessions.** Confirmed (code, not run). `src/main/integrations/manager.ts:210-241`: `connect` tests `this.sessions.has(key)` and only sets the session after three awaits (up to 80 s). Two callers in that window (startup `autoConnect`, a UI click, or two parallel Claude `external_run` calls) each create an adapter. The second `sessions.set` overwrites the first, so the first adapter and any process it started (for Blender, a second Blender window) is no longer tracked.

**M2. A crashed command removes the app from auto-reconnect.** Confirmed (code). `manager.ts:421` calls `this.disconnect(key)` with the default `forget`, which deletes the app from the remembered list (`:280`). After one unexpected adapter error the app is not reconnected at the next launch. Other paths deliberately use `{ forget: false }` (`:301`, `:290`).

**M3. Quit does not wait for shutdown.** Confirmed (code). `ipc.ts:730`: `app.on('will-quit', () => { void packages.shutdown(); void external.shutdown(); })`. Electron does not wait for those promises, so adapter disconnects and the bridge stop may not finish. For Blender the 'detach' flag write (`blenderLive.ts:166`) may be lost, leaving a listener polling in a window the user keeps open. Effect on the user is small; adapter child processes (`packageRunner.ts:233`) are the larger concern and I did not observe an orphan.

**M4. Credential status says "configured" for a key that cannot be decrypted.** Confirmed (code). `credentialVault.ts:60-63` reports `configured` from file existence only. If `userData` is copied to another PC or Windows user, DPAPI decryption fails but Settings shows "Key saved" (`ProvidersCard.tsx:35`); the error appears later at generation time (`credentialVault.ts:91-93`).

**M5. Corrupt `project.json` has no recovery path.** Confirmed (code). There is no backup copy (grep for `.bak` finds none). `ProjectManager.current()` (`projects.ts:134-147`) only checks that the file exists, so a corrupt manifest becomes the open project and every call fails; the UI shows "Could not load project: <raw JSON or zod error>" (`App.tsx:232`). `ProjectManager.list()` silently omits an unreadable project that lives in the built-in folder (`projects.ts:185-190`; only registered locations are shown as "missing"). Writes are atomic, so this needs an outside cause (disk full at the wrong moment, manual edit, sync tool); I did not reproduce a corrupt manifest.

**M6. A machine-wide `ANTHROPIC_API_KEY` can change how Claude is billed.** Confirmed (code), effect not run. All three `query()` calls pass `env: { ...process.env, ... }` (`claudePartner.ts:701, 747, 801`) and nothing removes `ANTHROPIC_API_KEY`. The UI promises "the Claude Code sign-in on this PC" (`ClaudePanel.tsx:95`). If a developer has that variable set, Claude Code uses it (my understanding of Claude Code's behaviour; I did not make a call to check). A chat can run up to `maxTurns: 300` (`:797`) and the only cost display is the session total (`ClaudePanel.tsx:129`); there is no limit for Claude's own usage, unlike image generation (`projectStore.ts:307-322`).

**M7. New-user dead end when Claude Code is not installed.** Confirmed (code). `claudePartner.ts:210` and `:227` check `%USERPROFILE%\.local\bin\claude.exe`. The panel shows the sign-in notice unconditionally (`ClaudePanel.tsx:94-101`); the only message about a missing install is the error "Claude Code is not installed on this PC." after the user clicks Sign in. There is no install link, no install check on first run, and `docs/planner-first-run-checklist.md` does not mention installing Claude Code. A user with Claude Code installed in a non-default location is treated as not installed.

### Low

* **L1. A tracked, unexplained Windows executable.** `creative-studio/undefined` is a 5,120-byte PE32 .NET console binary, tracked since commit `3f97628` ("Linux packaging configuration"). It looks like the output of a build step whose output path was `undefined`. I did not run it. It should be identified or removed.
* **L2. `ProvidersCard` has no error handler on its initial load.** `ProvidersCard.tsx:15` `useEffect(() => { void window.studio.generate.providers().then(setProviders); }, [])`; a rejection is unhandled and the card shows nothing.
* **L3. Console CSP warning on every start.** "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element." Observed on launch (Confirmed, run). Harmless; `frame-ancestors` only works as an HTTP header.
* **L4. Stray temp files.** `writeJsonAtomic` (`projectStore.ts:28-32`) does not remove its temp file if `writeFile` or `rename` fails.
* **L5. `claudeRun` reports "applied" without checking the document changed** (`liveTask.ts:441-454`). It reports success if `doc.run` did not throw. See section 3, R6.
* **L6. `electron-builder.yml`** has an uncommitted deletion of `signAndEditExecutable: false` under `deb` (that key is a Windows option, so likely correct). Noted only so it is not committed unreviewed.

## 3. Reliability and data-loss risks

Confirmed strengths first, because they set the baseline:

* Project files are written once and marked read-only (`projectStore.ts:170`); the opened library file is never overwritten by live editing (`liveTask.ts:10-12`); saves create new versions and skip a new version when the content digest is unchanged (`liveTask.ts:317-327`).
* Move is verified by size and SHA-256 before the original is touched (`projects.ts:57-74`); a workflow is backed up before Claude replaces it (`projectStore.ts:293-303`); remove goes to the Recycle Bin.
* Manual-edit protection is real: before every automated step the document version is compared with what automation last saw and automation pauses on a mismatch (`liveTask.ts:222-228`, `:425-431`). Tests cover the collaboration reducer.
* Every integration call is timed (20-120 s), cancellable, and its claimed outputs are checked on disk before success is reported (`manager.ts:402-412`).
* Open attempts time out after 120 s instead of hanging (`liveTask.ts:146-176`).

Data-loss and reliability risks (not proven to occur):

* **R1. No process-level error handling in the main process.** `src/main` has no `uncaughtException`, `unhandledRejection`, `render-process-gone` or `child-process-gone` handler (grep: only the adapter runner sub-process has them, `packageRunner.ts:52-53`). A crashed renderer or an unhandled rejection is not logged or surfaced by CreateCraft. There is also no log file anywhere in the app for a user to send when something breaks.
* **R2. Unsaved work in an ArtCraft app is not warned about.** Edits made in a live app window exist only in that app until the user presses Save version (`liveTask.ts:312`). Closing CreateCraft leaves the app window open ("no unsaved work is lost", `ipc.ts:346`), which is safe, but nothing in CreateCraft says the library copy lacks those edits. `open_file` relies on the model prompt to "ask the user first if the current document has unsaved changes" (`claudePartner.ts:641`), with no code check.
* **R3. Partial multi-step user edits are not rolled back.** `quickEdit`, `editTimeline` (`liveTask.ts:385`, `:591`) run several steps in a loop; if step 2 fails, step 1 stays applied and the controller's known version is not synced, so the next Claude call sees "changed by hand" and pauses (`:425-431`). Safe (it errs on pausing) but confusing.
* **R4. `saveVersion` is not guarded against two overlapping calls** (double click). Both would read the same `saveCount` and produce two files named `...-live<n>` with different ids (`liveTask.ts:332`). Names are not unique keys, so nothing is overwritten.
* **R5. The Claude chat can get stuck on a stale `resume` id.** `claudePartner.ts:800` resumes `sessionId` for every message; if that session is deleted from Claude Code's own store, each send would fail until the panel is reset. I did not test it.
* **R6. Accuracy of "completed" claims.** The integration manager verifies outputs on disk. The live-document path does not compare the document before and after (`liveTask.ts:447`: `endOperation` with the new version, never checked against the old one), so a command that silently did nothing is reported as applied. Claude does have `look_at_document` to check visually.
* **R7. Window embedding relies on a resident PowerShell process** (`windowTracker.ts:29`, `embeddedApp.ts:52`). It is robust to the app closing (`proc.on('error')`, EPIPE guarded) but is Windows-only by design.
* **R8. Large uncommitted tree.** 73 modified or new files (source, tests, docs, screenshots) are not committed. Not a defect in the code, but a recovery risk for the work itself.

## 4. User-experience improvements

All are changes to existing screens, no new features.

1. **Claude Code install check on first run** (M7). Show "Claude Code is not installed on this PC" in the Claude panel with the same "Check again" button, before showing "Sign in".
2. **Say why a key is unusable** (M4): show "Saved on a different PC or user; add the key again" instead of "Key saved".
3. **Project load error should offer a way out** (M5): replace "Could not load project: SyntaxError..." with "This project's file is damaged" and a button to open the Sample Project or pick another project.
4. **`ProvidersCard` initial load failure** (L2) should show a message, as the other cards do.
5. **Consistent error text.** The "Error invoking remote method" prefix is stripped in `ClaudePanel.tsx:15`, `ProvidersCard.tsx:7` and `useLive.ts:30` with three separate copies; `App.tsx:232` shows `String(e)` and so would show the prefix. One shared helper would make them match.
6. **Tell the user when a live edit is not yet in the library** (R2): a small "Not saved to the library" note beside the app tab.

## 5. Performance findings

Measured on this PC with a throwaway profile (`CS_USER_DATA_DIR`), built app from `out/`, no network or AI calls:

| Measure | Result |
|---|---|
| Time to first window | 0.37 s |
| Time to the library list showing | 3.1 s |
| Idle CPU after 23 s | ≈ 0 % in every Electron process |
| Working set at idle | Browser 167 MB, GPU 319-335 MB, Tab 157 MB, two utility processes 96 MB each; about 850 MB in total |
| Renderer JS heap | 10 MB; 321 DOM nodes |
| Resident PowerShell (spare window tracker) | 75 MB, 0.03 s of CPU in 10 s |
| Renderer bundle | one 1,842 kB JS file (`out/renderer/assets/index-*.js`) |

Findings:

* **No leak or runaway CPU observed** in a 25 s idle window. A leak over hours was **not** tested; that needs a long soak run.
* **P1 (Low).** The pre-started window tracker keeps a 75 MB PowerShell process alive for the whole session (`embeddedApp.ts:52-55`, re-created 2 s after each use, `:68`) so the first app window can be caught instantly. A reasonable trade-off; noted for completeness.
* **P2 (Low).** A single 1.8 MB renderer bundle. With a 3 s start this is not a problem now; code-splitting the Planner and workflow editor would be the safe lever if start time grows.
* **P3.** `autoConnect` returns immediately when nothing was connected (`manager.ts:270-273`), so a first run does no PowerShell or registry discovery at startup. Good.
* **P4 (Risk).** The status poll loops (`blenderLive.ts` 120 ms file poll, tracker 10-60 ms, Claude sign-in 3 s) only run while their feature is active; I did not find an always-on timer.

## 6. Test and build results

| Check | Result |
|---|---|
| `npm run typecheck` (node + web projects) | **Pass** |
| `npx electron-vite build` | **Pass** (zod "annotation Rollup cannot interpret" warnings only) |
| `npx vitest run` on Windows | **Pass**: 79 files passed, 13 skipped; 707 tests passed, 65 skipped, 0 failed (32 s) |
| `npx vitest run` on Linux (Ubuntu 24.04 WSL2, copy of the current working tree, existing Linux checkout untouched) | **Pass**: 74 files passed, 18 skipped; 624 tests passed, 148 skipped, 0 failed (22 s) |
| `npm run lint` | **Fail**: 189 errors. 186 are in the generated `release/win-unpacked/resources/planner-mcp.cjs` (H4); 3 are real, in source |
| `npm run check` | **Fail** (stops at lint) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run release:check` | **Fail**: NOT RELEASABLE (H5) |
| Startup / idle probe | See section 5 |

Not run, and why:

* **The `smoke:*` scripts.** They write screenshots into the tracked `docs/screenshots/` folder and most need the Craft apps running; running them would change tracked files. The `*.live.test.ts` files (65 skipped tests on Windows) need real Blender, Resolve, Revit, FreeCAD or Craft apps, and are gated by environment variables. I did not start those programs. The prior hands-on results for the 13 Craft apps, Blender, workflows, takeover and recovery are therefore not re-verified here.
* **Packaging** (`dist`, AppImage, deb): postponed by project decision.

Test coverage gaps found while reading: `claudeUndo` has no test (H1); there is no test for concurrent `ProjectStore` writes (H2); the manager has no test for two simultaneous `connect()` calls (M1); no test checks the missing-Claude-Code state of the panel.

Cross-platform readiness: the 624 passing Linux tests show the shared logic holds. The Windows-only pieces are the ones `docs/linux-compatibility.md` already lists: window embedding (PowerShell + Win32), `.exe` paths, GPU detection through PowerShell, Revit and the registry-based discovery. I found no new Windows-only assumption outside that list. Paths in messages such as `D:\\CreateCraft Projects` (`projects.ts:38`) are Windows wording. `defaultClaudeCliPath` already has a Linux branch (`platform/exec.ts:33-36`).

## 7. Prioritized repair plan

Order is by risk reduced per line changed. None of these changes the architecture.

### First group (smallest, safest; implement first)

1. **H1 `claudeUndo`:** wrap `doc.undo()` in `try/catch` that dispatches `endOperation ok:false` and rethrows, as `claudeRun` does. Add a test with a failing `undo`. About 6 lines.
2. **H2 manifest writes:** (a) give `writeJsonAtomic` a unique temp name per call (`randomUUID()` suffix) and remove the temp file on failure; (b) run `persist()` through a per-store promise chain so writes happen one at a time; (c) make `storeFile` do its duplicate check and `push` inside that same serialised section. Apply the unique temp name to `projects.ts:121`, `credentialVault.ts:60`, `settingsStore.ts:21`. Add a test that runs 12 parallel imports and expects zero rejections and one asset per distinct file (the probe from this audit).
3. **H3 error boundary:** a small boundary around the workspace area in `App.tsx` showing the error text and a "Reload this view" button. Also handle `render-process-gone` in `index.ts` (reload the window).
4. **H4 lint gate:** add `release/**` to the `ignores` list in `eslint.config.mjs`; remove the three unused variables. Then `npm run check` can be trusted again.

These four are independent, each is a few lines to a few dozen, and each has a direct test.

### Second group

5. **M1 connect de-duplication:** keep a `Map<string, Promise<...>>` of in-flight connects in `IntegrationManager.connect` so a second caller awaits the first. Add a test with two simultaneous calls.
6. **M2:** change `manager.ts:421` to `this.disconnect(key, { forget: false })`.
7. **M3:** in `will-quit`, call `event.preventDefault()`, await both shutdowns with a 3 s cap, then quit again.
8. **M7 / UX 1:** Claude Code install check in `ClaudePanel`, using the existing `checkAuth` null result (`claudePartner.ts:210` already returns `null` when the program is missing).
9. **M4:** make `SafeStorageVault.status` try the decrypt and report "cannot be read on this PC".
10. **M6:** remove `ANTHROPIC_API_KEY` (and the other `ANTHROPIC_*` variables) from the `env` passed to `query()`, or show a one-line warning in the Claude panel when it is set. Decide which with the product owner; both are small.
11. **L1:** identify and delete the tracked `undefined` file.

### Third group (when convenient)

12. **M5:** keep `project.json.bak` on each successful write and fall back to it when parsing fails; show corrupt projects in the list as "damaged".
13. **R1:** a main-process log file plus `uncaughtException` / `unhandledRejection` handlers.
14. **R2 / UX 6:** an "unsaved in library" indicator. **R3, R4, L2-L5, P2:** as listed above.
15. Re-run the live tests and the hands-on recovery tests after groups 1 and 2, because groups 1 and 2 touch the project store, collaboration lock and connection manager that those tests exercise.

### Recommendation

Implement the **first group (items 1-4)** now. Together they fix the one Confirmed (run) data-handling defect, the one stuck-lock bug, the blank-window failure mode and the broken quality gate, with about 40 lines of code plus tests, and with no behaviour change on the paths that work today. After that, run `npm run check` and the Windows and Linux unit tests, then do the second group.

## 8. First group: implemented 2026-10-19 (not committed)

* H1: `claudeUndo` now ends its operation when the undo fails (`liveTask.ts`); test added in `liveTask.test.ts`.
* H2: `writeJsonAtomic` is exported, serialises writes per file, uses a unique temp file and removes it on failure; `storeFile` runs one at a time; `projects.json` and `appearance.json` use it. Tests added in `projectStore.test.ts` (12 parallel imports, same content twice). The credential vault's temp name was left as it is (single user action, not a concurrent path).
* H3: `ErrorBoundary` around the app in `main.tsx`, plus a `render-process-gone` reload in `index.ts`; test in `ErrorBoundary.test.ts` (`vitest.config.ts` now sets automatic JSX).
* H4: `release/**` ignored by ESLint, `ignoreRestSiblings` enabled, unused `BLANK_FILES` import removed.
* Results: `npm run check` passes (lint, typecheck, 713 tests passed, 65 skipped); `electron-vite build` passes; Linux (WSL copy of the working tree) 630 passed, 148 skipped, 0 failed.

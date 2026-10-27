# CreateCraft internal-Claude test on the VOLTERRA X1 files (2026-10-15)

Result key: **VERIFIED** (run, evidence), **FAILED**, **BLOCKED**, **NOT TESTED**.
Run command: `node scripts/smoke-volterra.mjs` (creative-studio). Commit `ca7eae7`. Real Claude on Tomas's plan: about $2.1 reported usage across two runs. No paid APIs, no keys, no downloads.

## 1. Seven-app test through CreateCraft's own Claude panel

How it ran: Playwright launched the real CreateCraft Electron app with a scratch profile (`CS_USER_DATA_DIR`), imported 9 VOLTERRA v2 files into a scratch project (copies), then sent each request through the same `window.studio.claude.send` call the chat panel uses. Claude (Claude Code sign-in) chose tools; CreateCraft opened the real app windows and applied edits. Limit: the text was injected via the app's IPC, not typed with keyboard events into the textbox.

| App | Request | Result | Evidence |
|---|---|---|---|
| PhotoCraft | brighter + contrast on car .pcraft, save | VERIFIED | history Open, Brightness/Contrast; new `...car-edited-v2-live1.pcraft` + png |
| VectorCraft | invert logo .vectorcraft, save | VERIFIED | history Invert; new `...logo-transparent-v2-live1.svg` + png |
| SoundCraft | soundtrack v2 wav -1 dB, save | VERIFIED | Clip Gain; new `...soundtrack-v2-live1.wav` |
| LightCraft | Golden Hour on electric-blue png, save | VERIFIED | Preset: Golden Hour; new `...-color1.png` |
| EffectCraft | add title on still, save | VERIFIED | New Text Layer; new `...-fx1.png` (a still, not the .ecproj) |
| DesignCraft | change poster headline, save | VERIFIED | Change All; new `volterra-x1-poster-live1.designcraft` + png |
| FilmCraft | trim 0.5 s start + fade out on promo v2 mp4, save | VERIFIED | Ripple Trim, Dip to Black, Constant Power; new `...-live1.mp4` (19.5 s) |

Checks that also passed: control lock released after each turn (7/7); VOLTERRA source folder hashed before and after: 0 files changed, 0 added (originals preserved); Claude reported each outcome accurately in the transcripts (no false success seen).

Spec items:
1. Identify seven apps: VERIFIED (all seven opened by name). 2. Real control interfaces: VERIFIED (their MCP/control ports). 3. Open VOLTERRA projects: VERIFIED for .pcraft, .vectorcraft, .scraft-exported wav, .designcraft; PARTIAL for FilmCraft and EffectCraft, where the library holds the rendered mp4 / png, not the `.fcproj` / `.ecproj` (CreateCraft's editors open media, not those project files). 4. Read state: VERIFIED (Claude "looked at the document" and described content, e.g. the DesignCraft headline). 5-6. Modify and save: VERIFIED as new versions. 7. Update assets used downstream: PARTIAL, new versions land in the library with lineage, but nothing was re-linked into the FilmCraft project. 8. Rebuild the final video in FilmCraft from updated assets: **NOT TESTED** (not possible via the panel today: FilmCraft's panel ops are trim/fade on a media file, not swap-asset-and-rebuild). 9. New export version: VERIFIED only for the FilmCraft trimmed mp4 above, not a rebuilt production. 10. Accurate success/failure reporting: VERIFIED on the 7 successes; failure reporting NOT TESTED (no failure occurred).
Part 2 persistence by closing and reopening: NOT TESTED in this run (saved files are new library assets; reopen not exercised). Edit-tab embedding: the tab changed to the expected workspace each time (Edit/Audio/Color/Effects/Edit); visual embedding quality not inspected. Workflow and Deliver on VOLTERRA files: NOT TESTED (their existing smoke scripts pass on fixtures, not these files).

## 2. Known issues

| Issue | Status | Finding |
|---|---|---|
| DesignCraft redundant version after undo+save | **RESOLVED** | Cause confirmed: byte-hash dedupe vs a 0.7.1 original, while 0.8.0 writes new `meta.json` stamp. Fix: semantic digest (ignores `meta.json`/`mimetype`, canonical JSON) of the opened state; undo-then-save now says nothing changed. Unit test added; live DesignCraft suite 3/3. |
| DesignCraft character styling "silent" | **EXPLAINED, not a bug in CreateCraft** | `type.char {attrs}` formats the current *text selection* (needs `text.select {story, anchor, focus}` with UTF-8 byte offsets, or `edit.selectAll`). Verified with `type.selectionAttrs` (size, bold applied). An unknown swatch name fails loudly. Paragraph styles remain the reliable route. CreateCraft's DesignCraft quick edits still only offer black/white text: UNRESOLVED (enhancement). |
| EffectCraft v2 render 90 s vs 8.6 s | **ROOT CAUSE FOUND, mitigation verified, not changed in code** | Reproduced: 89.7 s vs 8.9 s. Per-layer bench: Glow on each `Light streak` costs about 440 ms/frame in v2 (Scale 100x260) vs about 51 ms in v1, only while streaks are visible (t 0.5-2.5 s). Setting height through the shape Size with Scale 100 cuts t=1.5 from 1880 ms to 268 ms (7x) with the same geometry. This is an EffectCraft engine behaviour (Glow on scaled layers); not a CreateCraft bug. Full re-render of the fixed file not run. |
| SoundCraft true peak -0.6 dBTP | **RESOLVED for this deliverable** | New `CreateCraft_7_App_Integration_Test_Run2/volterra-x1-soundtrack-v3-safe-peak.wav`: -0.8 dB gain, peak -1.4 (ffmpeg ebur128 peak=true). Done with ffmpeg, not inside SoundCraft; the SoundCraft script's own master limiter ceiling was not changed. |

Code tests after the change: typecheck 0 errors, lint 0, Vitest 230 passed / 15 skipped (one earlier run showed 2 transient failures that did not repeat).

## 3. Evidence commands came from inside CreateCraft
Claude's tool activity lines ("Opened ... in PhotoCraft", "Saved ...-live1...") are emitted by CreateCraft's live-app layer; resulting files appear in the scratch project's `versions/` with provenance "Saved from the live <App> window". External Claude Code only launched the app and imported files.

## 4. Existing architecture (as built)
Electron main process: `claudePartner` (Claude Code sign-in, tool surface) -> `liveTask` (one live document, collaboration lock, history, save-version) -> `liveApps` (one driver class per app extending `LiveAppBase`: spawns `<app> --control PORT` or headless `<app>-cli mcp`, talks MCP, implements open/run/history/writeVersion/describe) -> `projectStore` (library with sha256 dedupe, lineage, provenance). Workflow engine and Deliver reuse the same drivers. Quick edits = per-app `appEditors` op tables. WordCraft was already added by another thread (commit f151e7e); not touched here.

## 5-8. Native framework for the 13 apps and plan
Recommended (reuse, no new abstraction): a data-driven **app manifest** per app (id, exe name, formats, control args, capabilities, min/max version), discovered by scanning `C:\Program Files\<App>` and `--version`; the existing `LiveAppBase` stays the driver contract. Add a shared **conformance test** (connect, open, read, edit, undo, save, reopen) that every driver must pass, plus a version-compat check that warns instead of failing (the DesignCraft 0.7.1 to 0.8.0 stamp issue is the reason). Status today: CADCraft, DeckCraft, FigCraft, GridCraft, PdfCraft are **audited only** (headless CLI and live control seen working for the first five, per CURRENT_PROGRESS) and **not integrated**; WordCraft is integrated by another thread.

Suggested order and difficulty: 1. PdfCraft (low-medium, mostly open/read/export, fits existing document kind), 2. GridCraft (medium, cell-level ops, formulas, new asset kind), 3. DeckCraft (medium, slides as pages, image export for preview), 4. FigCraft (medium-high, frames/prototypes, overlaps DesignCraft UI), 5. CADCraft (high, units/layers, large preview formats). Each step ends with the conformance test and Tomas's OK. Nothing in section 5-8 was implemented.

## Not covered / open
FilmCraft rebuild from updated assets; reopen persistence; Workflow/Deliver on VOLTERRA files; typed-keyboard Claude panel input; GPU/CPU measurements; failure-path reporting.

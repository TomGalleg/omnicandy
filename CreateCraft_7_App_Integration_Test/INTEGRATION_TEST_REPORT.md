# CreateCraft 7-App Integration and Production Test: VOLTERRA X1

Date: 2026-10-15 (PC time 2026-10-14 evening). Tester: Claude (Thread Claude, Sonnet 5.5) on Tomas's Windows 11 PC
(i5-12600K, 31.8 GB RAM, AMD RX 6650 XT). Cost: **$0**. No paid API, no cloud, no model download, no stored key used.
Tomas's own CreateCraft was open throughout, so **CreateCraft itself was not launched**; no existing project was touched.

## How it was tested (read this first)

Every ArtCraft app was driven through its **own installed CLI / MCP engine, headless**, on real project files in this folder.
Outputs were verified by re-reading the project or file (SVG text, pixel statistics, `info`, `probe`, re-bounce, frame renders),
not just by exit codes. This proves the **apps' automation surfaces and file hand-offs**. It is not a test of CreateCraft's
own Claude panel or Edit-tab embedding; those were not run (see "Not tested").

"Live window" control (the real app GUI via `--control`) was exercised by CreateCraft's existing opt-in live suite
(`src/main/liveApps.live.test.ts`, fixtures, not the VOLTERRA files). Its result is listed under Connect and below.

## Result table

| Application | Connect | Create | Edit | Save | Reopen | Export | Cross-App | Result |
|---|---|---|---|---|---|---|---|---|
| VectorCraft | PASS (headless CLI) | PASS (logo, bolt, car illustration) | PASS (text + colour changed after reopen) | PASS (.vectorcraft) | PASS (`info`, edit after open) | PASS (SVG, PNG, .vectorcraft) | PASS (logo placed in DesignCraft, EffectCraft; car into PhotoCraft) | **PASS** |
| PhotoCraft | PASS (headless CLI) | PASS (opened VectorCraft car) | PASS (contrast, exposure, vibrance, sharpen; v2 hue/sat) | PASS (.pcraft) | PASS (v2 made from the saved .pcraft) | PASS (PNG) | PASS (into DesignCraft, LightCraft) | **PASS** |
| DesignCraft | PASS (headless CLI) | PASS (poster, end card) | PASS (images swapped on reopen, text reset) | PASS (.designcraft) | PASS (reopened, story.get, no overset) | PASS (PDF, PNG) | PASS (VectorCraft logo + PhotoCraft/LightCraft images in; end card into FilmCraft) | **PASS** |
| LightCraft | PASS (headless CLI) | PASS (2 grades + a library project) | PASS (v2 grade; library settings changed on reopen) | PASS (library) | PASS (settings read back) | PASS (PNG, 1920x1080) | PASS (PhotoCraft in; both grades into FilmCraft and DesignCraft) | **PASS** |
| EffectCraft | PASS (headless CLI, JSX scripting) | PASS (reveal, 50 layers) | PASS (streaks resized on reopen) | PASS (.ecproj) | PASS (opened, edited, re-rendered) | PASS (H.264 MP4, still frame) | PASS (VectorCraft logo in; MP4 into FilmCraft) | **PASS** |
| SoundCraft | PASS (headless CLI) | PASS (synth + drum MIDI, FX, VO) | PASS (mix + reverb on reopen; level changed) | PASS (.scraft) | PASS (re-bounce identical level) | PASS (24-bit WAV) | PASS (WAV into FilmCraft) | **PASS** |
| FilmCraft | PASS (headless MCP engine) | PASS (20 s sequence) | PASS (4 clips relinked to v2 on reopen) | PASS (.fcproj) | PASS (reopened, inspected) | PASS (1920x1080 H.264+AAC) | PASS (all five sources placed) | **PASS** |

Live-window column (existing live suite): see "Live window control" below.

Legend: PASS only where I verified an output or state. Anything not exercised is listed as NOT TESTED below.

## Deliverables (this folder)

| Item | Path |
|---|---|
| Final 20 s promo video (v1) | `Final/VOLTERRA_X1_promo_v1_1080p.mp4` (1920x1080, 30 fps, H.264 + AAC, exactly 20.0 s) |
| Revised video (v2) | `Final/VOLTERRA_X1_promo_v2_revised_1080p.mp4` |
| Poster | `Final/VOLTERRA_X1_poster.png` / `.pdf`; editable `DesignCraft/volterra-x1-poster.designcraft` |
| Vector logo | `Final/VOLTERRA_X1_logo.svg` / `.png`; editable `VectorCraft/*.vectorcraft` |
| Edited car image | `Final/VOLTERRA_X1_car_edited.png`; editable `PhotoCraft/volterra-x1-car-edited.pcraft` |
| Lighting variations | `Final/VOLTERRA_X1_lighting_electric_blue.png`, `..._deep_noir.png`; editable `LightCraft/library-electric-blue` |
| VFX sequence | `Final/VOLTERRA_X1_vfx_logo_reveal.mp4`; editable `EffectCraft/volterra-x1-logo-reveal.ecproj` |
| Soundtrack | `Final/VOLTERRA_X1_soundtrack.wav` (20.0 s, 24-bit); editable `SoundCraft/volterra-x1-soundtrack.scraft` |
| Editable timeline | `FilmCraft/volterra-x1-promo.fcproj` (+ `-v2`) |
| Scripts used | `scripts/` (copies; they point at a scratch folder that was deleted, so paths need adjusting to re-run) |

Per-app folders also hold the v2 edit round (`*-v2.*`).

## What each app actually did

* **VectorCraft**: logo (lightning bolt, wordmark, accent bar) built from shape/path/text commands; transparent variant for compositing; a stylized side-view car illustration (no photo exists locally) with gradients, wheels and a glow plate. 6 exports verified (SVG text and fill colours read back).
* **PhotoCraft**: opened the VectorCraft car, brightness/contrast, exposure, vibrance, unsharp mask; saved .pcraft and PNG. Pixel mean/stddev changed as expected (stddev 27/35/43 -> 30/40/50).
* **DesignCraft**: 1080x1620 poster with logo, car, "THE FUTURE HAS ARRIVED." and credits; 1920x1080 end card for the video. Paragraph styles are the way to set type (see bugs).
* **LightCraft**: two real grades (electric blue, deep noir) with colour grading, vignette, clarity, dehaze, grain; library project persisted and re-read.
* **EffectCraft**: 6 s reveal: logo scale/opacity keys, glow, 6 light-streak layers, 40 particle layers, tagline fade. Authored with EffectCraft's JSX scripting (privileged; my own script, not agent-supplied text).
* **SoundCraft**: pad, bass, arp (SoundCraft's Subtractive Synth) and drums (Drum Synth) written as MIDI, a Maximizer on the master, plus imported FX and voiceover.
* **FilmCraft**: reveal + two grades + end card with dissolves, soundtrack, 20 s.

## Cross-application workflow (verified paths)

VectorCraft logo -> DesignCraft poster and end card, EffectCraft reveal. VectorCraft car -> PhotoCraft. PhotoCraft image -> LightCraft
(both grades) -> FilmCraft and DesignCraft. LightCraft -> FilmCraft. EffectCraft MP4 -> FilmCraft. SoundCraft WAV -> FilmCraft.
DesignCraft end card -> FilmCraft.

**Edit round (one change per app, then re-incorporated):** VectorCraft tagline text + bolt colour; PhotoCraft hue/saturation/exposure;
LightCraft cooler, stronger grade from PhotoCraft v2 (+ library setting change); EffectCraft thicker streaks; DesignCraft new
LightCraft image and v2 logo placed into the end card; SoundCraft drums -5 dB, arp -14 dB, plate reverb on pad; FilmCraft
relinked 4 items and re-exported. v2 video differs from v1 (frame diff at 8 s mean 2-6 levels, at 18 s up to 17 on blue).
Note: the v2 poster was not made; v2 flows through the end card only.

## Performance (measured, not estimated)

| Item | Measurement |
|---|---|
| EffectCraft v1 render, 180 frames 1080p H.264 | 8.6 s wall, peak working set about 2.6 GB (sampled) |
| EffectCraft v2 render (same comp, thicker streaks) | **89.9 s**, 10x slower; cause not isolated (likely the Glow effect on scaled layers); one run only |
| FilmCraft export, 600 frames 1080p H.264 | 11.4 s, 52 fps render rate |
| SoundCraft session build + bounce (20 s, 11 tracks) | under 1 s of CLI time |
| LightCraft render 1920x1080 | about 1 s each |
| CPU %, GPU %, per-app memory over time | **NOT MEASURED** beyond the peak above |
| Crashes / hangs in the CLIs | none observed |

## Bugs and findings

| # | Finding | Type | Status |
|---|---|---|---|
| 1 | DesignCraft: character formatting commands (`type.char`) silently did nothing on a freshly created frame; text came out tiny serif black. Paragraph styles (`style.paragraph.create` + `apply`) work | App/API quirk | Worked around in my scripts; **CreateCraft's DesignCraft quick edits only offer black/white text, a related known limit** |
| 2 | DesignCraft: 78 pt tagline overset the frame and hyphenated ("AR-"); the app reports it correctly (`overset` count) and I fixed the size to 64 pt | My error, app diagnostics fine | Fixed |
| 3 | DesignCraft: a longer replacement tagline overset by 30 characters; `story.setText` keeps formatting and does not shrink | Expected behaviour | Used a shorter edit |
| 4 | SoundCraft: MIDI ticks are 960 per quarter note (not 480); my first arrangement stopped at 10 s and the check caught it | My assumption, app is consistent | Fixed |
| 5 | SoundCraft: bounce of the whole session includes FX tails (21.6 s); needs explicit `start/end` for 20 s | Usage note | Fixed |
| 6 | SoundCraft: master Maximizer default drives mix to -13 LUFS / 0 dBTP; at threshold -6 dB it is -15.2 LUFS but true peak -0.6 dBTP, a bit above the -1 dBTP streaming target | Tuning | Documented, not tuned further |
| 7 | EffectCraft: v2 render took 10x longer than v1 (see Performance) | Unknown | Open |
| 8 | FilmCraft: `sequence.applyAudioTransition` on a 20 s music clip returned a transition id, but I did not verify an audible fade | Unverified | NOT TESTED |
| 9 | Windows PowerShell `Start-Process` loses exit code and CPU time for redirected runs | Tooling | Used wall time and sampled memory only |

No CreateCraft integration code was changed, so no code tests (lint, typecheck, unit) were needed or run for changes.

## Live window control (existing suite)

CreateCraft's opt-in live suite (`CS_LIVE_TESTS=1`, real windows, fixtures) was run once for FilmCraft, LightCraft, EffectCraft,
DesignCraft, WordCraft and SoundCraft: **12 passed, 1 failed** (log: `scripts/live-suite.log`). Connect, open, edit, undo and
save through the real windows therefore work for all seven apps on today's builds, except one assertion:

* **FAIL: DesignCraft "undo then save says Nothing changed".** Re-run alone, same result. Cause found: all seven apps are one
  minor version newer than the audit (PhotoCraft 0.9.0, VectorCraft 0.11.0, LightCraft 0.8.0, EffectCraft 0.10.0, DesignCraft 0.8.0,
  SoundCraft 0.7.0, FilmCraft 0.8.0). DesignCraft 0.8.0 writes `generator`/`version` and two new paragraph-style fields, so any
  re-saved file differs in bytes from a 0.7.1 original, and CreateCraft's byte-identity check then makes a redundant version
  instead of saying "Nothing changed". Headless undo-then-save is byte-identical (checked), so this is a format-bump effect, not
  data loss. Not fixed: a semantic comparison for DesignCraft would be a design change; low severity.

This live suite used the apps' fixtures, **not the VOLTERRA files**; the live-window row is therefore PASS for connect/open/
edit/save of each app in general, and NOT TESTED for these specific project files.

## Remaining limitations and honest caveats

* The car is a **stylized illustration**, not a photo or render; the shots are stills with dissolves, no camera moves, no depth.
* Soundtrack: music is SoundCraft's own synths playing my MIDI; **whooshes, riser and impact are numpy-generated** and imported (documented, free, local). Voiceover is Windows SAPI "David". It is not a mastered production.
* No MP3 output (SoundCraft writes WAV/AIFF/FLAC). Video is H.264 + AAC MP4.
* LightCraft "project" is a library folder (editable), not a single project file.
* EffectCraft scene was built via JSX scripting; its engine commands via MCP exist but were not used for this scene.
* Video, audio and image quality were checked by statistics and a few frame views, not by a human listening/viewing session. Subjective audio quality is **unverified**.
* GPU use was not measured; the apps' own CLIs choose their render path.

## Not tested

* CreateCraft's own Claude Creative Partner driving these seven apps for this production (not run: Tomas's CreateCraft was open; per the project's history a second instance has overwritten data).
* CreateCraft Edit-tab embedding, Deliver tab and Workflow tab on these files.
* Live GUI control with the VOLTERRA files specifically (only the generic fixture suite).
* Audio fade-out audibility; concurrent multi-app stress; long-run stability.
* Cross-app handover **inside** CreateCraft (done here by file paths in a shared folder).

## Potential costs

None incurred. Potential: any use of Veo/Runway/OpenAI/Gemini from CreateCraft's AI Generate (not used). Local Wan model and Motion Effects not used.

## Recommended improvements (priority order)

1. **Run this same production from inside CreateCraft** with Claude (once Tomas closes his instance or uses a scratch profile) to verify the Claude + workflow layer on real multi-app projects, not only the apps.
2. Add DesignCraft text styling (colour, size, font) to CreateCraft's quick edits via paragraph styles (bug 1 workaround proven).
3. Add an overset warning for DesignCraft text edits so Claude/users see "text does not fit" (the engine already reports it).
4. Expose SoundCraft instrument/MIDI building and master loudness (LUFS target) to Claude; the engine supports it.
5. Add EffectCraft scene building through engine commands (not JSX) and investigate the 10x render time seen in v2.
6. A "stills with camera move" helper (CreateCraft's Motion Effects already exists) in the FilmCraft assembly path, so product shots are not static.
7. Record CPU/GPU/memory samples automatically during exports for the Activity panel.

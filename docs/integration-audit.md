# Integration audit — Phase 0

Audited 2026-10-13 on the target workstation. Everything marked **verified** was executed on this
machine. The probe script is [`phase0-probe.mjs`](phase0-probe.mjs); its raw output (scratch paths
redacted) is [`probe-results-2026-10-13.json`](probe-results-2026-10-13.json). All probes ran
headless and wrote only into a scratch directory. No GUI app was launched and no user documents
were opened.

## Environment

| Item | Found |
|---|---|
| OS | Windows 11 Pro 10.0.26200, 64-bit |
| CPU / RAM | Intel i5-12600K, 31.8 GB |
| GPU | AMD Radeon RX 6650 XT + Intel UHD 770 |
| Node / npm | v22.15.1 / 11.12.1 |
| Git | 2.52.0.windows.1 |
| Python | 3.13.5 |
| Shells | Windows PowerShell 5.1, Git Bash |
| Other creative software (not in scope) | Blender 4.0.2, DaVinci Resolve 21, Adobe Creative Cloud 6.10 |

Missing dependencies: none blocking Phase 1. The project's own npm dependencies are installed
locally, and nothing was installed globally.

## Installed ArtCraft apps (publisher: Learning Machines LLC)

All of them install per machine under `C:\Program Files\<App>\` with two binaries: the GUI
`<app>.exe` and a headless `<app>-cli.exe`. The **ArtCraft Launcher** 0.4.0 lives in
`%LOCALAPPDATA%\Programs\ArtCraft Launcher\` and was running during the audit.

| App | Version | CLI headless ops | MCP server (stdio) | Live-app bridge |
|---|---|---|---|---|
| PhotoCraft | 0.8.2 (build d43db3e15, 2026-10-12) | convert, info, run, batch, droplet, commands (892), serve | `photocraft-cli mcp` — 25 tools | `photocraft --control <port>` + `mcp --bridge`; token-protected |
| VectorCraft | 0.10.0 | run, convert, info, commands | `vectorcraft-cli mcp --headless` — 32 tools | `vectorcraft --control 7979` (default) |
| LightCraft | 0.7.1 | run, render, snapshot, merge, commands, controls | `lightcraft-cli mcp` — 17 tools (compact) | `lightcraft --control 7980` |
| EffectCraft | 0.9.2 | info, exec, run, props/get/set, render-frame, render, script (JSX) | `effectcraft-cli mcp` — 27 tools | `--bridge PORT` |
| DesignCraft | 0.7.1 | run, script, commands, describe | `designcraft-cli mcp` — 25 tools | `--connect PORT` |
| SoundCraft | 0.6.1 | info, convert, run, script, commands | `soundcraft-cli mcp` — 17 tools | `app --port P`, `mcp --connect PORT` |
| FilmCraft | 0.7.2 | exec, run, inspect, import, export, render, probe | `filmcraft-cli mcp` — 17 tools | `filmcraft --control PORT` + `--bridge` |

Also installed, but outside the spec's scope for now: CADCraft 0.6.2, DeckCraft 0.6.1, GridCraft
0.6.1, PdfCraft 0.7.1, WordCraft 0.6.1.

File associations are registered for PhotoCraft (`.pcraft`, PSD, images), SoundCraft (`.scraft`)
and others.

### Security-relevant features found in the CLIs

- PhotoCraft, VectorCraft and EffectCraft MCP servers take `--automation-read-root` /
  `--automation-write-root`. These confine the agent's file access, and **a root left out grants no
  access**. CreateCraft must always pass the project root here.
- PhotoCraft's live bridge takes `--control-token` / `--control-token-file` (64 hex characters).
  The main process should generate this token and pass it by file, never through the renderer.
- LightCraft's `denoise-serve` opens a TCP listener. We must never start it.
- EffectCraft `script` runs arbitrary JSX. Treat it as privileged and never route agent text into
  it without review.
- Several MCP servers expose UI-automation tools (`pointer_gesture`, `click`, `type_text`,
  `press_key`). These make **visible edits without cursor movement possible** (the spec's
  principle), but they need the collaboration lock before use.

## Verified end-to-end (headless)

1. **PhotoCraft headless edit pipeline: verified.**
   `photocraft-cli run --new {256×256 white} --cmd edit.fill --params {color #3366ff, 50%} --out smoke.png`
   exited 0 and printed `{"command":"edit.fill","result":{"contents":"color"}}`, writing a 747-byte
   PNG. `convert smoke.png smoke.pcraft` exited 0. `info smoke.pcraft --compact` returned full
   document JSON (size, mode, depth, layer tree, channels).
2. **MCP handshake for all seven in-scope apps: verified.** `initialize` (protocol 2025-06-18)
   followed by `tools/list` succeeded headless for PhotoCraft, VectorCraft, LightCraft, EffectCraft,
   DesignCraft, SoundCraft and FilmCraft. Server names and versions match the installed builds.
3. **Command registry introspection: verified** for PhotoCraft (`commands --json`: 892 commands,
   each with id, menu path, typed param schema string, enabled flag and disabled reason).

## Not yet verified

- **Live GUI control** (`<app> --control <port>` + `mcp --bridge`). This needs the GUI launched
  with a control port, so it is not yet tested. It is the core of Phase 2.
- **Window capture** of a running ArtCraft window (Electron `desktopCapturer`). Not yet tested.
- **`doc_render_preview` / `ui_screenshot` tools.** These exist and could give in-app previews.
  They were not called. They are snapshots, not a live view, and must not be presented as live.
- The `docs/control-protocol.md` that the CLI help references is **not shipped** in the install
  directories. The protocol must be learned from `--help`, `commands --json` and MCP tool schemas.
  The DesignCraft help links to `github.com/storytold/designcraft` and `getartcraft.com`, which
  were not fetched in this audit.
- Licences and EULAs were not inspected. Check before redistributing or bundling anything.
- No ArtCraft MCP server is configured in Claude Desktop or Claude Code on this machine.

## AI generation providers

Bring-your-own-key, checked against the official docs on 2026-10-13. No real key was used and **no
paid call has been made**. Everything below is verified with mocked responses (unit tests) and in
the built app with the offline Mock model and a fake key (smoke tests).

| Provider | Endpoint (official) | Models offered | Price used for the estimate |
|---|---|---|---|
| OpenAI | `POST /v1/images/generations` (JSON), `POST /v1/images/edits` (multipart, with reference pictures); `Authorization: Bearer`; result `data[].b64_json` | `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` | $30 / 1M image output tokens. Tokens per image use OpenAI's own calculator formula (e.g. 1024² medium = 439 tokens ≈ $0.013), plus prompt and reference-image input |
| Google Gemini | Interactions API `POST /v1beta/interactions`; `x-goog-api-key`; `response_format {type:"image", aspect_ratio, image_size}`; image in `steps[].content[]`. One image per call | `gemini-nano-banana-2.1`, `gemini-3.1-flash-lite-image`, `gemini-3.1-flash-image`, `gemini-3-pro-image` | Google's Standard per-image price (e.g. Nano Banana 2.1: $0.0336 at 1K, $0.0504 at 2K, $0.113 at 4K) |

- **Connection test:** lists models only (`GET /v1/models`, `GET /v1beta/models`), which is free.
  The picker then shows only the image models listed for that key. Verified with a fake OpenAI key:
  OpenAI answered 401 and the app showed "the key was rejected".
- **Keys:** encrypted with Electron `safeStorage` (Windows DPAPI) in `%APPDATA%\creative-studio\secrets\providers\`
  by the main process, which reads them straight from the clipboard and then clears it. Keys never
  reach the renderer, logs, project files or Claude. Errors are redacted, including OpenAI's masked
  `sk-abcd****1234` echo.
- **Approval:** every paid call shows a native dialog in main with the provider, model, prompt,
  settings, references and estimated price. Cancel is the default button. The Generate tab and
  Claude's `generate_image` tool use the same path. Verified with the dialog stubbed to Cancel:
  nothing was sent or added.
- Not verified: a real generation with either provider. That needs Tomas's key and his OK.
- Gemini's older `generateContent` route still works, but Google now recommends Interactions. Imagen
  is shut down. `gemini-2.5-flash-image` shut down on 2026-10-02, so it is not offered.
- Midjourney is limited to folder import (spec rule).

## Integration truth table (updated 2026-10-14, Phase 3 "More apps")

| Capability | Status | Evidence / note |
|---|---|---|
| ArtCraft app detection (exe present + `--version`) | **Real, verified** | Implemented in the app's main process (`creative-studio/src/main/artcraftProbe.ts`) |
| PhotoCraft headless edit → .pcraft + .png versions | **Real, verified in app** | `PhotoCraftCliAdapter` (`src/main/photocraftCli.ts`); integration tests against the installed CLI plus a GUI smoke run |
| Workflow Export node | **Real** (when PhotoCraft is installed) | `photocraft-cli convert` into `<project>/exports/`; never overwrites earlier exports |
| MCP handshake, 7 apps | **Real, verified** (audit only) | Probe step 2; app does not yet hold MCP sessions |
| Live GUI control via `--control` bridge | **Real, verified** | `photocraft.exe --control <port>` + `PHOTOCRAFT_CONTROL_TOKEN_FILE` + `PHOTOCRAFT_AUTOMATION_READ_ROOT/WRITE_ROOT` (env vars found in the binary); `photocraft-cli mcp --bridge`. Verified: wrong token → "authentication required"; paths outside roots → "automation path rejected"; open/command/inspect/save/export/ui_screenshot work. Bridge-mode `doc_export` takes the format from the extension only |
| VectorCraft live control | **Real, verified** | `vectorcraft --control <port>` + `VECTORCRAFT_AUTOMATION_READ_ROOT/WRITE_ROOT`; `vectorcraft-cli mcp --connect`. Tools used: open_file, run_command, inspect_document, undo, save_file (saves in the background; we wait for the file), export. **No control token exists**; the port is random per launch and loopback-only |
| SoundCraft live control | **Real, verified** | `soundcraft --control <port>`; `soundcraft-cli mcp --connect <port>`. Tools used: new_session, import_audio, execute, bounce_mix. **No token and no automation roots**; CreateCraft only sends commands from its own table and only writes to the project's work folder |
| App shown inside CreateCraft (Edit tab) | **Real, verified** | Borderless app window owned by CreateCraft and kept over the Edit area (no cross-process reparenting). Live smoke 18/18: placement matches the Edit area within 1 px for all three apps, follows window moves, pop-out/put-back, hides when leaving Edit |
| ArtCraft interface theme sync | **Real, verified** for PhotoCraft (`ui.set` `theme`: pro, proMedium, studio, studioLight, …; read back via `ui_inspect`), VectorCraft (`prefs.set uiBrightness`: dark/mediumDark/mediumLight/light), SoundCraft (`ui_set` `{state:{theme}}`: system/light/dark). FilmCraft (`prefs.set appearance.colorTheme`: darkest/dark/light), LightCraft (`lightcraft-cli run --connect … ui.set {settings:{appearanceMode}}`: dark/light), EffectCraft (`prefs.set appearance.appearanceMode`: dark/light), DesignCraft (`ui_set brightness`, read back via `ui_inspect`). Each set and read back in the live tests. Measured palettes: PhotoCraft proMedium #282828 / #535353 / #424242; studioLight #e2e2e6 / #f6f6f8 / #fcfcfd; SoundCraft dark #1e1e1e / #252526 |
| FilmCraft live control (video in the Edit tab) | **Real, verified** | `filmcraft --control <port> --empty --no-recover --data-dir <work>`; `filmcraft-cli mcp --bridge`. **No token and no automation roots.** Each open: media_import + `file.newSequence fromItem`. Quick edits verified live: trim (ripple `timeline.trim`, linked audio follows), speed (`clip.speedDuration`), volume (`clip.audioGain`), fades (dip-to-black / constant-power transitions), black & white, saturation (lumetri). Undo, playhead, clip select, timeline read (`sequence_inspect`) shown under the Edit area. Save = `file.exportMedia` H.264 MP4 |
| LightCraft live control (Color tab) | **Real, verified** | `lightcraft --control <port> --memory --no-demo` (throwaway session; the user's LightCraft library is not touched); `lightcraft-cli mcp --connect`. Imports a copy from the work folder. Verified: auto, exposure/contrast/highlights/shadows, vibrance/saturation, clarity/dehaze, vignette, black & white, 15 built-in looks, reset, undo. Save = `app.export` full size |
| EffectCraft live control (Effects tab) | **Real, verified** | `EFFECTCRAFT_CONTROL_PORT`; `effectcraft-cli mcp --bridge` with `--automation-read-root/--automation-write-root`. Never uses `script`. Verified: glow, gaussian blur, brush strokes, cartoon, posterize, add title, undo. Save = render queue H.264 MP4 (video) or `render_frame` PNG (picture); an unchanged save makes no new version |
| DesignCraft live control (.designcraft in the Edit tab) | **Real, verified** | `designcraft --control <port>`; `designcraft-cli mcp --connect`. Open, history, undo, save as a new .designcraft + PNG of page 1. No quick edits: you edit with DesignCraft's own tools |
| Phase 3 end-to-end in CreateCraft | **Real, verified** | `scripts/smoke-apps.mjs` 2026-10-14: 20/20 (video thumbnails needed `stream: true` on the asset protocol). Every app window the test opens is closed afterwards |
| Edit lock / pause / take control / resync on live doc | **Real, verified** | `src/main/liveTask.ts`; unit tests + live integration tests + GUI live smoke (5/5) |
| Live window capture | **Untested** | `WindowCapture` interface only; UI shows "not connected" |
| Workflow "ArtCraft Edit" node in the app | **Real** (headless PhotoCraft) | Falls back to a labelled MOCK only if photocraft-cli.exe is missing; commands limited to an allowlist (adjustments, filters, rotations, fill) |
| AI Generate tab (OpenAI, Gemini, Mock) | **Real code, mock-verified**; no paid call made yet | `src/main/generation.ts`, `src/main/imageApis.ts`, `src/shared/generation.ts`; unit tests with mocked HTTP; smoke 16/16 (Mock generation, key entry, approval gate, Open in Edit) |
| Claude `generate_image` / `list_image_models` tools | **Verified** with Mock + cancelled OpenAI request (5/5) | Same approval dialog; Claude never sees keys |
| Workflow AI Generate node | **Mocked** | Still `MockGenerationProvider`; not yet wired to the real providers |
| Claude Creative Partner (chat panel) | **Real, verified** (signed in with claude.ai, 2026-10-13: Claude looked at the document, applied Black & white in PhotoCraft, replied, lock released; usage reported $0.083) | Claude Agent SDK 0.3.296 (`@anthropic-ai/claude-agent-sdk`) runs Claude Code with this PC's Claude Code sign-in (no API key stored by CreateCraft). No built-in tools (`tools: []`), no user settings (`settingSources: []`), only CreateCraft's in-process tools (get_status, look_at_document, apply_edit, photocraft_command, undo, save_version, list_files, open_file) under the shared edit lock. Verified end-to-end up to authentication: the standalone Claude Code CLI on this PC reports `loggedIn: false`, so a real edit by Claude is untested until the user signs in |
| Claude controls all 7 ArtCraft apps | **Real, verified** (2026-10-14, signed-in Claude Code) | `open_file` takes an optional `app` (validated against the file type), so Claude picks the app and hands a saved version on to the next one; the main window follows to that app's tab. `get_status` lists every app and adds app details (FilmCraft timeline, DesignCraft page text). Edits are the same verified quick edits as the UI (plus the PhotoCraft allowlist), under the edit lock and versioning. DesignCraft gained Replace text (`find.change`) and Add a line of text (`frame.create` + `find.change` attrs on the new story), verified headless and live. `scripts/smoke-claude-apps.mjs`: one real request per app plus a PhotoCraft → LightCraft hand-off, 15/15 across two runs (first run 14/15 found a tab re-open race, fixed, then the affected four rerun 9/9); about $3.80 of Claude usage |
| Audio tab (SoundCraft live) | **Real, verified** | Sounds open in SoundCraft embedded in the Audio tab (the Edit tab still opens them there too). Timeline under it from `inspect_session` (clips, gain, fades, mute) with the real waveform decoded in the renderer (Web Audio via the asset protocol, which now sends CORS headers); ruler click = `transport.locate {at: samples}`; history from SoundCraft's own `engine.history`, so hand edits show. Live test + smoke 13/13. VectorCraft and SoundCraft are now opened live by the tabs (they were still on the old working-copy mode, so the Edit tab did not open SVG/WAV) |
| Deliver tab (export queue) | **Real, verified** | 24 presets across pictures, vector, audio, video and layouts, each run headless by the app's own CLI (no window): `photocraft-cli convert/run image.imageSize`, `vectorcraft-cli convert`, `soundcraft-cli convert`, `filmcraft-cli run` (newProject, import, newSequence fromItem 1, exportMedia wait), `designcraft-cli run --export`. One job at a time, cancel, never overwrites, exports/manifest.json records source, version history, preset and SHA-256; Show in folder. Every preset checked against the real tools in `deliver.test.ts` (headers, sizes, durations). Not available: MP3 (SoundCraft writes WAV/AIFF/FLAC only) |
| Claude exports | **Real, verified** | `list_export_formats` / `export_file` use the same queue and manifest (marked "asked by Claude"); real request "Export sunset-flyer.designcraft as a PDF" → exports/sunset-flyer.pdf; Claude audio fade in SoundCraft with the window following to the Audio tab ($0.21) |
| Multi-clip video (FilmCraft) | **Real, verified** | Clip toolbar under the Edit area and Claude tools (`timeline_add`, `timeline_move_clip`, `timeline_remove_clip`): `media_import` + `timeline.place` at the end of V1 (sound on A1; pictures 3 s), music on the first free audio track from 0 with sync lock off (so insert-moves don't shift it), named Music and fitted to the picture (trimmed, or extended again when clips are added); reorder = `timeline.move` insert + linked; remove = `edit.rippleDelete`. New quick edits: Crossfade between clips (`cross_dissolve` + `constant_power` at every cut), Music volume; fades include the music. Live test (add, music first then still, reorder by Claude and by hand, remove, crossfades, undo, save 7 s MP4) and smoke 8/8 with a real Claude request building a 3-clip video with music and crossfades ($0.46 across runs). New fixtures: aurora-clip.mp4 (FilmCraft demo), groove-loop.wav (SoundCraft demo mix) |
| Workflow tab, step one (batch, cross-app, export, approval) | **Real, verified** | Files step: several library files or a folder (copied into the library; folder only read). App step: any of the 7 apps with its verified quick edits, run with NO window: PhotoCraft/VectorCraft/SoundCraft via their headless CLIs (AppEditors), FilmCraft/LightCraft/EffectCraft/DesignCraft via their CLI's own MCP engine (`filmcraft-cli --data-dir … mcp`, `lightcraft-cli mcp` in-memory, `effectcraft-cli mcp` with automation roots, `designcraft-cli mcp`). Each step picks the version the app can open (e.g. the PNG of a .pcraft); files an app can't open stop there, others carry on. Steps run file by file, step by step; Approval shows every file's result as a thumbnail and passes on only the ticked ones. Export: any of the 24 Deliver presets (formats that don't fit a file are skipped), same queue and manifest, marked "workflow". Tests: headless engines run every quick edit (`headlessApps.test.ts`), real cross-app workflows (`workflowSteps.test.ts`: photos PhotoCraft→LightCraft→approve→web JPEG+PNG; video FilmCraft→EffectCraft→MP4+GIF; sounds→FLAC; SVG→PDF+PNG; layout→PDF; folder with partial approval), runner batch tests, smoke 7/7 with no ArtCraft window. AI Generate node still MOCK (step two) |
| Credential vault | **Real, verified** | `SafeStorageVault` (`src/main/credentialVault.ts`): DPAPI-encrypted files, main process only; smoke checks that the file on disk does not contain the key and the renderer never receives it |
| Midjourney automation | **Blocked by policy** | Import from a user-chosen folder only |
| SQLite asset index | **Deferred** | Phase 1 uses a JSON manifest; see `creative-studio/docs/architecture.md` |

## Audit of five more ArtCraft apps (2026-10-15, this PC, all 0.6-0.7 builds)

All five installed in `C:\Program Files\<App>\` (`<app>.exe` + `<app>-cli.exe`), none running during the audit.
Real runs only (scratch files, no CreateCraft project touched, no paid call).

| App | Version | Native files | Headless CLI (verified) | MCP tools (headless `mcp`) | Live control (verified) | Token |
|---|---|---|---|---|---|---|
| CADCraft | 0.7.0 | .dxf (read/write), .dwg (convert both ways) | `convert` DXF to dxf/dwg/svg/png(2400x1600)/pdf; `info`; `run --cmd 'id {json}' --save --export`; `sample bracket|floorplan` | 12 (`command_line, script, execute, inspect_drawing, query_entities, render, open, save...`), 426 commands | `cadcraft --control PORT` + `cadcraft-cli mcp --connect 127.0.0.1:PORT`: open, inspect, screenshot ok | none |
| FigCraft | 0.6.0 | .figcraft; imports .json, .fig (best effort), .svg, png/jpg/webp/gif/bmp | `export` png/jpg/svg/webp/pdf/fig (+ bleed, crop marks, CMYK), `convert`, `render`, `run script.json` | 18 (`run_command, batch, create_node, set_properties, inspect_document, export, screenshot, open_file, save_file, undo/redo`...) | `figcraft --control PORT` + `figcraft-cli mcp --attach PORT`: open, inspect, screenshot ok | none |
| WordCraft | 0.7.0 | .docx (also read .doc) | `convert` docx to pdf/html/md/txt/odt/rtf/png/tex/json/xml; `info`, `text`, `inspect`, `render --page`, `run --file --cmd --save` | 16, 617 commands; `--automation-read-root/-write-root` for headless | `wordcraft --control PORT` + `wordcraft-cli mcp --connect 127.0.0.1:PORT`: open, inspect, screenshot ok | none (roots only headless) |
| DeckCraft | 0.7.0 | .deckcraft; converts to/from .pptx | `render --slide N|--all` png, `convert` to pdf/pptx/png, `run --in --cmd --save --export`, `info` | 25 (`open/save_presentation, export, inspect_slide, render_slide, add_slide, add_text_box, set_text, insert_*`...), 234 commands | `deckcraft --control PORT` + `deckcraft-cli mcp --connect PORT`: open, inspect, screenshot ok | none |
| GridCraft | 0.7.0 | .xlsx | `convert` xlsx/csv/tsv/json/html, `eval`, `cat`, `check`, `run --in --cmd --out --print`, `info` | 21 (`read_range, write_range, set_cell, evaluate_formula, format_range, insert_chart, ...`), 341 commands | `gridcraft --control PORT` + `gridcraft-cli mcp --connect PORT`: open, inspect ok; `screenshot` needs a `path` argument | none |

Not yet verified: app-interface theme sync (commands exist: FigCraft `view.themeLight/Dark/System`, WordCraft `view.darkMode`;
none found for CADCraft, DeckCraft, GridCraft), saving from a live window, and any Edit-tab embedding of the new windows.
Every live check used the app's own window opened by the audit and closed afterwards.

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

## Integration truth table (updated 2026-10-13, Phase 2 steps 1–2)

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
| ArtCraft interface theme sync | **Real, verified** for PhotoCraft (`ui.set` `theme`: pro, proMedium, studio, studioLight, …; read back via `ui_inspect`), VectorCraft (`prefs.set uiBrightness`: dark/mediumDark/mediumLight/light), SoundCraft (`ui_set` `{state:{theme}}`: system/light/dark). **Available but not used yet:** DesignCraft (`ui_set brightness`), FilmCraft (`prefs.set appearance.appearanceMode`), LightCraft (`settings.appearanceMode`, seen in live `ui.inspect`). **None found:** EffectCraft. Measured palettes: PhotoCraft proMedium #282828 / #535353 / #424242; studioLight #e2e2e6 / #f6f6f8 / #fcfcfd; SoundCraft dark #1e1e1e / #252526 |
| Edit lock / pause / take control / resync on live doc | **Real, verified** | `src/main/liveTask.ts`; unit tests + live integration tests + GUI live smoke (5/5) |
| Live window capture | **Untested** | `WindowCapture` interface only; UI shows "not connected" |
| Workflow "ArtCraft Edit" node in the app | **Real** (headless PhotoCraft) | Falls back to a labelled MOCK only if photocraft-cli.exe is missing; commands limited to an allowlist (adjustments, filters, rotations, fill) |
| AI Generate tab (OpenAI, Gemini, Mock) | **Real code, mock-verified**; no paid call made yet | `src/main/generation.ts`, `src/main/imageApis.ts`, `src/shared/generation.ts`; unit tests with mocked HTTP; smoke 16/16 (Mock generation, key entry, approval gate, Open in Edit) |
| Claude `generate_image` / `list_image_models` tools | **Verified** with Mock + cancelled OpenAI request (5/5) | Same approval dialog; Claude never sees keys |
| Workflow AI Generate node | **Mocked** | Still `MockGenerationProvider`; not yet wired to the real providers |
| Claude Creative Partner (chat panel) | **Real, verified** (signed in with claude.ai, 2026-10-13: Claude looked at the document, applied Black & white in PhotoCraft, replied, lock released; usage reported $0.083) | Claude Agent SDK 0.3.296 (`@anthropic-ai/claude-agent-sdk`) runs Claude Code with this PC's Claude Code sign-in (no API key stored by CreateCraft). No built-in tools (`tools: []`), no user settings (`settingSources: []`), only CreateCraft's in-process tools (get_status, look_at_document, apply_edit, photocraft_command, undo, save_version, list_files, open_file) under the shared edit lock. Verified end-to-end up to authentication: the standalone Claude Code CLI on this PC reports `loggedIn: false`, so a real edit by Claude is untested until the user signs in |
| Credential vault | **Real, verified** | `SafeStorageVault` (`src/main/credentialVault.ts`): DPAPI-encrypted files, main process only; smoke checks that the file on disk does not contain the key and the renderer never receives it |
| Midjourney automation | **Blocked by policy** | Import from a user-chosen folder only |
| SQLite asset index | **Deferred** | Phase 1 uses a JSON manifest; see `creative-studio/docs/architecture.md` |

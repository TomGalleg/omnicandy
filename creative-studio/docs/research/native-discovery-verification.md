# Native command discovery verification (read-only)

Run 2026-10-20 on this PC. Only CLI discovery subcommands were run (`commands`, `commands --json`, `tools`), headless, no windows, no documents opened, no editing/export/generation commands, no project files touched. The MCP `command_list` fallback was **not** needed and not exercised.

All 13 apps are installed as `C:\Program Files\<App>\<app>-cli.exe`.

| App | Discovery method used by CreateCraft driver | Output | Commands | Result |
|---|---|---|---|---|
| PhotoCraft | `photocraft-cli commands --json` (new `LivePhotoCraft.listCommands`, `src/main/photocraftLive.ts`) | JSON array, every entry has string `id` (+ label, params, enabled, needsDocument, menu, shortcut) | 918 | PASS |
| VectorCraft | `vectorcraft-cli commands` (`LiveAppBase.listCommands`, `liveApps.ts:109`) | JSON | 785 | PASS |
| SoundCraft | `soundcraft-cli commands` | plain lines (`--json` prints nothing; driver does not use it) | 480 | PASS |
| FilmCraft | `filmcraft-cli commands` | plain lines (`--json` works too) | 701 | PASS |
| LightCraft | `lightcraft-cli commands` | plain lines, 2 per command | 371 | PASS (format note) |
| EffectCraft | MCP `tools/list` + `effectcraft-cli commands` (override `liveApps.ts:594`) | CLI part: plain lines. MCP part not run | 731 (CLI) | PASS (CLI part) |
| DesignCraft | `designcraft-cli commands` | JSON (`--json` returns `[]`; driver does not use it) | 521 | PASS |
| WordCraft | `wordcraft-cli commands` | plain lines | 629 | PASS |
| PdfCraft | `pdfcraft-cli tools` (override `liveApps.ts:894`); CLI has **no** `commands` subcommand | JSON tool list (before the driver's blocklist) | 170 | PASS |
| GridCraft | `gridcraft-cli commands` | plain lines, 2 per command | 341 | PASS (format note) |
| DeckCraft | `deckcraft-cli commands` | plain lines (`--json` prints nothing) | 321 lines | PASS |
| FigCraft | `figcraft-cli commands` | plain lines, 2 per command (some ids end in `*`) | 569 | PASS (format note) |
| CADCraft | `cadcraft-cli commands` | JSON (`--json` is an unknown option; driver does not use it) | 426 | PASS |

**Result: 13 of 13 PASS, 0 FAIL, 0 NOT INSTALLED.** Every installed app returns a non-empty, parseable catalog through the method its driver already uses.

## Findings

1. **The earlier "likely gap" for FilmCraft, WordCraft, GridCraft, DeckCraft, FigCraft and CADCraft is disproved.** The audit's CLI tables omitted `commands`, but all six implement it. The MCP `command_list` fallback is not needed for any installed app.
2. **PhotoCraft** returns 918 commands now (the 2026-10-14 audit recorded 892; the app was updated). `commands --json` is valid and matches what the new `listCommands` expects.
3. **PdfCraft** is the only app without a `commands` subcommand, and its driver already uses `tools`, so it is correct.
4. **Format quality issue (not a failure).** For LightCraft, GridCraft and FigCraft the plain output uses two lines per command (an id/label line, then an indented params line). The base `listCommands` fallback in `liveApps.ts` (the "not JSON" branch) treats every line as a row. Effects: the 80-row cap shows only about 40 commands, and a filter can match a params line that is shown without its command id. Plain-line apps with one line per command are unaffected. A fix would pair id and params lines before filtering. DeckCraft, SoundCraft, FilmCraft, WordCraft and EffectCraft were not inspected line by line for this.
4. `--json` support differs per app (works: PhotoCraft, FilmCraft, LightCraft, EffectCraft, WordCraft, GridCraft, FigCraft; empty or unsupported: SoundCraft, DeckCraft, DesignCraft, CADCraft). Drivers other than PhotoCraft do not rely on it.

## Not verified

- The MCP route (`tools/list`, `command_list`) for any app, including EffectCraft's override.
- That an ID returned by discovery runs successfully (no commands were executed).
- Whether `app_commands` through the harness shows the PhotoCraft result in practice (needs a live run).

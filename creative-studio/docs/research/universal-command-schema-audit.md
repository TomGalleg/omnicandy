# Universal command schema audit (read-only, 2026-10-21)

Scope: all 13 installed Craft apps. Method: `<app>-cli commands` (and `--json` / `describe <id>` where they exist; PdfCraft via its MCP `tools/list`), parsed with the committed `commandDiscovery.ts`; exact-id lookups via `formatDiscoveredCommands`; schemas checked with the committed `nativeCommandValidation.ts` (empty params must not be rejected for schema reasons, an unknown param must be reported as unknown). No command was executed, no document opened, no model called. Raw samples: `universal-command-schema-samples.zip`.

## Per-app table

| App | Source | Commands | Params format | Validatable now | Notes |
|---|---|---|---|---|---|
| PhotoCraft | `commands --json` | 918 | DSL string | 866 | no `describe` |
| VectorCraft | `commands` (JSON) | 785 | DSL string | 524 | 35 schemas >1000 chars, 3 >4000 (max 5,531) |
| DesignCraft | `commands` (JSON), `describe` ok | 521 | DSL string | 424 | |
| CADCraft | `commands` (JSON) | 426 | DSL string | 290 | 28 without params; 9 ids start with `-` or a digit |
| PdfCraft | MCP `tools/list` (no `commands` subcommand) | 170 | real JSON Schema | 170 | 9 schemas >1000 chars; ids are `tool:<name>` |
| FilmCraft | plain; `--json` ok; `describe` ok | 701 | DSL (only in `--json`) | 0 plain / 682 with `--json` | |
| LightCraft | plain; `--json` ok | 371 | DSL (only in `--json`) | 0 / 332 | no `describe` |
| EffectCraft | plain; `--json` ok | 731 | DSL (only in `--json`) | 0 / 473 | 120 commands have no params |
| WordCraft | plain; `--json` ok | 629 | DSL (only in `--json`) | 0 / 597 | no `describe` |
| GridCraft | plain; `--json` ok | 341 | DSL (only in `--json`) | 0 / 310 | no `describe` |
| FigCraft | plain; `--json` ok | 569 | DSL (only in `--json`) | 0 / 466 | ids carry a `*` in plain output |
| SoundCraft | plain; `--json` unsupported; `describe` ok | 480 | DSL (only via `describe`) | 0 from catalog | |
| DeckCraft | plain; `--json` unsupported; `describe` ok | 321 | DSL (only via `describe`) | 0 from catalog | |

Totals: 6,793 commands in 12 CLI catalogs, plus 170 PdfCraft tools. Validatable from the catalog as used today: 2,274 of 6,963. With `commands --json` for the six apps that support it, a further 2,860 would be validatable (of 3,342).

## Answers to the audit questions

1. **Counts:** above. No duplicate ids and no case-only duplicates in any app.
2. **Descriptions:** every command has a label in every app. Only PdfCraft returns a proper long description (as MCP tool descriptions); other apps give a short label plus the parameter text.
3. **Required / allowed values / min / max:** present only as the app's own DSL text, never as structured fields, except PdfCraft (JSON Schema). Ranges appear as `a..b`, enums as `a|b|c`, defaults as `=value`. Optional is marked with `?`, and the marker position varies: after the key (`name?:`), after the type (`"layer":id?`), or implied by prose. Required is nowhere stated explicitly.
4. **Exact-id lookup (`app_commands`):** returns the complete catalog entry, with parameters, for all 13 apps, with no truncation: the longest schema is 5,531 chars (VectorCraft) and the 7,500-char reply cap is not hit. Two caveats:
   - For the eight plain-text apps the lookup runs on the plain catalog, whose parameter lines are folded into the label, so it returns no `params` field. Preflight therefore reports "unavailable" for those apps (SoundCraft, FilmCraft, DeckCraft and DesignCraft use `describe`, so their exact lookups return real JSON).
   - The `describe` path cuts replies at 4,000 chars (`liveApps.ts`); no current `describe` reply exceeds that.
5. **Missing, truncated or ambiguous:**
   - Plain-text catalogs: parameter text is present in the raw output but the parser merges it into the label (FilmCraft, LightCraft, EffectCraft, WordCraft, GridCraft, FigCraft, SoundCraft, DeckCraft); labels longer than 150 chars are cut in the catalog row view.
   - CADCraft: 9 commands whose ids begin with `-` or a digit (`-vports`, `-block`, `-attedit`, `-xref`, `-group`, `-linetype`, `-plottermanager`, `3dpoly`, `3dorbit`). `appCommandTier` treats them as `never` and the plain-text id pattern would drop them, so they cannot be called.
   - 1,057+ DSL schemas contain prose, alternatives (`{path} | {data: base64, name}`) or nested objects the normalizer cannot parse; these fail closed.
6. **Executable id vs discovery id:** for the six apps that support `--json`, the plain ids equal the `--json` ids exactly (after the parser strips FigCraft's trailing `*` undoable marker). I could not confirm the id each command executes under without running commands.

## Confirmed problems

1. The plain `commands` call used by `LiveAppBase.listCommands` (`liveApps.ts`) throws away parameter schemas for six apps whose `--json` output has them. Preflight is therefore `unavailable` for most of those apps' commands.
2. Parameter schemas are free-text DSLs. Four JSON-catalog apps ship them as strings; the validator covers about 60 percent of VectorCraft/DesignCraft/CADCraft commands.
3. No explicit required-parameter information in any DSL.
4. SoundCraft and DeckCraft have neither `--json` nor a structured parameter field in the catalog; schemas are reachable only per command through `describe`.
5. CADCraft's 9 dash/digit ids are unreachable.
6. Very long schemas (VectorCraft up to 5,531 chars, PdfCraft up to 2,925) approach the 4,000-char `describe` cap.

## Recommended shared fixes

1. **Use `commands --json` first** in `LiveAppBase.listCommands`, falling back to plain text (adds ~2,860 validatable commands for six apps without any app change).
2. **For SoundCraft and DeckCraft**, fetch `describe <id>` on exact-id lookups (already done) and feed it to preflight; consider a one-time describe-all cache.
3. **Normalize all schemas to one internal shape** (type, required, enum, min, max, nested) in one place, and keep the original DSL text next to it so the model still sees it.
4. **Treat `?` placement and `|` alternatives** in the normalizer as first-class forms; mark anything it cannot parse as `unavailable` with the raw text rather than `rejected`.
5. **Accept ids that start with `-` or a digit** in `appCommandTier`, the plain-text id pattern, and the preflight id check, or document them as unsupported.
6. **Raise the `describe` reply cap** above the longest known schema (use 8,000, matching the detail cap), and report truncation explicitly if it ever happens.
7. **Ask the app vendors** for an explicit `required` list and numeric constraints as structured fields, as PdfCraft's MCP already provides.

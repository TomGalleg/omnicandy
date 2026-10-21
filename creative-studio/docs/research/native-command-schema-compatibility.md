# Native command schema compatibility (read-only check, 2026-10-20)

Method: for each installed Craft CLI, ran `<app>-cli commands` (PhotoCraft: `commands --json`), parsed it exactly as `listCommands` does (JSON, else `parsePlainCommandCatalog`), then sampled 4 commands with parameters plus 1 without. Detail text was taken as `liveApps.listCommands` would return it for an exact id (`describe <id>` first, except PhotoCraft; otherwise `formatDiscoveredCommands`). Each detail was run through `validateNativeCommandDetail` with `{}` and with an unknown parameter (expected: accepted-or-missing-required, and "Unknown parameter"). No document was opened and no command executed.

| App | Catalog | Commands | Sample pass | Result |
|---|---|---|---|---|
| PhotoCraft | json | 918 | 0/4 | FAIL (194/918 validatable overall) |
| VectorCraft | json | 785 | 0/4 | FAIL (21/785 validatable overall) |
| DesignCraft | json | 521 | 0/4 | FAIL |
| CADCraft | json | 426 | 0/5 | FAIL |
| SoundCraft | plain | 480 | 0/1 | FAIL |
| FilmCraft | plain | 701 | 0/1 | FAIL |
| LightCraft | plain | 371 | 0/1 | FAIL |
| EffectCraft | plain | 731 | 0/1 | FAIL |
| WordCraft | plain | 629 | 0/1 | FAIL |
| GridCraft | plain | 341 | 0/1 | FAIL |
| DeckCraft | plain | 321 | 0/1 | FAIL (`describe` text is not JSON) |
| FigCraft | plain | 569 | 0/1 | FAIL |
| PdfCraft | n/a | n/a | n/a | FAIL: CLI has no `commands` subcommand |

Passing: 0 of 13 apps in the sample. (PhotoCraft's simple commands, e.g. `image.adjustments.brightnessContrast`, do validate; confirmed live.)

## Causes
1. **Plain-text catalogs (8 apps)**: `parsePlainCommandCatalog` folds the parameter line into `label`, so entries have no `params`; the validator reports "parameter schema unavailable or malformed" (fails closed).
2. **JSON catalogs with prose or union params (PhotoCraft, VectorCraft, DesignCraft, CADCraft)**: `params` is a free-text DSL string, e.g. `{"depth":8|16|32=8,...}`, `{} → {dropped, offset} (...)`, `{preset?: ..., name?|title?: ...}`. `parseCompactParams` rejects these, so only simple `{key:min..max=default}` shapes validate.
3. **`describe` output** (SoundCraft, FilmCraft, DesignCraft, DeckCraft): returned verbatim as the detail text; for DeckCraft it is not JSON at all. The validator expects `{id, params}`.
4. **PdfCraft**: no command discovery via CLI.

## Scope note
`validateNativeCommandDetail` is wired only into the PhotoCraft path (`liveTask.ts` `claudePhotoCraftCommand`). Other apps do not call it, so these failures do not block them today; they would if validation were extended.

Suggested follow-up (not done): make the validator fail open-with-warning or skip for unparseable DSL, and parse `?` optional markers, `a|b` unions and trailing `→ {...}` return docs; keep param text for plain catalogs.

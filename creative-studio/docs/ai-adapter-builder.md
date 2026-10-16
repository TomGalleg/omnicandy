# AI Adapter Builder

A user tells CreateCraft which program they want to connect. CreateCraft researches how that program can be controlled, has
Claude write a small integration, tests it, shows the user exactly what it may do, and installs it only after the user approves.
Everything is **private to this computer**. There is no marketplace, catalogue, sharing, publishing, upload or community account of any kind.

It sits on the existing Universal Connect framework and changes none of it: the 13 native Craft apps, manifest v1/v2, the
`.ccadapter` package manager, the installation manager, the authenticated bridge, the permission model, `external_apps` /
`external_run` / `external_job`, and the Blender, FreeCAD, Resolve and Revit integrations are unchanged.
(Docs for those: `external-integration-sdk.md`, `universal-installer.md`, `installation-profiles.md`.)

## The user's path

Settings > Integrations > **Create Custom Integration** (below Connect Applications).

1. Choose how to begin: **an installed program that has no integration yet** (from Windows' own list of installed programs, local only), or **type any program name**, installed or not. Optionally say what you want to do and add documentation or an SDK folder.
2. **Create Integration.** The notice says what leaves the computer: the program name and any documentation you chose go to Claude (your Claude sign-in). Nothing else.
3. Understandable progress: *Checking application compatibility, Researching…, Preparing connector, Building integration, Testing safely, Ready for your approval*.
4. The result says in plain words what it can do, what you would be allowing (the usual plain permission wording), what was checked, and that the trial run used a pretend program. **Advanced** holds the checks, sources, generated files (manifest, connector, program script), log, versions and diagnostics.
5. **Review and approve installation** opens the *normal* package review (unsigned warning, per-permission boxes) and the *normal* native confirmation. Claude cannot answer either.
6. **Connect and test on the real program**: Universal Connect connects, then the live tests run; every command still asks first because generated packages are unsigned.
7. Claude can then use it through `external_apps` / `external_run`.

If something needs manual action the result says exactly what (install the program, add documentation, …).

## Architecture

```
Settings UI (builder/*.tsx)  ->  IPC builder:*  ->  BuilderService (integrations/builder/service.ts)
                                                      |-- Author            Claude (Agent SDK, user's sign-in)  |  ScriptedAuthor (tests, proofs)
                                                      |-- Blueprint         strict JSON: the ONLY thing the AI returns (blueprint.ts)
                                                      |-- Templates         CreateCraft's fixed code: python-script, cli, file-exchange, add-in source
                                                      |-- Pipeline          static -> security -> simulated (validate.ts, simulate.ts)
                                                      |-- existing          AdapterPackages review/install, manager, bridge, permission store
                                                      '-- Store             <userData>/integrations/builder/projects/<id>/... (local only)
```

**The AI never writes a package.** It returns a *blueprint* (data). CreateCraft's templates produce `main.js`, the manifest and the
runtime; the only AI-written lines in an installable package are one Python `run` and one `verify` function per command (python
template), which the validators check before the package exists. Command lines (cli template) and file templates (file-exchange) are
data filled into fixed code.

### Templates

| Template | What it makes | Installable? | Verified how |
|---|---|---|---|
| `python-script` | Python job run inside the program (FreeCADCmd, Blender background mode, or a described custom program). Fixed `main.js` + fixed runtime + AI `run`/`verify` per command. Two phases: *run*, then an independent *verify* in a **fresh process** | yes | live on real FreeCAD 1.1.4 (below) |
| `cli` | Fixed typed argument lists for a documented command line; settings substituted as single validated arguments (no shell), unique output names, optional independent read-only check call | yes | simulated only; ImageMagick proof is not installed here |
| `file-exchange` | Writes a file in a documented format (JSON/XML/pattern checked) for the program to open | yes | simulated only; cannot prove the program accepts the file |
| `dotnet-addin`, `uxp-plugin` | Source for an add-in inside the program, a capability contract and a scan of the source | **no (source for review only)** | not built, not run |

The host table (`builder/hosts.ts`) is CreateCraft's: FreeCAD and Blender rows (launch line, version probe, host modules, recognised
API names). A "custom" Python host is described by the blueprint but checked against strict rules (no inline-code flags, `{run}` exactly once).

### Choosing the method

The research step reports which methods exist and how official they are; the generation step picks per the framework rules:
official API/scripting, then command line, then file exchange; **never UI automation or screen scraping**. If the only way is unsafe or
unsupported it must answer `feasible: false` with a reason: the project is then *Cannot be integrated safely* and nothing is built.
Not enough trustworthy information ends as *Needs documentation* (nothing generated; the user can add docs). Web research that
fails without user documentation stops the same way: CreateCraft will not guess.

### The test pipeline (`pipeline.ts`)

| Stage | Checks |
|---|---|
| 1 Static | decision and research present; unique typed commands; limits/defaults sane; example inputs satisfy the typed settings; manifest and package parsed by the installer's own reader (SDK range, hashes, strict schema); `main.js` compiles; assembled Python compiles; Python syntax; add-in source layout |
| 2 Security | permissions inspected against what the template allows (never `network`, `launch`, `ui-automation`); destructive commands flagged; AI code scanned by a Python **syntax tree** checker plus a text scan (no processes, files, network, `os`/`sys`/…, `eval`/`exec`/`open`/`getattr`, dunder access, classes, path/URL strings, undeclared imports; classes of escape routes, not a sandbox); command lines checked (no shell metacharacters, list files, URLs, paths, run-text flags); **every function/class/option used must be documented**: each command cites symbols with URLs that must be among the research sources, and the code's actual module symbols and called methods must be covered by those citations; names CreateCraft does not recognise are flagged; package integrity (exact file list, SHA-256, no unlisted files); fixed publisher identity and `custom.` id; add-in source scan |
| 3 Simulated | the package is installed in a scratch profile through the real `AdapterPackages`/manager/restricted process against a **MOCK program** (`mockHost.ts`): connect + health, every command with its example inputs, independent-check phase, unsigned = asked every time, invalid input refused, a crashing program then recovery, **timeout**, **cancellation**, uninstall removes everything. Always labelled *Simulated*; "tested" is never claimed |
| 4 Live | only with the real program installed: connect through Universal Connect, verify the version, `app.health`, each command's live test (reads first, then a small edit with a unique name), independent verification, reconnect after disconnect, an optional outside check |

A failing static or security stage stops the pipeline (no package exists). When Claude is the author it gets up to two chances to
correct itself with the failing checks as input.

### Verification truth

`verification.json` records, **per command and per program version**, `verified | failed | untested`, with the evidence. Only stage 4
writes it, only after a real run whose result was independently re-checked. Changing a command's code (repair) clears that command's
record; untouched commands keep theirs. Statuses: *Awaiting live verification* (mock only / program missing), *Ready for your
approval*, *Installed, not tested on the real program*, *Tested on the real program*, *Needs repair*.

## Security

Preserved unchanged: package integrity (SHA-256 of every file), strict manifest schema (no scripts, paths, hooks), publisher identity,
explicit permission approval with a ceiling, per-command authorization, runtime isolation (OS-enforced Node permission model, minimal
environment), crash recovery (3 crashes in 10 minutes turns it off), install rollback, Repair from the saved original.

Added: generated packages are **always unsigned, always labelled "Created on this computer (AI-generated)"** (the AI cannot choose
a publisher or an official-looking id; ids start `custom.`), so they are asked about **before every command** with no "always allow".
The AI cannot grant itself permissions, install, write to protected folders or change settings: it has no install tool (the Claude tools
`integration_builder_start/status` only *start* a build after a native dialog and read status), permissions are limited per template,
output files are always new (existing files are never overwritten), and installing needs the native confirmation. No generated code is
ever submitted anywhere; only the program name and documentation you chose go to Claude.

**Not provided** (see Known limitations): Python code running inside the program cannot be fully sandboxed by a scan; the connector runs as
the same Windows user; network is not restricted for adapter processes.

## Private adapter management

Settings > Integrations > **My Integrations**: *Official CreateCraft Integrations* (built-in and official packages) and *My Custom
Integrations* (compatibility and verification status per integration; Details/test/repair, Update Integration, Turn off, Remove
Integration). Removing keeps the saved versions; deleting a project deletes its files.

### Repair, update, rollback

*Repair integration* (a command failed) or *Update for this version* (installed program version not tested): Claude gets the failing
command, error, evidence, installed and declared versions and the documentation; it returns a corrected blueprint; CreateCraft builds and
tests it (the same pipeline), and shows the problem, a plain list of changed/added/removed commands, **new permissions** and the
checks. Nothing changes until the user installs it through the normal review as an *update*. Every built version is kept; **Go back to
this version** reinstalls an earlier one (native confirmation, previous permissions). A working integration is never silently replaced.

## Proof of concept 1: real FreeCAD 1.1.4

Blueprint `fixtures/ai-generated/freecad-enclosure.blueprint.json` (generator `make_freecad.py`). Authored by Claude in the
development session (not by the in-app research run; the project records the author as *scripted*, and the opt-in
`claude.live.test.ts` is the in-app run). New, narrow commands that the existing FreeCAD adapter does not have:
`enclosure.create` (open-top enclosure with width, depth, height, wall; parametric box minus inner box) and `enclosure.measure`.
Documented API: `Part.makeBox`, `Shape.cut`, `FreeCAD.newDocument`, `Document.addObject/recompute/saveAs`, `FreeCAD.openDocument`,
`Shape.isValid/Volume/Solids/BoundBox`. The wiki pages could not be read in the authoring session (bot protection); every symbol was
confirmed on the installed FreeCAD 1.1.4 by inspecting the real module, and the blueprint's source notes say so.

`builder/freecad.live.test.ts` (`CS_LIVE_TESTS=1`) and `scripts/smoke-builder.mjs` (real app window): build, static + security + mock
stages pass, the normal review and native confirmation, install, connect to the **real** FreeCADCmd, live execution of the generated
Python, independent re-open inside the integration (fresh process) **and** an outside FreeCADCmd run that re-opens the file and checks
1 valid solid, volume = 60·40·30 − 56·36·28 mm³ to 0.001 and the bounding box. Also: refusal of an existing name, of a too-thick wall,
of out-of-range settings and of a path escape; update (repair) and rollback in the real window.

## Proof of concept 2: a program that is not installed (ImageMagick)

Blueprint `fixtures/ai-generated/imagemagick.blueprint.json` (cli template; sources were read: `-resize`, `magick identify`). Typing the
name in the real window builds the candidate, passes static/security/**simulated** stages and stays **Awaiting live verification**:
no install is offered, no command is marked tested, the trial run is labelled as a pretend program. Installing ImageMagick later
enables the review, install and live test.

## Tests

| Suite | What |
|---|---|
| `builder/pipeline.test.ts` | FreeCAD blueprint through every stage; 11 refusal cases (os import, eval, dunder, path string, undocumented API, network permission, uncited source, no documentation, insufficient research, reserved id, bad example) |
| `builder/templates.test.ts` | file-exchange, add-in source, Python scan (text and syntax tree), parsers, prompts, tamper checks on a built package |
| `builder/service.test.ts` | not-installed workflow, honest stops (insufficient / not feasible / failing checks / Claude signed out), installed workflow with install, live verification per command and version, repair proposal, update, changed-command re-test, rollback, My Integrations, inventory |
| `builder/freecad.live.test.ts` | the real FreeCAD proof (opt-in `CS_LIVE_TESTS=1`) |
| `builder/claude.live.test.ts` | the real in-app Claude author (opt-in `CS_CLAUDE_TESTS=1`; uses your Claude sign-in) |
| `scripts/smoke-builder.mjs` | the real window: both ways to begin, build, review, install, live test, repair, rollback, remove, uninstalled flow (40 checks, screenshots 130 to 138) |

## Known limitations

* **The in-app Claude author has not been run end to end** unless `claude.live.test.ts` was run (it spends Claude usage). Proofs 1 and 2 use blueprints Claude authored in a development session and the same pipeline; their provenance says *scripted*.
* **Python in the program is not sandboxed.** The scan refuses common escape routes and every function/class must be documented and reviewed, but code inside FreeCAD/Blender has that program's privileges. Generated packages are unsigned and ask before every command; review the source in Advanced.
* **Only FreeCAD 1.1.4 has run generated scripts.** Blender and custom hosts are templates and checks only. Mock modules accept any call: they catch typos and wrong shapes, not API misuse. Version ranges are the AI's claim until live tests record real versions.
* **Add-ins (C#, UXP) are source for review only**: no build, no install, no connection. UXP plug-ins cannot open CreateCraft's named pipe; no WebSocket transport exists. Photoshop-style requests therefore end as source or as "cannot be integrated yet".
* **One integration per program at a time**: a program already handled by an official integration (installed) conflicts with a custom one (turn the official one off first). Placeholders are replaced as usual.
* The cli and file-exchange templates have only simulated tests here (ImageMagick is not installed); file exchange cannot prove the program accepts the file.
* Research quality depends on the web tools and what the vendor publishes; sites that block automated readers (as the FreeCAD wiki did) fall back to documentation the user supplies.
* Generated integrations are not signed and cannot be marked "verified" by CreateCraft; they appear as experimental. No signing, trust upgrade or sharing path exists on purpose.
* Windows only for the simulated stage (needs the .NET Framework compiler that ships with Windows); without it the stage is reported as skipped. The Python scan degrades to the text scan when no Python is installed and says so.

## Regression results (Windows 11, FreeCAD 1.1.4, Blender 4.0.2, Resolve 21 closed, Revit 2027)

* `npm run lint` and `npm run typecheck` clean.
* `npx vitest run`: **511 passed, 61 skipped** (opt-in live suites), twice in a row. New: 12 + 5 + 21 builder tests. Under parallel load several older process-spawning tests passed the 5 s default and an uninstall hit `EBUSY` while the adapter process was still exiting; fixed with a 30 s test timeout, a 60 s hook timeout (`vitest.config.ts`) and a retrying delete in `PackageStore.uninstall`. No test logic was changed.
* Live (`CS_LIVE_TESTS=1`, one file at a time): Blender 6/6, FreeCAD (existing adapter) 3/3, Resolve 2/2 (closed: honest result), Universal Connect 6/6, **builder FreeCAD proof 1/1**. Revit live is skipped without its environment.
* Real-window smokes: **`smoke-builder` 40/40**, `smoke-connect-hybrid` 15/15, `smoke-freecad` 7/7 (mock) and 7/7 with `--real`, `smoke-docks` 15/15, `smoke-apps` 20/20, `smoke-external` 8/8, `smoke-adapter-packages` 14/14 (it timed out once under load, then passed).
* **`smoke-connect` 36/39 on this tree and on the unmodified previous commit alike** (checked in a clean checkout of `HEAD`): three failures predate this work: the Revit row is no longer a "placeholder" (a real Revit integration exists since the previous commit) and two Blender portable-copy / Forget checks. Left unchanged.
* Not run: `smoke-claude-*` and `claude.live.test.ts` (they spend Claude usage; see Known limitations).

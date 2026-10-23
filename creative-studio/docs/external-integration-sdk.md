# Universal Application Integration Framework (external software)

Scope: third-party desktop software (Blender, Autodesk, Adobe, FreeCAD, Godot, DaVinci Resolve, ...).
The 13 native Craft apps keep their own first-party integrations (`liveApps.ts`, `liveTask.ts`) and are never routed here.

Two kinds of adapter share one manager, one permission model, one AI router and one screen:

* **Built-in adapters** (Blender, DaVinci Resolve, vendor placeholders) ship inside OmniCandy and run in its process.
* **Installed packages** (`.ccadapter`) are added by the user at run time, verified, and run only in a separate restricted
  process. See [Installable adapter packages](#installable-adapter-packages).

**Universal installer (manifest version 2).** Packages can now be `external` (a connector), `internal` (an add-in inside the program,
no connector code) or `hybrid` (both), all through the same Connect Applications experience. The manifest, installation manager,
plugin bridge, host profiles (Autodesk and Adobe groundwork) and security statement are in
[`universal-installer.md`](universal-installer.md), [`installation-profiles.md`](installation-profiles.md) and
[`release-signing.md`](release-signing.md). Version 1 packages (Blender-style connectors, FreeCAD) keep working unchanged.

**AI Adapter Builder.** Settings > Integrations > Create Custom Integration lets Claude research a program and write a PRIVATE, local
integration (a manifest-v2 external `.ccadapter` made by OmniCandy's templates from an AI blueprint), tested in four stages and installed
only through the normal review and native confirmation. Generated packages are unsigned, labelled "Created on this computer (AI-generated)",
asked about before every command, and never called tested without a real, independently re-checked run. See
[`ai-adapter-builder.md`](ai-adapter-builder.md). Nothing in the framework described below changed for it.

## Layout

| Path | Role |
|---|---|
| `src/shared/integrations.ts` | Contract: control methods, permissions, capabilities, `CommandSpec`, `AdapterManifest`, statuses, results |
| `src/main/integrations/sdk.ts` | `ExternalAdapter` interface, `AdapterFactory`, manifest validation |
| `src/main/integrations/discovery.ts` | Local discovery (see [Discovery](#discovery)) |
| `src/main/integrations/manager.ts` | Lifecycle, permissions, parameter validation, timeouts, cancel, output verification, audit log |
| `src/main/integrations/process.ts` | Shared child-process helpers for adapters: `runProcess`, `safeFileName`, `parseResultLine` |
| `src/main/integrations/adapters/blender.ts` | First real adapter (scripting, background mode, verified live) |
| `src/main/integrations/adapters/resolve.ts` | Second real adapter (DaVinci Resolve scripting API, live session, experimental) |
| `src/main/integrations/adapters/vendors.ts` | Autodesk, Adobe and other vendor placeholders: detected, honest "unsupported", no commands |
| `src/main/integrations/zip.ts` | Defensive ZIP reader (traversal, symlinks, bombs, limits) and a small deterministic writer |
| `src/main/integrations/packageFormat.ts` | Package manifest schema, SHA-256 integrity, Ed25519 signature check, folder/zip reading |
| `src/main/integrations/packageStore.ts` | Install, update, verify, repair, enable/disable, uninstall; registry, trusted publishers, inbox |
| `src/main/integrations/packageRunner.ts` | Child-process runner (Node permission model) and its host operations |
| `src/main/integrations/loader.ts` | `AdapterPackages`: registers verified packages with the manager and removes them again |
| `scripts/pack-adapter.mjs` | Packs a folder into a `.ccadapter` (hashes, optional signature) |
| `fixtures/sample-adapter/` | The sample package (self-contained, harmless) |
| `src/renderer/src/components/ExternalApps.tsx`, `IntegrationPackages.tsx` | Settings > Integrations screen |
| `src/shared/connect.ts`, `connectFlow.ts`, `src/main/integrations/connect.ts`, `state.ts`, `src/renderer/src/connect/` | Universal Connect guided setup (see [Universal Connect](#universal-connect-guided-setup-for-beginners)) |
| `claudePartner.ts` tools `external_apps`, `external_run`, `external_job` | The AI router: only listed commands, approval dialog per run, background jobs |

## Discovery

Only executables that registered adapters declare are looked for; nothing is uploaded and no drive is ever walked. Every source asks
one question: is a wanted executable in this folder or its `bin` subfolder? Sources, in order:

1. **Uninstall records** (HKLM, WOW6432Node, HKCU) matched by display name. The folder comes from `InstallLocation`, **the folder of `DisplayIcon`**
   and **the folder of the uninstaller** (`QuietUninstallString` / `UninstallString`). Many installers (FreeCAD's among them) leave `InstallLocation`
   empty, so the icon and uninstaller folders are what finds a program on `D:` or `E:`.
2. **App Paths**.
3. **Start Menu shortcuts** (all users and current user): one PowerShell call lists the shortcut targets; each target's folder is checked.
4. Common install folders two levels under Program Files, Program Files (x86) and `%LOCALAPPDATA%\Programs`.
5. `PATH`, then user-selected locations (Settings > Integrations > Add location), then **remembered locations**, then running processes.

**Remembered locations.** Programs found through records that can vanish (uninstall record, App Paths, shortcut) are saved in
`external-apps.json` (`remembered`, at most 100, in the per-user private folder). On later scans they count as long as the file exists, so a
program is still recognised after its record or shortcut is gone, and again when an unplugged drive returns. Nothing is pruned automatically.
Several installed versions of one program are separate entries (one per executable path). The user's own locations are unchanged.

**Placeholder replacement.** Registering a real adapter drops the entries of the placeholder it replaces immediately (they were listed as
"Unsupported"); installing, turning on/off, removing or repairing a package rescans in the same call (`AdapterPackages`), and the Settings
screen reloads its list on every such action. Removing the package restores the placeholder and its entries on the rescan that follows.

Limits: a program with no uninstall record, no shortcut, not in a standard folder and not on `PATH` still needs Add location once (then it is
saved); portable copies are the typical case. The shortcut scan adds about a second to a rescan.

## Writing an adapter

1. Declare an `AdapterManifest`: `id`, `sdkVersion: 1`, `exeNames`, `displayNames`, supported `versions`, `methods` (prefer
   `api` > `scripting` > `mcp` > `cli` > `file-exchange` > `ui-automation` > `visual`), `capabilities`, typed `commands`
   (params with type/default/min/max, required `permissions`, `destructive`, `idempotent`, `timeoutMs`), `maturity`.
2. Implement `ExternalAdapter`: `probe` (real version, read only), `connect`, `disconnect`, `healthCheck` (a real tiny run),
   `execute(command, params, ctx)` and `dispose`. Honour `ctx.signal`. Return `AdapterOutcome` with the files produced and
   facts you checked (`evidence`, `verified`). Throw `AdapterError` with a kind to classify failures.
3. Register: `manager.register({ manifest, create })`. Manifests are validated (SDK version, ids, permissions, stubs must
   not declare commands). New adapters need no change to the router or UI.

The manager, not the adapter, enforces: parameter validation (unknown keys rejected), permission approval (asked when not
granted; destructive commands always asked), timeout and cancellation, "every claimed output exists and is not empty",
adapter crash isolation (a failing adapter drops its session and returns an `internal` error), and an audit log
(app, command, outcome, duration; no parameter values).

## Security model

- Built-in adapters ship with OmniCandy. Third-party adapters are only loaded as installed packages (below): verified,
  explicitly approved, and executed in a separate restricted process. There is no marketplace and no network fetch.
- Scripts that run inside an application are fixed templates; parameters are passed as a JSON file, never spliced into code.
- Outputs go to `<project>/work/external/<adapter>/`; the library and original files are not modified.
- Discovery is local and only looks for executables adapters declare; nothing is uploaded.
- Grants are per application and permission, stored in the per-user private folder, revocable ("Forget permissions").

## Blender adapter (verified against Blender 4.0.2)

Commands: `scene.create_basic` (cube + camera + light, saved as .blend, then re-opened in a fresh Blender and counted),
`scene.inspect` (read only), `scene.render_still` (Workbench PNG). Needs no add-on and no open window. Version support
starts at 3.6; the scripts use only API calls stable across 3.6 to 4.x. Rollback: outputs are new files; nothing existing is touched.

## Shared 3D foundation (apps sharing each other's work)

The library has a **3D model** kind (`model`: GLB, glTF, FBX, OBJ, STL, PLY, USD, STEP) stored in `Assets/Models`. These are exchange formats: an app's own
project file (`.blend`, `.uproject`) is not one and stays in that app's folder under `work/external/`. Any command output with one of these extensions is
added to the library automatically, like a render, so it can be used by any other app and in any other project.

* **Blender `mesh.export`** (read-project, write-files; never changes the project): GLB, FBX, OBJ or STL of all meshes or chosen objects, modifiers applied,
  merged into one mesh by default (`join`), so a scene of thousands of instances becomes one clean model. Verified from the finished file (GLB container and
  its triangle count against Blender's, FBX signature, OBJ vertices and faces, STL size or facets).
* **Hand-off by library item** (`ExecuteContext.libraryFile`, supplied by the app from the project store): a command takes the name `list_files` shows
  (or an id) instead of a path. The file is always inside the project folder; adapters still check that. Unreal's `asset.import` is the first user.
* Blender → Unreal: `mesh.export` (GLB) → library → `asset.import` (static_mesh) → `actor.place`.
## Unreal Engine adapter (experimental)

Id `unreal` (it replaced the placeholder). Control method: Epic's built-in MCP server (Unreal 5.8+, plugins "Unreal MCP" and "All Toolsets";
Editor Preferences > Model Context Protocol > Auto Start Server, or `ModelContextProtocol.StartServer`), reached over Streamable HTTP by
`src/main/mcpHttpClient.ts` (loopback only, session id, JSON or SSE replies). The server offers three meta tools (`list_toolsets`,
`describe_toolset`, `call_tool`) in front of ~830 toolset tools. Endpoint `http://127.0.0.1:8000/mcp`, or `OMNICANDY_UNREAL_MCP_URL`.
OmniCandy never starts the editor or the server. Unreal has no undo tool: recovery is Ctrl+Z in the editor plus the read-back checks.

Wrapping 830 tools by hand would never end, so control is layered. Tiers live in `adapters/unrealTools.ts`; each tool belongs to exactly one,
each generic command accepts only its own tier, and the tool must also exist in the live toolset with its required arguments (so a wrong tier is
refused before Unreal is touched).

| Command | Permissions | Notes |
|---|---|---|
| `app.info`, `toolsets.list`, `toolsets.describe`, `tools.search` | read-info (+read-project) | inventory; `tools.search` finds any tool by words and says which command runs it |
| `level.inspect`, `assets.find`, `logs.read` | read-project / read-info | typed read helpers; `level.inspect` explains an empty level during Play-In-Editor |
| `tool.read` | read-project | any READ-tier tool (get_/list_/find_/is_...) |
| `tool.edit` | modify-project | any EDIT-tier tool; result is Unreal's own answer, reported as a receipt, never "verified" |
| `tool.restricted` | modify-project, write-files, **asked** | delete whole assets/actors, move assets, file paths, imports, level load, plugins, config, editor UI driving |
| `tool.batch` | modify-project | up to 50 read/edit calls, all checked first, stops at the first failure and says what was applied (no rollback) |
| `actor.place`, `actor.transform`, `actor.delete`, `level.save` | modify-project (+write-files) | verified shortcuts: each re-reads the editor and fails with `verification-failed` if it differs; delete is asked |
| `script.run` | execute-scripts, **asked every time** | Epic's tool-orchestration sandbox (math/re/time/json/copy/datetime, can only call registered tools); the user reads the code |

Every edit is refused while Play-In-Editor runs (the editor has no level then), except `StopPIE`. Results over 20,000 characters are cut with a note.

**Files and other projects** (`adapters/unrealFiles.ts`). Unreal now works like the other apps: it writes files into the OmniCandy project
(`work/external/unreal/`) and hands pictures to the library.

| Command | Permissions | Notes |
|---|---|---|
| `viewport.capture`, `asset.preview` | read-project, write-files | PNG into `work/external/unreal/captures/`, checked as a real PNG and re-read; the app adds it to the library ("Made in Unreal Engine") like a Blender render, so PhotoCraft and other projects can use it. A camera can be given without moving the editor camera |
| `bundle.export` | read-project, write-files | saves the assets (and their `/Game` dependencies; engine content is not carried), packs them with SHA-256 into ONE `<name>.unrealbundle` (a ZIP with `bundle.json`) plus a manifest copy, then re-reads the finished bundle; a level is bundled with its external actors |
| `bundle.list` | read-info | the bundles in this project |
| `bundle.import` | open-files, modify-project, write-files, **asked** | installs a bundle (by name, or by full path of a file from another OmniCandy project) into the open Unreal project's Content folder; validated first (format, only Unreal file types, every checksum, no unlisted files); never overwrites unless `overwrite`, and then backs the old files up in `work/external/unreal/backups/`; undoes itself on a failed write; reports whether Unreal has noticed the new assets |
| `asset.import` | open-files, modify-project | a picture or mesh from inside the OmniCandy project folder becomes a Texture or Static Mesh asset; the file must resolve (symlinks included) inside the project folder; verified by the asset existing |

The Unreal MCP server gives no disk paths, so the project's Content folder is read from Unreal's own log (the loaded level's file or any saved package)
and accepted only if the open level's file exists there. `level.save` is proven by the log line Unreal always writes when it saves a package
(`LogSavePackage: Moving output files for package: ...`), not by the dirty flag, which Unreal does not set for an edited level.

Tests: `unreal.test.ts` (mock server shaped like Unreal's, with a small stateful editor and two fake Unreal projects on disk, so a bundle is proven to
travel from one project to another), `unreal.live.test.ts` (real editor, skipped when none answers; everything that writes runs only with
`OMNICANDY_UNREAL_LIVE_EDIT=1` and cleans up after itself).
## Vendor groundwork (not integrated yet)

Revit: C#/.NET add-in per Revit year (version-specific module), local pipe, work inside Revit's API context via
ExternalEvent; needs the add-in installed with approval and a Revit restart. Photoshop: UXP plugin with a local WebSocket
bridge (Adobe developer tooling or a signed plugin, Creative Cloud licence). Others are listed in `vendors.ts`.

## DaVinci Resolve adapter (second adapter, experimental)

Control method: Resolve's scripting API (Python `DaVinciResolveScript` / `fusionscript.dll`), run as fixed templates in a
child process. Id `davinci.resolve` (it replaced the placeholder of the same id). Maturity `experimental`, so a successful
connection is shown as "Limited functionality", never "Connected".

| Command | Permissions | Notes |
|---|---|---|
| `app.info` | read-info, execute-scripts | edition (from the product name), version, page, open project name |
| `project.list` | read-project, execute-scripts | project names in the current database folder |
| `project.inspect` | read-project, execute-scripts | timelines, frame rate, resolution, media pool clip count; changes nothing |
| `project.create_scratch` | modify-project, execute-scripts | new project `OmniCandy <name>` (+ optional empty timeline); re-opens the previously open project; refuses to switch away from a user project unless `allow_switch` is set; verified by listing |
| `project.delete_scratch` | modify-project, execute-scripts, always asks | only names starting with `OmniCandy`; verified by listing |
| `timeline.export` | read-project, write-files, execute-scripts | FCPXML or EDL into the project's `work/external/davinci.resolve/` folder |

What Resolve itself dictates, reported by the adapter instead of hidden:

* Resolve must already be **running**. The adapter never starts it, so it cannot disturb a session or open a user's project.
  Not running gives status "Not running".
* **External scripting is a Studio feature** and must be set to Local (Preferences > System > General). When Resolve is
  running but returns no scripting connection (Free edition, or preference off) the status is "Scripting not available".
  A Free edition cannot be told apart from a disabled preference from outside; the message says both.
* The scripting library **crashes some Python builds at import** (Python 3.13 on this PC: access violation; 3.14 loads).
  Because scripts run in a child process the crash cannot reach OmniCandy; the adapter tries the next interpreter
  (newest first, `CREATECRAFT_PYTHON` first of all) and reports "crashed every Python tried" if none works.

### What was generalized for the second adapter

| Was Blender-shaped | Now shared |
|---|---|
| process spawn, timeout, abort, tail capture lived in `blender.ts` | `process.ts` `runProcess` (Blender and Resolve use it) |
| file-name sanitising, `CREATECRAFT_RESULT` parsing in `blender.ts` | `process.ts` `safeFileName`, `parseResultLine` |
| a failed health check was always "needs repair" | `HealthResult.state` (`not-running`, `api-unavailable`): the manager keeps a precise status and does not ask for repair; the screen shows a Connect retry |
| a failed Connect left the screen stale | the Integrations screen refreshes after every action, also a failed one |
| version came from running the program (`--version`) | adapters may take it from the installer record or file without starting the program (Resolve) |
| every app was assumed launchable on demand | the manifest simply omits the `launch` permission; nothing in the manager assumed it |

Nothing in the manager, router (`external_apps` / `external_run`), approval dialog, permission store or audit log needed
a Resolve-specific branch.

## Installable adapter packages

Goal: a new application is added by installing a package, without changing OmniCandy's code.

### Package format (`.ccadapter` = ZIP, or an unpacked folder while developing)

```
adapter.json   manifest (below). Lists the SHA-256 of every other file.
adapter.sig    optional: { "algorithm": "ed25519", "publicKey": "<base64 SPKI DER>", "signature": "<base64>" }
               over the exact bytes of adapter.json
main.js        the entry script (CommonJS), plus anything it needs
```

`adapter.json` (strict: unknown fields are rejected; `manifestVersion` 1):

| Field | Meaning |
|---|---|
| `id`, `name`, `version` | identity; id is lower-case letters, digits, `.`, `-`; version `1.2` or `1.2.3` |
| `description`, `license`, `homepage` | shown in the review and in Settings |
| `publisher.name` | display name only. **Identity is the signing key's fingerprint**, never this text |
| `sdk: { min, max }` | adapter SDK versions it works with (this OmniCandy speaks 1) |
| `application.kind` | `program` (drives an installed program: `exeNames`, `displayNames`, `versions[]`) or `self-contained` |
| `application.versions` | any number of `{ min, max }` ranges of the program's versions that are supported |
| `application.displayNames` | literal text; a program matches when its installer name starts with it (not a regex) |
| `requirements[]` | what the user needs first: `application`, `edition`, `running`, `runtime`, `preference`, `licence`, `other` |
| `runtime.entry`, `runtime.dependencies[]` | entry script; declared dependencies (python, dotnet, java, application, other) are shown, not installed |
| `methods`, `capabilities` | how it controls the program and which operations it implements (same vocabulary as built-ins) |
| `commands[]` | typed commands: `id`, `label`, `description`, `params`, `permissions`, `destructive`, `idempotent`, `timeoutMs`, `longRunning` |
| `files` | `{ "path": "<sha256 hex>" }` for every file except `adapter.json` and `adapter.sig` (filled in by the packer) |

Entry script contract (`exports.probe/connect/healthCheck/disconnect/execute`): each receives a `ctx`; `execute(commandId,
params, ctx)` returns `{ message, outputs: [file names in the work folder], data, evidence: [..], verified }`.
`ctx` offers `progress(stage, fraction)`, `signal` (aborted on cancel/timeout), `runApp(args)`, `writeFile(name, data)`,
`readFile(name)`, `error(kind, message)`, and `app` (name, version, exePath). Nothing else is reachable (next section).

Build one: `node scripts/pack-adapter.mjs fixtures/sample-adapter out/sample.ccadapter --generate-key .local/publisher.key.pem`
(omit the key option for an unsigned package). The private key is yours and is never part of a package.

### Installation and trust

1. **Review first, run nothing.** Reading a package validates names, sizes, schema, hashes and signature. The review lists
   publisher, key fingerprint, commands, requested permissions, requirements and warnings.
2. **Identity.** A valid signature proves "the holder of this key published exactly these bytes". A publisher key is
   trusted only after the user confirms it (the fingerprint is shown); until then installing is blocked.
   Unsigned packages can be installed only with an explicit confirmation, are labelled *Not signed*, are asked about
   before **every** command (no "always allow"), and run no code during scans (only when the user presses Connect).
   A forged or edited package fails as *Signature invalid* and cannot be installed.
3. **Approved permission ceiling.** The user ticks the permissions to grant. A command that needs a permission outside
   the ceiling is refused at run time even though the manifest declares it. Per-run approval still applies on top.
4. **Native confirmation.** Main shows a dialog the renderer and Claude cannot answer. Claude has no install tool.
5. **Safe extraction.** Entries with `..`, absolute or drive paths, backslashes, NUL, reserved Windows names,
   symlinks, duplicates or case-colliding names, encryption, zip64, or sizes beyond the limits (200 files, 8 MB each,
   32 MB total, checked against real decompressed size) reject the whole package. Files are written to a staging folder
   and renamed into place.
6. **Application-specific storage.** `<userData>/integrations/adapters/<id>/<version>/` (the only folder the package can
   read), `.../data/<id>/` (its own storage), `.../adapters/<id>/source-<version>.ccadapter` (verified original for Repair).
   The `inbox/` folder lists dropped packages; listing never loads them.
7. **Verification on every start.** Hashes, signature, identity and SDK range are re-checked; edited files turn the
   adapter off (*Files changed*) and **Repair** restores the verified original.
8. **Updates** need the same signing key (or both unsigned), a higher version and a fresh review. Downgrades and
   publisher changes are refused. Ids and programs already handled by a built-in adapter are refused. A package may
   replace a *placeholder* (for example `freecad`); removing it restores the placeholder.

### Runtime isolation (what it is and what it is not)

* **Process isolation.** Package code never runs in OmniCandy's main process. Crashes, hangs and busy loops end only the
  child. Timeouts and cancellation reach it (cancel signal, then kill after 3 s); a crash is reported as an `internal`
  error, the next call starts a fresh process, and 3 crashes in 10 minutes turn the adapter off until Repair.
* **Node permission model** (`--permission`). The child may read only its package folder; the operating system refuses
  writes, spawning programs, worker threads and native addons (`ERR_ACCESS_DENIED`, verified in tests and by the
  sample's *selftest.isolation* command). It gets a minimal environment, so no API keys or tokens from OmniCandy's
  environment are inherited.
* **Host operations.** Everything else goes through OmniCandy, which checks the permissions of the command *in flight*
  (calls run one at a time per adapter): `runApp` needs `execute-scripts`/`launch` (or `read-info` while connecting) and only
  ever starts the discovered program; `writeFile` needs `write-files`; `readFile` needs `read-project`. Files are confined
  to the project's work folder, and every claimed output must exist and be non-empty (manager verification).
* **Not an operating-system sandbox.** The child runs as the same Windows user, Node's permission model does not
  restrict network access, and `execute-scripts` on a program means exactly the power of that program's scripting. This is
  why unsigned packages are always asked about and every package is labelled *experimental* (OmniCandy's own
  "verified" status is never granted to a package).

### Long-running operations (jobs)

A command with `longRunning: true` (or `background: true` in `external_run`) returns a job handle after the user has
approved it and the adapter connected. The job carries `status` (running/succeeded/failed/cancelled), stage, progress,
timeout (the command's `timeoutMs`), cancellation (`external_job` with `cancel`, or the Cancel button) and the same
output verification as a foreground run. Jobs are kept in memory (last 50 finished); they do not survive a restart.

### AI router

`external_apps` lists whatever is registered (built-ins and installed packages, with origin, trust and requirements);
`external_run` validates every argument and permission in the manager before the package sees anything; `external_job`
follows background jobs. No application or adapter name appears in the router code.

### Settings > Integrations

Install integration package…, Install from folder…, the inbox list, a review panel (publisher key, commands, per-
permission checkboxes, unsigned/new-publisher confirmations), per installed package: state and compatibility, requirements
("needs no other program", "the program must be installed"), allowed permissions, Turn on/off, Update…, Repair, Remove;
plus Background jobs with Cancel.

### Sample adapter

`fixtures/sample-adapter` ("Sample Text Kit") is self-contained and harmless: `text.stats`, `report.write` (needs
`write-files`), `slow.count` (a cancellable job) and `selftest.isolation`. It was installed through the Settings
screen and driven by real Claude from the Claude panel without any change to OmniCandy code.

## Verification status

| Item | Evidence |
|---|---|
| Blender 4.0.2, three commands | real application (live test and smoke) |
| Resolve 21.0.4.5 detection, version, manifest, Connect path | real application: live test with Resolve closed ("Not running") and with Resolve running headless (`-nogui`, started and stopped around the test run: "Scripting not available" through the real `fusionscript.dll` under Python 3.14) |
| Resolve commands (`app.info` ... `timeline.export`) | **not verified against a real Resolve**: this PC's Resolve refuses external scripting (see above), so the six commands are verified only against a fake `DaVinciResolveScript` module (real adapter, real templates, real Python process: `resolve.test.ts`, 9 tests) |
| Package format, signatures, tampering, unsafe archives | `packages.test.ts`: 45 tests against real files and real child processes (traversal, bombs, forged signature, edited file, unlisted file, downgrade, publisher change) |
| Isolated runtime: permissions, ceiling, crash, hang, busy loop, jobs, cancel, env leak | same suite; the OS refusal of spawn/write/read-outside is observed from inside a real child (Node permission model; also confirmed under Electron's runtime) |
| Install/review/trust/enable/update/remove UI | `scripts/smoke-adapter-packages.mjs` in a scratch profile: 14/14, screenshots `100`-`103` |
| Claude drives an installed package (no hardcoded name), background job | `scripts/smoke-claude-adapter.mjs` (opt-in, Claude usage only): 5/5 |
| Blender through the same manager after the change | `blender.live.test.ts`, `smoke-external.mjs` 8/8, `smoke-claude-external.mjs` 4/4 |
| Resolve | unchanged: detection and Connect verified against the real program; commands against a fake scripting module only |
| Everything else | mock-tested (adapter contract) or detection-only |

To verify the commands for real: run Resolve Studio, set External scripting to Local, open Resolve, then
`CS_LIVE_TESTS=1 npx vitest run src/main/integrations/resolve.live.test.ts`. It creates and deletes only a project named
"OmniCandy Live Test" and re-opens whatever was open.

## FreeCAD adapter (installable package, `fixtures/freecad-adapter`)

The first adapter delivered purely as a `.ccadapter`: no change to the manager, router, runner, UI, native Craft apps
or `vendors.ts`. Package id `freecad` replaces the FreeCAD placeholder while installed (removing it restores the placeholder).

Build and install: `node scripts/pack-adapter.mjs fixtures/freecad-adapter out/adapters/freecad-1.0.0.ccadapter --generate-key .local/publisher.key.pem`
(omit the key option for an unsigned package), then Settings > Integrations > Install integration package.

How it works: FreeCAD is driven through its own **FreeCADCmd.exe** (no window, FreeCAD need not be open). `main.js` runs in the
restricted adapter process; for each command it writes `_cc_job.py` (a fixed script, `freecad_job.py`, hashed with the
package, behind a generated header that carries the parameters as base64 JSON, never as code) into the project's
`work/external/freecad/` folder and starts `FreeCADCmd.exe _cc_job.py` through the host operation `ctx.runApp` (cwd =
that folder). The script prints one `CREATECRAFT_RESULT {json}` line. Version comes from `FreeCADCmd --version`
(supported 0.21 to 1.x; older/newer shows as Incompatible before any command runs).

| Command | What it does and checks |
|---|---|
| `app.health` | builds and measures a 10 mm cube in a temporary document; reports version, Python, module availability; saves nothing |
| `doc.create` | new `.FCStd` with a `Params` spreadsheet (named parameters) driving a `box`, `cylinder` or `plate_with_hole`; volume compared with the formula, then the saved file is re-opened and re-measured |
| `doc.inspect` | read only: objects, parameters, expressions, volumes, bounding boxes |
| `geometry.add` | adds a box, cylinder, sphere or cone to an existing document; saves a NEW file; re-opened and checked |
| `object.set_property` | one allow-listed property (Length, Width, Height, Radius, Radius1, Radius2, Angle, Label, Placement.Base.x/y/z); refuses properties driven by a parameter (use `param.set`); NEW file; re-opened and compared |
| `param.set` | changes one named parameter, FreeCAD recomputes dependants; NEW file; volume before/after reported and re-checked |
| `doc.save_as` | copy under a new name; re-opened and the object list compared |
| `export.step`, `export.stl` | long-running jobs (cancellable, 10 min limit). STEP is re-read and its volume compared; STL is re-read (triangle count, volume within 5%) |

Permissions: every command needs `execute-scripts` + `write-files` (the job script is written to the work folder), the health
command also `read-info` (so the version probe at Connect is allowed). Nothing is destructive: every edit writes a new file and
**never overwrites** (an existing output name is refused). Files are plain names inside the work folder only; `main.js`
validates names and `freecad_job.py` validates them again (real path must be the work folder). FreeCAD files from elsewhere must
be copied into the work folder first: reading arbitrary folders would need a host operation OmniCandy does not offer. Cancel
kills FreeCADCmd; results are written under a temporary name and renamed only when complete, so a cancel leaves no half file.

### FreeCAD verification status (read this before trusting it)

| Item | Evidence |
|---|---|
| Package format, signature, install/enable/repair/remove, permission ceiling, unsigned handling, job + cancel, crash, path confinement, argument and geometry errors | `freecad.test.ts` (13 tests): REAL package store, REAL restricted child process, REAL manager; the program is a **test double** |
| Install through Settings, discovery, commands listed, Connect | `scripts/smoke-freecad.mjs` (6/6) in a scratch profile with the test double |
| Real Claude finds FreeCAD with `external_apps`, runs `external_run` (create, change parameter) and follows `external_job` (STEP export) | `scripts/smoke-freecad.mjs --claude` (10/10, Claude usage only) against the test double; Claude itself reported that the connected program was a mock folder |
| **Real FreeCAD 1.1.4** (Windows x64, official signed installer, installed per user at `E:\FreeCAD 1.1`) | **VERIFIED** by `freecad.live.test.ts` 3/3 (`CS_LIVE_TESTS=1`, `CS_FREECAD_BIN` for a custom install folder): health, parametric create, inspect, parameter change, add box/cylinder/sphere/cone, property edit, save copy, STEP and STL export, error reporting. The generated files were then reopened by a separate FreeCADCmd run outside the adapter: parameters 60 -> 80 mm, volumes 11607.301 -> 15607.301 -> 16964.469 mm3, STEP re-read as 2 valid solids, STL 208 triangles and a closed solid. `smoke-freecad.mjs --claude --real` 10/10: real Claude with `external_apps` / `external_run` / `external_job` on the real program (no mock executable or Python module involved) |
| Not verified | FreeCAD 0.21 to 1.0 and 1.2+ (only 1.1.4 was available); cancelling a long export on real FreeCAD (real exports finish in well under a second here, so cancel is verified only against the test double); very large models; FreeCAD's own GUI; Linux/macOS |

Findings from running on real FreeCAD 1.1.4 (all handled inside the package, no core change):

* **Stale bytecode (fixed).** FreeCAD imports the script it is given as a module, so Python cached its bytecode keyed on
  size and whole-second mtime. Two different jobs of equal size written within one second ran the *previous* job (the live
  test saw `geometry.add` repeat an earlier output name). FreeCAD is now always started with a constant launcher
  `_cc_run.py` that reads `_cc_job.py` as text. The test double runs scripts as `__main__`, so it could not show this: a
  reminder that the mock proves plumbing only.
* **Discovery of a custom install folder (fixed in the core, see [Discovery](#discovery)).** The FreeCAD installer leaves `InstallLocation` empty and its icon points at `FreeCAD.exe`; discovery now also uses the icon and uninstaller folders and Start Menu shortcuts, so `E:\FreeCAD 1.1\bin\FreeCADCmd.exe` is found without Add location.
* **Stale placeholder row (fixed in the core).** The old "Unsupported" row of the replaced placeholder is removed at once; see Discovery.
* `FreeCADCmd.exe` starts and exits by itself with the minimal environment `ctx.runApp` provides (no APPDATA); no host
  change was needed.
* `smoke-external.mjs` matched rows by text, so the FreeCAD placeholder's note (it mentions Blender) broke it once FreeCAD
  was installed; its locators now match the row's name.

## Universal Connect (guided setup for beginners)

Settings > Integrations starts with a **Connect Applications…** card. It opens a four-step dialog (Find, Allow, Set up, Done) that
sits on top of the framework described above and changes none of it: the manager, adapter SDK, discovery, AI router, permission
model, package store and trust rules are the ones already in use. Words such as "adapter", "API" and "scripting" are not used in
the beginner text; the technical names stay one click away under **Details** / **Technical details**.

| Path | Role |
|---|---|
| `src/shared/connect.ts` | Types and plain-language wording: `classifyApp` (framework record to group, headline, explanation), `PERMISSION_PLAIN` (plain permission titles and impact), `approvalDetail` (text of the native "Run X?" question), `explainConnectFailure`, `sameInstall` |
| `src/shared/connectFlow.ts` | `runSetup`: the multi-program run as plain logic (no UI): one program after another, each with its own connector decision, install, connection and test |
| `src/main/integrations/connect.ts` | `ConnectService`: `overview` (scan, connectors that could be installed, one row per installation), `connectAndVerify`, `browse`, `forget` |
| `src/main/integrations/state.ts` | `ExternalState`: grants, user-chosen locations, remembered locations and the first-run flag in `external-apps.json` (same file and format as before; writes are serialised) |
| `src/renderer/src/connect/` | `ConnectApplicationsCard`, `ConnectWizard`, `PackageReviewCard` (the package review, now shared with Settings > Integration packages), `PermissionExplainer`, `events.ts` |
| `resources/adapters/` | Connectors that ship with OmniCandy (today `freecad-1.0.0.ccadapter`, signed). They are only LISTED; nothing is installed or trusted until the user does it. Rebuild with `node scripts/build-catalog.mjs` |

### What the dialog does

1. **Find.** Scans on open (same discovery as before, plus the programs the available connectors drive). Each installation is **one** row
   with its version, publisher and a plain status. Groups: *Ready to connect*, *Connector available*, *Needs attention*, *Already
   connected*, *Version not supported*, *Found, but not supported yet*. Chips tell the connector state (installed / available / planned /
   none) and **Experimental** (Resolve, and every package connector, by design). Programs the PC lacks are listed under "Supported, but not found".
   A detected program with no usable connector gets a short explanation (placeholder: "cannot control it yet"; none: "has no connector for it"), is
   never selectable, and nothing about it is changed.
2. **Allow.** For every chosen program: what will happen, and what its connector may be allowed to do in plain language with an impact label
   (Low impact / Writes files / Powerful). Technical names, commands, method, trust and location are under a disclosure. Connecting grants nothing
   by itself; the existing per-command approval still asks the first time a command needs a permission, now with the same plain wording first
   and the technical names after it. Destructive commands and unsigned packages are still asked every time.
3. **Set up** (one program at a time; native dialogs are modal):
   * *Connector needed:* the package review (publisher, key fingerprint, commands, per-permission checkboxes, trust checkboxes) is shown **per program**.
     Install stays disabled until the unsigned/new-publisher boxes are ticked, then the existing native confirmation appears. Declining skips only that program.
     A connector that is installed but turned off is offered with a "Turn on" button instead.
   * *Connect and verify:* `ConnectService.connectAndVerify` connects, then runs the adapter's own **health check again** (a real tiny run of the
     program). Only if that passes is the outcome `verified` (or `verified-limited` for experimental connectors). If the second check fails the session is ended,
     so the list cannot say Connected. A program that is not open or has scripting off is `blocked` with an instruction, not a vague failure.
4. **Done.** One result card per program ("Connected and tested", "Connected (experimental)", "Needs your action", "Not connected", "Skipped",
   "Not set up") with what was checked and a **Try again** for the ones that need it. The headline counts only verified programs.

Independence: `runSetup` catches everything per program; a refused connector, a failed install, a failed test, a thrown exception or a cancel for one
program never changes another program's outcome (unit tests for every combination, plus a service test with a real package install next to a failing and a succeeding program).
**Cancel setup** stops before the next step; the program that is finishing keeps its real result and the rest are "Not set up".

### Browse for Application and Forget Application

* **Browse for Application…** (program file) and **Choose a program folder…** (also finds it in the folder's `bin`). Only programs OmniCandy has a connector for, or a planned one, are
  saved (as before, in `external-apps.json` `paths`); anything else gets "has no connector for it" and nothing is saved. A program already listed is not added twice.
* **Forget** (inline confirmation) disconnects the program, forgets its permissions and removes its saved/remembered location (also the folder or `bin`-parent the user chose, never a parent drive). It never touches the program.
  If Windows still lists the program (uninstall record, shortcut) it comes back on the next scan and the message says so instead of pretending.
* The list refreshes by itself after install, connect, disconnect, repair, remove, forget and browse: main rescans, and the `createcraft:external-apps-changed` event reloads both the dialog and the Settings list behind it.

First run: a welcome note is shown until the dialog has been closed or a setup finished once (`onboarded` in `external-apps.json`).

Accessibility: dialog with `aria-modal` and a labelled heading, focus moves into it and back to the button, Tab is trapped, Escape closes only the wizard (a running setup is cancelled instead), checkboxes
have real labels, status changes are announced through a polite live region, colours come from the theme tokens (light and dark checked for contrast).

### Verification (this machine: Windows 11, Blender 4.0.2, FreeCAD 1.1.4 at `E:\FreeCAD 1.1`, DaVinci Resolve 21.0.4.5 installed but not running, Revit 2027)

| Item | Evidence |
|---|---|
| Wording, grouping, every status, jargon-free beginner text, permission titles, native-question text | `src/shared/connect.test.ts` (10) |
| Multi-program run: partial failure, exception, blocked, declined / cancelled / failed install, key change after install, incompatible after install, cancel at every point | `src/shared/connectFlow.test.ts` (15) |
| Overview from real manager, real package store and the real signed FreeCAD connector; first-run flag; one row per installation; damaged package; connector for a program only the catalog knows; experimental / incompatible; connect-then-verify incl. second-check failure and blocked; Browse (file, folder with `bin`, stranger, non-exe, duplicate, portable FreeCAD placeholder); Forget (state, grants, honest "still listed"); state store; a real package install next to a failing and a succeeding program | `src/main/integrations/connect.test.ts` (24; the programs themselves are fake adapters, the FreeCAD package is real but its program is a fake .exe) |
| **Real programs**: Blender 4.0.2 verified, FreeCAD 1.1.4 connector installed after trust then verified (experimental), Resolve blocked ("not running") without affecting the others, real Browse/Forget | `src/main/integrations/connect.live.test.ts` (6, `CS_LIVE_TESTS=1`) |
| **Real UI** in the real window, scratch profiles | `scripts/smoke-connect.mjs` 39/39: first-run welcome, card order, scan with versions, Experimental and Revit explanations, keyboard selection (Space), focus trap, Escape, plain permissions + disclosure, connector review gate, native confirmation, **2 of 3 connected and tested (Resolve closed: "Needs your action")**, list refresh without rescan, welcome shown once, Forget (ask, Keep it, honest message, Blender unaffected), Browse (stranger refused; portable copy recognised, pre-selected, connected with the real test, forgotten), dark and light contrast, restart persistence, cancel during review leaves nothing installed or trusted. Screenshots `120` to `127` |
| Regression | lint, typecheck clean; `npx vitest run` 402 passed / 58 skipped; live Blender, Resolve, FreeCAD, Connect 17/17 (run one file at a time: see limits); `smoke-adapter-packages` 14/14, `smoke-external` 8/8, `smoke-freecad` 7/7 (test double) and 7/7 with `--real` |

### Limits of this work (read before relying on it)

* The install confirmation and the file/folder pickers are native dialogs; the UI smoke answers them on the user's behalf, and the unit/service/live tests play "the user" through the same install calls. A human has not yet clicked through it.
* The "portable copy" in the smoke is a **directory junction** to the real Blender folder (a different path, the real Blender runs from it), not a copied portable install.
* Resolve was **closed**, so only its honest "Needs your action" state was verified; a successful Resolve connection (and its commands) are still unverified against a real Resolve.
* Missing and incompatible connectors are verified by unit and service tests with fake adapters. There is no real incompatible program version on this PC.
* A forgotten program that Windows still lists comes back by design; there is no "hide" list.
* The signing key of the bundled FreeCAD connector lives in `.local/` (ignored by git). If it is lost, a rebuilt connector has a different publisher key and users are asked to trust it again; an update over an older install from the old key is refused by the existing rule. There is no packaging configuration yet, so `resources/adapters` is not yet shipped by an installer.
* The overview runs the full discovery (registry and a PowerShell shortcut scan, a few seconds) every time the dialog opens or Scan again is pressed.
* `Add application location…` in the older list below the dialog entry still adds a location without feedback; the new Browse button is the guided version.
* Keyboard and ARIA are checked automatically; it was not tried with a screen reader.
* The live test files collide when Vitest runs several of them in parallel (the FreeCAD `beforeAll` fails, also on the commit before this work); run them with `--no-file-parallelism`.

## Prerequisites from the earlier review: status

| # | Prerequisite | Status |
|---|---|---|
| 1 | Packaging and signing | **Done**: manifest, hashes, Ed25519 signatures, trusted-publisher store, approved permission ceiling, process isolation with the OS permission model |
| 2 | First-class attach step for live-session apps | Not built: `mustBeRunning` is only a requirement text; no `ensureRunning` yet |
| 3 | Edition and licence discovery | **Partly**: packages declare `requirements` (edition, preference, runtime) and the screen shows them before Connect; the edition is still not detected automatically |
| 4 | Shared runtime resolver (Python, .NET) | Not built: dependencies are declared and displayed; the adapter checks them itself via `runApp` |
| 5 | Job handles for long commands | **Done** (in-memory jobs; not persisted across restarts) |
| 6 | Output policy (library, provenance) | Not built: outputs stay in `<project>/work/external/<id>/` |
| 7 | Version matrix | **Partly**: several supported ranges per package; only Blender 4.0.2 and Resolve 21 exist on this PC to test |
| 8 | Mutation safety / reversibility declaration | Not built: only `destructive` and `idempotent` flags exist |

## Remaining limitations (honest list)

* Not an OS sandbox: same Windows user; network is not restricted for package code; a program driven with `execute-scripts`
  is as powerful as that program's scripting. Keep "unsigned" and "new publisher" warnings meaningful.
* There is no OmniCandy signing authority, publisher revocation list, marketplace, remote install or automatic update;
  trusted publisher keys can be added but there is no UI yet to un-trust one (uninstall removes the package).
* Package code is CommonJS JavaScript on OmniCandy's bundled Node. Packages that need Python or .NET must start them
  through `runApp` of a program they control; a standalone helper executable is not supported yet.
* Calls to one adapter run one at a time, so a long job blocks its other commands.
* `readFile` and `writeFile` only see the project's work folder for that adapter; reading library assets is not wired.
* The runner relies on `ELECTRON_RUN_AS_NODE`. Verified to work in the packaged (unpacked electron-builder) application with the
  default fuses; a build that disables that fuse would need a utility-process runner.
* Resolve is still **not live-verified**: its commands need Resolve Studio with external scripting set to Local.
* Two PhotoCraft SVG live tests in `photocraftLive.test.ts` fail ("PhotoCraft can't open SVG files" in `liveTask.ts`); they
  predate this work and are tracked separately.

## Universal installer: remaining limitations

* No Autodesk or Adobe add-in exists. Their host profiles are documentation plus installer rules; none is marked ready.
* The only add-in host that was run is the simulated SimCAD test application. Real hosts will add their own surprises (security prompts, load order, licence dialogs).
* No administrator elevation helper ships; protected folders are refused with guidance. The elevation gate itself is tested with a fake elevator.
* The pairing secret protects against other users and remote machines, not against malware running as the same user.
* No production release key, code-signing certificate, update feed or revocation list exists; see `release-signing.md`.
* The installer (NSIS) was configured and the unpacked application built and tested; a signed `OmniCandy-Setup.exe` was not produced or run through Windows SmartScreen.
* Vendor-workflow add-ins (Adobe UXP through Creative Cloud) are guided only; OmniCandy cannot tell that the user finished until the add-in connects.

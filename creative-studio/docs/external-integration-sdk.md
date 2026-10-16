# Universal Application Integration Framework (external software)

Scope: third-party desktop software (Blender, Autodesk, Adobe, FreeCAD, Godot, DaVinci Resolve, ...).
The 13 native Craft apps keep their own first-party integrations (`liveApps.ts`, `liveTask.ts`) and are never routed here.

Two kinds of adapter share one manager, one permission model, one AI router and one screen:

* **Built-in adapters** (Blender, DaVinci Resolve, vendor placeholders) ship inside CreateCraft and run in its process.
* **Installed packages** (`.ccadapter`) are added by the user at run time, verified, and run only in a separate restricted
  process. See [Installable adapter packages](#installable-adapter-packages).

## Layout

| Path | Role |
|---|---|
| `src/shared/integrations.ts` | Contract: control methods, permissions, capabilities, `CommandSpec`, `AdapterManifest`, statuses, results |
| `src/main/integrations/sdk.ts` | `ExternalAdapter` interface, `AdapterFactory`, manifest validation |
| `src/main/integrations/discovery.ts` | Local discovery (registry Uninstall + App Paths, common folders 2 levels, PATH, running processes, user paths) |
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
| `claudePartner.ts` tools `external_apps`, `external_run`, `external_job` | The AI router: only listed commands, approval dialog per run, background jobs |

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

- Built-in adapters ship with CreateCraft. Third-party adapters are only loaded as installed packages (below): verified,
  explicitly approved, and executed in a separate restricted process. There is no marketplace and no network fetch.
- Scripts that run inside an application are fixed templates; parameters are passed as a JSON file, never spliced into code.
- Outputs go to `<project>/work/external/<adapter>/`; the library and original files are not modified.
- Discovery is local and only looks for executables adapters declare; nothing is uploaded.
- Grants are per application and permission, stored in the per-user private folder, revocable ("Forget permissions").

## Blender adapter (verified against Blender 4.0.2)

Commands: `scene.create_basic` (cube + camera + light, saved as .blend, then re-opened in a fresh Blender and counted),
`scene.inspect` (read only), `scene.render_still` (Workbench PNG). Needs no add-on and no open window. Version support
starts at 3.6; the scripts use only API calls stable across 3.6 to 4.x. Rollback: outputs are new files; nothing existing is touched.

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
| `project.create_scratch` | modify-project, execute-scripts | new project `CreateCraft <name>` (+ optional empty timeline); re-opens the previously open project; refuses to switch away from a user project unless `allow_switch` is set; verified by listing |
| `project.delete_scratch` | modify-project, execute-scripts, always asks | only names starting with `CreateCraft`; verified by listing |
| `timeline.export` | read-project, write-files, execute-scripts | FCPXML or EDL into the project's `work/external/davinci.resolve/` folder |

What Resolve itself dictates, reported by the adapter instead of hidden:

* Resolve must already be **running**. The adapter never starts it, so it cannot disturb a session or open a user's project.
  Not running gives status "Not running".
* **External scripting is a Studio feature** and must be set to Local (Preferences > System > General). When Resolve is
  running but returns no scripting connection (Free edition, or preference off) the status is "Scripting not available".
  A Free edition cannot be told apart from a disabled preference from outside; the message says both.
* The scripting library **crashes some Python builds at import** (Python 3.13 on this PC: access violation; 3.14 loads).
  Because scripts run in a child process the crash cannot reach CreateCraft; the adapter tries the next interpreter
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

Goal: a new application is added by installing a package, without changing CreateCraft's code.

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
| `sdk: { min, max }` | adapter SDK versions it works with (this CreateCraft speaks 1) |
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

* **Process isolation.** Package code never runs in CreateCraft's main process. Crashes, hangs and busy loops end only the
  child. Timeouts and cancellation reach it (cancel signal, then kill after 3 s); a crash is reported as an `internal`
  error, the next call starts a fresh process, and 3 crashes in 10 minutes turn the adapter off until Repair.
* **Node permission model** (`--permission`). The child may read only its package folder; the operating system refuses
  writes, spawning programs, worker threads and native addons (`ERR_ACCESS_DENIED`, verified in tests and by the
  sample's *selftest.isolation* command). It gets a minimal environment, so no API keys or tokens from CreateCraft's
  environment are inherited.
* **Host operations.** Everything else goes through CreateCraft, which checks the permissions of the command *in flight*
  (calls run one at a time per adapter): `runApp` needs `execute-scripts`/`launch` (or `read-info` while connecting) and only
  ever starts the discovered program; `writeFile` needs `write-files`; `readFile` needs `read-project`. Files are confined
  to the project's work folder, and every claimed output must exist and be non-empty (manager verification).
* **Not an operating-system sandbox.** The child runs as the same Windows user, Node's permission model does not
  restrict network access, and `execute-scripts` on a program means exactly the power of that program's scripting. This is
  why unsigned packages are always asked about and every package is labelled *experimental* (CreateCraft's own
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
screen and driven by real Claude from the Claude panel without any change to CreateCraft code.

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
"CreateCraft Live Test" and re-opens whatever was open.

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
* There is no CreateCraft signing authority, publisher revocation list, marketplace, remote install or automatic update;
  trusted publisher keys can be added but there is no UI yet to un-trust one (uninstall removes the package).
* Package code is CommonJS JavaScript on CreateCraft's bundled Node. Packages that need Python or .NET must start them
  through `runApp` of a program they control; a standalone helper executable is not supported yet.
* Calls to one adapter run one at a time, so a long job blocks its other commands.
* `readFile` and `writeFile` only see the project's work folder for that adapter; reading library assets is not wired.
* The runner relies on `ELECTRON_RUN_AS_NODE`; a packaged build that disables that Electron fuse needs a utility-process runner.
* Resolve is still **not live-verified**: its commands need Resolve Studio with external scripting set to Local.
* Two PhotoCraft SVG live tests in `photocraftLive.test.ts` fail ("PhotoCraft can't open SVG files" in `liveTask.ts`); they
  predate this work and are tracked separately.

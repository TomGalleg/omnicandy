# Universal Application Integration Framework (external software)

Scope: third-party desktop software (Blender, Autodesk, Adobe, FreeCAD, Godot, DaVinci Resolve, ...).
The 13 native Craft apps keep their own first-party integrations (`liveApps.ts`, `liveTask.ts`) and are never routed here.

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
| `src/renderer/src/components/ExternalApps.tsx` | Settings > Integrations screen |
| `claudePartner.ts` tools `external_apps`, `external_run` | The AI router: only listed commands, approval dialog per run |

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

- Built-in adapters only. Third-party adapters are code and must be shipped/signed with CreateCraft or installed by the
  user explicitly; this slice does not load unsigned code from disk. A marketplace is future work.
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

## Verification status

| Item | Evidence |
|---|---|
| Blender 4.0.2, three commands | real application (live test and smoke) |
| Resolve 21.0.4.5 detection, version, manifest, Connect path | real application: live test with Resolve closed ("Not running") and with Resolve running headless (`-nogui`, started and stopped around the test run: "Scripting not available" through the real `fusionscript.dll` under Python 3.14) |
| Resolve commands (`app.info` ... `timeline.export`) | **not verified against a real Resolve**: this PC's Resolve refuses external scripting (see above), so the six commands are verified only against a fake `DaVinciResolveScript` module (real adapter, real templates, real Python process: `resolve.test.ts`, 9 tests) |
| Everything else | mock-tested (adapter contract) or detection-only |

To verify the commands for real: run Resolve Studio, set External scripting to Local, open Resolve, then
`CS_LIVE_TESTS=1 npx vitest run src/main/integrations/resolve.live.test.ts`. It creates and deletes only a project named
"CreateCraft Live Test" and re-opens whatever was open.

## Before universal third-party adapter loading

1. **Packaging and signing**: manifests are validated, but adapters are code in the main process. Loading needs a signed
   package format, a per-adapter permission ceiling and, ideally, running adapters in a utility process.
2. **Live-session apps need a first-class attach step**: the manager has no concept of "the user must start the program".
   `HealthResult.state` covers the status; an `ensureRunning` capability (with the `launch` permission) would let an
   adapter offer to start a program the user approves.
3. **Edition and licence discovery**: `ExternalAppInfo` has no edition field. Resolve only reveals it after a successful
   connection. A manifest-declared `requirements` list (edition, preference, runtime such as Python) would let the screen
   say "needs Studio and Python" before the user tries.
4. **Runtime dependencies**: Python discovery is inside the Resolve adapter. A shared runtime resolver (Python, Node,
   .NET) with version and crash probing belongs in the SDK once a third adapter needs it.
5. **Long-running commands**: `execute` is one request and response with a timeout. Renders need job handles
   (`getExecutionStatus` is in the capability list but the manager does not implement it).
6. **Output policy**: outputs land in the work folder; adding them to the user's library with provenance is not wired.
7. **Version matrix**: only Blender 4.0.2 and Resolve 21 exist on this PC; supported ranges are declared, not tested.
8. **Mutation safety for live projects**: Resolve has no undo over the API; `project.create_scratch` is the only mutating
   command and is limited by name prefix. Adapters should declare which mutations are reversible before any command
   edits a user project.

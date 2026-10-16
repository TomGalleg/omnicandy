# Autodesk Revit 2027 integration

CreateCraft's first real Autodesk integration. It is a **hybrid** package (`autodesk.revit`) on the existing Universal Connect /
Universal Installer framework (`docs/universal-installer.md`): a connector that runs in CreateCraft's restricted adapter process,
plus a C# add-in inside Revit that talks to CreateCraft over the authenticated named-pipe bridge. There is no separate Autodesk
engine: Claude reaches Revit through the same `external_apps` / `external_run` / `external_job` tools as every other program.

## What the user does

1. Revit 2027 is detected (Connect Applications).
2. **Connect**: CreateCraft explains the add-in (what it is, the folder it goes into, that Revit must be closed and restarted).
3. The user approves. CreateCraft copies two files into `%APPDATA%\Autodesk\Revit\Addins\2027` (no administrator rights, no
   .NET or pipe setup) plus its pairing file `cc-bridge.json`.
4. The user starts Revit. Revit may ask once whether to load an add-in it does not know: choose **Always Load**.
5. CreateCraft shows Connected only after the add-in answers a real check from inside Revit.

## Pieces

| Piece | Where |
|---|---|
| Add-in source (C#, net10.0-windows) | `addins/revit/CreateCraft.Revit/` (`App.cs` entry + dispatcher, `BridgeClient.cs` protocol, `Commands.cs` operations, `Log.cs`) |
| Build | `node scripts/build-revit-addin.mjs` (needs the .NET SDK and Revit 2027 installed, only to reference its API assemblies; none of Autodesk's files are copied) |
| Package source | `fixtures/revit-adapter/` (`adapter.json` manifest v2, `main.js` connector, `plugin/` built DLL + `.addin`) |
| Signed package | `resources/adapters/autodesk.revit-1.0.0.ccadapter` (built by `npm run catalog`; **development key**, see `docs/release-signing.md`) |
| Host profile | `autodesk.revit` in `install/hostProfiles.ts`, readiness `supported` |

Revit 2027 runs on **.NET 10** (its `RevitAPI.runtimeconfig.json` says `net10.0`). The add-in targets `net10.0-windows` and loads from
`Addins\2027\CreateCraft\CreateCraft.Revit.dll` through `CreateCraft.addin` (relative `Assembly` path, confirmed to load).

## Execution model

- The bridge client runs on its own thread and **never touches the Revit API**. Each command is queued and executed in Revit's
  supported API context: an `ExternalEvent` handler, with an `Idling` handler draining the same queue when Revit does not
  raise the event promptly. Commands run one at a time, in order.
- The bridge starts at Revit's **first idle**, not at add-in load, so CreateCraft never sees an add-in that cannot answer yet
  (Revit may still be opening a file or showing start-up dialogs).
- Edits run in a `Transaction` with a failure preprocessor that rolls back on any error; every edit is one step in Revit's own
  Undo list.
- Lost connection: the client reconnects with backoff and re-reads the endpoint, so CreateCraft restarts recover by themselves.
  Revit closing sends `ApplicationClosing`, the pipe is closed, and CreateCraft stops showing Connected at once.
- Diagnostics (no model data, no secrets): `%LOCALAPPDATA%\CreateCraft\revit-addin.log`.

## Commands (all registered dynamically by the add-in)

| Command | Kind | What it does |
|---|---|---|
| `revit.app_info` | read | Revit name, version, build, open documents, add-in connection |
| `revit.project_info` | read | active project: title, path, project information, units, `documentKey`, whether it may be edited and why not |
| `revit.levels.list` | read | levels and elevations (mm) |
| `revit.views.list` | read | views by type (templates and system browsers excluded) |
| `revit.elements.count` | read | counts for one of 20 supported categories, or all |
| `revit.lighting.list` | read | lighting fixtures (family, type, level, position, placement kind), counts per type/level, and the fixture types available for placement |
| `revit.element.get` | read | category, family, type, level, Comments, Mark of one element |
| `revit.parameter.set` | edit | set **Comments** or **Mark** (an allow-list of two string parameters) |
| `revit.element.place_test` | edit | place an already-loaded, level-based family type at a point on a level; marked "CreateCraft test placement" |
| `revit.element.remove_test` | edit | delete only instances that the test placement created (needed to reverse a placement) |

`revit.element.get` and `revit.element.remove_test` go beyond the six read and two edit commands in the request: the first lets the
connector verify edits independently, the second makes a placement reversible.

## Safety

- **No arbitrary code.** There is no script, expression or "run this API call" command, and the manifest asks for neither
  `execute-scripts` nor `write-files`. A test (`revit.test.ts`) fails if one appears.
- **Permissions and confirmation.** Reads need `read-info` / `read-project`; edits need `modify-project` and are marked
  `destructive`, so the existing manager asks the user **every time** (verified live: the approval request was raised and flagged
  destructive before the placement).
- **Document identity.** Edits need the `documentKey` from `revit.project_info` (hash of path, title and the project's unique id).
  If another project is open now, nothing is changed. The connector checks it, then the add-in checks it again.
- **Scratch models only.** The add-in refuses edits unless the file name contains `scratch`, `cc-test` or `createcraft-test`, and
  never edits family documents, read-only documents, linked models or workshared models.
- **Independent verification.** After an edit the connector asks the add-in for a *separate* read of the element before reporting
  `verified`.
- **Bridge authentication unchanged** (mutual HMAC over nonces; secret created at install, in the add-in folder and under
  CreateCraft's data folder). A different Windows user or remote machine cannot use it; a process of the same user can read the
  pairing file (see the security statement in `docs/universal-installer.md`).
- Uninstall removes only files CreateCraft installed (hash-checked) and leaves other add-ins untouched.

## Verified against the real Revit 2027 (2027.3, build 27.3.0.28, trial/non-commercial licence)

Live test: `CS_LIVE_REVIT=1 npx vitest run src/main/integrations/revit.live.test.ts` (and `CS_LIVE_PHASE=repair` for the last stage).
It installs into the real per-user Addins folder, so Revit must be closed at the start, and it needs a scratch model
(`.local/revit-live/CreateCraft-scratch.rvt`, created from Revit's `Default_M_ENU` template with one test lighting family loaded).
Recorded results of the last full run:

| Check | Result |
|---|---|
| Install (review → approve → files) | passed: `CreateCraft.addin`, `CreateCraft\CreateCraft.Revit.dll`, `cc-bridge.json`; neighbouring add-ins (LightingAutomation, pyRevit) byte-identical afterwards |
| Revit loads the add-in | passed (relative `Assembly` path, no admin) |
| Pipe authentication + capability registration | passed: Revit 2027, 10 capabilities registered, none refused |
| Connect + verify | passed: "answered a real check from inside the program" |
| Real model data | passed: `revit.app_info`, `project_info`, 2 levels (Level 1 at 0 mm, Level 2 at 4000 mm), 9 views, 0 lighting fixtures, 1 placeable fixture type |
| Safety refusals | passed: wrong `documentKey` refused, non-approved parameter refused, unknown category refused, removing an element CreateCraft did not place refused |
| Reversible edit in the scratch model | passed: placed a test fixture (id 212311), set Comments, restored it, removed it; count 0 → 1 → 0, every step `verified` with a separate read; the approval prompt was raised and marked destructive |
| Connection recovery | passed: CreateCraft restarted (new pipe name); the add-in reconnected by itself |
| Revit closes | passed: the session dropped immediately; the next command failed honestly ("The add-in is not connected"); add-in log shows `bridge closed` on shutdown |
| Repair | passed: deleted DLL restored from the verified saved original |
| Uninstall | passed: Revit's add-in folder back to the other add-ins only, byte-identical |

Offline tests: `revit.test.ts` (manifest, plan, install/repair/uninstall, manifest ⇄ C# command list), installer and bridge suites.

## Known limitations

- **Not yet run through the Electron window.** The whole flow was driven through the real `AdapterPackages` / integration manager
  (the layer the Connect screen and Claude's `external_*` tools call). Clicking Connect in the CreateCraft window and asking Claude
  in natural language was not exercised for Revit; Claude's tools use the same manager calls.
- Tested on one machine with Revit 2027.3 on a trial licence, one language (English), one Windows user. Other Revit years are not
  supported (a separate build is needed per year).
- Revit must be **closed during install**, and restarted afterwards. Revit may show its own "load this add-in" prompt once.
- Commands wait for Revit to be idle. While Revit shows a modal dialog (open/save prompts, errors), commands time out with the
  bridge's timeout error and the user has to dismiss the dialog. Closing Revit with unsaved changes also shows Revit's own
  save prompt.
- The add-in DLL is **unsigned** (a Revit publisher certificate would remove the load prompt); the package is signed only with a
  development key.
- Edits are limited to Comments and Mark and to placing one already-loaded, level-based family. No family loading, hosted
  placement, geometry editing, saving or sync (deliberate).
- Lighting results show placement info (levels, positions, placement kind), but no photometric or electrical data.
- Results are capped (400 views, up to 500 fixtures, 64 KB per reply) and say when they were truncated.
- Opening a project in Revit is done by the user (CreateCraft has no `open` command for Revit).
- Same-user processes can read the pairing secret (framework-wide limitation).

## Known issues found while testing

- Revit queues `ExternalEvent`s without running them while it starts up or shows dialogs, so the add-in now connects only at first
  idle and also drains its queue from `Idling`.
- `FreeCAD`/`Universal Connect` live tests have a 10 s start-up hook that sometimes times out on a busy PC (passed on retry; same
  without these changes).

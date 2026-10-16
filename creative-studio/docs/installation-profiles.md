# Installation profiles: Autodesk and Adobe (groundwork only)

These profiles live in `src/main/integrations/install/hostProfiles.ts` and are CreateCraft's own record of **where and how each
program accepts plugins**. A package can only name a profile and one of its destination ids; the folders, file types, size
limits and administrator flags below are enforced by the installer independently of any manifest.

> **Status: groundwork. None of these programs is ready to connect.** There is no working CreateCraft add-in for any of them, so
> none is marked supported, none is selectable in Connect Applications, and nothing here was run against the real software.
> The entries come from vendor documentation and developer-community answers read on 2026-10-16 (links at the end). Entries marked
> *confirm* are the ones that must be re-checked against the current vendor documentation and a real installation before the first
> add-in is written. A profile becomes "ready" only together with a real, tested add-in for that program.

Local check on this PC (Windows 11): Revit 2027 is installed (the per-year `Addins` folder convention applies); no other Autodesk or
Adobe program was found by discovery. The shipped Revit MCP tooling in the project is unrelated to this installer.

## What every profile records

Plugin technology · installation requirements · supported desktop versions · user versus administrator installation · restart
behaviour · communication options · API-context rule · vendor installation mechanism · restrictions and dependencies.

Common to all: the add-in connects **out** to CreateCraft's local plugin bridge (named pipe), authenticates with the secret created at
install time, registers its capabilities and executes each command **inside the program's supported API context**. CreateCraft never
calls a program's API from its own threads.

## Autodesk

| Program | Plugin technology | Where (installer's approved destinations) | User / admin | Restart | Versions |
|---|---|---|---|---|---|
| **Revit** | .NET add-in + `.addin` manifest | `%APPDATA%\Autodesk\Revit\Addins\<year>` (user), `%PROGRAMDATA%\Autodesk\Revit\Addins\<year>` (all users), or an `ApplicationPlugins\*.bundle` | user folder: no admin; ProgramData: admin | **Required** (manifests are read at start-up) | One build per release year; .NET Framework 4.8 to 2024, .NET 8 from 2025 |
| **AutoCAD** | `.bundle` with `PackageContents.xml` (autoloader); .NET assembly via NETLOAD | `%APPDATA%\Autodesk\ApplicationPlugins` (user), `%PROGRAMDATA%\Autodesk\ApplicationPlugins` (all users) | user: no admin; all users: admin | **Required** for autoload (or load by hand) | Series-specific builds; .NET 4.8 to 2024, .NET 8 from 2025 *(confirm)* |
| **Fusion** | Python or C++ add-in with a `.manifest` | `%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns` | no admin | **Not required** (start from Scripts and Add-Ins) | Single rolling desktop release *(confirm)* |
| **Inventor** | .NET add-in + `.addin` manifest | `%APPDATA%\Autodesk\Inventor <year>\Addins` (user), `%PROGRAMDATA%\Autodesk\Inventor Addins` (all users) | user: no admin; shared: admin | Required | Per release year *(confirm)* |
| **3ds Max** | `.bundle`, Python (pymxs) or MAXScript start-up scripts | `%APPDATA%\Autodesk\ApplicationPlugins` | no admin | Required (start-up) | Per release year *(confirm)* |

- **Communication:** add-in dials the named pipe (Revit/AutoCAD/Inventor/3ds Max); Fusion add-ins may use a worker thread for the pipe
  and hand work to the main thread with a custom event.
- **API context:** Revit: only inside a valid API context (command, event, or an `ExternalEvent` handler) and model changes inside a
  `Transaction`. AutoCAD: application/document context with the document locked. Fusion: API is not thread-safe; use a custom event.
  Inventor: COM, apartment threaded, marshal to the main thread. 3ds Max: scene changes on the main thread.
- **Vendor mechanism:** Autodesk App Store `.bundle` packages (`PackageContents.xml`) are the vendor-recommended distribution; a manual
  copy into the folders above is the documented alternative. When a vendor flow is required CreateCraft guides it (manifest
  `mechanism: "vendor-workflow"`) instead of copying files.
- **Restrictions:** Revit may prompt to allow an unsigned add-in; AutoCAD's `SECURELOAD` may block untrusted folders; build per
  release year/series.

## Adobe

| Program | Plugin technology (desktop) | Where | User / admin | Restart |
|---|---|---|---|---|
| **Photoshop** | UXP plug-in (`.ccx`), CEP panel (legacy), ExtendScript | UXP: installed by Adobe's Unified Plugin Installer / Creative Cloud (vendor workflow). CEP: `%APPDATA%\Adobe\CEP\extensions` (user) or `%COMMONPROGRAMFILES%\Adobe\CEP\extensions` (all users) | user: no admin; common files: admin | Unknown, confirm per version |
| **Illustrator** | CEP panel, ExtendScript; check current UXP status *(confirm)* | same CEP folders | same | Unknown |
| **Premiere Pro** | UXP (newer releases), CEP (older), project-file exchange | same | same | Unknown |
| **After Effects** | ExtendScript / ScriptUI panels, C++ AEGP plug-ins, CEP | CEP folders; scripts and plug-ins live **inside the program folder** (admin) | admin for program-folder items | Unknown |
| **InDesign** | UXP (recent), CEP (older), ExtendScript | CEP folders; user Scripts Panel folder for scripts | user: no admin | Unknown |

- **Communication:** a panel or plug-in connects to the named pipe where its technology allows it, otherwise to a loopback socket
  restricted to the local machine (that variant would need its own authentication review before use).
- **API context:** host scripting runs on the program's main thread through its scripting entry point; UXP calls go through the
  plug-in's host APIs. Photoshop's `batchPlay` is Photoshop-specific.
- **Vendor mechanism:** signed `.ccx`/`.zxp` packages are installed by Adobe's Unified Plugin Installer Agent or Creative Cloud.
  CreateCraft guides this workflow; it does not copy UXP plug-ins into place.
- **Restrictions:** unsigned CEP panels need Adobe's `PlayerDebugMode`, which CreateCraft will **not** switch on silently (it is a
  security setting). Adobe is moving panels from CEP to UXP and support differs per program and release: check the release notes
  of the target version first. A Creative Cloud licence is needed for the program itself.

## Rules the installer applies to every profile

1. Destination ids and folders come from this table, never from the package.
2. A manifest that claims no administrator rights for an admin destination is rejected.
3. A technology that the destination does not load (for example CEP into Revit's `Addins`) is rejected.
4. Only allowed file extensions are written; `.exe` and scripts are never written into these folders by default tables.
5. Existing files that CreateCraft did not install are never overwritten.
6. The program is never closed or started by the installer; elevation needs the user's approval **and** an elevator (see
   `docs/universal-installer.md`, "Administrator rights").

## Sources

- Autodesk, *Add-in Registration* (Revit API): https://help.autodesk.com/cloudhelp/2016/ENU/Revit-API/files/GUID-4FFDB03E-6936-417C-9772-8FC258A261F7.htm
- Autodesk Revit API forum, add-in file locations: https://forums.autodesk.com/t5/revit-api-forum/revit-addin-file-locations-for-production-release-and-test-debug/m-p/6733987/highlight/true
- Autodesk App Store documentation (`ApplicationPlugins`, `PackageContents.xml`): https://aps.autodesk.com/node/3092 and the Autodesk University autoloader handout https://static.au-uw2-stg.autodesk.com/DV2142_handout_2142_an_20in-depth_20look_20at_20the_20autodesk_20autoloader_20module.pdf
- Adobe, *CEP to UXP technical migration guide*: https://developer.adobe.com/uxp/migration-center/uxp-for-cep-devs/technical-migration-guide/
- Adobe CEP resources: https://github.com/Adobe-CEP/CEP-Resources and UXP: https://developer.adobe.com/uxp/

Not found in official documentation during this research and therefore marked *confirm*: exact per-release version ranges, After
Effects/Illustrator/Premiere restart behaviour, Fusion and 3ds Max autoload specifics, and the end-of-life date of CEP.

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
| `src/main/integrations/adapters/blender.ts` | First real adapter (scripting, background mode) |
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

## Verification status

See the milestone report. Real-application verification exists for Blender only; everything else is mock-tested
(adapter contract) or detection-only.

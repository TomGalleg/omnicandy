# Blender batch modeling and safe recovery

Three commands on the built-in Blender adapter (no second controller; they go through `IntegrationManager`, the approval
dialog, the encrypted edit journal and `evidence_verify` like every other command).

| Command | Purpose | Permissions |
|---|---|---|
| `discover.search` | Search what `scene.build` can make against the running Blender (primitives, modifiers with their real RNA properties, materials, lights); lists `bpy.ops` entries as **informational, not executable**. `name` returns one schema; `name: "spec"` returns the grammar and an example. | launch, execute-scripts (read only, trusted read-back) |
| `scene.inspect_detail` | Opens the **saved** file in a fresh background Blender and reports project identity, every object's `cc_id`, transforms, world bounding box, vertex/face counts, materials, modifiers, parent, collections and the batch ledger. `ids` / `batch_id` focus and bound the answer. | read only, trusted read-back |
| `scene.build` | Creates or updates up to 64 objects from a strict JSON spec (`json` parameter, built-in adapters only). | edit permissions |

## The spec

`{batch_id, chunk?:{index,total}, project_id?, objects:[{id, kind, name?, collection?, parent_id?, loc?, rot_deg?, scale?, shape?, origin?, smooth?, material?, modifiers?, light?, camera?}], scene?:{camera_id}}`

Kinds: `box uv_sphere ico_sphere cylinder cone plane circle monkey empty light camera`. Modifiers: `subsurf bevel solidify mirror array
wireframe decimate triangulate boolean screw edge_split simple_deform`, with properties validated against the running Blender's own
RNA. Geometry is made with `bmesh.ops.create_*` and `bpy.data`; no `bpy.ops` besides opening and saving the project. There is no code
path from the spec to Python text, and unknown keys are rejected.

## Idempotency and durability

* Every object carries a stable `cc_id` (and `cc_batch`, `cc_chunk`). Objects are upserted by `cc_id`, never by Blender name
  (Blender renames collisions to `Cube.001`).
* The **batch ledger** (`scene["cc_ledger"]`, inside the `.blend`) records each applied `batch_id#chunk` with its spec hash and ids.
  The same batch + chunk with the same content is a no-op; with different content it is refused. An id belongs to the batch that made it.
* The whole spec and every reference are validated **before** anything changes; building keeps an undo log, so a failure restores the open scene.
* Saving is not trusted to Blender: a temporary copy is written and checked, the previous version is kept as `.blend1`
  (as Blender does), and the project is replaced in one step. A crash leaves the old file or the new one.

## Recovery (journal + host assessment)

Before dispatch the edit journal records the batch identity: file, `batch_id`, chunk, spec hash, object ids and a few requested
facts (never the raw spec). After an interrupted `scene.build` all edits stay locked until a fresh `scene.inspect_detail` and a passing
`evidence_verify`. The host then judges the read-back itself:

| Outcome | Meaning | Lock |
|---|---|---|
| applied | ledger records the chunk with the expected hash **and** every requested object has the requested content | released, never replayed |
| absent | no ledger entry and none of the objects exist, right project, complete id list | released; the same batch may run again |
| partial | objects exist without a ledger entry | stays; no replay |
| ambiguous | wrong/unidentifiable project, damaged ledger, other hash, ledger and content disagree | stays; the journal is never cleared automatically |

## Tests

`blenderBatchSpec.test.ts`, `jsonParams.test.ts`, `jsonParam.test.ts` and `blenderBatchRecovery.test.ts` run everywhere.
`blenderBatch.live.test.ts` drives a real Blender on disposable files (`CS_LIVE_TESTS=1`), including crashes at every point of the
save (the adapter forwards `CREATECRAFT_BATCH_FAULT` to the script; it can only abort).

## script.run (open-ended Python, approval-gated)

For what the typed commands cannot do (armatures and rigging, geometry nodes, simulation, UVs). The user reads and approves the
exact code on EVERY run (never "always allow"). It runs in a background Blender on a COPY of the project, with only an allow-list of
modules importable (checked by an AST walk inside Blender; a guard against mistakes, not a sandbox). On success a backup is kept
(`.cc-backups`, last ten) and the project is replaced in one step; the open window saves first and reloads after. A run marker in the
work folder holds the file's hash before and after, so recovery can prove applied (file == new), absent (file == old, may run again)
or ambiguous (anything else; the lock stays). Not idempotent: read the result back with `scene.inspect_detail`.

## scene.viewport (pictures for vision models)

A read-only picture of the open window's 3D view (iso/front/back/left/right/top/camera, optional `focus`), drawn into an offscreen GPU
buffer with explicit matrices (no render, the user's own viewport is not changed). It is a view-only inspection: not an edit, never
read-back evidence, never proof. Pictures go only to vision-capable models, at most 6 per task, one every 2 seconds, at most 1024 px
and 2 MB, are deleted after use, and the temporary path is never shown to the model.

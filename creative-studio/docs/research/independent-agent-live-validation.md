# Independent AI: live validation (Round 4)

Baseline `6c66a00` (Package A+B+C, working tree otherwise clean). Validated against the **built Electron app** (`out/`, launched with Playwright `_electron` and an isolated, disposable profile in the temp folder), the **real ArtCraft apps** (PhotoCraft, FilmCraft, 13/13 detected) and **real Blender 4.0.2**. No paid API calls, no model downloads, no API keys used or printed, no user project touched.

## Method and what "mock" means here

- **The model is always mocked.** The real app was pointed (through the real provider selector and IPC) at a free OpenAI-compatible HTTP server on `127.0.0.1` that returns scripted tool calls. Everything after the model reply (tool registry, IPC, loop, checkpoints, controllers, PhotoCraft/FilmCraft/Blender, Deliver queue, approval prompts) is the real implementation. So a PASS below proves integration of the harness and applications, **not** the quality of any real model's decisions.
- PASS = verified in the actual Electron app or against the real application. MOCK PASS = only a simulated integration was verified. Rows say which.
- Native message boxes were intercepted by the test (answers: Cancel everywhere, "Allow once" only for the Blender permission prompt). Paid/approval cards were **closed** (= Cancel); nothing was sent or charged. A fake, never-transmitted test key was written to the temp profile's vault only to let the paid-generation flow reach its approval card.
- Harness scripts live in the session scratchpad (not in the repository). The one repository addition is `src/main/agentHarness/agentBlender.live.test.ts`, skipped unless `CS_LIVE_TESTS=1` (uncommitted).

## Environment

- Windows 11, Node 22, Electron app built from HEAD `6c66a00`; Blender 4.0.2 (detected, connected through the built-in adapter); ArtCraft apps installed 13/13.
- Providers: no OpenAI/Gemini key in the profile; local mock endpoint only.

## Summary

| Result | Count |
|---|---|
| PASS | 60 |
| MOCK PASS | 5 |
| FAIL | 5 |
| BLOCKED | 4 |
| NOT TESTED | 7 |
| **Total** | **81** |

## Failures (reproducible)

### F1 - `shape.info {layer}` read-back is rejected as evidence (N3) - high
**What happens.** The natural call `app_command shape.info {"layer": 43}` returns `Result: {...}` followed by an extra line `Parameter validation unavailable: Cannot validate shape.info: unsupported schema for "layer". Do not execute.` `parseReadback` (`src/main/agentHarness/taskPlan.ts`) parses everything after `\nResult: ` as one JSON document, so the trailing note makes it fail, the receipt is not read-back-eligible and `evidence_verify` answers "Receipt has no eligible structured read-back". The same applies to any command whose parameters the native preflight cannot validate.
**Consequence.** The documented PhotoCraft shape verification and the rectangle-intent recovery path only work if the model calls `shape.info` with *no* parameters (N3b passes) or uses `layer.list` (N2 passes).
**Reproduce.** Open the Independent AI panel, choose Local model with any scripted endpoint; script: `open_file photocraft-smoke.png`, `app_command shape.create {kind:"rect",rect:[20,30,100,60]}`, `app_command shape.info {layer:<id from create>}`, `evidence_verify {receipt_id:<shape.info receipt>, path:"live.rect.0", expected:20}` -> error. Same script with `shape.info {}` passes.
**Not fixed** (validation round; no source changes).

### F2 - `document.inspect` is listed as a read-back command but real PhotoCraft refuses it (N3c) - low
`readbackCommands` in `loop.ts` and `readOnlyNativeCommands` in `taskPlan.ts` include `document.inspect`; real PhotoCraft answers `PhotoCraft command "document.inspect" is not allowed.` `layer.list` and `shape.info` work. Reproduce: `app_command document.inspect {}` with PhotoCraft open.

### F3 - A new task started right after a takeover fails, and the failed attempt destroys the paused task (N8e, N8f) - medium
**Reproduce.** Run any Independent AI task; while the model is thinking click **Take Control** (or call `window.studio.live.takeControl()`); the task ends `paused`. Click **I'm done, hand back** (`releaseControl()`). Now press **Run** for a new goal: result is `failed: User control or pause is active.` The attempt has already cleared the saved task (`pausedAgent = null` and checkpoint cleared in `agentRun`, `src/main/ipc.ts`, before `runAgent` rejects), so **Continue Task is no longer available** and the interrupted work cannot be resumed. Using **Continue Task** instead of Run works (N8d). Two issues: the collaboration state stays `paused` after "hand back" until Resume/Cancel, and a rejected start must not discard a resumable task.

### F4 - Paid-generation approval card says "Claude is asking to generate..." when Independent AI asks (N9c) - low/medium
**Reproduce.** Save any OpenAI key (a test value is enough; nothing is sent until you approve), choose Local model with a scripted endpoint, script `generate_image {prompt:"a cat", model_id:"gpt-image-2.5-flare"}`. The approval card heading reads *"Claude is asking to generate 1 image with OpenAI - GPT Image 2.5 Flare?"* (price shown correctly, cancelling charges nothing). Cause: the shared Claude handler hard-codes `requestedBy: 'claude'`, which `approveGeneration` (`ipc.ts`) and the spend log use to pick the label. The model-download dialog and the Blender permission prompt are not labelled Claude.

## Detailed results

### Electron UI / IPC

| ID | Result | Test | Evidence |
|---|---|---|---|
| U1a | PASS | provider selector lists OpenAI, Gemini, Local | {"providerOptions":["OpenAI","Google Gemini","Local model"],"openaiModels":["gpt-4.1-mini","gpt-4.1","gpt-4o-mini"]} |
| U1b | PASS | Gemini shows its models and run label | gemini-2.5-flash,gemini-2.5-pro / Run with Google Gemini |
| U1c | PASS | Local shows model name + endpoint inputs |  |
| U2 | PASS | budget inputs: defaults 20/50, out-of-range or fractional values block Run | 0/50:blocked 101/50:blocked 20/251:blocked 20/0:blocked 1.5/50:blocked 100/250:ok 20/50:ok |
| U2b | PASS | main process rejects maxTurns=1000 sent around the UI | Error invoking remote method 'agent:run': [   {     "origin": "number",     "code": "too_big",     "maximum": 100,     " |
| U4a | PASS | OpenAI without a key fails before anything is sent | failed: No OpenAI API key is saved. Add it in Settings, then run again. Nothing was sent. |
| U4b | PASS | Gemini without a key fails before anything is sent | failed: No Google Gemini API key is saved. Add it in Settings, then run again. Nothing was sent. |
| U4c | PASS | a failed-before-start run leaves no resumable checkpoint | null |
| U3a | PASS | no usage line when the provider reports none | status=completed usageLine=0 usage=undefined |
| U3b | PASS | usage line appears with provider-reported numbers | Tokens reported by the provider: 1,234 in, 56 out (Local model) |
| U3c | PASS | local provider sends no Authorization header / no key |  |
| U5a | PASS | turn budget ends the task as limit; state keeps provider+budget | {"status":"limit","provider":{"provider":"local","endpoint":"http://127.0.0.1:62080/v1"},"budget":{"maxTurns":2,"maxToolCalls":9}} |
| U5b | PASS | the 2-turn budget was enforced in the real app | model requests=2 |
| U5c | PASS | Continue Task used the same provider, endpoint, model and 2-turn budget | requests after resume=2 models=mock-limit |
| U5d | PASS | usage accumulates across Continue Task (4 reported replies x 10) | {"input":40,"output":8} |
| U5e | PASS | encrypted task checkpoint written to the project | C:\Users\tomas\AppData\Local\Temp\cs-live-ui-sXiV4j\projects\sample-project\.omnicandy-agent-checkpoint.enc |
| U5f | PASS | checkpoint file is encrypted (no plaintext model or endpoint) |  |
| U5g | PASS | after an app restart the task, provider, budget and usage are restored | {"status":"limit","provider":{"provider":"local","endpoint":"http://127.0.0.1:62080/v1"},"budget":{"maxTurns":2,"maxToolCalls":9},"usage":{"input":40,"output":8}} |
| U5h | PASS | Continue Task after restart still uses the restored local provider and budget | status=limit requests=2 |
| U6a | PASS | an older checkpoint (no provider/budget/usage/jobs) is readable and defaults to OpenAI + default budget | keys=goal,messages,model,plan,savedAt,status,version -> {"status":"limit","provider":{"provider":"openai"}} |
| U6b | PASS | continuing an older checkpoint targets OpenAI and fails safely without a key (nothing sent) | limit: Resume interrupted: No OpenAI API key is saved. Add it in Settings, then run again. Nothing was sent |

### Real apps through Independent AI

| ID | Result | Test | Evidence |
|---|---|---|---|
| N1 | PASS | real PhotoCraft opens through Independent AI; command discovery returns the real command schema | status=completed |
| N1b | PASS | the real app registers the shared Claude tool families, export and job tools | 48 tools |
| N1c | PASS | no shell / arbitrary filesystem tool is advertised | none |
| N2 | PASS | real PhotoCraft edit (shape.create) + fresh layer.list read-back + passing evidence_verify => completed | status=completed verify={"id":"v1","sourceReceiptId":"r2","path":"layers.0.bounds.0","expected":20,"observed":20,"passed":true} |
| N2b | PASS | a mismatching real read-back does not permit completion | status=limit |
| N2c | PASS | an unverified real edit ends as limit (resumable), not completed | status=limit |
| N2d | PASS | a read-only real command (layer.list) is not counted as an edit | status=completed |
| N2e | PASS | photocraft_command (Claude handler shared with Independent AI) edits the real document and is verified with layer.list | status=completed first=layer.new.layer (PhotoCraft) applied. Result: {"layer":47} Parameter validation unavailable: Cannot validate l |
| N3 | FAIL | shape.info {layer:N} (the PhotoCraft rectangle read-back) gives eligible structured evidence | evidence_verify said: Error: Receipt has no eligible structured read-back; use an approved read-only inspection command. Recovery: Outcome may \| shape.info text ends: ...0],"out":[80,90],"smooth":false}],"op":"combine"}]},"stroke":null} / Parameter validation |
| N3b | PASS | shape.info with no parameters (active layer) works as read-back | status=completed {"id":"v1","sourceReceiptId":"r2","path":"live.rect.0","expected":90,"observed":90,"passed":true} |
| N3c | FAIL | document.inspect (listed by the harness as a read-back command) is accepted by real PhotoCraft | Error: PhotoCraft command "document.inspect" is not allowed. Recovery: Outcome may be partial or unk |
| N4a | PASS | save_version through Independent AI creates a real new library version with a confirmed id | {"saved":true,"versionId":"d0d89c6c-137b-4a9b-8d5c-872de849bae2","message":"Saved photocraft-smoke-live1.pcraft (+ PNG preview) to the library."} Exec |
| N4b | PASS | list_export_formats returns real Deliver presets for the saved version | [ { "preset_id": "image-png", "label": "PNG", "note": "Full size, lossless", "file_type": "png", " |
| N4c | PASS | export_file really exports a PNG into the project exports folder via the Deliver queue | PNG: exports/photocraft-smoke-live1.png file=802 bytes |
| N4d | PASS | the whole edit -> verify -> save -> export task completes | status=completed |
| N5 | PASS | planner_packages (read-only) works against the real Project Planner service | [] |
| N6 | PASS | workflow_catalog / workflow_status / list_workflow_versions (read-only) work in the real app | { "step_types": { "import": "Pick library fi \| { "run": { "runId": null, "state": "idle \| [] |
| N8a | PASS | manual takeover while the model is thinking pauses the real task | takeControl=ok status=paused result=Agent stopped: paused. |
| N8b | PASS | no further model request was made after the takeover | requests=2 |
| N8c | PASS | the edit that was pending at takeover time was not executed (checked with a fresh layer.list) | sawLayerList=true layer x positions: 0 |
| N8d | PASS | after hand-back, Continue Task resumes and completes | status=completed |
| N8e | FAIL | starting a NEW task right after the user hands control back works | failed: User control or pause is active. |
| N8f | FAIL | the paused task is still resumable after a rejected attempt to start a new task | state after rejected new run: failed; Continue Task enabled=false |
| N9a | PASS | Independent AI generate_image reaches the real paid-generation approval card with a price (declined, nothing sent) | heading="Claude is asking to generate 1 image with OpenAI Â· GPT Image 2.5 Flare?" cost="â‰ˆ $0.013 USD" |
| N9b | PASS | a declined approval stops the agent task and reports that nothing was charged | status=paused tool="Error: The user cancelled this generation. Nothing was charged. Do not retry unless they ask." |
| N9c | FAIL | the paid-generation approval card is not labelled "Claude" when Independent AI asks | heading="Claude is asking to generate 1 image with OpenAI Â· GPT Image 2.5 Flare?" |
| N9d | PASS | request_model_download shows the real license/size dialog and a Cancel starts no download | dialogs=1 tool="The user declined the download. Do not ask again unless they bring it up." msg="Download Wan 2.1 T2V 1.3B (test model) (6.3 GB)?" buttons=["Cancel","Accept license and download 6.3 GB"] |
| N9e | PASS | the model-download dialog is not labelled "Claude" |  |
| N7a | PASS | timeline_add through Independent AI changes the real FilmCraft timeline | Add sunset-still.jpg to the timeline (FilmCraft) applied. Execution receipt: r2 (tool accepted; verify actual state before claiming outcome). |
| N7b | PASS | a timeline edit without a passing evidence_verify is not completed | status=limit |
| N7c | PASS | real FilmCraft timeline edit verified with a fresh get_status read-back (controller state) => completed | status=completed verify={"id":"v1","sourceReceiptId":"r3","path":"open.details.tracks.0.clips.2.name","expected":"sunset-still.jpg","observed":"sunset-still.jpg","passed":tru |

### Blender through the real Electron app

| ID | Result | Test | Evidence |
|---|---|---|---|
| B0 | PASS | Blender detected by the real app | 4.0.2 available |
| B0b | PASS | Blender connects through the real adapter | connected |
| B1a | PASS | real app: the inspection of scene.inspect advertises trustedReadback=true | ermissions, not an execution grant. IntegrationManager must enforce permissions and approvals."},"trustedReadback":true} |
| B1b | PASS | real Electron + real Blender adapter: edit + fresh scene.inspect read-back + matching evidence_verify => completed | status=completed verify={"id":"v1","sourceReceiptId":"r3","path":"data.details.1.location.0","expected":3,"observed":3,"passed":true} result=done |
| B1c | PASS | the real external-command approval prompt appeared for Blender edits (answered "Allow once" by the harness) | 3 prompts: Run "Create a basic 3D scene" in Blender? \| Run "Move, rotate or scale an object" in Blender? \| Run "Inspect a Blender file" in Blender? |
| B2 | PASS | real Blender read-back that disagrees with the claim does not permit completion | status=limit |
| B3 | PASS | a read-only trusted external command is not a mutation (completes without verification, no edit journal entry left) | status=completed journalFile=none newPrompts=1 |
| B4 | PASS | real edit response (verified:true by the adapter) is not accepted as verification | status=limit tool=Error: Receipt has no eligible structured read-back; use an approved read-only inspection command. Recovery: O |

### Other

| ID | Result | Test | Evidence |
|---|---|---|---|
| V1 | PASS | Real Blender 4.0.2 + real IntegrationManager + real `runAgent` (vitest, not Electron): `scene.inspect` classified trusted, edit/render/create commands not | source: agentBlender.live.test.ts |
| V2 | PASS | Same harness: edit + fresh real `scene.inspect` + matching `evidence_verify` => completed; cube really at x=3 afterwards | source: agentBlender.live.test.ts |
| V3 | PASS | Same harness: claimed value that disagrees with the real read-back => `passed:false`, task `limit` | source: agentBlender.live.test.ts |
| V4 | PASS | Same harness: read-only `scene.inspect` creates no mutation / journal begin | source: agentBlender.live.test.ts |
| V5 | PASS | Same harness: an edit whose response is lost (real edit applied, bridge error) blocks a second identical edit; adapter saw exactly one `object.transform` | source: agentBlender.live.test.ts |
| V6 | MOCK PASS | Real Blender render job on the real IntegrationManager, cancelled by the agent job ledger on takeover (`cancelled` observed). The command is not long-running in the real adapter, so the `longRunning` flag was injected in the command LIST only | source: agentBlender.live.test.ts |
| P1 | BLOCKED | Real OpenAI call (no key in the isolated profile; paid) |  |
| P2 | BLOCKED | Real Gemini call (no key in the isolated profile; paid) |  |
| P3 | MOCK PASS | OpenAI and Gemini request building, key header, usage parsing against a faked `fetch` (Package B unit tests); only the missing-key path was exercised in Electron | source: packageB.providers.test.ts |
| J1 | BLOCKED | Agent-owned background job + takeover inside the real Electron app: no built-in adapter command is `longRunning`, so no job can be started through the real agent path |  |
| J2 | BLOCKED | Job ledger restored after a real app restart with a job in it (same reason as J1). Checkpoint round-trip of `jobs` covered by unit tests | source: packageC.test.ts |
| J3 | MOCK PASS | Missing/interrupted job is never relaunched, restored ledger blocks relaunch (simulated manager) | source: packageC.test.ts |
| R1 | NOT TESTED | Uncertain external/native edit in the real Electron app (cannot be forced without crashing or tampering with a running application) |  |
| R2 | MOCK PASS | Uncertain edit cannot be blindly retried / recovery lock only released by matching trusted read-back (Blender transform + colour, PhotoCraft rect) with simulated adapters | source: packageC.test.ts |
| L1 | MOCK PASS | Large (3,000-object) read-back compared in full while the model sees an outline; >1 MB refused explicitly | source: packageC.test.ts |
| T1 | NOT TESTED | `timeline_move_clip` and `timeline_remove_clip` against real FilmCraft (only `timeline_add` was exercised) |  |
| W1 | NOT TESTED | `plan_workflow`, `run_workflow` (needs a prepared workflow and a user approval), `change_workflow_step`, template save |  |
| PL1 | NOT TESTED | Planner write operations: `planner_claim`, `planner_report`, `planner_propose`, `planner_get_package` (the new profile has no planner project; only the empty `planner_packages` list was read) |  |
| G1 | NOT TESTED | `generate_video` approval card; `make_local_video` / `make_motion_video` real runs |  |
| RS1 | NOT TESTED | DaVinci Resolve read-back (`app.info`, `project.inspect`): Resolve was not started |  |
| EX1 | NOT TESTED | Exports other than PNG, `add_to_library` hand-off |  |

## Answers to the specific questions

- **Electron UI validated?** Yes, in the real built app: selector (OpenAI / Gemini / Local), per-provider model lists, local endpoint input, budget validation (renderer and main process), usage shown only when reported, Continue Task keeping provider/endpoint/model/budget/usage (also after an app restart), encrypted checkpoint, older checkpoint without the new fields, missing-key failures before anything is sent.
- **Real Blender read-back worked?** Yes: edit via the real adapter, fresh `scene.inspect` in a new Blender process, matching `evidence_verify` completes; mismatching does not; the adapter's own `verified:true` is not accepted (inside the real Electron app and in the vitest live harness).
- **Approvals labelled Claude?** Paid generation: yes (F4). Model download and external-application prompts: no.
- **Providers:** local free endpoint fully validated end to end; OpenAI/Gemini validated only up to the credential check in Electron; real calls BLOCKED (no key, paid).

## Other observations

- Blender permission prompts appear for every external command including the read-only `scene.inspect` (existing policy).
- `get_status` now serves as read-back evidence for timeline edits (N7c passes); a timeline edit without a passing comparison stays `limit`.
- The 48 advertised tools include the shared timeline, workflow, planner, generation, local-media, PhotoCraft, export and job tools; no shell or arbitrary filesystem tool.

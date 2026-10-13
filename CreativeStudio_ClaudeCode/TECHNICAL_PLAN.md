# Creative Studio — Technical and delivery plan

## Proposed stack (validate with Claude Code environment)
- **Shell:** Electron / React / TypeScript; secure main/preload/renderer separation, Vite, minimal validated IPC; optionally alternative desktop shell if justified.
- **UI:** dockable layout library, React Flow (`@xyflow/react`) for node canvas, CSS design tokens for Dark/Light/System and accents, keyboard shortcuts, accessible controls.
- **State:** UI-local reactive store + events driven by persisted workflow runtime; no fake 'running' state. Main process controls lifecycle of external apps and AI jobs.
- **Persistence:** SQLite asset index (migrations), portable project directory with manifest and files; file integrity/hashes and version provenance.
- **Claude:** Agent SDK or equivalent verified Claude integration; separate creative reasoning from privileged execution. Credentials stored only in secure backend.
- **ArtCraft:** per-app adapter with capability handshake. Prefer official MCP/CLI/JSON interfaces if documented and tested. Native app window capture/focus is a separate OS service. Do not embed foreign native windows without proof of reliability.
- **Generation:** adapter registry with official HTTP APIs only, typed capability metadata, model discovery, cost estimator, provider-specific async job handler, rate limits and cancellation where supported.

## Contracts (illustrative)
```ts
type AssetKind = 'image'|'video'|'audio'|'vector'|'design'|'project';
type Capability = 'open'|'edit'|'save'|'export'|'preview'|'selection'|'layers';
interface AppAdapter {
  id: string;
  probe(): Promise<{installed:boolean; connected:boolean; capabilities: Capability[]; notes:string[]}>;
  open(assetId:string): Promise<{documentId:string}>;
  execute(documentId:string, operation:unknown): Promise<{checkpointId:string; outputAssetIds:string[]}>;
  save(documentId:string): Promise<void>;
  export(documentId:string, format:string): Promise<string>;
}
interface GenerationProvider {
  id: string;
  listModels():Promise<Array<{id:string; capabilities:string[]}>>;
  estimate(job:unknown):Promise<{amount:number; currency:string; approximate:boolean}>;
  submit(job:unknown, credentialHandle:string):Promise<{jobId:string}>;
  status(jobId:string):Promise<'queued'|'running'|'completed'|'failed'>;
}
type Actor = 'claude'|'user';
interface CollaborationController {
  requestPause():Promise<void>;
  acquireEditLock(actor:Actor, documentId:string):Promise<void>;
  releaseEditLock(actor:Actor, documentId:string):Promise<void>;
  resumeAfterSync(documentId:string):Promise<void>;
}
```
Adapt contract to platform reality, strong runtime validation and cancellation/error handling. Avoid treating arbitrary agent-generated operations as trusted input.

## Security model
- Electron webPreferences: contextIsolation true, nodeIntegration false, sandbox true when feasible, app-only navigation, Content Security Policy; strict IPC endpoint allowlist with validation. No arbitrary shell access from UI.
- Keychain-backed vault (Windows DPAPI/Credential Manager via audited implementation); renderer gets only connection status and non-secret credential handle; keys never included in Claude context.
- Per-provider explicit permissions, budget & spending approvals, immutable audit log for billed jobs; show estimates as estimates and actuals only if provider exposes them.
- Asset paths constrained to approved project roots and user-selected imports; avoid traversal and command injection; third-party content untrusted.

## Delivery phases and exit gates
**0. Discovery / setup**: audit installed ArtCraft tools, real integrations, software licenses, providers, environment and limitations; choose stack and document constraints. Gate: reproducible repo setup and evidence-backed capability matrix.

**1. Visual desktop shell**: professional dark/light/system UI, dockable panes, workspace navigation, mock project/asset library, contextual bottom pane, Claude panel, graph editor mock with real persistence. Gate: builds and runs on Windows, smoke-tested layout, no fake integrations claimed.

**2. First real vertical slice (PhotoCraft)**: import photo → open in running PhotoCraft → perform documented edit → observe real app state → save editable source + exported PNG → record node outputs/checkpoint. Gate: repeatable end-to-end screen recording/log; no manual file swapping; error state handled.

**3. Collaboration**: status lifecycle, pause safe boundary, exclusive takeover, save/sync then resume, approval cards and non-destructive branches, change history. Gate: tests for race/conflict recovery plus actual edit takeover demo.

**4. Provider BYOK**: Google image provider or other selected officially supported API, OS vault, connection test, optional paid preview, image generation results and metadata, quota/cost protections. Gate: integration test with mocks + explicitly approved live test (never incur charges unprompted).

**5. Additional apps and video**: VectorCraft, LightCraft, EffectCraft, DesignCraft, SoundCraft and FilmCraft as capability audit allows; video generation providers, video/animation/audio timelines, media compatibility conversions. Gate: one demonstrated cross-app and image-to-video workflow with source preservation.

**6. Production quality**: packaging/signing plan, migration/relink, performance, hotkeys, help/tutorials, secure updates, offline recovery, accessibility and crash handling.

## Initial acceptance test matrix
1. Dark/Light/System switch applies to all owned UI and persists restart; follows OS changes in System mode.
2. A still-image project never displays the editing timeline; video/animation does; audio waveform timeline as relevant.
3. Asset import never modifies original bytes; can find generated versions and provenance after restart.
4. Workflow graph persists and validates node type/edge compatibility; reruns only invalidated successors.
5. Agent task can be paused, manual edit lock obtained, state refreshed, resumed; conflicting writes prevented.
6. API keys cannot be found in log files, project JSON, renderer devtools state or export bundles.
7. Approvals block configured paid or destructive operations; cancelled requests cannot silently continue.
8. Actual PhotoCraft demo shows real application state change; missing integration displays 'not connected' accurately.
9. AI model picker filters by capabilities and authentication; unsupported Midjourney automation never offered.
10. Captured window can be undocked/maximized; capture failure offers clear fallback to native app window.

## Out-of-scope for first session
Real Midjourney automation, simultaneous support for all ArtCraft apps, guaranteed editable interchange among apps, accurate per-model price predictions without current published rates, native-window embedding, auto-generated media calls that incur cost, collaboration across remote users.

## Expected reporting from Claude Code each milestone
- Files changed, commands run, tests (pass/fail), executable demo instructions, sample screenshot locations.
- Integration truth table: **real verified / mocked / blocked / untested**.
- Security concerns and recommended next incremental task.

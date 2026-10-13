# Architecture (Phase 1)

## Stack decision

The plan's default stack is **Electron + React + TypeScript**, built with electron-vite, and I kept
it. The environment does not justify a different shell:

- Windows 11, Node 22 and Git are present. Electron 44 runs here and passed the smoke tests.
- The ArtCraft apps expose **stdio MCP servers and JSON CLIs**. Node's `child_process` in the main
  process is the natural host for them, so no native addon is needed to talk to ArtCraft.
- Electron's `desktopCapturer` is the likely route to live window capture in Phase 2, and
  `safeStorage` (DPAPI) is the likely backing for the credential vault in Phase 4.

Other choices:

- **React Flow (`@xyflow/react` 12)** for the node editor.
- **react-resizable-panels 4** for resizable and collapsible panes. Full docking and pop-out are
  deferred.
- **zod** for runtime validation at trust boundaries.
- **Vitest** for unit tests. **Playwright `_electron`** drives the built app for smoke tests and
  needs no browser download.

**SQLite is deferred.** A native module such as `better-sqlite3` needs an Electron-ABI rebuild,
and this machine runs npm with `ignore-scripts=true`. Phase 1 stores a portable JSON manifest per
project behind the `AssetRepository` interface. Swap in SQLite as an index (keeping the manifest as
the portable source of truth) once asset counts or queries need it. Revisit `node:sqlite` when the
bundled Node version ships it as stable.

## Layout

```
src/
  shared/      pure TS, no Electron: types, contracts, theme, workflow graph + validation,
               mock executor, collaboration reducer, timeline rule, IPC channel map  (unit-tested)
  main/        privileged side: window + security, IPC (zod-validated), project store,
               settings store, media sniffing, ArtCraft probe, service stubs
  preload/     contextBridge → window.studio (typed StudioApi), nothing else
  renderer/    React UI; only talks to window.studio
fixtures/sample-project/   seed assets (including real PhotoCraft headless output from the audit)
scripts/       fixture generator, Playwright smoke test
```

## Contracts (`src/shared/contracts.ts`)

`AppAdapter`, `GenerationProvider`, `AssetRepository`, `WorkflowExecutor`, `WindowCapture`,
`CredentialVault` and `CollaborationController` follow TECHNICAL_PLAN.md, with these additions:

- `isMock` on adapters, providers and executors, so the UI and executor can never mistake a mock
  for a real integration.
- `billable` on providers. The executor refuses billable submits unless a `consentToBillable`
  callback resolves `true`.
- `AppOperation` is `{command, params}`, matching the ArtCraft engine-command model the audit
  found (for example PhotoCraft `edit.fill`). Commands will be validated against the app's own
  `commands --json` registry before use.

## Phase 2 plan: PhotoCraft adapter

1. `PhotoCraftCliAdapter` (headless) in main. It calls `photocraft-cli run <file> --cmd … --out …`
   with fixed argv and no shell, writing only to a working-derivative directory inside the project.
   It produces `.pcraft` and `.png` outputs and records them as new asset versions with `parentId`.
2. `PhotoCraftLiveAdapter`. Launch `photocraft --control <port>` with a main-generated 64-hex
   `--control-token-file`, then hold one `photocraft-cli mcp --bridge … --automation-read-root
   <project> --automation-write-root <project>/work` session. Read state with `doc_inspect` and
   `session_list`.
3. `WindowCapture` via `desktopCapturer`, matched to the PhotoCraft window, shown in the Edit
   workspace with an explicit "live capture" label and a fallback to "focus native window".
4. Wire the collaboration lock to the live adapter. Claude's operations take the lock, and user
   takeover pauses at the operation boundary. On resume, `doc_inspect` and a file hash detect
   manual changes.

## Risks

| Risk | Mitigation |
|---|---|
| ArtCraft apps are pre-1.0 (0.6–0.10) and their protocols may change | Capability handshake on every connect (`tools/list`, `commands --json`); pin tested versions in the audit |
| `docs/control-protocol.md` referenced by the CLIs isn't shipped | Derive from `--help`, MCP tool schemas and the command registry; ask the vendor for docs |
| MCP UI tools (`click`, `type_text`) can make arbitrary edits | Gate behind the edit lock; prefer engine commands; confine with automation roots |
| EffectCraft `script` runs arbitrary JSX | Never route model text into it without review/approval |
| Window capture may be blocked (minimised, protected or GPU surfaces) | Separate service with explicit failure states; "open native window" fallback |
| npm `ignore-scripts` | Documented one-off Electron binary fetch; avoid native deps until needed |
| Renderer bundle is ~1.1 MB | Acceptable for desktop; code-split workspaces later |

# CreateCraft

CreateCraft is a Windows-first desktop app for creative editing. Claude acts as a Creative
Partner that coordinates the ArtCraft apps (PhotoCraft, VectorCraft, LightCraft, EffectCraft,
DesignCraft, SoundCraft, FilmCraft) and optional BYOK generation providers.

**Status: Phase 2, steps 1–2.** The UI, data model, contracts and safety state machines are real and
tested. **PhotoCraft edits run for real** (headless, through the installed `photocraft-cli`) from
workflow ArtCraft Edit nodes, and Export nodes write real files. Live control of the open PhotoCraft
window, window capture, Claude and generation providers are **not connected yet**. The app says so wherever they would appear. See [`../docs/integration-audit.md`](../docs/integration-audit.md)
for what was verified on this machine.

## Run it

Requires Node 22+ on Windows.

```bash
npm install
```

npm on this machine has `ignore-scripts=true`, so `npm install` skips Electron's own binary
download. Fetch it once (official GitHub release, verified against Electron's `checksums.json`):

```bash
node node_modules/electron/install.js
```

```bash
npm run dev
```

| Script | What it does |
|---|---|
| `npm run dev` | Electron + Vite with hot reload |
| `npm run build` | Typecheck, then production bundle to `out/` |
| `npm start` | Run the production bundle |
| `npm test` | Unit tests (Vitest) |
| `npm run lint` / `npm run typecheck` | ESLint / tsc for main+preload and renderer |
| `npm run check` | lint + typecheck + test |
| `npm run smoke` | Build, then drive the real app with Playwright-Electron in an isolated profile; writes `docs/screenshots/` |
| `npm run smoke:live` | Same, through the live PhotoCraft flow (opens a real PhotoCraft window, closes it afterwards) |
| `CS_LIVE_TESTS=1 npx vitest run src/main/photocraftLive.test.ts` | Integration tests against the live PhotoCraft window |

On first launch the app creates a sample project in `%APPDATA%\creative-studio\projects\sample-project`
by copying `fixtures/sample-project`. Appearance settings are stored in `%APPDATA%\creative-studio\appearance.json`.

## What works (Phase 1)

- **Shell.** Resizable, collapsible panes, with layout remembered per user: media browser and
  inspector on the left, workspace in the centre, Claude panel on the right, and a context-sensitive
  bottom pane. Eight workspaces: Media, Edit, AI Generate, Workflow, Effects, Color, Audio, Deliver.
- **Appearance.** Dark, Light, or System (follows Windows live). Seven accent presets plus a custom
  colour, persisted in main. Accent text is auto-adjusted to reach 4.5:1 contrast. The theme
  reaches the node editor, and media is never tinted.
- **Media library.** Import through a native dialog. Each original is copied into the project,
  hashed (SHA-256) and marked read-only, and the source file is never touched. Exact duplicates are
  detected. Thumbnails, search, a kind filter, ratings, and an inspector showing provenance,
  dimensions or duration, hash and storage path.
- **Timeline rule.** The bottom pane shows a timeline only for audio and video. Stills, vectors and
  native docs show the activity log.
- **Workflow.** React Flow graph with typed ports (`image`, `document`). Node types: Import,
  AI Generate, ArtCraft Edit, Approval, Export. Connections are validated live (type mismatch,
  doubled input, cycle, self-loop). The graph autosaves to `workflow.json` and is re-validated in
  main. "Run demo" uses the **MOCK** executor: real topological ordering, node states, an approval
  gate that blocks downstream nodes, and cancel. It makes no network calls, writes no files and
  drives no app.
- **Collaboration state machine.** Planning, Ready, Running, Pausing, Paused, Manual Control,
  Awaiting Approval, then Completed, Failed or Cancelled. There is a single edit lock. Pause and
  Take Control wait for the active operation to finish. Resume compares the document version and
  replans if it changed. The Claude panel drives a labelled mock task through it.
- **PhotoCraft edits (real, headless).** An ArtCraft Edit node runs one allowlisted PhotoCraft
  command (17 presets such as Hue/Saturation, Levels, Photo Filter, Gaussian Blur and Oil Paint, or
  any other adjustment, filter or rotation id) with JSON parameters. Each run adds an editable
  `.pcraft` and a flattened `.png` as new read-only versions linked to their parent. The input is
  never modified. SVG inputs are flattened first, and chained edit nodes continue from the layered
  `.pcraft`. Commands that open, save, run scripts or reference other files are refused, as are
  path-like parameters. PhotoCraft runs with a fixed argument list and no shell.
- **Edit tab: the app opens right inside CreateCraft (real).** Pick a file and go to Edit: it opens
  automatically in its app (PhotoCraft for photos, VectorCraft for vector art, SoundCraft for audio),
  shown in the big Edit area. The app's real window is made borderless and owned by CreateCraft,
  then kept exactly over the Edit area as CreateCraft moves or resizes (`src/main/embeddedApp.ts`,
  `resources/window-tracker.ps1`); input works natively because it is still the app's own window.
  On the right, a short list of edits grouped by intent applies live in the app; Undo, Save as new
  version, and **Open in its own window** / **Put back in CreateCraft** sit in the top bar. Leaving
  the Edit tab hides the app; switching files minimizes the previous app.
- **Edit tab: the right app for each file type (real).** Photos and PhotoCraft/PSD documents go to
  PhotoCraft, SVG/AI/EPS/PDF to VectorCraft, audio to SoundCraft, and video to FilmCraft (no quick
  edits yet: there's no video to verify against). Each app offers quick edits with sliders and
  choices: PhotoCraft has 10, VectorCraft 5 (invert colours, rotate, flip, scale, fit artboard),
  and SoundCraft 4 (normalize, volume, fades, sample rate). They run headless through the app's CLI,
  are validated against `src/shared/appEditors.ts`, and are saved as new versions with a preview.
  *Open in VectorCraft/SoundCraft* opens a writable working copy in the app's window (audio as a
  SoundCraft session); after saving there, *Bring back* adds it as a new version (SoundCraft: the
  bounced mix).
- **Live PhotoCraft (real).** Edit → *Open … in PhotoCraft* launches the real PhotoCraft window
  with a random control token (a file in `%APPDATA%\creative-studio\secrets`, never sent to the UI)
  and PhotoCraft's own automation roots: it can read only the project and write only
  `work/live`. PhotoCraft enforces this itself; a wrong token or an outside path is refused.
  Automation steps run one at a time, visibly, under the **edit lock**: Pause and Take Control
  land after the current step, automation refuses to run while you hold control, and resuming
  re-reads PhotoCraft's history. If you changed the document, the remaining steps wait for your
  go-ahead, and edits made in PhotoCraft mid-task auto-pause the task. *Save as new version* stores
  `.pcraft` + `.png` versions with lineage. SVGs are flattened on open.
- **Pop-out controls docked to PhotoCraft.** When PhotoCraft opens, the task controls, automation
  steps and Save move into a slim panel attached to the left edge of the PhotoCraft window. It is
  made an owned window of PhotoCraft (Win32), so it stays above it and minimizes with it, and it
  follows the window as you move or resize it (`resources/window-tracker.ps1`, no native modules).
  If there is no room on the left, PhotoCraft is nudged right once. *Dock* returns the controls to
  the main window.
- **Export (real).** Export nodes convert the upstream version into `<project>/exports/`
  (PNG, JPG, WebP, TIFF, PSD or PCRAFT). Deliver lists the exports with "Show in folder".
- **ArtCraft detection (real).** Main checks each `*-cli.exe` and reads `--version`. The header shows
  "N installed · 0 connected".

## Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The preload exposes one
  typed `window.studio` API. ESLint forbids Node and Electron imports in the renderer.
- Every IPC handler checks that the sender frame is the app's own page and validates its arguments
  with zod. Graphs and manifests loaded from disk are schema-validated too. Asset paths that escape
  the project root are refused.
- CSP is `default-src 'self'`. Images load only from `self`, `data:` or the read-only
  `studio-asset:` protocol, which resolves asset IDs through the manifest. Navigation is
  restricted to the app, `window.open` is denied, and permission requests are denied.
- No secrets anywhere. `CredentialVault` is an interface plus a "not configured" stub. Billable
  providers are refused by the executor unless an explicit consent callback approves, and Phase 1
  provides none.

See [`docs/architecture.md`](docs/architecture.md) for structure, decisions and risks.

# CreateCraft

CreateCraft is a Windows-first desktop app for creative editing. Claude acts as a Creative
Partner that coordinates the ArtCraft apps (PhotoCraft, VectorCraft, LightCraft, EffectCraft,
DesignCraft, SoundCraft, FilmCraft) and optional BYOK generation providers.

**Status: Phase 2, steps 1–2.** The UI, data model, contracts and safety state machines are real and
tested. **PhotoCraft edits run for real** (headless, through the installed `photocraft-cli`) from
workflow ArtCraft Edit nodes, and Export nodes write real files. Live control of PhotoCraft, VectorCraft
and SoundCraft, the Claude Creative Partner and BYOK AI image generation (OpenAI, Google Gemini,
approval before every paid call) are connected. Window capture is **not connected yet**. The app says so wherever they would appear. See [`../docs/integration-audit.md`](../docs/integration-audit.md)
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
| `npm run smoke:generate` | AI Generate: Mock generation, key entry (fake key), approval gate stubbed to Cancel, Open in Edit. No paid calls |
| `node scripts/smoke-claude-generate.mjs` | Claude's `generate_image` tool (needs Claude Code signed in): one Mock image plus one cancelled OpenAI request |
| `node scripts/smoke-projects.mjs` | Project Home / Overview: create, open, switch, rename, remove, remembered after restart |
| `node scripts/smoke-theme.mjs` | Theme presets with PhotoCraft embedded, app theme sync, System mode, persistence, artwork unchanged (opens real app windows) |
| `npm run smoke:live` | Same, through the live PhotoCraft flow (opens a real PhotoCraft window, closes it afterwards) |
| `CS_LIVE_TESTS=1 npx vitest run src/main/photocraftLive.test.ts` | Integration tests against the live PhotoCraft window |

On first launch the app creates a sample project in `%APPDATA%\creative-studio\projects\sample-project`
by copying `fixtures/sample-project`. Appearance settings are stored in `%APPDATA%\creative-studio\appearance.json`.

## What works (Phase 1)

- **Projects.** The **Home** tab (or the project name in the header) shows Project Home: every
  project as a card with a thumbnail, file/version counts and last change; create, open, rename,
  show folder, and remove (to the Recycle Bin; never the open project or the Sample Project). Below
  it, the open project's Overview: files by kind, versions, exports, storage, recent versions and
  the workflow. Each project is its own folder under `%APPDATA%\creative-studio\projects` with its
  own originals, versions, workflow and exports; the open project is remembered. Switching is
  refused while an edit task, workflow or Claude is busy, and app windows left open are not closed.
- **Shell.** Resizable, collapsible panes, with layout remembered per user: media browser and
  inspector on the left, workspace in the centre, Claude panel on the right, and a context-sensitive
  bottom pane. Eight workspaces: Media, Edit, AI Generate, Workflow, Effects, Color, Audio, Deliver.
- **Appearance.** Four choices, switched instantly and remembered: **ArtCraft Match** (charcoal,
  measured from PhotoCraft's own "proMedium" theme so CreateCraft and the embedded app read as one
  application), **Studio Dark** (the original near-black look), **Light** (coordinated with
  PhotoCraft's "studioLight") and **System** (follows Windows, with a choice of dark look). New
  installs default to System with ArtCraft Match; earlier choices are preserved ("Dark" becomes
  Studio Dark). Palettes live in `src/shared/theme.ts` and are contrast-tested. Accent presets and a
  custom accent apply to selections and active controls. The canvas, artwork and exports are never
  recoloured.
- **ArtCraft theme sync.** With "Match the open ArtCraft app" on (default), the open app's own
  interface theme follows CreateCraft through its official control: PhotoCraft `ui.set theme`
  (proMedium / pro / studioLight), VectorCraft `prefs.set uiBrightness` (mediumDark / dark / light),
  SoundCraft `ui.set theme` (dark / light). These are the apps' own settings, so they also persist in
  the apps. DesignCraft, FilmCraft and LightCraft have theme settings but aren't opened by CreateCraft
  yet; EffectCraft has no theme control.
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
- Provider API keys (OpenAI, Google Gemini) are BYOK. The main process reads them from the
  clipboard, encrypts them with Windows DPAPI (`safeStorage`) and clears the clipboard. They never
  reach the renderer, logs, project files or Claude.
- Every paid generation shows a native approval dialog in main with the price estimate (Cancel is
  the default). The Generate tab and Claude's `generate_image` tool share this path. Results become
  new read-only originals with provenance: prompt, provider, model, settings, estimate and who asked.
  The workflow executor still refuses billable providers.

See [`docs/architecture.md`](docs/architecture.md) for structure, decisions and risks.

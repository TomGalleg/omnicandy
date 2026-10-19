# OmniCandi

OmniCandi is a Windows-first desktop app for creative production. Claude acts as a Creative
Partner that coordinates the 13 first-party Craft apps (PhotoCraft, VectorCraft, SoundCraft, FilmCraft,
LightCraft, EffectCraft, DesignCraft, WordCraft, PDFCraft, GridCraft, DeckCraft, FigCraft, CADCraft),
third-party software through an adapter framework, and optional generation providers (bring your own keys).

**Status (2026-10-17).** Working and verified on the author's Windows PC: projects in folders you choose,
a prompt-first Home where Claude can create a project, Simplified and Advanced navigation, live control of
the Craft apps (embedded in the Edit area on Windows), a visual workflow editor with one shared engine that
Claude can plan and run, 11 built-in templates, real image generation (OpenAI, Gemini) and Veo video with
approval before every paid call, an integration framework (Blender and FreeCAD verified, Autodesk Revit 2027
verified, DaVinci Resolve unverified), an AI Adapter Builder, and the Project Planner. **Not built yet:**
installer, signing, first-run guide, backup/recovery; Luma video; Runway is untested. Linux runs from the same
code (tests and Planner verified on Ubuntu 24.04 under WSL2) but no Craft apps exist for Linux and no
AppImage/deb has been built. The current state, with evidence and gaps, is in
[`CURRENT_PROGRESS.md`](CURRENT_PROGRESS.md) and [`docs/STATUS_FOR_ANALYSIS.md`](docs/STATUS_FOR_ANALYSIS.md);
the integration evidence is in [`../docs/integration-audit.md`](../docs/integration-audit.md).

## Run it

Requires Node 22+ (Windows is the primary platform; on Linux use `../Run OmniCandi.sh`, see [`docs/linux-compatibility.md`](docs/linux-compatibility.md)).

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
| `npm run check` | lint + typecheck + test (the gate before every commit) |
| `npm run dist:dir` / `npm run dist` | Unpacked / NSIS installer build (configuration only; no signed installer has been produced). `npm run dist:linux` builds AppImage and deb (never run) |
| `npm run smoke:planner`, `smoke:external`, `smoke:docks`, ... | One script per area, see `package.json` and `scripts/smoke-*.mjs`; most need the Craft apps installed |
| `npm run smoke` | Build, then drive the real app with Playwright-Electron in an isolated profile; writes `docs/screenshots/` |
| `npm run smoke:generate` | AI Generate: Mock generation, key entry (fake key), approval gate stubbed to Cancel, Open in Edit. No paid calls |
| `node scripts/smoke-claude-generate.mjs` | Claude's `generate_image` tool (needs Claude Code signed in): one Mock image plus one cancelled OpenAI request |
| `node scripts/smoke-projects.mjs` | Project Home / Overview: create, open, switch, rename, remove, remembered after restart |
| `node scripts/smoke-theme.mjs` | Theme presets with PhotoCraft embedded, app theme sync, System mode, persistence, artwork unchanged (opens real app windows) |
| `npm run smoke:live` | Same, through the live PhotoCraft flow (opens a real PhotoCraft window, closes it afterwards) |
| `CS_LIVE_TESTS=1 npx vitest run src/main/photocraftLive.test.ts` | Integration tests against the live PhotoCraft window |

On first launch the app creates a sample project in `%APPDATA%\creative-studio\projects\sample-project`
by copying `fixtures/sample-project`. Appearance settings are stored in `%APPDATA%\creative-studio\appearance.json`.

## What works

The list below describes the core app; later areas (integrations, AI Adapter Builder, generation, templates, Planner) are summarised in the status above and documented in `docs/`.

- **Projects.** The **Home** tab (or the project name in the header) shows Project Home: every
  project as a card with a thumbnail, file/version counts and last change; create, open, rename,
  show folder, and remove (to the Recycle Bin; never the open project or the Sample Project). Below
  it, the open project's Overview: files by kind, versions, exports, storage, recent versions and
  the workflow. Each project is its own folder under `%APPDATA%\creative-studio\projects` with its
  own originals, versions, workflow and exports; the open project is remembered. Switching is
  refused while an edit task, workflow or Claude is busy, and app windows left open are not closed.
- **Shell.** Resizable, collapsible panes, with layout remembered per user: media browser and
  inspector on the left, workspace in the centre, Claude panel on the right, and a context-sensitive
  bottom pane. Workspaces: Home, Media, Edit, AI Generate, Workflow, Effects, Color, Audio, Deliver and Planner (Simplified mode shows Project, Create, AI Generate and Deliver, with the rest under More).
- **Appearance.** Four choices, switched instantly and remembered: **ArtCraft Match** (charcoal,
  measured from PhotoCraft's own "proMedium" theme so OmniCandi and the embedded app read as one
  application), **Studio Dark** (the original near-black look), **Light** (coordinated with
  PhotoCraft's "studioLight") and **System** (follows Windows, with a choice of dark look). New
  installs default to System with ArtCraft Match; earlier choices are preserved ("Dark" becomes
  Studio Dark). Palettes live in `src/shared/theme.ts` and are contrast-tested. Accent presets and a
  custom accent apply to selections and active controls. The canvas, artwork and exports are never
  recoloured.
- **ArtCraft theme sync.** With "Match the open ArtCraft app" on (default), the open app's own
  interface theme follows OmniCandi through its official control: PhotoCraft `ui.set theme`
  (proMedium / pro / studioLight), VectorCraft `prefs.set uiBrightness` (mediumDark / dark / light),
  SoundCraft `ui.set theme` (dark / light). These are the apps' own settings, so they also persist in
  the apps. DesignCraft, FilmCraft and LightCraft have theme settings but aren't opened by OmniCandi
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
  main. "Run demo" uses the **MOCK** executor (no network, no files, no app). Real runs use the shared
  workflow engine, which Claude can also plan, run, pause and rerun; paid AI steps wait for your approval.
- **Collaboration state machine.** Planning, Ready, Running, Pausing, Paused, Manual Control,
  Awaiting Approval, then Completed, Failed or Cancelled. There is a single edit lock. Pause and
  Take Control wait for the active operation to finish. Resume compares the document version and
  replans if it changed. The Claude panel and live app tasks run through it.
- **PhotoCraft edits (real, headless).** An ArtCraft Edit node runs one allowlisted PhotoCraft
  command (17 presets such as Hue/Saturation, Levels, Photo Filter, Gaussian Blur and Oil Paint, or
  any other adjustment, filter or rotation id) with JSON parameters. Each run adds an editable
  `.pcraft` and a flattened `.png` as new read-only versions linked to their parent. The input is
  never modified. SVG inputs are flattened first, and chained edit nodes continue from the layered
  `.pcraft`. Commands that open, save, run scripts or reference other files are refused, as are
  path-like parameters. PhotoCraft runs with a fixed argument list and no shell.
- **Edit tab: the app opens right inside OmniCandi (real).** Pick a file and go to Edit: it opens
  automatically in its app (PhotoCraft for photos, VectorCraft for vector art, SoundCraft for audio),
  shown in the big Edit area. The app's real window is made borderless and owned by OmniCandi,
  then kept exactly over the Edit area as OmniCandi moves or resizes (`src/main/embeddedApp.ts`,
  `resources/window-tracker.ps1`); input works natively because it is still the app's own window.
  On the right, a short list of edits grouped by intent applies live in the app; Undo, Save as new
  version, and **Open in its own window** / **Put back in OmniCandi** sit in the top bar. Leaving
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
- **ArtCraft detection (real).** Main checks each app's CLI and reads `--version`; on Linux all 13 report "not installed, no Linux version known".

## Project Planner

A plain planning workspace (**More > Planner**) that keeps one current plan per project while you brainstorm elsewhere and execute in Claude Code,
Cowork or OmniCandi. It opens in a four-area view (Plan, Tasks, AI, Files) with one Send to AI and one Paste back; an Advanced checkbox shows packages, claims and the full history. Works with no AI and no API key (copy and paste); an optional local MCP server lets Claude Code read the plan, claim
tasks and report back. An executor's report is never acceptance: only you accept. Status of each client (verified / untested / unavailable) and
how it works: [docs/project-planner.md](docs/project-planner.md).

## Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The preload exposes one
  typed `window.studio` API. ESLint forbids Node and Electron imports in the renderer.
- Every IPC handler checks that the sender frame is the app's own page and validates its arguments
  with zod. Graphs and manifests loaded from disk are schema-validated too. Asset paths that escape
  the project root are refused.
- CSP is `default-src 'self'`. Images load only from `self`, `data:` or the read-only
  `studio-asset:` protocol, which resolves asset IDs through the manifest. Navigation is
  restricted to the app, `window.open` is denied, and permission requests are denied.
- Provider API keys (OpenAI, Google Gemini, Runway) are BYOK. The main process reads them from the
  clipboard, encrypts them with Electron `safeStorage` (Windows DPAPI; on Linux only GNOME Keyring or KWallet are accepted, never plaintext) and clears the clipboard. They never
  reach the renderer, logs, project files or Claude.
- Every paid generation shows a native approval dialog in main with the price estimate (Cancel is
  the default). The Generate tab and Claude's `generate_image` tool share this path. Results become
  new read-only originals with provenance: prompt, provider, model, settings, estimate and who asked.
  Workflow AI steps and Claude's generation tools use the same approval and spending limit.

See [`docs/architecture.md`](docs/architecture.md) for structure, decisions and risks.

# Linux compatibility report (Phase 1: architecture audit)

Date 2026-10-17. Method: static review of `creative-studio` (source, scripts, packaging, tests) by search and reading of the Windows-specific
files; the install folders of the Craft apps on this PC; the packaged Claude Agent SDK. **Nothing in this report was run on Linux.** This PC is
Windows 11; WSL has only the Docker Desktop distro, and Docker 28.1.1 is installed but stopped. Every "works on Linux" statement below is
therefore a prediction from the code, labelled as such. No code was changed in this phase.

Classes: **A** cross-platform as written, **B** needs adaptation (a bounded change), **C** Linux-incompatible as designed (needs a different
approach or does not apply), **U** unverified (depends on something outside this repository).

## 1. The decisive unknown: the 13 Craft apps

CreateCraft does not contain PhotoCraft, VectorCraft, SoundCraft, FilmCraft, LightCraft, EffectCraft, DesignCraft, WordCraft, PDFCraft, GridCraft,
DeckCraft, FigCraft or CADCraft. It drives separately installed programs. On this PC each install folder holds only `<app>.exe` and
`<app>-cli.exe` (for example `C:\Program Files\PhotoCraft\photocraft.exe` and `photocraft-cli.exe`). **Nothing in the repository, the audit or the
install folders shows that Linux builds of these programs exist** or how they are named, installed or located. Everything CreateCraft does with them
(headless CLI runs, live MCP control, embedding their window) depends on that. This is class **U** for all 13 and must be answered by the vendor
before any Linux claim about them: Do Linux builds exist (AppImage, deb, tarball)? Same CLI and MCP command surface? Same control flags? Where do
they install?

Until then the only honest Linux target for the Craft apps is "detected as not installed; unavailable".

## 2. Component classification

| Component | Where | Windows-specific parts | Class | Linux notes |
|---|---|---|---|---|
| Electron shell, window, IPC, preload, CSP, asset protocol | `src/main/index.ts`, `ipc.ts`, `preload` | none significant (`window-all-closed` already non-darwin quit) | A | Electron 44 supports Ubuntu x64. Chromium sandbox needs working user namespaces or SUID helper (AppImage often needs `--no-sandbox`); decide policy |
| React UI, themes, navigation, docks, workflow editor | `src/renderer`, `src/shared` | none | A | Visuals unverified; system dark mode via `nativeTheme` works on GTK/portal setups only |
| Project store, manifest, layout, projects registry | `projectStore.ts`, `projects.ts` | wording ("D:\\CreateCraft Projects"), `path.isAbsolute`; drive-letter notions in a few messages | A (B for messages) | Uses `node:path`. Free-space check at `projects.ts:334` is generic. Case-sensitive filesystem may expose case-insensitive assumptions in tests |
| App data location | `index.ts:20`, `planner/dir.ts` | default `appData/creative-studio` (Electron resolves `~/.config` on Linux); `dir.ts` already handles XDG | A | Same folder name on both OSes |
| Settings, planner, workflow engine, templates, spending ledger | `settingsStore`, `planner/*`, `shared/workflow*` | none | A | Pure Node + JSON. Planner file lock uses `O_EXCL` (fine on Linux); its EPERM/EBUSY retry is harmless |
| Project Planner MCP server | `planner/mcp*.ts`, `scripts/build-planner-mcp.mjs` | none; installed-app form uses `ELECTRON_RUN_AS_NODE` (works on Linux Electron too) | A | Real-process tests exist only on Windows |
| Claude Agent SDK | `claudePartner.ts` | `defaultClaudeCli()` = `%USERPROFILE%\.local\bin\claude.exe`; SDK ships a per-platform native binary (`claude-agent-sdk-win32-x64`); `asarUnpack` pattern is fine | B | Needs the `linux-x64` SDK binary package installed on Linux, and a Linux path for the user's own Claude login (`~/.local/bin/claude`). Auth/state location differs. U until run |
| Credential vault | `credentialVault.ts` | text says Windows DPAPI; uses Electron `safeStorage` | B | On Linux `safeStorage` needs libsecret/kwallet; without one it falls back to a weak plaintext-obfuscated backend. Must check `getSelectedStorageBackend()` and refuse or warn. The existing `isEncryptionAvailable` check is not sufficient on Linux |
| ArtCraft discovery and CLI paths | `artcraftProbe.ts`, `appEditors.ts` (`exe()` uses `ProgramFiles`), `liveApps.ts`, `photocraftLive.ts`, `deliver.ts`, `localVideo.ts:132` | hard-coded `Program Files\<App>\<app>-cli.exe`, `.exe` names, `windowsHide` | B code, but **U** because the apps' Linux layout is unknown | Needs one `platform.appPaths()` that returns per-OS candidate locations and binary names |
| Live app control (spawn app + `--control`, MCP over stdio) | `liveApps.ts`, `photocraftLive.ts`, `mcpClient.ts` | `.exe` suffixes only; loopback TCP and stdio are portable | B | Mechanism is portable; availability U |
| **Embedding an app window inside CreateCraft** | `embeddedApp.ts`, `windowTracker.ts`, `dockedPanel.ts`, `resources/window-tracker.ps1` | PowerShell + Win32 (`getNativeWindowHandle`, owned windows, tracking by pid) | **C** | No equivalent on Wayland; on X11 it would need a different reparenting approach. Realistic Linux behaviour: no embedding, apps open in their own window beside CreateCraft ("Open in its own window" already exists as a path). Needs a design decision |
| Window capture (`desktopCapturer`) | noted "not yet tested" in audit | none in code | U | Works on X11; PipeWire portal prompts on Wayland |
| Hardware / GPU detection | `hardware.ts` | PowerShell `Get-CimInstance Win32_VideoController` and registry for VRAM; `System32\vulkan-1.dll` check; `nvidia-smi` is portable | B | Linux: `lspci`/`/sys/class/drm`, `vulkaninfo --summary`, `rocm-smi`/`radeontop`, Mesa RADV. VRAM for AMD is readable from sysfs |
| Local AI video (stable-diffusion.cpp Vulkan) | `localVideo.ts`, `modelDownloads.ts`, `shared/localAi.ts` | downloads a Windows Vulkan zip (`sd-cli.exe`), unpacks with `System32\tar.exe`, `.exe` lookup | B | Needs Linux release assets (URL + SHA-256 per asset), `tar`/`unzip` from `PATH` or a JS unzip (`integrations/zip.ts` exists), executable bit, Vulkan loader (`libvulkan1`) and a Mesa RADV or AMDVLK driver. AMD works on Linux in principle (RADV); **untested** |
| Free local "motion" video | `motionEffects.ts` | uses FilmCraft CLI via `Program Files` path | B/U | Depends on FilmCraft Linux availability |
| External adapter framework core | `integrations/loader.ts`, `packageStore.ts`, `packageRunner.ts`, `manager.ts`, `sdk.ts`, `zip.ts` | spawn of Node child with permission flags (portable); manifest has no OS field | **B** (needed by the brief) | Add `platforms` to the manifest and enforce it in the manager so unsupported commands cannot run. The "registry" in `packageStore.ts` is CreateCraft's own `registry.json`, not the Windows registry |
| External application discovery | `integrations/discovery.ts`, `connect.ts` | `reg query` of Uninstall keys, App Paths, Start Menu shortcuts via PowerShell, `Program Files` scans | B (replace) | Linux sources: `PATH` lookup, `.desktop` files (`/usr/share/applications`, `~/.local/share/applications`), `/opt`, Flatpak/Snap, `dpkg`/`rpm` queries. Largest single new module |
| Blender adapter | `adapters/blender.ts` | `exeNames: ['blender.exe']`, discovery-driven path | B | Blender CLI (`blender -b --python`) is the same on Linux. Verified on Windows 4.0.2 only; Linux U |
| FreeCAD adapter | `fixtures/freecad-adapter`, `resources/adapters/freecad-1.0.0.ccadapter` | looks for `FreeCADCmd.exe`; Windows paths in the package | B | Package is a signed `.ccadapter`; changing it means re-signing. Linux FreeCAD ships an AppImage with `FreeCADCmd` inside; the mount/extract step is a new problem. U |
| DaVinci Resolve adapter | `adapters/resolve.ts` | PowerShell file-version probe, `tasklist`, Windows scripting module path | B | Resolve on Linux exists; scripting API path differs. Already unverified on Windows |
| Revit, Autodesk, Adobe | `adapters/vendors.ts`, `install/hostProfiles.ts`, Revit C# add-in | `%APPDATA%\Autodesk\...` destinations, `.exe` | **C** | Revit and most Adobe/Autodesk desktop programs have no Linux versions. Must be shown as "not available on this operating system", never as failing |
| Plugin bridge | `bridge/server.ts` | named pipe on Windows; **already uses a Unix socket path on non-Windows** | A (U) | Unix socket under `os.tmpdir()`: should use a private directory with mode 0700 and the socket removed on exit. Tested only on Windows |
| Plugin installer, process checks | `install/pluginInstaller.ts`, `install/processes.ts` | `tasklist` (already returns false when not win32) | B | Add `ps`/`pgrep` implementation |
| AI Adapter Builder | `integrations/builder/*` | Python discovery tries `python`, then `py -3`; mock host `.exe`; templates generate `.exe`/`.cmd` assumptions; blocklist mentions `powershell|cmd.exe` | B | Linux: `python3`. Mock program host must work without `.exe`. Documentation fetching is portable |
| Deliver / export | `deliver.ts` | `<app>-cli.exe` paths | B/U | As the ArtCraft path item |
| Packaging | `electron-builder.yml`, `scripts/release-check.mjs`, `scripts/make-icons.mjs` | NSIS, `.ico`, `resources/window-tracker.ps1` as extraResource, `asarUnpack` | B | Add `linux:` targets AppImage and deb, a PNG icon set, per-OS extraResources (tracker script Windows only). `dist` script and release checks assume Windows signing |
| Launchers and smoke tests | `Run CreateCraft.cmd`, `scripts/smoke-*.mjs` | `.cmd`, PowerShell calls in 12+ smokes, drive paths | B | Add shell launcher; most smokes need Craft apps and will be Windows-only |
| Unit and integration tests | `src/**/*.test.ts` | 40+ files contain `C:\\`/`E:\\` literals, `.exe` fixtures or Windows path expectations; a few are already gated on `win32` | B | Pure parsing tests pass anywhere. Tests asserting backslash paths, Program Files, registry text need platform conditionals or `path`-based expectations. Mock-program tests use `.cmd` |

## 3. Risk list for the specific areas named in the brief

1. **13 Craft apps**: availability, naming, CLI/MCP parity and window behaviour on Linux are unknown (section 1). Highest risk, outside this repository.
2. **Window embedding** (Edit workspace, docked panel): Windows-only design. Will become "open separately" on Linux; the Edit UI must be explicit about that.
3. **Project Planner**: low risk. Pure Node, JSON, lock files, stdio MCP. Needs a Linux run to confirm lock behaviour, file permissions of exported files, and the HTTP mode.
4. **Workflow engine**: low risk (shared TypeScript); steps that call Craft apps inherit risk 1.
5. **Claude integration**: medium. SDK binary per platform, login state location, and `defaultClaudeCli()` path; keychain-backed API-key storage (Claude login itself is the SDK's concern).
6. **Local AI**: medium-high. Needs Linux builds of stable-diffusion.cpp with Vulkan, model downloads (portable), and GPU detection rewrite. AMD via Mesa RADV is plausible; **no AMD/Linux testing is possible on this PC** (Windows only).
7. **External adapters**: framework portable with changes; each vendor adapter must declare supported platforms. Revit and Adobe: not available.
8. **Credential storage**: `safeStorage` falls back to a weaker backend on headless or keyring-less Linux; must be detected and surfaced rather than silently accepted.
9. **Packaging**: AppImage needs FUSE 2 on Ubuntu 22.04+ and has Chromium-sandbox quirks; deb is more predictable. Updates, signing and first-run differ.
10. **Tests**: platform-conditional rewrites are required before Linux CI means anything. Linux test results must be recorded separately from Windows ones.

## 4. What a Linux environment can be, and what needs approval

None of these were started (your rules: no major installs or spend without approval):

| Option | Cost | Can verify |
|---|---|---|
| Docker Desktop (installed here, stopped) running `ubuntu:24.04`, headless | pulls an image (a few hundred MB) | tests, Node-only code, Planner, MCP, packaging build (AppImage/deb build needs more packages); **no GUI, no GPU/Vulkan** |
| Ubuntu in WSL2 (WSLg gives a GUI, Vulkan via D3D12 translation) | Ubuntu distro download | GUI startup, Electron on X11/Wayland-ish; Vulkan through `dzn` is not representative of AMD RADV |
| A real Ubuntu x86-64 machine or VM with GPU passthrough | your hardware | the only way to verify AMD GPU + Vulkan local AI |

## 5. Proposed work plan (after your decisions)

Phase 2 (foundation), in logically separate commits:
1. `src/shared/platform.ts` (pure: OS id, app-data dir, exe suffix, path candidates) plus `src/main/platform/` implementations (executable discovery, process list, GPU detection, secure-storage check, shell open). Windows implementations are the current code moved behind the interface, behaviour unchanged, covered by the current tests.
2. Replace direct `ProgramFiles`/`.exe`/`windowsHide`/PowerShell use in the files listed in section 2 with the platform layer.
3. Adapter manifest field `platforms` (default `["win32"]` for existing packages so nothing changes), enforced in the manager before any command runs, shown in the UI as "Not available on this system".
4. Linux discovery module (`PATH`, `.desktop`, `/opt`, dpkg); Linux GPU and Vulkan detection; Linux stable-diffusion.cpp asset table (unverified until run).
5. Vault: check the actual `safeStorage` backend on Linux and refuse plaintext fallback by default.
6. Tests: platform conditionals, new platform-layer unit tests with injected OS, Windows suite unchanged.

Phase 3 needs the environment decision above plus the vendor answer on Craft apps. Phase 4 (AppImage, deb, first run, backup, upgrade) follows validation.

## 6. Decisions needed from you

1. Do Linux builds of the 13 Craft apps exist (or are planned)? Where do they install, what are the binaries called?
2. Which Linux environment may I use first: Docker `ubuntu:24.04` (headless only, small download), WSL2 Ubuntu (GUI, larger download), or your own Ubuntu machine?
3. Accept "no embedded Craft app window on Linux; apps open in their own window" as the Linux behaviour?
4. Accept refusing plaintext credential fallback on Linux (the user would be told to install a keyring) as the default?

## 7. Verified vs predicted

Nothing is verified on Linux. The existing Windows results (13 apps, Blender, FreeCAD, Revit, Planner) are unchanged and not affected by this audit.

---

# Phase 2 progress (2026-10-17): the foundation, and what is and is not proven

Decisions applied (from the approval): the Craft apps are unavailable on Linux until a real Linux build is confirmed (no invented paths, no Wine);
Ubuntu 24.04 under WSL2 is the first Linux environment (**not installed yet: waiting for approval**, see below); Craft apps open in their own windows on Linux
while Windows keeps Win32 embedding; Linux requires a real keyring and rejects `basic_text`.

## What changed (one shared codebase, Windows behaviour unchanged)

| Area | Change | Files |
|---|---|---|
| OS facts | `OsId`, `binName`, `supportsOs` (pure, injectable) | `src/shared/platform.ts` |
| Craft apps | `craftInstallDir/Bin`: Program Files on Windows; on Linux none, so each app reports "no Linux version known" and the 13 probe results say unavailable. All former `ProgramFiles` and `.exe` literals in `appEditors`, `liveApps`, `photocraftLive`, `deliver`, `localVideo`, `artcraftProbe`, `ipc` go through it | `src/main/platform/craftApps.ts` |
| Credentials | Linux accepts only `gnome_libsecret` / `kwallet*`; rejects `basic_text`, unknown, or unavailable backends with setup instructions (no secrets); Settings and AI Generate show the reason; non-credential features keep working | `src/main/platform/secureStorage.ts`, `credentialVault.ts` |
| GPU / Vulkan / ROCm | Linux detection from `lspci -mm -nn`, amdgpu sysfs (VRAM), Vulkan ICD folders (RADV, software-only llvmpipe is reported as CPU), `libvulkan.so.1`, `/proc/cpuinfo` AVX2; Windows path untouched | `src/main/platform/gpuLinux.ts`, `hardware.ts` |
| Claude | `defaultClaudeCliPath` (`~/.local/bin/claude` on Linux), sign-in opens the first installed terminal (x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, xterm) or says what to run | `src/main/platform/exec.ts`, `claudePartner.ts` |
| Python / processes | `python3` then `python` on Linux; process check via `ps -A -o comm=` | `exec.ts`, `pyguard.ts`, `install/processes.ts` |
| Window embedding | `EmbeddedApp.supported` is true only on Windows; elsewhere every call is a no-op and the Edit area shows "open in its own window". Same class, so a Linux window manager can be added later | `src/main/embeddedApp.ts`, `ipc.ts` |
| Adapters | Manifest and command `platforms` (missing = Windows only). The manager marks an unsupported adapter "incompatible", never runs its code (not even to read a version), and refuses commands with "not available on Linux" | `shared/integrations.ts`, `packageFormat.ts`, `manager.ts` |
| Discovery | Linux discovery: PATH, `/usr/local/bin`, `/usr/bin`, `/snap/bin`, `~/.local/bin`, `/opt/<product>` and `/opt/<vendor>/<product>` (+ `bin`), `.desktop` `Exec=` lines, user folders, remembered folders | `integrations/discoveryLinux.ts`, `discovery.ts` |
| Local video engine | Per-system engine download. Linux entry is the official `sd-master-1d0a58a-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip` with the size and SHA-256 GitHub reports (same release as the Windows one, whose reported hash matched ours). Unpack chain: `unzip`, Python `zipfile`, built-in reader; executable bit set before running | `shared/localAi.ts`, `platform/archive.ts`, `modelDownloads.ts`, `localVideo.ts` |
| Packaging config | `linux:` AppImage + deb targets, PNG icon, Windows-only resources moved under `win`, deb recommends keyring and Vulkan packages, `npm run dist:linux`, `Run CreateCraft.sh` | `electron-builder.yml`, `package.json` |

Planner, workflow engine, project formats and MCP protocol were already OS-neutral and are untouched: project and Planner files are the same on both systems.

## Evidence (read this table carefully)

| Claim | Evidence | Status |
|---|---|---|
| Windows behaviour unchanged | `npm run check`: lint and both typechecks clean; Vitest 639 passed, 62 skipped (same opt-in skips as before; 604 before this phase) | **verified on Windows** |
| Platform logic is correct for Linux inputs | 35 new unit tests inject `linux` (OS, file system, command output). **Inputs are synthetic text written from documented formats, not captured from a Linux machine** | **predicted** (unit-tested only) |
| Anything runs on Linux | none run | **not verified** |
| Real Linux startup, project create/save/reopen, Planner, MCP, Claude connectivity, workflows | not run: no Linux environment installed yet | **not verified** |
| Native Craft apps on Linux | none exist as far as known | **unavailable** |
| GPU acceleration, AMD, Vulkan, local AI video on Linux | detection and download code written, never executed on Linux or against a GPU | **untested** |
| Blender / FreeCAD on Linux | adapters are Windows-only by declaration, so they are refused on Linux until tested and declared | **not enabled** |
| AppImage / deb | configuration only; nothing built | **untested** |

## Known limitations / blockers

* **Blocker for Phase 3:** installing Ubuntu 24.04 in WSL2 needs your approval (download, disk, Node, git, build tools inside it). Not done.
* WSL2's GPU is not representative of a real AMD Vulkan setup; AMD/Vulkan verification needs your own Ubuntu machine or a GPU-capable setup.
* `claude-agent-sdk` ships the native binary as a per-platform package; Linux needs `npm install` on Linux to fetch `claude-agent-sdk-linux-x64`. Not checked.
* `release-check.mjs` reports "NOT RELEASABLE" for the bundled FreeCAD and Revit adapters because they are signed with the development key rather than an official release key. This predates Phase 2 and is a release-signing task.
* 12+ smoke scripts and the Craft-app live tests call PowerShell or Windows paths; they stay Windows-only. Unit tests that use `C:\` fixtures still pass on Windows; whether each passes on Linux is unknown until run there (expected to need conditionals).
* The 2-process planner lock and the plugin bridge Unix socket have only been exercised on Windows.

## Next (Phase 3), in order, after your approval

1. `wsl --install Ubuntu-24.04` (location of your choice), then Node 22, git, build-essential, `libsecret-1-0`, `gnome-keyring`, `libvulkan1`, `mesa-vulkan-drivers` inside it; clone the repo into the Linux filesystem (`git clone` from the Windows checkout, history preserved, no remote).
2. `npm ci`, `npm run check` on Linux. Record every failure here as a separate "Linux results" table.
3. Launch under WSLg: startup, project create / save / reopen, Planner round trip, Claude connectivity (the user signs in), workflows.
4. Report GPU/Vulkan detection results from WSL as what they are (WSL virtual GPU).

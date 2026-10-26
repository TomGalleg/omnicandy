# OmniCandy (folder name: creative-studio)

Electron + React + TypeScript desktop app. Claude is the Creative Partner that drives the Craft apps and third-party software (Blender, FreeCAD, Revit, Unreal, DaVinci Resolve). Windows is primary; Linux is kept compiling.

## Map
- `src/renderer/src` the interface. `App.tsx` is the shell, `components/Header.tsx` the top bar, `components/*Workspace.tsx` the tabs (Home/Project, Planner, Create/Edit, AI Generate, Deliver, Software, ...). `components/ClaudePanel.tsx` is the in-app Claude chat. `styles.css` holds all styling.
- `src/shared/navigation.ts` which tabs exist and their labels (Simplified vs Advanced).
- `src/shared/ipc.ts` the full renderer to main API; add a channel there, then `src/preload/index.ts`, then `src/main/ipc.ts`.
- `src/main` the app: `claudePartner.ts` (Claude's prompt and sign-in), `agentHarness/` (the agent loop and tools), `integrations/` (third-party apps).
- `src/main/integrations/adapters` one file per connected app (blender, unreal, resolve...). To add an app, follow `docs/external-integration-sdk.md`; Universal Connect (`integrations/connect.ts`) can attach to apps that expose a command interface.
- `docs/` design notes; `CURRENT_PROGRESS.md` is the status snapshot.

## Working here
- Gate: `npm run check` (eslint, both tsc projects, Vitest). Run it before calling a change done.
- The running app does not hot-reload: close OmniCandy and double-click `..\Run CreateCraft.cmd` (rebuilds, then launches). `npm run dev` also works for interface work.
- The person you are chatting with may not be a programmer: explain changes plainly and say what they will see.
- Commit only when asked.

# Paste into Claude Code

You are the senior product engineer building **Creative Studio**, a Windows-first professional desktop creative application. Read `PRODUCT_SPEC.md` and `TECHNICAL_PLAN.md` completely before making changes. Treat them as product requirements, but verify all third-party integration claims independently against installed software and current official documentation. Do not assume an MCP, CLI, model API or embeddable application window exists without evidence.

**Goal for this first session:** implement and demonstrate Phase 0 and the smallest useful part of Phase 1, not all features. Preserve the architecture for later phases.

1. Inspect the repository, OS, runtime versions, installed ArtCraft apps, and available MCP/CLI documentation. Record findings and missing dependencies in `docs/integration-audit.md`. Never request API keys in chat; use a secure local credentials workflow later.
2. Recommend an architecture and concise risks summary; default to Electron + React + TypeScript, a secure main-process service layer, SQLite, and React Flow (or its current equivalent), unless the environment justifies alternatives. Document why.
3. Create the desktop app shell with a clean professional design and responsive dockable/resizable panes: top project header/workspace switcher; left project/media browser; central viewer with a clearly labeled **mock/empty live-preview state**; right Claude Creative Partner panel; bottom context-sensitive area (timeline only for video/animation/audio). Implement Media, Edit, AI Generate, Workflow, Effects, Color, Audio, Deliver routes, with honest placeholders for unimplemented capabilities.
4. Implement Dark / Light / System modes with persistence, accessible contrast, and an accent-color selector. Theme applies to all app-owned surfaces and node editor, never modifies source media.
5. Define typed service interfaces for `AppAdapter`, `GenerationProvider`, `AssetRepository`, `WorkflowExecutor`, `WindowCapture`, `CredentialVault`, and `CollaborationController`. Mock adapters are allowed but must be explicitly labeled and never report real integrations.
6. Implement a small usable asset browser using local project fixtures or user-imported assets; support image thumbnails, selection, inspector and source metadata. Original files are immutable. Do not request broad filesystem access unnecessarily.
7. Implement the first Workflow page with basic draggable/connectable typed nodes (Import, AI Generate, ArtCraft Edit, Approval, Export), validated edges, and persisted graph. A demo run must NOT trigger paid services.
8. Add automated tests for theme persistence, project metadata, graph validation, mock workflow states and safe collaboration state transitions. Run build/lint/tests.
9. Report exactly what was implemented, what is simulated, how to run it, screenshots where available, and an actionable next milestone: **real PhotoCraft integration audit and open/edit/save/export smoke test**.

**Operating constraints**
- Do not silently install dependencies or incur charges; ask before paid operations.
- Do not automate Midjourney through unsupported unofficial APIs or browser bots. Support approved user exports/imports only unless official capabilities change.
- Credential secrets must stay in OS-protected storage / secure main-process backend. No localStorage for secrets; no credentials in renderer or project files.
- Secure Electron defaults: context isolation on, sandbox where feasible, nodeIntegration off; narrow validated IPC interfaces and restrict external navigation.
- Do not claim that screenshots prove live editing; live viewing and application control need separate verified capabilities.
- Checkpoints and collaboration locks must prevent simultaneous agent/manual edits. `Pause` acts at safe boundaries; `Take Control` transfers editing ownership after the active operation finishes or resolves.
- Prefer small commits, type-safe boundaries, and demonstrable milestones. Do not claim unsupported features work.

Before implementing, summarize assumptions and the Phase 0/1 plan in the terminal. Then proceed to actually implement Phase 0/1 without seeking unnecessary confirmation. Produce a short completion report with evidence.

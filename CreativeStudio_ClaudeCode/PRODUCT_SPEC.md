# Creative Studio — Product specification v0.3

## Vision and principles
A professional Windows desktop editing application built with Claude Code. End users can direct Claude in **Creative Partner** mode to coordinate editing operations in supported ArtCraft creative software and optional BYOK AI image/video generation services. Deliver an integrated, user-visible creative experience with non-destructive workflows and a node editor.

**Default AI mode: Creative Partner** — follow user direction, proactively suggest improvements but seek approval before applying major creative reinterpretations. Routine file handling and reversible technical edits may run automatically under configured permissions. Alternate modes (strict follow / director) may be added later.

## Primary workspaces
- **Media:** Projects, thumbnails, metadata, source info, search, filters, smart collections, variations, ratings/approval state and asset inspector.
- **Edit:** Live app view (or clearly signposted unavailable state), selection, layers/properties if integration supports them, contextual AI edits, manual takeover.
- **AI Generate:** Image / video model selectors, prompt, reference assets, aspect, model-specific parameters, estimated cost, generation variants, result comparison and send-to-editor.
- **Workflow:** Visual executable graph with asset inputs, AI generation, ArtCraft edit, transforms, conditions, review gates, export and reusable nested workflows.
- **Effects / Color / Audio:** Show app-specific views or bridge to corresponding ArtCraft tools once proven; placeholders must be labeled.
- **Deliver:** Export presets, source + outputs manifest, job progress, formats and version history.

**Timeline visibility:** Do not show a timeline for still images, illustrations, page layouts, posters, or general media browsing. Show timeline for video, animation and audio/multitrack work when applicable. Mixed media uses active-content context.

## Dockable layout
- Top: active project + current workspace + connection/usage status.
- Left: project tree, collections and asset browser.
- Center: largest space, actual editor live window capture / canvas / workflow graph / media preview depending on workspace.
- Right: persistent Claude panel with chat, concise plan, suggestions, current operation, approvals and context-sensitive options; resizable/collapsible.
- Bottom: optional activity stream, nodes, versions or timeline when relevant; user can resize and pop out relevant panes.
- Provide dual-monitor/hybrid workspace layouts eventually. Never rely on native-window embedding before verification; default to actual OS window capture plus focus/open-native-editor actions.

## Creative Partner interaction
- Natural-language task instructions; selected asset/layer/region/node automatically becomes input context.
- Annotation tools: circles/arrows/region masks supplied to editing operation, but do not assume all app adapters support spatial edits.
- Visible lifecycle: Planning → Ready → Running → Pausing → Paused → Manual Control → Awaiting Approval → Completed / Failed / Cancelled.
- Pause at safe edit boundary; manual takeover requires ownership handoff and state synchronization. Resume rechecks on-disk document modifications.
- Major stage approval; optional before/after previews and isolated creative branches. Approved assets not replaced without consent. User can dismiss suggestions and avoid repeat suggestions.
- Detailed log separate from chat, including tool, app, asset version, node, time, outcome, errors and cost (where available).
- Show what Claude actually changed; no fictitious animated pointer or claimed work when tool executed invisibly.

## AI providers and user API keys
- Connector architecture with capability discovery: text-to-image, image-to-image, inpainting, outpainting, image-to-video, text-to-video, audio, resolution/ratio, references, prices, async job polling, content rules.
- Candidate providers (subject to API verification): Google Gemini image/Nano Banana and Veo, OpenAI image API, Runway, Luma, fal.ai, Replicate, possible FLUX/Kling through supported official APIs.
- Midjourney: user-authorized download-folder import only, unless an official API and permissions are available at implementation time.
- Provider screen: connect/test/replace/revoke key, model capability list, enabled-for-Claude toggle, default model, per-operation approval threshold, project spending cap and cost tracking.
- Users can pick specific provider/model or allow Claude to choose from configured, compatible, authorized providers. Require preview of planned billable calls where approval applies.
- Never store secrets in application databases, UI renderer, project archives or plaintext config; secure via OS credential store. Restrict secret usage to main process/service layer.

## Asset library
- Project, folder, collection and smart collection semantics; assets stable IDs and version lineage.
- Import original media immutably; use working derivatives and keep paths relative in portable project manifests where possible.
- Support image/video/audio/vector/native-project assets; useful provenance: generated/imported, prompt, provider/model, generation settings, reference assets, creation time, licensing notes, dimensions, source format, native document link.
- Support content hashes for identity and exact duplicate detection, with user approval for destructive cleanup; don't delete visually similar assets automatically.
- Search metadata first; visual similarity and embeddings are opt-in enhancements.
- Handoffs across applications must specify supported formats and warn when layers, vectors, editability or metadata will be flattened/lost.
- Offline projects work without any API key; AI generation only when configured.

## Workflow system
- Type-safe inputs/outputs for nodes; validate formats, application and provider capabilities before run.
- Users can see node execution statuses, costs and outputs. Editing node graph can invalidate descendants, not independent branches. Keep successful node outputs cached with hashes / settings provenance.
- Branching for alternative directions. Approval nodes and locked/approved nodes respected by execution engine.
- Save/reuse workflow templates and nested workflows. Graph view shares exact runtime state with agent activity; graph is not merely explanatory decoration.
- Persist graph, parameters, run logs, output artifact IDs and recovery state.

## Appearance
- **Dark**, **Light** and **Follow Windows system** modes, immediately switchable, persisted per user.
- Custom accent colors. Accessible contrast, visible focus states, theme all in-app dialogs/panels including node graph; source media never changes.
- External native ArtCraft windows may keep their own themes if synchronization unsupported.

## Non-functional
- Windows-first, local-first; recoverable autosaves, explicit file access, secure IPC, clear errors, telemetry opt-in, no hidden costs.
- Real window view performance tested independently from native editing adapter. Graceful degradation if capture is blocked, window minimized, or ArtCraft not available.
- Minimum viable app functional offline with mock/sample projects and clearly marked unconnected services.

# 08. Architecture diagrams (existing code only)

All four diagrams describe what is in the repository now (HEAD `bf7b6b5`). Dashed arrows are "text hand-off by a person" or event-only
links, not function calls. Mermaid renders in GitHub, VS Code and most Markdown viewers.

## A. Current application architecture

```mermaid
flowchart TB
  subgraph Renderer["Renderer (React 19) - src/renderer/src"]
    App["App.tsx: go() / showApp(), docks"]
    Header["Header.tsx: tabs (Simplified / Advanced)"]
    WS["Workspaces.tsx: Home, Media, Edit, AI Generate, Software, Planner, Deliver"]
    PlannerUI["planner/*: PlannerWorkspace, PlannerChat, PlannerWork, PlannerSend"]
    ClaudePanel["ClaudePanel.tsx (engine picker)"]
    IndAgent["IndependentAgent.tsx"]
    EditUI["EditWorkspace.tsx (live ArtCraft app + modes)"]
    SoftUI["SoftwareWorkspace.tsx"]
    Bottom["BottomPanel.tsx (timeline / activity)"]
  end

  subgraph Preload["Preload - src/preload/index.ts"]
    Bridge["window.studio (contextBridge)<br/>planner API = one channel planner:call"]
  end

  subgraph Main["Main process (Electron/Node) - src/main"]
    IPC["ipc.ts (1788 lines): handlers and tool sets"]
    Projects["projects.ts ProjectManager<br/>projectStore.ts ProjectStore"]
    PlannerSvc["planner/: service.ts, store.ts, routedStore.ts,<br/>projectPlanner.ts, chat.ts, ipc.ts"]
    PMCP["planner/mcp.ts McpSession (in-process)"]
    Claude["claudePartner.ts (Claude Agent SDK)"]
    Harness["agentHarness/: runAgent, registry,<br/>checkpoint, journal, jobLedger"]
    Live["liveApps.ts, liveTask.ts (13 native Craft apps)"]
    Integ["integrations/: IntegrationManager + adapters"]
    Gen["generation.ts, videoApis.ts (paid, approval)"]
    Vault["credentialVault (keys, safeStorage)"]
  end

  subgraph Disk["Disk"]
    Reg["userData/projects.json"]
    Proj["project folder: project.json, Assets/, Workflows/, Planner/, Claude/"]
    Shared["userData/planner/ (older plans)"]
    Ckpt[".omnicandy-agent-checkpoint.enc"]
  end

  subgraph External["Other processes"]
    PMCPexe["out/planner-mcp.cjs (stand-alone MCP server)"]
    Craft["13 ArtCraft apps (live windows)"]
    Third["Blender / Unreal / Fusion / Resolve (+ stubs)"]
    ExtAI["Claude Code, Gemini CLI, ChatGPT (via MCP or paste)"]
    Cloud["Anthropic, OpenAI, Gemini APIs"]
  end

  Header --> App
  App --> WS
  WS --> PlannerUI
  WS --> EditUI
  WS --> SoftUI
  App --> ClaudePanel
  ClaudePanel --> IndAgent
  PlannerUI --> Bridge
  EditUI --> Bridge
  SoftUI --> Bridge
  ClaudePanel --> Bridge
  IndAgent --> Bridge
  Bridge --> IPC
  IPC --> PlannerSvc
  IPC --> Claude
  IPC --> Harness
  IPC --> Live
  IPC --> Integ
  IPC --> Gen
  IPC --> Projects
  PlannerSvc --> Projects
  IPC --> PMCP
  PMCP --> PlannerSvc
  Claude -. "planner_* tools" .-> PMCP
  Harness -. "shared Claude tool defs" .-> Claude
  PlannerSvc --> Proj
  PlannerSvc --> Shared
  Projects --> Reg
  Projects --> Proj
  Harness --> Ckpt
  Live --> Craft
  Integ --> Third
  Claude --> Cloud
  Harness --> Cloud
  PlannerSvc --> Cloud
  Vault --> Cloud
  ExtAI --> PMCPexe
  PMCPexe --> Shared
  PMCPexe --> Proj
  Live -. "state events" .-> App
  Integ -. "ExternalLiveState" .-> SoftUI
```

## B. Current planner data flow

```mermaid
flowchart LR
  subgraph Start["Start"]
    Home["Home: createBlank('idea')<br/>projects.create + open + startPlan"]
    Scan["PlannerStart: analyze() then applyFindings()"]
  end
  subgraph Idea["Idea tab"]
    Chat["PlannerChat: chat() - no tools<br/>(Claude / OpenAI / Gemini)"]
    Ready["[[READY]] then 'Yes, make the plan' (mode chunks)"]
    Chunks["chunkPlan() parses chunk list"]
    Paste1["Paste an outside AI answer<br/>classifyPaste()"]
  end
  subgraph Store["PlannerService, store.mutate (lock + atomic write)"]
    Prop["Proposal (pending)"]
    Plan["PlannerProject: brief, items, tasks, milestones,<br/>assets, packages, reports, planVersions"]
  end
  subgraph PlanTab["Plan tab"]
    Edit["TaskForm: addTask / updateTask / removeTask,<br/>milestones"]
  end
  subgraph Work["Work tab"]
    Cur["pickCurrent(): current chunk"]
    Send["SendPanel: prepareSend() -> ExecPackage<br/>sendText() -> clipboard or prefill event"]
    Back["PastePanel: importReport()"]
    Inbox["ReviewInbox: reviewReport accept / revise / reject"]
  end

  Home --> Plan
  Scan -->|"set_brief proposals, accepted"| Plan
  Chat --> Ready --> Chunks
  Chunks -->|"importSuggestions + decideProposal (one click)"| Prop
  Paste1 -->|"importSuggestions"| Prop
  Prop -->|"decideProposal: owner ticks"| Plan
  Edit --> Plan
  Plan --> Cur --> Send
  Send -->|"task.packageId, package state open"| Plan
  Send -. "person copies text to an AI" .-> Out["AI does the work elsewhere"]
  Out -. "person pastes the answer" .-> Back
  Back -->|"report submitted, task reported"| Plan
  Plan --> Inbox
  Inbox -->|"accept: task accepted, progress counts"| Plan
  Plan -. "history.jsonl, planVersions, lastActive" .-> Plan
  Plan -. "poll every 3 s" .-> PlannerUI["PlannerWorkspace state"]
```

## C. Planner-to-agent-to-application execution flow (as it exists; the dashed parts are manual)

```mermaid
flowchart TB
  Task["PlanTask (todo)"] --> Pkg["prepareSend -> ExecPackage<br/>(frozen accepted plan, task, checks)"]
  Pkg --> Dest{"Destination chosen by the person"}
  Dest -->|"createcraft"| Prefill["'createcraft:claude-prefill' DOM event<br/>fills the chat input only"]
  Dest -->|"tools"| Line["one line for Claude Code / Gemini CLI"]
  Dest -->|"chat"| Md["full Markdown brief copied"]

  Prefill -. "person presses Send" .-> Panel{"Engine picked in ClaudePanel"}
  Panel -->|"Claude"| ClaudeLoop["ClaudePartner.send: SDK query,<br/>~46 tools, maxTurns 300"]
  Panel -->|"OpenAI / Gemini / local"| AgentLoop["runAgent: ToolRegistry,<br/>must call enable_tools planner first"]
  Line -. "person pastes into Claude Code" .-> ExtMCP["planner-mcp.cjs (own process)"]
  Md -. "person pastes into a chat" .-> ChatAI["ChatGPT / Gemini / Cowork"]

  ClaudeLoop --> PTools["planner_get_package, planner_claim, planner_report"]
  AgentLoop --> PTools
  PTools --> Session["McpSession scopes: read, propose, execute<br/>actor OmniCandy Claude"]
  ExtMCP --> Svc["PlannerService.claimTask / submitReport"]
  Session --> Svc
  Svc --> Claimed["task in_progress, 8 h lease"]

  ClaudeLoop --> Tools["app tools: get_status, apply_edit, app_command,<br/>external_run, generate_*, timeline_*, save_version"]
  AgentLoop --> Tools2["native + external_command + export tools"]
  Tools --> Approve{"Approval gate"}
  Tools2 --> Approve
  Approve -->|"external command / paid call: dialog"| Run["IntegrationManager.execute / GenerationService / liveTask"]
  Run --> Apps["ArtCraft apps, Blender, Unreal, Fusion, Resolve"]
  Apps --> Readback["trusted read-back (TRUSTED_READBACK_COMMANDS),<br/>save_version id, outputs checked non-empty"]
  Readback --> Evidence["evidence_verify and receipts<br/>inside the harness (TaskPlan)"]

  Evidence -. "NOT connected to the report" .-> Report
  Tools -->|"AI writes prose"| Report["planner_report / submit_report:<br/>self-reported verification[]"]
  Tools2 -->|"AI writes prose"| Report
  ChatAI -. "person pastes answer back" .-> Paste["PastePanel -> importReport"]
  Report --> Svc2["PlannerService.applyReport: task reported"]
  Paste --> Svc2
  Svc2 --> Review["Owner: reviewReport accept / revise / reject"]
  Review --> Done["task accepted"]
```

## D. Current project persistence and recovery flow

```mermaid
flowchart TB
  subgraph Open["Open / switch project"]
    Reg["userData/projects.json: current, recent, locations"]
    PM["ProjectManager.open(key)"]
    Sync["ProjectPlanner.sync(): store.setProject(root, ownerId)<br/>before every planner call"]
    Reload["Renderer: onSwitched, loadCurrent(restore)"]
  end
  subgraph Files["Project folder"]
    Man["project.json (ProjectManifest incl. view)"]
    Lib["Assets/, Versions/, Exports/, per-app folders"]
    PlanDir["Planner/projects/planId/: project.json, history.jsonl, chat.json, raw/"]
    ClaudeH["Claude/conversation.json"]
    Cp[".omnicandy-agent-checkpoint.enc"]
  end
  subgraph Restore["What comes back after a restart"]
    V["Tab + file (manifest.view, saved 800 ms after changes)"]
    PL["Plan (whole project.json), chat.json, lastActive banner"]
    CL["Claude chat (new SDK session seeded by buildResumeContext)"]
    AG["Agent: restoreAgent() -> paused or limit state"]
    J["Edit-intent journal: blocks edits until a fresh read-back"]
    Gone["Lost: running jobs (in memory), live document state, Planner tab position"]
  end

  Reg --> PM --> Reload
  PM --> Man
  Reload --> V
  Man --> V
  Sync --> PlanDir --> PL
  ClaudeH --> CL
  Cp --> AG
  Cp --> J
  Lib -. "assets read-only, versions by parentId" .-> Man
  PlanDir -. "lock file: app and MCP process share it" .-> PlanDir
  Dup["Duplicate project: copyVerified whole tree"] --> PlanDir
  Dup --> Adopt["forProject(): adoptPlan() re-owns the copied plan"]
  Older["userData/planner (older plans)"] -->|"attachOlder: copy into project, original untouched"| PlanDir
```

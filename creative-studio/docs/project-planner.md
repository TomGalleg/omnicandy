# Project Planner

One current plan per project, kept while you brainstorm in ChatGPT or Gemini and run the work in Claude Code, Cowork or
CreateCraft. It works on its own (copy and paste, no AI, no API key) and can optionally connect to a local AI through an MCP
server. Open it from **More > Planner** (Simplified) or **Planner** (Advanced).

Private and local: plans live in `<user data>/planner` (on Windows `%APPDATA%\creative-studio\planner`). There is no sharing,
marketplace or publishing feature, and nothing is uploaded.

## What a plan contains

All optional except a title (and a simple project needs only a title and goal).

| Part | Notes |
|---|---|
| Brief | goal, description, scope, constraints, expected deliverables |
| Ideas, references, open questions | not part of the plan; never sent as requirements |
| Requirements and decisions | accepted ones form the plan. Decisions keep their reason |
| Tasks | subtasks, dependencies (no cycles), priority, completion checks, expected outputs, optional native app / external integration reference |
| Assets | references, working files, deliverables (output versions share a group). Files are linked by path, never copied; CreateCraft art-project assets are linked by id |
| Milestones | tasks can point at one |
| Proposals, packages, reports | see below |
| History | who did what (every entry names the actor) and every version of the accepted plan |

Templates (software, art/design, document, research, video/audio, engineering, blank) only fill in editable defaults: ordinary
requirements, questions, tasks and checks. They can be mixed (a project can be research + document + image). There is no
separate project system per template.

## The round trip

1. A person or connected AI develops a **proposal**. Proposals are stored apart from the plan; nothing in them is accepted.
2. You accept (some or all of) a proposal. Accepted requirements and decisions become the plan, and a new plan version is kept.
3. You select tasks and create an **execution package**: an immutable, hashed snapshot (project and task ids, plan revision,
   objective, accepted requirements and decisions, scope, constraints, assets, tasks with completion checks, report instructions).
   Creating a package starts nothing.
4. An executor retrieves it (copy and paste, or MCP), **claims** a task (8 hour lease, renewed by progress, expired claims can be
   taken over and the history says so) and does the work.
5. The executor submits a structured **report**: work performed, outputs and changed files, verification actually run (pass / fail /
   not run per completion check id), blockers, limitations, unresolved questions, proposed plan changes, executor identity, package
   revision.
6. You review it. **Reported complete is not accepted.** Only you accept (task becomes Accepted), ask for changes (task goes back to
   Revision requested) or reject. A report that is not "complete" cannot be accepted as done. Questions and plan changes in a report
   arrive as a pending proposal, not as plan content.

## Consistency rules (all tested)

* Revisions: every change bumps `revision`; `planRevision` bumps only when the accepted plan changes (compared as a snapshot, so
  touching an idea does not bump it).
* **Outdated work**: a package keeps the plan it was made from. `planDrift` lists requirements, decisions, goal, scope, constraints
  and deliverables that were added, changed or removed since. It is shown on the package, on every report (as of submission) and at
  review; accepting an outdated report needs an explicit acknowledgement.
* **No silent overwrite**: every item, task, asset and the brief carry a revision. Edits that pass an older one are refused with the
  current value. A proposal that edits something changed since it was written is refused, not merged.
* **No duplicates**: an identical report for the same package and task returns the existing one. A task is in at most one open
  package (a newer package supersedes the older; claims on the old one are refused as stale). A task has at most one live claim.
* **Recovery**: state is `project.json` written atomically under a lock file (two processes can write safely; stale locks are
  removed after 20 s), plus an append-only `history.jsonl`. Reports, claims and transitions survive a restart.
* Proposals and ideas are kept separate from accepted state; accepted requirements are never deleted, only superseded.

## Copy and paste (no AI connection needed)

* Package out as readable Markdown (Handoffs > Show / copy) and as JSON, or saved as files.
* Report in: paste JSON or Markdown, press **Preview what it says**. Nothing is applied by previewing. The preview shows what
  was read, what had to be guessed (for example a verification line with no clear result is recorded as "not run"), and errors.
  You choose the package and task if they were not named, then **Apply as a report**. The original response is kept verbatim next
  to the report.

## Direct connection: the planner MCP server

`out/planner-mcp.cjs` (built by `npm run build`; shipped as `planner-mcp.cjs` in the installed app) is a stand-alone MCP server
(protocol 2025-06-18, 2025-03-26, 2024-11-05) over stdio, with an optional local HTTP mode. It reads the same folder as the app,
so it works even when CreateCraft is closed.

Permissions are separate scopes given when the connection is started (`--scopes`):

| Scope | Tools |
|---|---|
| `read` (always) | `list_projects`, `get_project_context`, `get_changes_since`, `list_packages`, `get_package` |
| `propose` | `propose_changes` (suggest only) |
| `package` | `create_execution_package` (prepares text, starts nothing) |
| `execute` | `claim_task`, `report_progress`, `submit_report`, `release_claim` |

Editing the plan, accepting proposals and accepting reports are not scopes a connection can hold: asking for them refuses to
start. Every change is attributed to the connection's name. Planner > Handoffs > Connect an AI shows ready-to-paste settings for a
"brainstorming" connection (`read,propose`) and an "executor" connection (`read,execute`).

```
node out/planner-mcp.cjs --scopes read,execute --actor "Claude Code" --kind claude-code        # stdio
node out/planner-mcp.cjs --http --port 8765 --token-file token.txt --scopes read,propose         # local HTTP, 127.0.0.1
```

Installed app: use CreateCraft's own runtime, `ELECTRON_RUN_AS_NODE=1 CreateCraft.exe planner-mcp.cjs ...` (the app generates the
snippet). Tried here with the dev Electron binary.

HTTP mode listens on `127.0.0.1` only, requires `Authorization: Bearer <token>` (24+ characters), rejects non-local `Origin`
headers, and answers only `/mcp`. Making it reachable from the internet is your explicit choice and is not set up by CreateCraft.

### CreateCraft's own Claude

The Claude panel has `planner_packages`, `planner_get_package`, `planner_claim` and `planner_report`, backed by the same MCP
session with `read,execute` only (named "CreateCraft Claude" in history). It only works from a package when you ask it to.

## What each client can do (checked 2026-10-16)

| Client | Status | Notes |
|---|---|---|
| Claude Code | **verified** | Official docs list stdio and HTTP servers. Claude Code's own `claude mcp list` (isolated config) started the planner server and showed it **Connected**. Not run: a model deciding to call the tools (paid) |
| Claude Cowork | unavailable (local) | Remote connectors only; local stdio config in Claude Desktop does not reach Cowork. Source: third-party guides, not confirmed in Anthropic's pages. Use copy and paste |
| ChatGPT | unavailable (local) | Needs a public HTTPS MCP server in Developer Mode, plan limits vary; local stdio does not work. Third-party guides only. Use copy and paste. The local HTTP mode exists but has never been exposed or called by ChatGPT |
| Gemini CLI | untested | Documented stdio `mcpServers` shape generated; CLI not installed here |
| Gemini app | unavailable (local) | Remote URL only, reported since mid-2026; third-party summaries only |
| CreateCraft's Claude | untested live | Handlers tested against the real service; no live Claude session (paid) |

"Verified" means a real client of that kind was connected to the real server. The in-repo tests (`mcp.roundtrip.test.ts`) use
CreateCraft's own MCP client for full round trips; the Claude Code check covers the handshake and health only.

## Tests

* `src/main/planner/service.test.ts` (15): persistence after restart, templates, full round trip, outdated plan, proposals
  separate, proposal conflicts, concurrent writers, supersede/claims, dependencies, partial/revision, lease takeover, paste flow,
  export/import, permissions.
* `mcp.session.test.ts` (2) and `mcp.roundtrip.test.ts` (3): real processes over stdio and HTTP; scope separation; brainstorm,
  accept, package, claim, report, review across processes.
* `scripts/smoke-planner.mjs` (`npm run smoke:planner`): the real window with a real MCP executor process: mixed project
  (research, document, image), plan changed mid-work, outdated-report guard, suggestions, paste path with preview, restart.
  Screenshots `docs/screenshots/140-*.png` to `149-*.png`.

## Export and import

Export (Export / import menu) writes a zip: `planner.json` and `README.txt`; with "linked files bundled", files up to 50 MB are
included under `assets/<id>/`; others stay **referenced** (their path on the exporting computer). Claims are removed. Nothing
secret is in a plan. Import always creates a new project (never overwrites), rewrites bundled file paths, and flags missing
referenced files.

## Not done / limits

* Remote access for cloud chat clients is not built (no tunnel, no OAuth); copy and paste covers them.
* No live Claude/Cowork/ChatGPT/Gemini session was run (spend is $0).
* Tasks have no due dates; milestones have an optional due date.
* Linking CreateCraft assets stores the project key and asset id; resolving a link into a file open is not wired.

# Project Planner

One current plan per project, kept while you brainstorm in ChatGPT or Gemini and run the work in Claude Code, Cowork or
CreateCraft. It works on its own (copy and paste, no AI, no API key) and can optionally connect to a local AI through an MCP
server. Open it from **More > Planner** (Simplified) or **Planner** (Advanced). It opens in a plain four-area view; the original
screens are one checkbox away (see below). How and why it was simplified, with the checks made, is in `docs/planner-simplification-plan.md`;
a plain-language description is in `docs/planner-explained.md`.

Private and local: plans live in `<user data>/planner` (on Windows `%APPDATA%\creative-studio\planner`). There is no sharing,
marketplace or publishing feature, and nothing is uploaded. The one exception is the optional **Plan with an AI** chat (below): when you
press a button in it, your message and a short summary of the plan go to the AI you chose.

## Every project has its own Planner

The Planner is part of each CreateCraft project (the **Planner** tab beside Project, Create, AI Generate and Deliver). It is optional, and always there.

* **Where the plan lives.** In the project's own folder: `<project>/Planner/projects/<planId>/` (`project.json`, `history.jsonl`, `chat.json`, raw
  pasted responses). The plan records the project's identity (`ownerProjectId` = the project's manifest id), so it travels with **Move** and
  **Duplicate** (a duplicated project adopts its copy of the plan the first time the Planner opens) and reopening the project restores the plan,
  the planning conversation (`chat.json`), the current chunk and progress. A project has **one** plan; the plan approved on Home is added to it as suggestions.
* **Code.** The planner engine is unchanged. `RoutedPlannerStore` (`main/planner/routedStore.ts`) decides where a plan id is read or written: the open
  project's folder first, then the shared folder; new plans go to the open project. `ProjectPlanner` (`projectPlanner.ts`) ties a plan to its project,
  starts it and applies findings. The stand-alone connection (MCP) is pointed at the open project's `Planner` folder by the connection panel.
* **Starting.** New project: **Start with an idea** (opens the Planner on the Idea step) or **Start creating** (a blank workspace). An existing project, or
  one made before this existed, shows an entry screen on first open: **Start with an idea**, or **Look at what is already here**.
* **Looking at what is already here** (`projectContext.ts`, local and read-only): counts of files, saved versions, exports, the workflow, the saved
  brief and objective, and the saved Claude conversation. It proposes the goal and description from a saved brief (if there is one), the notable files as
  **References**, and questions. Each suggestion has a tick box; nothing is added until the owner presses **Start my plan with these**. A file existing never
  marks a chunk as done, no history is assumed, and the project's own files (including `project.json`) are not written. The planning AI is also told the
  project's file names and counts (never paths), so it understands what exists.
* **Flow.** Plain view: **Idea** (the brief, rules, decisions, questions, ideas, references, and the planning chat), **Plan** (the work in editable **chunks**
  (tasks) and milestones), **Work** (one **current chunk**: send it to ChatGPT, Gemini, Claude or CreateCraft, bring the result back, review it, approve
  it or ask for changes), **Files**. Everything copies out as text and comes back through Paste back or the review inbox.
* **Pick up where I left off.** The chunk worked on last is recorded in the plan (`lastActive`: opened in Work, sent to an AI, a result brought back,
  approved or sent back for changes) without changing the accepted plan. When the project is opened later the Planner shows **Pick up where I left off** with
  that chunk and how long ago; **Pick up** goes straight to it in Work.
* **Files stay the source of truth.** The Planner tracks goals, decisions, approvals and progress. It never moves, edits or deletes the project's assets. A chunk that
  has been handed off cannot be deleted (only cancelled, history kept), and the owner approves every result; nothing is marked done by itself.
* **Older plans.** Plans made before this (in the shared planner folder) keep working. **Older plans (n)** in the header lists them: **Just open it** (as they were) or,
  on the entry screen, **Bring into this project** (a copy; the original is never changed, and the copy records `importedFrom`).

## Plain view and Advanced

The Planner opens in the **plain view**: four areas, **Idea, Plan, Work, Files** (ids `plan`, `tasks`, `handoffs`, `assets`), and one **Needs you** list. The **Advanced** checkbox in the
header (remembered per user, off by default) shows the original six tabs (Overview, Plan, Tasks, Assets, Handoffs, History), revision
chips, packages, claims, plan versions and connection profiles. Both views read and write the same data through the same rules; only
wording and layout differ.

| Stored (and in Advanced, history, MCP) | Plain view |
|---|---|
| todo / revision / in_progress / reported / accepted / blocked / cancelled | To Do (with "Changes requested") / In Progress / Needs Review / Done / Blocked / hidden under "Show removed" |
| in_progress with an expired claim | In Progress, **Stalled**, with **Take back** |
| todo with an open package and no claim | In Progress, "Sent to AI, waiting for a result" |
| proposal / report / package / claim | suggestion / result / brief / "is working on it" |
| plan drift | "The plan changed after this was sent" |

Plain areas: **Plan** (goal and progress, phases, rules for the AI, notes and questions), **Tasks** (list or five-column board, add, per-task
Send to AI, Take back, Unblock, Unsend, Mark done, Remove, the result card inline when a task needs review), **AI** (the **Needs you**
inbox, **Send to AI**, **Ask an AI for ideas**, **Paste back**, and a collapsed "Connect an AI directly (optional)"), **Files** (assets).
Plain wording of errors comes from `plainError()`; unknown errors are shown unchanged.

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

### In the plain view

1. **Ask an AI for ideas** (AI area) copies a short summary of the plan and asks for Requirements, Decisions, Tasks, Questions, Ideas.
2. **Paste back**: one box. `classifyPaste()` decides locally whether it is a task result or plan suggestions (or unclear, and asks).
   Suggestions are read from JSON (`changes`, or `tasks`, `requirements`, `decisions`, `questions`, `ideas`) or Markdown lists under those
   headings, at most 30 changes and 200,000 characters. The preview marks each item **changes the plan** (rule, decision, edit) or **adds to
   your list**. *Add selected to my plan* stores a pending proposal (source `pasted`) and then accepts the ticked items as you; *Save for
   later* stops after storing. Both history entries are yours, with the named AI as proposer.
3. **Send to AI**: tick tasks (or press Send to AI on a task), choose CreateCraft Claude, Claude Code or Gemini CLI, or any chat, press one
   button, copy. `prepareSend()` creates the package like `createPackage` but returns an identical open one instead of superseding it
   (`contentKey`: plan, tasks, assets, objective, note and what the AI receives, not the package number). CreateCraft Claude gets its box
   filled (you press Send); nothing is started or paid for by the Planner.
4. The result comes back by paste (or MCP), the task shows **Needs Review**, and you accept, ask for changes or reject.

### Plan with an AI (the chat beside the brief)

On the Plan area, next to **Project brief**, a chat sends your messages to an AI and shows its answers. It is only for planning: it can read
a short summary of the plan (title, goal, description, scope, constraints, agreed rules, open questions, task titles; no file locations, no
ideas, no task details) and **can write nothing**.

* **Which AI:** a picker offers **Claude** (your Claude sign-in; Opus 5.5 or Sonnet 5.5), **OpenAI** and **Google Gemini** (your own API keys
  from Settings > Integrations, the same keys used for images; each message is billed to that account). The model list for OpenAI and Gemini
  is read live from the provider with your key, so no model name is built in. A provider without a key shows "needs a key". The choice is
  remembered.
* **Saving the brief** shows "Brief saved. Ask <AI> to help plan this". Nothing is sent until you press that button (or type and press
  Send). One request per message; the history sent is the newest 24 messages (each cut at 6,000 characters) and replies are limited to
  3,000 tokens, which bounds what a message can cost.
* **What it fills in.** The AI is asked (and Paste back reads) these sections: **Project brief** (goal, description, scope, constraints,
  deliverables), **Milestones** (optional due date), **Requirements**, **Decisions** (with "why"), **Tasks** (each can name its milestone and,
  indented, how to check it is done), **Questions**, **Ideas** and **References** (title and link). The summary it sees also lists milestone names so it does not repeat them.
  The button **Fill in my plan with <AI>** (and the offer after saving the brief) asks for all of them at once.
* **What comes back** is read with the same reader as Paste back, one tick box per suggestion, marked "changes the plan" (the brief, rules and
  decisions) or "adds to your list" (milestones, tasks, questions, ideas, references). **Add selected to my plan** or **Save for later** work
  exactly as for a pasted answer, so the owner still decides and the history names "Planning chat" as the proposer. When added: rules and decisions
  become accepted; questions, ideas and references stay open items; tasks join the milestone of the same name (milestones are added first, and a
  milestone with the same name is never duplicated); brief text parts replace the old text, while constraints and deliverables only gain new
  lines (nothing you wrote is removed). A brief suggestion is tied to the brief as it was when the answer arrived: if you edit the brief before
  accepting, it is refused instead of overwriting your edit. At most 80 suggestions are read from one answer.
* The conversation is saved with the project's plan (`chat.json`, the newest 48 messages) and comes back when the project is opened. Keys are lent from the encrypted store for one call, are never sent
  to the page, and are removed from any error text.

### What the AI receives (context builder)

`buildContext()` (`src/shared/plannerContext.ts`) is pure and local. A Send to AI brief carries goal, scope, constraints, deliverables, the
chosen tasks with checks, **every accepted rule and decision**, the references, and the accepted results of tasks it depends on. It never
carries ideas, open questions, rejected items, other tasks' details or history. Only for chat destinations and only above 6,000 characters
of rules are the least related rules left out (ranked by word overlap with the tasks); the send preview lists what was left out and lets
you put any back, the brief names them ("Not included here"), and `delivery` on the package records included and omitted ids. The package
still stores the full plan snapshot, so changing a left-out rule still marks the work outdated. "Remove file locations" replaces your file
paths with file names. A package made with `createPackage` (Advanced, MCP) has no `delivery` and lists every rule, as before.

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
start. Every change is attributed to the connection's name. Planner > AI > Connect an AI directly (Advanced: Handoffs > Connect an AI) shows ready-to-paste settings for a
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

The Claude panel has `planner_packages`, `planner_get_package`, `planner_claim`, `planner_report` and `planner_propose`, backed by the same
MCP session with `read,propose,execute` only (named "CreateCraft Claude" in history). It only works from a package, or suggests changes,
when you ask it to. `planner_propose` creates a pending suggestion; the panel cannot create packages, edit the plan, accept or review.
Send to AI > CreateCraft Claude fills the panel's box with a message you send yourself.

### Workflow and Home

* A task can use **the workflow of the open CreateCraft project** (the existing `appRef {kind:'workflow'}`). The task shows a Workflow chip
  and a read-only line from the run state; a finished run never accepts or changes a task. Only the open project's workflow has a live state.
* Home's **Create with Claude** makes a CreateCraft project. With "Also keep these steps in the Planner as suggestions" ticked (default),
  the steps and questions become one pending suggestion list in a new Planner plan (source `home`); nothing joins the plan until you accept it.

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

Planner folder: 65 tests in 8 files (counts are re-checked in docs/planner-simplification-plan.md, Part 19).

* Added with the simplification: `baseline.test.ts` (9: golden fixtures from the earlier build, findings pinned, owner-only invariant),
  `plannerView.test.ts` (6: status view, plain errors), `send.test.ts` (17: reuse, two writers at once, restart, pasted suggestions,
  hostile text, file locations, no network code), `context.test.ts` (8: context builder, delivery, upstream results, brainstorm text),
  `links.test.ts` (5: Home plan to suggestions, panel can suggest but not decide, workflow wording).
* `src/main/planner/service.test.ts` (15): persistence after restart, templates, full round trip, outdated plan, proposals
  separate, proposal conflicts, concurrent writers, supersede/claims, dependencies, partial/revision, lease takeover, paste flow,
  export/import, permissions.
* `mcp.session.test.ts` (2) and `mcp.roundtrip.test.ts` (3): real processes over stdio and HTTP; scope separation; brainstorm,
  accept, package, claim, report, review across processes.
* `scripts/smoke-planner.mjs` (`npm run smoke:planner`): the real window with a real MCP executor process: the plain view's four areas, then
  (Advanced ticked) mixed project (research, document, image), plan changed mid-work, outdated-report guard, suggestions, paste path with
  preview, restart; then the plain view again: five-column board, Send to AI and repeat send, pasted suggestions saved, then accepted, a
  pasted result accepted inline, a task pointing at the workflow. Screenshots `docs/screenshots/140-*.png` to `154-*.png`.
* `docs/planner-first-run-checklist.md`: the hands-on walkthrough with a first-time user (not automated).

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
* Not run (they need paid calls or a sign-in): the planning chat against a real Claude, OpenAI or Gemini account (request shapes are tested with faked providers only), Home's Create with Claude into the Planner from the real screen, `planner_propose` from a live
  Claude session, "Put it in the Claude panel", any live ChatGPT/Gemini/Cowork session.
* No stored per-rule "always include" pin (the owner can put left-out rules back for one send). The context builder's relevance is plain
  word overlap.
* No MCP `get_context` tool (it would change the tested tool list); connected tools get the built brief from `get_package`.

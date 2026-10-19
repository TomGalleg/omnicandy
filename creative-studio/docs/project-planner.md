# Project Planner

One current plan per project, kept while you brainstorm in ChatGPT or Gemini and run the work in Claude Code, Cowork or
OmniCandi. It works on its own (copy and paste, no AI, no API key) and can optionally connect to a local AI through an MCP
server. Open it from **More > Planner** (Simplified) or **Planner** (Advanced). It opens in a plain four-area view; the original
screens are one checkbox away (see below). How and why it was simplified, with the checks made, is in `docs/planner-simplification-plan.md`;
a plain-language description is in `docs/planner-explained.md`.

Private and local: plans live in `<user data>/planner` (on Windows `%APPDATA%\creative-studio\planner`). There is no sharing,
marketplace or publishing feature, and nothing is uploaded. The one exception is the optional **Plan with an AI** chat (below): when you
press a button in it, your message and a short summary of the plan go to the AI you chose.

## Every project has its own Planner

The Planner is part of each OmniCandi project (the **Planner** tab beside Project, Create, AI Generate and Deliver). It is optional, and always there.

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
  brief and objective, and the saved Claude conversation. It offers the goal and description from a saved brief (if there is one) with a tick box, and starts the conversation from what it found; nothing is added until the owner presses **Start planning from this**. A file existing never
  marks a chunk as done, no history is assumed, and the project's own files (including `project.json`) are not written. The planning AI is also told the
  project's file names and counts (never paths), so it understands what exists.
* **Flow.** **Idea** (a conversation that ends with a list of clear chunks), **Plan** (the work in editable **chunks**
  (tasks) and milestones), **Work** (one **current chunk**: send it to ChatGPT, Gemini, Claude or OmniCandi, bring the result back, review it, approve
  it or ask for changes). Everything copies out as text and comes back through Paste back or the review inbox.
* **Pick up where I left off.** The chunk worked on last is recorded in the plan (`lastActive`: opened in Work, sent to an AI, a result brought back,
  approved or sent back for changes) without changing the accepted plan. When the project is opened later the Planner shows **Pick up where I left off** with
  that chunk and how long ago; **Pick up** goes straight to it in Work.
* **Files stay the source of truth.** The Planner tracks goals, decisions, approvals and progress. It never moves, edits or deletes the project's assets. A chunk that
  has been handed off cannot be deleted (only cancelled, history kept), and the owner approves every result; nothing is marked done by itself.
* **Older plans.** Plans made before this (in the shared planner folder) keep working. **Older plans (n)** in the header lists them: **Just open it** (as they were) or,
  on the entry screen, **Bring into this project** (a copy; the original is never changed, and the copy records `importedFrom`).

## The screens: three steps and one menu

There is no Advanced switch any more. The Planner shows **Idea, Plan, Work** (tab ids `plan`, `tasks`, `handoffs`) and a small **⋯** menu. The planner engine
(packages, claims, revisions, plan versions, the connection server) is unchanged and still does the work underneath; the screens only show what a person needs.

| Where it went | What it holds |
|---|---|
| **Idea** | Only the conversation with the AI (see below). "Use ChatGPT, Gemini or another AI instead" is folded under it. |
| **Plan** | The **chunks** (tasks): add one with a single line (extra detail under More options), edit, Mark done, Remove, and **Work on this**. **Milestones** are a folded section. |
| **Work** | What **needs you** (results to review, suggestions, stalled chunks) appears only when something waits; the **current chunk**; **Do this chunk** (pick OmniCandi, Claude Code / Gemini CLI, or ChatGPT / Gemini / any chat; one button copies the instructions); **Bring the result back** (paste, preview, review, approve or ask for changes). |
| **⋯ menu** | **What changed** (the full history), **Connect an AI tool** (the connection snippets), **Export this plan**, **Export with linked files**, **Import a plan**, **Open the plan's folder**, and **Older plans**. |
| Header | The plan's title, "n of m chunks done", and **Pick up where I left off** when you come back. |

Removed from view (their jobs live elsewhere): Overview (progress is in the header, next steps are Work), Handoffs (Work), History (⋯ > What changed), Files, the brief form and the rules/decisions/questions/ideas/references lists (the conversation fills in the summary quietly), the list/board toggle and the per-chunk
"Send to AI" button (Work on this opens it in Work), and the packages screen (a package is created for you when you copy instructions).

The mapping between what is stored and what is shown is unchanged:

| Stored (and in history, MCP) | Shown |
|---|---|
| todo / revision / in_progress / reported / accepted / blocked / cancelled | To Do (with "Changes requested") / In Progress / Needs Review / Done / Blocked / hidden under "Show removed" |
| in_progress with an expired claim | In Progress, **Stalled**, with **Take back** |
| todo with an open package and no claim | In Progress, "Sent to AI, waiting for a result" |
| proposal / report / package / claim | suggestion / result / brief / "is working on it" |
| plan drift | "The plan changed after this was sent" |

Plain wording of errors comes from `plainError()`; unknown errors are shown unchanged.

## What a plan contains

All optional except a title (and a simple project needs only a title and goal).

| Part | Notes |
|---|---|
| Brief | goal, description, scope, constraints, expected deliverables |
| Ideas, references, open questions | not part of the plan; never sent as requirements |
| Requirements and decisions | accepted ones form the plan. Decisions keep their reason |
| Tasks | subtasks, dependencies (no cycles), priority, completion checks, expected outputs, optional native app / external integration reference |
| Assets | references, working files, deliverables (output versions share a group). Files are linked by path, never copied; OmniCandi art-project assets are linked by id |
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
3. **Send to AI**: tick tasks (or press Send to AI on a task), choose OmniCandi Claude, Claude Code or Gemini CLI, or any chat, press one
   button, copy. `prepareSend()` creates the package like `createPackage` but returns an identical open one instead of superseding it
   (`contentKey`: plan, tasks, assets, objective, note and what the AI receives, not the package number). OmniCandi Claude gets its box
   filled (you press Send); nothing is started or paid for by the Planner.
4. The result comes back by paste (or MCP), the task shows **Needs Review**, and you accept, ask for changes or reject.

### Plan with an AI (the Idea step: a conversation)

**Idea** is only a conversation. There is no brief form and no lists of rules, decisions, questions, ideas or references to fill in.

1. The AI talks the idea through (plain sentences, at most two short questions at a time): what is being made, what it is for, what finished looks like, the limits
   that matter, and what already exists. It is told what the project already holds (file names and counts, never paths).
2. When it understands enough it says what it understood and asks **"Ready to start building? I'll break it into clear steps."**, ending the message with the marker
   `[[READY]]` (`READY_MARK`). The page hides the marker and shows **Yes, make the plan** and **Not yet, I want to add something**.
3. **Yes** sends one more request in `chunks` mode. The AI answers once in `CHUNK_FORMAT`: a sentence, a short project summary (goal, description, scope) and 4 to 12 chunks in the
   order they should be done, each small enough for one sitting and starting with a verb, with how to check it is done. The page shows this as a plain numbered list (tick boxes,
   **Add these to my plan**, **I want to change something**), never as raw text.
4. **Add these to my plan** adds the chunks in order and quietly fills in the project summary (it never overwrites a summary you edited since). Nothing else is created.
   Coming back to the conversation later does not offer the same chunks twice, and asking for more chunks or changes in the chat gives a new list of only the new ones.

* **Which AI:** a small "Talking with Claude · model" line opens the picker: **Claude** (your Claude sign-in), **OpenAI** and **Google Gemini** (your own API keys from Settings >
  Integrations; each message is billed to that account). OpenAI and Gemini model lists are read live from the provider. The choice is remembered.
* **Cost bounds:** one request per message you send; the newest 24 messages (each cut at 6,000 characters) go with it; replies are limited to 3,000 tokens.
* **ChatGPT, Gemini or any other AI:** "Use ChatGPT, Gemini or another AI instead" copies a request that asks for the same two steps, and **Paste the answer** reads it back with the same reader, with a preview first.
* **Existing projects:** the entry screen's **Look at what is already here** starts the conversation from what was found ("I looked through this project. Here is what I found ... What would you like to do with it next?"); the AI is told the same facts on every message.
* The conversation is saved with the project's plan (`chat.json`, the newest 48 messages) and comes back when the project is opened. Keys are lent from the encrypted store for one call, are never sent to the page, and are removed from any error text.
* The older sections (rules, decisions, questions, ideas, references, milestones) still exist in the plan data and are still understood when pasted or proposed by a connected tool; they are just not forms the owner has to fill in.

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
so it works even when OmniCandi is closed.

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

Installed app: use OmniCandi's own runtime, `ELECTRON_RUN_AS_NODE=1 OmniCandi.exe planner-mcp.cjs ...` (the app generates the
snippet). Tried here with the dev Electron binary.

HTTP mode listens on `127.0.0.1` only, requires `Authorization: Bearer <token>` (24+ characters), rejects non-local `Origin`
headers, and answers only `/mcp`. Making it reachable from the internet is your explicit choice and is not set up by OmniCandi.

### OmniCandi's own Claude

The Claude panel has `planner_packages`, `planner_get_package`, `planner_claim`, `planner_report` and `planner_propose`, backed by the same
MCP session with `read,propose,execute` only (named "OmniCandi Claude" in history). It only works from a package, or suggests changes,
when you ask it to. `planner_propose` creates a pending suggestion; the panel cannot create packages, edit the plan, accept or review.
Send to AI > OmniCandi Claude fills the panel's box with a message you send yourself.

### Workflow and Home

* A task can use **the workflow of the open OmniCandi project** (the existing `appRef {kind:'workflow'}`). The task shows a Workflow chip
  and a read-only line from the run state; a finished run never accepts or changes a task. Only the open project's workflow has a live state.
* Home's **Create with Claude** makes an OmniCandi project. With "Also keep these steps in the Planner as suggestions" ticked (default),
  the steps and questions become one pending suggestion list in a new Planner plan (source `home`); nothing joins the plan until you accept it.

## What each client can do (checked 2026-10-16)

| Client | Status | Notes |
|---|---|---|
| Claude Code | **verified** | Official docs list stdio and HTTP servers. Claude Code's own `claude mcp list` (isolated config) started the planner server and showed it **Connected**. Not run: a model deciding to call the tools (paid) |
| Claude Cowork | unavailable (local) | Remote connectors only; local stdio config in Claude Desktop does not reach Cowork. Source: third-party guides, not confirmed in Anthropic's pages. Use copy and paste |
| ChatGPT | unavailable (local) | Needs a public HTTPS MCP server in Developer Mode, plan limits vary; local stdio does not work. Third-party guides only. Use copy and paste. The local HTTP mode exists but has never been exposed or called by ChatGPT |
| Gemini CLI | untested | Documented stdio `mcpServers` shape generated; CLI not installed here |
| Gemini app | unavailable (local) | Remote URL only, reported since mid-2026; third-party summaries only |
| OmniCandi's Claude | untested live | Handlers tested against the real service; no live Claude session (paid) |

"Verified" means a real client of that kind was connected to the real server. The in-repo tests (`mcp.roundtrip.test.ts`) use
OmniCandi's own MCP client for full round trips; the Claude Code check covers the handshake and health only.

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
* Linking OmniCandi assets stores the project key and asset id; resolving a link into a file open is not wired.
* Not run (they need paid calls or a sign-in): the planning chat against a real Claude, OpenAI or Gemini account (request shapes are tested with faked providers only), Home's Create with Claude into the Planner from the real screen, `planner_propose` from a live
  Claude session, "Put it in the Claude panel", any live ChatGPT/Gemini/Cowork session.
* No stored per-rule "always include" pin (the owner can put left-out rules back for one send). The context builder's relevance is plain
  word overlap.
* No MCP `get_context` tool (it would change the tested tool list); connected tools get the built brief from `get_package`.

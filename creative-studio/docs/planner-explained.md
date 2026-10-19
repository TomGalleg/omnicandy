# OmniCandy Planner: what it is and how it works

A plain-language brief, written so another AI (or person) can understand the Planner. Facts here come from the code and `docs/project-planner.md`. The design history (what was too complicated, what was changed and what was checked) is in `docs/planner-simplification-plan.md`.

## 1. The idea in one paragraph

The Planner is the project's single source of truth for *what we are building, who is doing what, and what the owner approved*. You think and brainstorm with one AI (ChatGPT, Gemini, Claude), keep the agreed result as one accepted plan, hand slices of it to a worker (Claude Code, Cowork, OmniCandy's own Claude), and review what comes back. **The human is the only one who changes the plan or accepts work.** AIs can only suggest, claim a task and report. It works with no AI connection at all (copy and paste) and runs entirely on the user's PC.

Where: **More > Planner** in Simplified mode, **Planner** in Advanced mode. Data lives in `%APPDATA%\creative-studio\planner` (one folder per plan, `project.json` plus an append-only `history.jsonl`). Nothing is uploaded, shared or published, except what you choose to send in the planning chat (below).

## 2. Two views of the same data

* **Plain view (the default):** four areas, **Plan, Tasks, AI, Files**, five task labels (To Do, In Progress, Needs Review, Done, Blocked) and one **Needs you** list. No revision numbers, packages, claims or leases on screen.
* **Advanced** (a checkbox in the header, remembered): the original six tabs (Overview, Plan, Tasks, Assets, Handoffs, History), revision chips, packages, claims, plan versions, connection profiles and the full history.

The view changes only wording and layout. The stored data, the rules and the MCP tools are the same in both. A beginner's whole loop is four verbs: **Describe** the project, **Ask AI**, **Paste back**, **Approve**.

## 3. The cast

| Role | Who | What they may do |
|---|---|---|
| Owner | The person using OmniCandy | Everything: edit the plan, accept or reject suggestions and results, send work |
| Brainstormer | ChatGPT, Gemini, Claude chat, any AI | Read the plan, **suggest** changes. Suggestions are stored apart and change nothing until accepted |
| Executor | Claude Code, Cowork, OmniCandy's Claude, any AI that can follow a brief | Read a brief, claim a task, report progress, submit a result |
| OmniCandy | The app | Stores plans, enforces the rules below, shows history |

OmniCandy's Claude can also suggest plan changes (`planner_propose`), exactly like a brainstormer. It cannot edit, accept or package.

## 4. What a plan contains

Only a title is required.

* **Brief:** goal, description, scope, constraints, expected deliverables.
* **Notes and questions** (ideas, references, open questions): working material, never sent as requirements.
* **Rules and decisions** (stored as requirements and decisions): once *accepted*, these are the plan. Decisions keep their reason. Accepted items are never deleted, only superseded.
* **Tasks:** title, details, priority, dependencies (no cycles), completion checks, expected outputs, optionally which OmniCandy app or which project workflow it uses.
* **Files:** references, working files, deliverables. Linked by path, never copied.
* **Phases** (milestones), **suggestions, briefs, results and history**.

Stored task statuses are seven (todo, in_progress, blocked, reported, revision, accepted, cancelled). The plain view maps them to five labels: *revision* shows as To Do with "Changes requested", *reported* as Needs Review, *accepted* as Done, *cancelled* is hidden under "Show removed". An expired claim shows as **Stalled** with a **Take back** button; a task waiting on another shows as To Do with "Waiting for ...".

## 5. The round trip (plain words, with the stored names in brackets)

0. **Plan with an AI (optional, in the app).** Beside the Project brief is a chat. Pick Claude (your sign-in) or OpenAI or Google Gemini (your own keys, billed to you), save the brief, and press the offered button; nothing is sent by itself. Its suggestions appear with tick boxes exactly as in step 3, and the chat can change nothing.
1. **Ask AI for ideas (any chat app).** The AI area copies a short summary of your plan and asks for suggestions under headings (Requirements, Decisions, Tasks, Questions, Ideas).
2. **Paste back.** One box. The app works out whether you pasted suggestions or a task result and shows a preview. Nothing is stored by previewing.
3. **Approve.** Suggestions (a *proposal*) are listed with tick boxes; each is marked "changes the plan" (rules, decisions) or "adds to your list". "Add selected to my plan" stores them pending and then accepts the ticked ones as you. "Save for later" leaves them under Needs you.
4. **Send to AI.** Tick tasks, pick who it is for, press one button. The app prepares the brief (an *execution package*, an immutable hashed snapshot) and gives you one Copy button, or fills OmniCandy's Claude panel for you to send. An identical brief is reused rather than replaced. Nothing starts by itself.
5. **The AI works** (it may *claim* the task, an 8 hour lease) and answers with a result (a *report*): what it did, outputs, which completion checks it really ran, blockers, questions, suggested plan changes.
6. **Review.** The task is **Needs Review**. You choose Accept as done, Ask for changes, or Reject. A result that is not marked complete cannot be accepted as done. Questions and suggested changes inside a result arrive as pending suggestions.

## 6. What the AI receives (context builder)

A brief carries the goal, scope, constraints, deliverables, the chosen tasks with their checks, **all accepted rules and decisions**, the references, and the accepted results of tasks it builds on. It never carries ideas, open questions, rejected items, other tasks' details or history. Only for chat destinations, and only above a size budget, are rules ranked by overlap with the task and the least related left out; the preview shows what was left out and lets you put any back, and the brief itself lists the titles that were not included. Stale-work detection still uses the whole accepted plan. A **Remove file locations** option replaces your file paths with file names for cloud chats. No model is used to choose context and nothing is sent anywhere by the app.

## 7. The safety rules the app enforces

* **Outdated work is detected.** A brief remembers the plan it came from. If rules, decisions, goal, scope, constraints or deliverables change afterwards, the brief, the result and the review show what changed. Accepting an outdated result needs a tick.
* **No silent overwrites.** Every item, task, asset and the brief has a revision; an edit based on an older one is refused and shows the current value. A suggestion that edits something changed since it was written is refused, not merged.
* **No duplicates.** An identical result for the same brief and task returns the existing one. A task is in at most one open brief and has at most one live claim. Sending the same content twice returns the same brief.
* **Crash safe.** State is written atomically under a lock file; two processes can write safely. Results, claims and transitions survive a restart.
* **Attribution.** Every history entry names who did it. A pasted result or suggestion records the AI it names as the source and You as the person who entered it.
* **Owner only.** Editing the plan and accepting suggestions or results are not scopes a connection can hold, and no AI tool, including OmniCandy's Claude, can do them.

## 8. Two ways to connect an AI

**A. Copy and paste (works with any chat AI).** The Send to AI and Paste back screens above.

**B. Direct connection through the planner MCP server** (`planner-mcp.cjs`, stdio, or local HTTP on 127.0.0.1 with a bearer token). A connection is given scopes when it starts: `read` (always), `propose`, `package`, `execute`. The plain view's "Connect an AI directly (optional)" block shows ready-to-paste settings. The app cannot see whether a client is connected, so it only says when an AI last acted in the plan.

Client status as last checked: Claude Code verified (server connected); Cowork, ChatGPT and the Gemini app cannot reach a local server, so use copy and paste; Gemini CLI untested.

## 9. How it relates to the rest of OmniCandy

* **Planner** owns intent and acceptance: the goal, rules, tasks and what you approved.
* **Workflow** owns the mechanics of a repeatable media pipeline (nodes, cost, run state, its own approval steps). A task can point at the open project's workflow and shows its run state read-only; a finished run never accepts a task.
* **The Claude panel** is a conversation and a worker. It works from briefs and can suggest changes. It is never a second copy of the plan.
* **Home "Create with Claude"** makes an OmniCandy project (folder, brief, workflow template). With the tick box on, its steps and questions also go to a new Planner plan as pending suggestions only.

## 10. Known limits

* No remote access for cloud chat apps (no tunnel, no sign-in flow).
* Tasks have no due dates (phases do).
* Linking an OmniCandy asset stores its id; opening it from the Planner is not wired.
* Only the open project's workflow shows a live state.
* No live ChatGPT, Gemini, Cowork or Claude session has been run against it (they would be paid calls).
* Relevance ranking for chat briefs is plain word overlap and the 6,000-character chat budget is a guess.

# Planner simplification: current behaviour and proposed design

Status: **proposal for approval. Nothing has been implemented, installed, run against a paid API or pushed.** Only files were read
(`docs/project-planner.md`, `docs/planner-explained.md`, `src/shared/planner*.ts`, `src/main/planner/*`, `src/renderer/src/planner/*`,
the Planner parts of `claudePartner.ts` and `main/ipc.ts`). The existing test suites were **not** run for this review, so the
"all tested" claims in the docs are quoted, not re-verified.

---

## Part 1. What the Planner actually does today (from the code)

### 1.1 Layers

| Layer | Where | Role |
|---|---|---|
| Data model and pure rules | `shared/planner.ts` | types, `snapshotOf`, `planDrift`, `unmetDependencies`, `wouldCycle`, templates |
| Store | `main/planner/store.ts` | `project.json` (atomic write) + `history.jsonl` (append-only) under a lock file; `mutate()` is the only write path, bumps `revision`, bumps `planRevision` only if the accepted-plan snapshot changed |
| Service (all rules) | `main/planner/service.ts` | every rule is enforced here, for the app (user ctx, all scopes) and for connections (`read/propose/package/execute` only) |
| MCP server | `main/planner/mcp.ts`, `mcpMain.ts` | 10 tools over stdio or 127.0.0.1 HTTP; adds no rules |
| OmniCandi Claude | `claudePartner.ts` (`planner_*` x4) | the same MCP session with `read,execute`, actor "OmniCandi Claude" |
| Paste path | `shared/plannerHandoff.ts` | package -> Markdown; tolerant parser for a pasted report (JSON or Markdown) |
| UI | `renderer/.../planner/*` | 6 tabs: Overview, Plan, Tasks, Assets, Handoffs, History |

### 1.2 Nouns a user meets today

Plan item types (5): idea, reference, question, requirement, decision. Task statuses (7): todo, in_progress, blocked, reported,
revision, accepted, cancelled. Plus: proposal, execution package (with number, hash, state open/closed/cancelled/superseded),
claim + lease + claim token, report (with outcome, status, drift), plan revision, plan version, record revision, milestone, scope
names (`read/propose/package/execute`), executor profiles. Roughly **a dozen concepts** are visible, most of them on the
Handoffs tab, which holds six sections (reports to review, prepare a handoff, packages, paste a report, reviewed reports, connect an AI).

### 1.3 The real round trip and where the user does manual work

1. Brainstorm: only via an MCP connection with `propose`. **There is no paste path for a brainstorming response.** (`Proposal.source`
   has a `'pasted'` value but nothing creates one; a Markdown report's "suggested changes" are turned into *ideas* only.)
2. Accept a proposal: Plan tab -> "Suggested changes" card, per-change checkboxes, all-or-nothing conflict check (`decideProposal`).
3. Handoffs tab -> tick tasks -> "Create execution package" (manual; tasks must be `todo`/`revision`, unclaimed, dependencies met or
   included). A task already in an open package is silently replaced by the new package.
4. Package -> "Show / copy" -> copy Markdown/JSON by hand. Connected clients pull it (`get_package`) and claim (8 h lease).
5. Report returns by MCP `submit_report` or by paste: parse -> preview -> choose package and task if not detected -> "Apply as a report".
6. Review card: Accept as done / Ask for changes / Reject. Accepting an outdated report requires a checkbox. A non-`complete`
   report cannot be accepted.

### 1.4 Safety properties confirmed in code (these are the contract to preserve)

| Requirement | Where enforced |
|---|---|
| Only the owner edits the plan or approves | `need(c,'edit'|'review')`; `connectionCtx` refuses any scope outside `read/propose/package/execute`; MCP `tools/call` re-checks scope |
| AI output never silently changes the plan | `propose` stores a `pending` Proposal; only `decideProposal` (needs `review`) applies. Report-derived questions/changes also become pending proposals (`applyReport`) |
| Reported is not accepted | `applyReport` sets `reported`; only `reviewReport(accept)` sets `accepted` and requires `outcome==='complete'` |
| Stale-work detection | `planDrift(package.plan, snapshotOf(now))` on package view, at report submit (`driftAtSubmit`) and at review (`stale` error unless acknowledged) |
| Optimistic concurrency | `rev` on items, tasks, assets; `metaRev` on the brief; `checkRev` -> `conflict`; proposals carry `baseRev` and are refused, not merged |
| Duplicate prevention | report `contentHash` per package+task returns the existing report; one open package per task; one live claim per task |
| Crash safety | atomic temp+rename, lock file with 20 s stale takeover, append-only history (may lag one entry) |
| Attribution | every `mutate` logs `actor`; reports keep both `executor` (claimed in the text) and the history `actor` (who entered it) |
| Local only | store under user data; HTTP bound to 127.0.0.1 with bearer token; no sharing code |
| Accepted plan items never deleted | `removeItem` refuses accepted items; they are superseded |

### 1.5 Friction and defects found while reading (to confirm in Phase 0)

1. **No paste path for brainstorming** (see 1.3.1). ChatGPT/Gemini/Cowork users, who cannot connect, can only brainstorm outside
   the app and retype.
2. **Task stuck after a lease expires.** `createPackage` rejects any task whose status is not `todo`/`revision`. A task left
   `in_progress` by an expired claim has no visible "Reopen" (the button exists only for accepted/cancelled) and "Release claim" shows
   only while the claim is live. The workaround (cancel the package) is not discoverable. The service call to set it back to `todo` exists.
3. **Packages are manual and can churn.** Preparing the same tasks twice creates package 2 that supersedes package 1, even when
   nothing changed.
4. **Package -> executor is manual copy** and the Markdown is addressed to a machine, not a person.
5. **Everything is sent regardless of relevance**: all accepted requirements and decisions, scope, constraints and every reference
   asset go into every package (`snapshotOf`; `createPackage` wanted-assets). No summary of upstream accepted results for dependent tasks.
6. **Three places say "plan"/"workflow"**: Planner, Workflow graph, and `shared/projectPlan.ts` (the creative plan Claude proposes
   on Home; only its header was read, so *whether it overlaps the Planner needs confirming*). `AppRef.kind` already allows `'workflow'`
   and the task form parses `workflow:` values, but the form only offers native apps, so the link cannot be created from the UI.
7. Minor: a no-op line in `createPackage` (`if (t.status === 'revision') t.status = 'revision'`); the board maps `revision` into the
   To do column with no explanation.
8. Client status is only documented, not detectable: the app cannot tell whether Claude Code is "connected" (the client launches the
   server). The only honest signal is "this actor last acted at...", from history.

---

## Part 2. Design principles

1. **Re-skin and orchestrate; do not change the core.** Store, service rules, MCP tool names/schemas and the package/report formats
   stay. New code is (a) pure view-model functions, (b) a thin orchestration layer that calls existing service methods, (c) UI.
2. **Same four verbs for a beginner:** *Describe* the project, *Ask AI*, *Paste back*, *Approve*.
3. **Nothing an AI produces is ever applied without an owner click on a preview** (including the "Add to my plan" shortcut).
4. **Plain words in the UI, exact words in Advanced, history and MCP.**
5. **No new network calls, no automatic AI turns.** Send prepares text and (for OmniCandi Claude) pre-fills a prompt the user submits.

---

## Part 3. Proposed information architecture

### 3.1 Four areas (+ Advanced switch)

| Area | Contains (today's source) | Notes |
|---|---|---|
| **Plan** | Goal, brief, "Rules for the AI" (accepted requirements + decisions with reason), "Notes and questions" (ideas, references, questions as one list with a type chip), phases (milestones, collapsed), progress | Overview tab folds in here. Unanswered questions are shown first |
| **Tasks** | Board/list in 5 columns, add task (title only required; checks, priority, uses, waits-for under "More options"), inline review of results | "Needs Review" cards show the result in place |
| **AI** | *Send to AI*, *Paste back*, and the **Review inbox** (pending suggestions + results) | Replaces Handoffs. Connection setup is a collapsed "Connect an AI (optional)" |
| **Files** | Assets (references, working files, deliverables), link health | Unchanged logic |

A persistent strip at the top of every area, **"Needs you (n)"**, opens the Review inbox: one queue for pending proposals and
submitted reports. This replaces today's two badges (Plan, Handoffs).

**Advanced** (per-user switch, default off, remembered in localStorage like `cs-planner-project`): reveals the existing **History**
tab, **Packages** (list, supersede/cancel, hash, markdown/JSON/save files, manual creation), **Claims** (view, release), plan versions,
revision numbers, connection profiles/scopes/status table, export/import details. The current components are reused as-is for this.

### 3.2 Vocabulary map (UI only; stored values do not change)

| Today | Normal UI | Advanced UI |
|---|---|---|
| Proposal | Suggestion | Proposal |
| Execution package | "What the AI receives" / "Brief for the AI" | Execution package N |
| Claim / lease | "Claude Code is working on this" / "Stalled" | Claim, lease until |
| Report | Result | Report |
| Reported done, awaiting review | Needs Review | reported |
| Accepted | Done | accepted |
| Plan revision / drift | "The plan changed since this was sent" | plan v3 -> v5, drift list |
| Record revision conflict | "This changed while you were editing. Reload" | rev N vs M |
| Requirement / decision | Rule / Decision | same |
| Scopes | hidden ("Can read and report", "Can also suggest") | read/propose/package/execute |

### 3.3 Task statuses: a derived view, not a migration

The 7 stored statuses stay. A pure function `displayStatus(task, project, now)` returns one of the five labels plus an optional chip:

| Stored state | Shows as | Chip |
|---|---|---|
| `todo`, no package | To Do | "Waiting for <task>" if dependencies unmet |
| `todo` with open package, no live claim | In Progress | "Sent to AI, waiting for a result" |
| `revision` | To Do | "Changes requested: <note>" |
| `in_progress`, live claim | In Progress | "<Actor> is working" |
| `in_progress`, expired claim | In Progress | **"Stalled"** + one-click "Take back" (fixes 1.5.2) |
| `blocked` | Blocked | reason (progress note) |
| `reported` | Needs Review | outcome; "plan changed since" when drifted |
| `accepted` | Done | |
| `cancelled` | hidden; "Show removed" filter | Cancelled |

Dependency waiting stays a chip on To Do rather than Blocked, so Blocked always means "something needs a human".
Owner moves: To Do/In Progress/Blocked/Done are buttons (existing `setTaskStatus`). Needs Review is entered only by a result, never by
hand; the owner finishing work personally goes straight to Done (existing "mark done yourself", attributed to You).

---

## Part 4. Unified "Send to AI"

### 4.1 Flow

1. From a task ("Send to AI"), from the Tasks column header ("Send all ready"), or from the AI area.
2. **Pick the AI** (cards, no scope jargon):
   * *OmniCandi Claude* (in-app): pre-fills the Claude panel with "Work on the planner brief N"; the user presses send. Nothing starts by itself.
   * *Claude Code / Gemini CLI* (tools-capable, "last active <time>" from history, never "connected"): shows one short instruction to paste ("Use the OmniCandi planner tools: get_package pkg_..., claim, then report"), plus the full text as fallback.
   * *Anything else* (ChatGPT, Gemini app, Cowork, any chat): **Copy everything** (one button) = readable brief + how to answer.
3. The app calls the orchestration `prepareSend(taskIds, destination)`:
   * if an **open package with identical content hash** already covers these tasks and the plan has not drifted, **reuse it** (idempotent; kills churn);
   * otherwise `createPackage` exactly as today; if it replaces an older unclaimed package say so in plain words;
   * if a task has a live claim by someone else, stop with "Claude Code is already working on this" (existing `claimed` error).
4. Result screen: "Ready. Paste this into <AI>. When it answers, come back and press **Paste back**." Tasks move to In Progress / "Sent to AI".
5. Cancel/undo: "Unsend" = existing `cancelPackage` (tasks return to To Do).

### 4.2 What stays manual on purpose
Sending to a cloud chat needs the user's paste. No relay, no tunnel, no auto-start, no API call.

### 4.3 Safety
* Send never changes the plan and never starts work; it only calls `createPackage` (scope `package`, user ctx).
* Paths: the preview lists every local file path that will be copied; "Remove paths" (replace with titles) is offered for cloud chats.

---

## Part 5. Paste back and approve

One box, **"Paste what the AI said"** (AI area; also reachable from any task in In Progress).

1. **Classify** (local, deterministic, no AI): `classifyPaste(text)` -> `report` | `suggestions` | `unclear`. Report = existing `parseReportText` signals
   (`pkg_`/`task_` ids, "Work performed", JSON with `outcome`). Suggestions = JSON with `changes[]`/`op`, or Markdown headings
   Requirements/Decisions/Tasks/Questions/Ideas. `unclear` asks the user which it is.
2. **Preview** (nothing applied, nothing stored): plain-language list. For results: what was done, which checks passed/failed/not run,
   checks not mentioned, guesses made, and a **"plan changed since this was sent"** banner. For suggestions: each item with a checkbox, marked
   **"changes the plan"** (rule/decision/scope) or **"adds a task/note"**.
3. **Auto-matching:** package and task are filled when the text names them or when exactly one is waiting; else a single dropdown.
4. **Approve:**
   * Result -> "Save as result" (existing `importReport`; raw text kept) -> the task is **Needs Review** -> the same card offers
     *Accept as Done / Ask for changes / Reject*. Saving a result and accepting it are two deliberate clicks. An outdated result requires the
     acknowledgement checkbox, reworded: "I looked at what changed and accept anyway".
   * Suggestions -> "Add selected to my plan". Internally: new service method creates a pending Proposal (`source:'pasted'`, proposer = the
     stated AI or "Pasted suggestion", history actor = You) and then runs `decideProposal(accept, only=selected)` as the owner. Two history
     entries, both attributed, optimistic-concurrency conflicts surfaced in plain words. A "Save for later" button keeps it pending.
5. Direct connections feed the same Review inbox: their proposals and reports appear as items, identical to pasted ones.

Duplicate prevention is unchanged (report content hash). Pasted text is rendered as text only and cannot carry actions.

---

## Part 6. Context builder

New pure function in `shared/` (unit-testable, no I/O): `buildContext(project, request) -> { sections, included, omitted, text, size }`.
`request = { purpose: 'execute' | 'brainstorm' | 'review', taskIds, destination, budget }`.

| Purpose | Always | Included when relevant | Never |
|---|---|---|---|
| execute | goal, scope, constraints, deliverables; the selected tasks with checks/expected outputs; report instructions | accepted rules/decisions (all, unless over budget), task + reference assets, **accepted results of tasks it depends on** (titles + output paths) | ideas, unanswered questions as requirements, rejected/superseded items, other tasks' details, history, other proposals |
| brainstorm | goal, accepted plan in compact form, open questions, task titles only | milestones | reports, file paths |
| review | the task, its checks, the result, plan drift | | everything unrelated |

Rules that protect correctness:
* **Default is include-all** for accepted rules and decisions. Trimming starts only above a budget (per destination: small for chat, large
  for tools-capable clients that can read files), ranked by local text overlap with the tasks; "always include" is user-markable per rule.
* **Transparency:** the send preview shows "<n> rules included, <m> left out (list)". The owner can force-include. Omitted ids and titles
  are stored on the package, so a later reviewer can see what the AI did not receive.
* **Drift stays conservative:** `package.plan` keeps the full snapshot, so a change to an omitted rule can still flag work as outdated.
  The rendered brief uses a stored `delivery` view.
* No file contents are ever read or inlined; assets stay path/URL references.
* Cost: zero. No model is used to choose context.

Package format change: **additive optional fields only** (`delivery: { purpose, destination, includedIds, omitted: [{id,title}] }`, optional
`upstream` results). `get_package` keeps returning the same fields plus these. Existing packages remain valid; hashes of old packages are
unaffected (the hash is stored, not recomputed).

---

## Part 7. Planner, Workflow and the Claude panel: one clear split

| Thing | Owns | Does not own |
|---|---|---|
| **Planner** | *Intent and acceptance*: goal, rules, tasks, who asked for what, what the owner approved, history | how images/media are processed; AI conversations |
| **Workflow** | *Mechanics* of repeatable media pipelines (node graph, costs, run state, its own approval nodes and versions) | whether the result is accepted into the project plan |
| **Claude panel** | *A conversation and a worker*: it can edit, run workflows, and (read+execute only) work from Planner packages | a copy of the plan; any plan state |
| `projectPlan.ts` (Home "creative plan") | **To be confirmed in Phase 0.** If it overlaps, route "Plan a project" to the Planner and keep `projectPlan` only as a one-shot suggestion generator that outputs *suggestions* (never a second plan) | |

Single sources of truth: acceptance and plan state live only in the Planner; execution state of a graph lives only in the Workflow.
Links are by reference, never copies:
* A task may have `appRef {kind:'workflow', id}`. Phase 5 adds the missing picker. The task card shows the workflow's run state read-only.
* A finished workflow run does **not** accept a task. It may create a *result* (actor "OmniCandi Workflow", outputs listed) so the task
  becomes Needs Review, and the owner accepts it. Optional and last in the plan.
* The Claude panel stays a client of the same service (same four tools). Optional: add `planner_propose` (scope `propose`) so the panel can
  brainstorm into suggestions; it can never edit or accept. "Send to AI -> OmniCandi Claude" just pre-fills the panel.

---

## Part 8. What changes, what does not

### 8.1 Unchanged (code and behaviour)
`store.ts` (locking, atomic write, history), all of `service.ts` rules, `mcp.ts` tool names and schemas, `mcpMain.ts`, `planDrift`,
`reportDraftSchema`, `parseReportText` (reused), `packageToMarkdown` (extended, not replaced), export/import zip format v1, the
`claudePartner` planner tools, templates, assets, milestones, activity log.

### 8.2 UI to consolidate or hide
Tabs 6 -> 4 (+ Advanced). Overview -> Plan. Handoffs split: *Send* and *Paste back* and *Review inbox* in AI; Packages, Reviewed
history, Connect profiles, client-status table -> Advanced. History -> Advanced. Ideas/references/questions lists -> one "Notes and
questions". Revision/plan-version chips in the header -> Advanced. Task form: title only by default, rest under "More options".

### 8.3 Needs code
| Item | Kind | Risk |
|---|---|---|
| `displayStatus()` + labels | new pure fn, shared | low |
| 4-area shell, Advanced switch, Review inbox | renderer | low-med |
| `prepareSend()` (reuse-or-create package, destination text) | thin service wrapper over `createPackage`, user ctx | med (idempotency, concurrency) |
| `classifyPaste()`, `parseSuggestionText()`, `importSuggestions()` | shared parser + service method (`pasted` proposals) | med (misclassification) |
| `buildContext()` + package `delivery` / `upstream` fields | shared + service | med-high (correctness of omission) |
| "Take back" stalled task (service `setTaskStatus('todo')` already exists) | UI only | low |
| Workflow picker + read-only run status | renderer + small IPC | med |
| Optional MCP `get_context` tool and `planner_propose` for the panel | additive | low |

---

## Part 9. Compatibility with existing data and workflows

* **project.json:** no migration. Only new *optional* fields on packages. Unknown fields survive `mutate()` (JSON clone), so older builds and
  the shipped `planner-mcp.cjs` of an earlier version keep reading and writing the same files.
* **Existing statuses, ids, hashes, history lines:** untouched; the display map is read-only.
* **In-flight work** (open package, live claim, submitted report) shows correctly as In Progress/Needs Review and can be finished in
  either mode.
* **MCP clients/config snippets:** tool names, arguments and error codes unchanged; new tools are additive. Instruction text stays valid.
* **Exports:** version 1 stays. Imports of old zips must open in the new UI (fixture test).
* **Existing smoke script** (`smoke-planner.mjs`, screenshots 140-149) targets the current tab labels: it keeps working against Advanced
  mode with a one-line "switch to advanced" step; a Simple-mode variant is added.

---

## Part 10. What could break and how to catch it

| Risk | Test / mitigation |
|---|---|
| A state vanishes from view (revision, stalled, blocked, drifted) | exhaustive table test: every stored status x claim live/expired x package open/none x drift; assert a visible label and an available action for each |
| Send twice makes churn or duplicates | concurrency test with two processes sending the same tasks: exactly one open package; second call returns it; crash between create and copy -> re-Send reuses |
| Send supersedes someone's work | existing `claimed` rejection must surface as readable text; test with live claim from the MCP test client |
| Auto-everything weakens approval | invariant test: with every connection scope combination, run the full facade surface and assert `planRevision`, accepted items, and `accepted` task count never change; no new IPC/service method callable without `review`/`edit` |
| Pasted text misclassified or hostile (prompt injection, huge, truncated JSON, text instructing the app) | fixture corpus: valid/invalid JSON, Markdown variants, mixed, empty, 1 MB, script-looking text; assert preview never applies and rendering is text-only |
| Context builder omits a needed rule | default include-all test; golden outputs per purpose; test that omitted ids are stored on the package and shown; drift still computed on the full snapshot |
| Old data unreadable | golden fixtures generated from the **current** build (fresh, mid-claim, superseded packages, outdated report, imported project) loaded by the new UI logic and facade; round-trip an old export |
| Conflicts shown as raw errors while the 3 s refresh is running | UI test for each `PlannerError` code -> plain-language text; keep the user's draft on conflict |
| Existing 15 service tests, 5 MCP tests, smoke | must pass **unmodified** after every phase (they test the unchanged core) |
| Accessibility and non-technical comprehension | scripted first-run walkthrough: new user completes Describe -> Ask AI -> Paste back -> Approve -> Send task -> Paste result -> Accept, counting clicks and every unexplained word; screenshot docs refreshed |
| Cost | no code path in the new flow makes a network or model call; add a test that `prepareSend`/`classifyPaste`/`buildContext` import no network or SDK modules |

---

## Part 11. Phased plan (each phase shippable and revertable; Advanced keeps the old UI until Phase 6)

**Phase 0: baseline (no behaviour change).** Run the existing planner test suites and smoke on the current tree; create golden
fixtures from the current build; confirm items 1.5.1-1.5.8 (especially the `projectPlan.ts` overlap and the stuck-task case); decide the open
questions below. Exit: green baseline and fixtures committed.

**Phase 1: vocabulary, statuses, shell.** `displayStatus`, label map, 4-area shell, Advanced switch, "Needs you" strip. Reuse every
existing component under Advanced. No service change.

**Phase 2: tasks and review inbox.** Five-column board with chips and plain actions, "Take back", inline result review, merged
proposal+result queue, readable errors. Still no service change.

**Phase 3: Send to AI and Paste back.** `prepareSend` (reuse-or-create), destination cards, one-click copy, `classifyPaste`,
suggestion paste -> pending proposal -> owner accept, path redaction option. Concurrency and hostile-paste tests land here.

**Phase 4: context builder.** `buildContext`, send preview "what the AI will see", additive package fields, upstream results, optional MCP `get_context`.

**Phase 5: Planner / Workflow / Claude panel.** Workflow picker and read-only run status, panel pre-fill, optional `planner_propose` for the
panel, optional "workflow run -> result for review". Resolve `projectPlan.ts` per Phase 0.

**Phase 6: finish.** Update `project-planner.md` and `planner-explained.md`, smoke in both modes, refreshed screenshots, remove dead
UI only if Advanced no longer needs it, first-run walkthrough with a non-technical tester.

---

## Part 12. Decisions needed from you (recommended default first)

1. Advanced switch default: **off for everyone, remembered** (alternative: on when the app is in Advanced navigation mode).
2. `partial` results: **show In Progress with a "Partly done" chip, not Needs Review** (current behaviour), so Needs Review always means "claims complete".
3. Give the Claude panel `planner_propose`: **yes, scope `propose` only** (alternative: keep it execute-only).
4. Reuse an identical open package on Send: **yes** (alternative: always create a new numbered package).
5. Context trimming: **include-all by default, budgeted trimming only for chat destinations, always visible** (alternative: never trim).
6. Workflow run completing creates a result for review: **defer to the end of Phase 5, owner accepts**.

---

## Part 13. Phase 0 results (done)

Decisions in Part 12 were approved with the recommended defaults.

**Baseline.** `npx vitest run src/main/planner src/shared/navigation.test.ts` before any change: 4 files, 23 tests, all pass.
Not run: the full `npm test`, `npm run smoke:planner` (builds and launches Electron) and lint. Typecheck of the new test file: no errors reported for it.

**Added (tests only, no product code changed):**
* `src/main/planner/baseline.test.ts`: loads four golden fixtures and pins the findings below. With `GEN_PLANNER_FIXTURES=1` it rewrites the fixtures.
* `src/main/planner/__fixtures__/{fresh,mid-claim,outdated-report,superseded}.project.json`: made by the current build. Each must load, summarise, give context, keep the "task is only in an open package" invariant and still accept a write.
* After the change: `npx vitest run src/main/planner` = 4 files, 29 tests, all pass.

**Findings confirmed or corrected**

| # | Result |
|---|---|
| 1.5.1 | Confirmed. Nothing in the UI creates a `pasted` proposal; a connection without `execute` is refused for that source |
| 1.5.2 | Confirmed. A task left `in_progress` by an expired claim is refused by `createPackage` (`blocked`); the owner can set it back with `setTaskStatus('todo')`, which the UI never offers. (My first probe failed only because I left the fake clock off the store.) |
| 1.5.3 | Confirmed, with a **correction to the plan**: re-preparing identical tasks gives a new package with a different `contentHash`, because the hash includes the package `number` and `supersedes`. Reuse in Phase 3 must use a separate content key (plan, tasks, assets, objective, note) that excludes those. The plan and tasks themselves are equal |
| 1.5.5 | Confirmed. Every accepted requirement goes into every package, whatever the task |
| 1.5.6 | Resolved. `projectPlan.ts` is a separate one-shot Claude call (`planProject`, Home "Plan a project") returning a throwaway creative plan: name, kind, finished output, apps, AI tools, up to 8 steps, up to 3 questions, a template hint. It is **not stored in the Planner**, so there are two plan concepts. Phase 5 decision: make its result a *suggestion* (steps become suggested tasks, questions become questions) fed through the same approval path, instead of a second plan. It does make a paid Claude call today, outside the Planner |
| 1.5.7 | Confirmed no-op line in `createPackage`; harmless, leave until Phase 3 |
| 1.5.8 | Confirmed: no connection-state signal exists; "last active" from history is the only honest one |
| owner-only | A connection holding all four scopes is refused `addItem`, `decideProposal`, `reviewReport`; `edit` cannot be granted. Now a standing regression test |

**Next:** Phase 1 (vocabulary, status view, four-area shell, Advanced switch). Not started; waiting for your go-ahead.

---

## Part 14. Phase 1 results (done)

**Added**
* `src/shared/plannerView.ts`: `displayStatus()` (the five plain labels with chips: working, stalled, partly done, sent to AI, waiting for X, changes requested, plan changed), `SIMPLE_LABEL`, `needsYou()`. Pure and read-only; nothing stored changed.
* `src/main/planner/plannerView.test.ts` (5 tests, includes the golden fixtures): every stored status maps to one of the five labels, cancelled is flagged removed, stalled and partly-done are distinguishable, dependency waiting stays To Do, old fixtures display correctly.
* Planner UI: a **plain view by default** with four areas (Plan, Tasks, AI, Files) and an **Advanced** checkbox (remembered as `cs-planner-advanced`) that restores the original six tabs and the revision chips. The plain Plan area is Overview + Plan stacked; AI is the existing Handoffs screen; Files is Assets. A **Needs you** strip (results to review, suggestions, stalled tasks) shows in the plain view. Task chips and the board use the five labels; "Show removed tasks" is a checkbox.
* `scripts/smoke-planner.mjs`: asserts the four areas and hidden revision chips, then ticks Advanced so the original assertions run unchanged. New screenshot `docs/screenshots/150-planner-plain.png`.

**Not changed:** service, store, MCP, packages, reports, export format, any existing test.

**Verification (all local, no network, no paid calls)**
* `npx vitest run` (whole repo): 74 files passed, 13 skipped; 661 tests passed, 62 skipped. The skips were already in the repo; I did not look into why.
* `tsc` for the web and node projects: no errors. ESLint on the touched planner files: clean.
* `npm run smoke:planner` (real Electron window + real MCP executor): ALL PASSED, including the 2 new plain-view checks.

**Known rough edges left for Phase 2/3 (by design, not forgotten)**
* The plain Plan area is still long and keeps developer words in places ("accepted by you", "Prepare a handoff", Handoffs-screen section titles, package numbers in review cards). The AI area is the old screen until Phase 3.
* "Stalled" is shown and counted but has no "Take back" button yet (Phase 2).
* The Needs you strip links to two screens; the single review inbox is Phase 2.
* Only the plain view's task chips are re-worded. Smoke does not yet click through the plain Tasks board.

---

## Part 15. Phase 2 results (done)

**Plain view changes** (Advanced is unchanged except where noted)
* **Tasks:** a task in the plain view has plain actions: *Take back* (a live claim, a stalled claim, or a partly-done task, which puts it back on To Do so it can be sent again: fixes finding 1.5.2), *Unblock*, *Unsend* (cancels a brief nobody has started, shown only when no other task in that brief has been claimed, reported or started, because cancelling a package also drops other tasks' claims), *Mark done*, *Remove* / *Bring back*. Check "kind" chips and claim/lease text are hidden. The board has the five plain columns.
* **Inline result review:** a Needs Review task shows its result card (what was done, checks passed/failed/not reported, outdated warning, Accept as done / Ask for changes / Reject) right under the task.
* **One inbox:** the AI area opens on **Needs you**: stalled tasks, results to review and suggestions in one list. The old duplicate "Suggested changes" card on the Plan page and the Overview "Needs you" box are hidden in the plain view (the strip links to the inbox). `ProposalCard` moved into `PlannerWork.tsx` unchanged.
* **Readable errors:** `plainError()` (in `shared/plannerView.ts`, 1 new test) rewrites the common service messages (changed while editing, already being worked on, result waiting, sent again since, plan changed, already decided) and leaves unknown ones unchanged. Used only when Advanced is off. The user's typed text is never cleared on an error (forms reset only on success).
* Overview wording: "tasks done / waiting for your review"; "Send to AI…" instead of "Prepare a handoff…"; Recent activity moved to Advanced.

**Unchanged:** service, store, MCP, packages, reports, formats, every existing test.

**Verification (local only)**: whole-repo `vitest`, `tsc` (web and node), ESLint on planner files, and `npm run smoke:planner` (real window plus MCP executor) all green, including 4 new plain-view checks (five columns, Done, Changes requested, single inbox). Screenshots `150-` and `151-`.

**Not covered yet**
* No automated UI click-through of the plain inline Accept / Take back buttons: Take back reuses the already-tested `setTaskStatus('todo')` path (baseline probe 1.5.2), but the button itself and the Unsend guard are untested in the browser.
* The Send/Paste screens are still the old Handoffs sections below the inbox (Phase 3). The word "package", "report" and "handoff" still appear there and in review cards.

---

## Part 16. Phase 3 results (done)

**Send to AI**
* `PlannerService.prepareSend()`: same rules as `createPackage` (the body was split into shared helpers; `createPackage` behaves as before and its `contentHash` is computed exactly as before). It returns an identical open package instead of making a superseding one. "Identical" uses a new optional `contentKey` on the package (accepted plan, tasks, assets, objective, note; **not** number, id or time), set after `contentHash` so the old hash is untouched. Tasks are put in project order so the same selection always gives the same key. It runs in one locked step.
* The Phase 0 correction was needed: the stored `contentHash` includes the package number, so it cannot be used to recognise a repeat.
* Plain AI area: pick tasks (a task's own **Send to AI** button opens it ticked), pick **who** (OmniCandi Claude / Claude Code or Gemini CLI / any chat), one button, then one **Copy** button. Shows "same brief as before" or which earlier brief it replaces, a list of local file locations with **Remove file locations** (on by default for chats), and **Unsend**. "Last seen" for tool clients comes from history only; the app does not claim a connection it cannot see.
* OmniCandi Claude: **Put it in the Claude panel** fills the panel's box through a window event; the user presses Send (nothing starts by itself). If the panel is closed, Copy still works.

**Paste back**
* `classifyPaste()` decides result / plan suggestions / unclear, locally. Suggestions are read from JSON (`changes`, or `tasks`, `requirements`, `decisions`, `questions`, `ideas`) or Markdown lists under those headings (indented lines under a task become its checks, flagged as a guess). Limits: 200,000 characters, 30 changes, 200-character titles.
* Suggestions are shown with **changes the plan** (rule or decision, or an edit) versus **adds to your list**. **Add selected to my plan** stores a pending `pasted` proposal (`importSuggestions`, owner-only) and then runs `decideProposal` with the ticked items as the owner: two history entries, both by You, the AI named as proposer. **Save for later** stops after the first. The original text is kept next to the proposal. A conflict with something edited since is refused, not merged.
* Results go through the existing `importReport` path: the task becomes Needs Review and Accept is a separate click (inline on the task, or in the inbox).

**Tests added** (`src/main/planner/send.test.ts`, 16): reuse and replace, two service instances sending at once leave exactly one package (this **caught a real bug**: order of selected tasks changed the key; fixed), restart reuse, live-claim refusal, packages without a key, `contentHash` unaffected, permission checks, pasted proposal stays pending and attributed, no connection can import or decide, conflict refusal, classification, hostile corpus (invalid ops, prototype keys, truncated and deeply nested JSON, 100 tasks, 80 changes, HTML, control characters, 200k+ characters, text addressed to the app), path removal, and a source scan showing the send/paste/view code and the service make no network or AI calls.

**Unchanged:** store locking, MCP tools and schemas, report format, export format; every earlier test passes unmodified. Advanced view is as before (its paste box keeps its old label). One additive store change: `readRaw` also reads `prop_` files.

**Verification (all local, no paid calls):** whole-repo vitest 678 passed / 62 skipped (pre-existing skips); `tsc` web and node clean; ESLint clean; `npm run smoke:planner` ALL PASSED, including new plain-view checks: one-click brief, repeat send reuses it, suggestion preview, saved suggestion not in the plan until accepted, accepted rule appears in the plan, pasted result lands in Needs Review, inline accept moves it to Done. Screenshots `152-planner-send.png`.

**Not verified / known gaps**
* "Put it in the Claude panel" was not exercised (the panel needs a Claude sign-in); only Copy is covered.
* The in-panel `Unsend` for a package with several tasks and the "Take back" buttons have no browser test.
* Old Handoffs sections (Packages, manual package creation, reviewed reports) are now Advanced-only in the plain view; "Connect an AI directly" is a collapsed block there.
* The brief text still contains "package" and "report" words, because external AIs and the MCP tools use them.
* `createPackage` still allows tasks to replace each other's packages silently (Advanced). `prepareSend` reports what it replaced.

---

## Part 17. Phase 4 results (done)

**Added**
* `src/shared/plannerContext.ts`: `buildContext()` (pure, local): all accepted rules and decisions are included by default. Only chat destinations have a budget (6,000 characters of rules); above it, rules are ranked by plain word overlap with the chosen tasks and kept until the budget is used. Tools that can read files (Claude Code, Gemini CLI, OmniCandi Claude) get everything. Left-out rules are always listed and the owner can put any back for this send. Ideas, open questions, rejected items, other tasks and history are never part of it. `upstreamResults()` adds the accepted result (summary and output list) of each task a task depends on. `brainstormText()` builds a short request for ideas.
* Package: optional `delivery` (`includedIds`, `omitted`, `upstream`, destination, budget) stored by `prepareSend` when a destination is given. `plan` keeps the **full** snapshot, so a change to a left-out rule still marks work as outdated. `contentKey` now covers what the AI receives, not the destination, so the same content for another AI is the same brief (no needless "replaced" notices). `createPackage` and MCP `create_execution_package` are unchanged (no `delivery`, every rule listed).
* The brief text lists only the carried rules, then "Not included here (ask the owner if one might matter): ...", then "Results of earlier tasks you can build on". Upstream file locations are covered by the file-location list and by removal.
* Plain AI area: the send preview says "The AI will see N of your M agreed rules" with the left-out list and tick boxes, and which finished results it gets; a new **Ask an AI for ideas** block copies the request that goes with Paste back (completes the Describe, Ask AI, Paste back, Approve loop).

**Decision: optional MCP `get_context` tool not added.** The existing MCP tests assert the exact read-scope tool list (5 tools, in two places); any new tool breaks them, and the rule was to keep them unmodified. The built brief is already available to connected tools through `get_package` (markdown and `delivery`). Say if you want the tool and the two assertions updated.

**Not done:** a `review` purpose (no screen needs it yet); a stored per-rule "always include" pin (only a per-send override exists; a pin would need a field on rules and an edit control).

**Tests** (`context.test.ts`, 8): include-all by default and nothing unaccepted; budget only for chat, related rules first, left-out list, put-back; brief carries and states the omission while drift still detects a left-out rule changing; same content for another AI reuses the brief; upstream result passed on only after the owner accepted it, path listed and removable; `createPackage` unchanged; brainstorm text excludes ideas, file locations and task details; no network or AI calls in the builder.

**Verification (local, no paid calls):** whole-repo vitest 686 passed / 62 skipped (pre-existing); `tsc` web and node clean; ESLint clean; planner smoke ALL PASSED (+2 checks). Earlier tests unmodified.

**Limits to know:** word overlap is crude (for example "invoice" does not match "invoices"). It only decides order when a chat brief is over budget, and nothing is dropped silently. The 6,000-character chat budget is a guess, not measured against any model.

---

## Part 18. Phase 5 results (done)

**Planner and Workflow**
* A task can point at the workflow of the open OmniCandi project: the "Uses" list gets *The workflow of <project>* (stored as the existing `appRef {kind:'workflow', id: <project key>}`; no data change). The task shows a **Workflow** chip and one read-only line from the existing run state ("Not run yet", "Running: 2 of 5 steps done", "Waiting for you in the Workflow tab: ...", "The last run finished ... mark the task done yourself or send it for review"). For another project's workflow it says to open that project. The line never starts, approves or accepts anything.
* Only the open project's workflow has a live state in the app (there is one run monitor), so no status is shown for other projects.
* **Not done (kept optional and last, as planned):** a finished run creating a result for review. A run still never changes a task by itself.

**Home "Create with Claude" and the Planner**
* Finding from reading the code: Home's plan creates a *OmniCandi project* (folder, brief, workflow template). It was never stored in the Planner, so there was no second *plan* to merge; the overlap was the steps and questions. Now, on **Approve and create project**, a tick box (on by default, worded "Also keep these steps in the Planner as suggestions...") calls `createFromHomePlan`: a new Planner project (title, goal = finished output) with **one pending proposal** (source `home`, proposer "OmniCandi Claude", up to 8 steps as tasks, up to 3 questions). Nothing joins the plan until you accept it under Needs you; you can leave steps out. Unticked: nothing is created in the Planner. The paid Claude call that makes the plan is unchanged and still happens only when the user presses Create with Claude.

**OmniCandi's Claude**
* New tool `planner_propose` (the panel's session now holds `read, propose, execute`). It uses the MCP `propose_changes` path, so the result is a pending proposal attributed to "OmniCandi Claude". It cannot create packages, edit the plan, accept or review (tested: `create_execution_package` is refused, no tool name contains accept/review/decide/edit/delete, and the panel code only calls six named planner tools). The system prompt says so.

**Tests** (`links.test.ts`, 5): Home plan becomes pending suggestions and accepting leaves the plan revision unchanged; cap and clean-up, connection refused, empty plan refused; panel session proposes but cannot package or decide; source scans pin the panel's allowed tool calls and scopes; workflow run wording. Smoke: new check that a task can point at the workflow and shows its state read-only.

**Verification (local, no paid calls):** whole-repo vitest, `tsc` (web and node), ESLint, and the planner smoke. See the end of this section for counts.

**Honest notes**
* The Home flow end to end (the tick box and `createFromHomePlan` from the real Home screen) was **not** exercised: the screen needs a paid Claude call to produce a plan. Only the service method and its permission rules are tested.
* `planner_propose` was not run against a live Claude session (paid).
* The smoke script failed once with a 30 s click timeout (window on Home) and then passed four times in a row; I did not diagnose that one failure.
* `claudePartner.ts` already had uncommitted changes of yours before I started; my edits there are the import, the tool list entry, the prompt sentence and the new tool.

**Final counts for Phase 5:** vitest 77 files passed / 13 skipped, 691 tests passed / 62 skipped (pre-existing skips); `tsc` web and node and ESLint clean; planner smoke ALL PASSED (3 of 3 reruns after the one failure above).

---

## Part 19. Phase 6 results (done) and final state

**Done**
* `docs/project-planner.md` and `docs/planner-explained.md` updated to the plain view, Send to AI, Paste back, the context builder, Workflow and Home links and OmniCandi's Claude (`planner_propose`). `README.md` Planner paragraph updated. `docs/planner-explained.md` no longer lists "where it is too complicated"; that history is in this file.
* New `docs/planner-first-run-checklist.md`: the hands-on walkthrough (14 tasks, what to watch, pass criteria, what it cannot cover). **It has not been run with anyone.** Whether a non-technical person can use the Planner unaided is therefore **unproven**; the automated tests cannot show it.
* Dead code removed: the unreachable plain branch in the Advanced Handoffs screen. Small polish found by looking at the screenshots: on the plain board the status label is no longer repeated in its own column (only the explanation, such as "Waiting for ..." or "Changes requested", remains), the "normal" priority chip is hidden, and long explanations wrap instead of being cut off.
* Hardening found while documenting: `importSuggestions` now validates its changes itself (invalid operations and more than 30 changes are refused) instead of trusting the renderer; 1 new test.
* Screenshots refreshed by the smoke run: `140`-`154` (new: `153` plain board, `154` task pointing at the workflow).

**Final verification (local, no paid calls)**
* `npx vitest run` (whole repo): 77 files passed, 13 skipped; 692 tests passed, 62 skipped (the skips pre-date this work and were not investigated).
* Planner folder: 65 tests in 8 files. The original suites (service 15, MCP session 2, MCP round trip 3) pass unmodified.
* `tsc` for web and node: no errors. `eslint src scripts`: clean. `npx eslint .` reports 186 errors, all from the generated, git-ignored `out/` bundle that the smoke build writes (for example `process is not defined` at line 21284 of a built file); I did not change that configuration.
* `npm run smoke:planner` (real Electron window plus a real MCP executor): ALL PASSED on the last run.

**Files this work touched**
New: `src/shared/{plannerView,plannerSend,plannerPaste,plannerContext}.ts`, `src/renderer/src/planner/PlannerSend.tsx`, `src/main/planner/{baseline,plannerView,send,context,links}.test.ts`, `src/main/planner/__fixtures__/*` (4), `docs/planner-first-run-checklist.md`, `docs/planner-simplification-plan.md`.
Changed: `src/main/planner/{service,store,ipc}.ts`, `src/shared/{planner,plannerApi,plannerHandoff}.ts`, `src/preload/index.ts`, `src/main/{claudePartner,ipc}.ts`, `src/renderer/src/planner/{PlannerWorkspace,PlannerWork,plannerUi}.tsx`, `src/renderer/src/components/{HomeWorkspace,ClaudePanel}.tsx`, `src/renderer/src/styles.css`, `scripts/smoke-planner.mjs`, `docs/{project-planner,planner-explained}.md`, `README.md`, 14 screenshots. `claudePartner.ts`, `ipc.ts` (main) and `styles.css` already had uncommitted edits of yours; mine are limited to the lines described above. **Nothing is committed or pushed.**

**Requirement check**
| Requirement | State |
|---|---|
| Owner only approves | Unchanged rules; tested for every new path (no connection scope, panel session or import can edit, accept or review) |
| AI results never silently change an accepted plan | Pasted and Home suggestions are pending proposals; results wait in Needs Review |
| Full history and attribution | New actions log the owner and name the AI as proposer |
| Stale-work, concurrency, duplicates, crash safety | Core untouched; the two-writers test found and fixed an ordering bug in the new reuse key |
| Local by default, no new API cost | No network or model code in the new modules (source-scanned); only Home's existing Create with Claude makes a paid call |
| Compatible with old plans, packages and MCP tools | Additive optional fields only; golden fixtures from the earlier build load and write; MCP tools unchanged (the optional `get_context` was left out to keep the tool-list tests unmodified) |
| No sharing or marketplace | None added |

**Not verified**: the first-run walkthrough with real users; Home's Create with Claude into the Planner from the real screen; `planner_propose` and "Put it in the Claude panel" in a live Claude session; any live ChatGPT, Gemini, Cowork or Claude Code connection.


---

## Part 20. Planning chat beside the brief (added after Phase 6)

**Why:** a request to chat with an AI inside the Planner, next to the Project brief, and to choose which AI, using the OpenAI and Google keys already saved. This reverses the earlier "copy and paste only" stance for planning, so the safeguards below were chosen to keep the original rules.

**Built**
* `src/shared/plannerChat.ts`: the providers, limits (24 messages, 6,000 characters each, 3,000 reply tokens), the instructions the AI is given (suggest only; never say the plan changed), the starter message.
* `src/main/planner/chat.ts`: `PlannerChat` with an injected `fetch` and key vault: OpenAI `chat/completions`, Gemini `generateContent`, and Claude through a new `ClaudePartner.planChat` (one request, no tools, no files, the existing sign-in). Model lists come from each provider's own models endpoint (no model id is guessed); only models that can chat are offered. Errors are plain and have the key removed even if the provider echoes it.
* Three Planner calls (`chatProviders`, `chatModels`, `chat`) on the existing channel. The chat call builds the system prompt in the main process from the stored plan, so the page cannot add file paths or other data.
* `PlannerChat.tsx` beside the brief: AI and model pickers, cost note, offer after Save, messages, and the same tick-box suggestions as Paste back (add or save for later).

**Safeguards that keep the earlier rules**
* No automatic call: Save only shows an offer; a request needs a button press. (Recommended default; say if you want it automatic.)
* The chat code cannot write a plan: source scan in the tests, and the Planner calls it adds contain no edit, accept or review call. Suggestions go through the same `importSuggestions` and `decideProposal` as Paste back.
* The AI sees only the short plan summary, never file locations, ideas or task details. Cost is bounded by the limits above.
* The OpenAI and Google keys are used inside the main process only, as for images.

**Verification (local; providers faked, no paid call):** `chat.test.ts` (12): what the AI is told and not told, suggestion reading, history and reply limits, OpenAI and Gemini request shapes (key only in the header, never in the URL or body), Claude model check and no HTTP, rejection of a model name that could alter the address, key redaction, live model-list filtering, ready states, and a source scan. Smoke: the chat sits beside the brief, offers Claude first, and saving the brief only offers help (no message sent). Whole repo 704 passed / 62 skipped; `tsc` and `eslint src scripts` clean; smoke ALL PASSED.

**Not verified:** a real conversation with Claude, OpenAI or Gemini. The OpenAI and Gemini request formats follow the providers' standard text endpoints but were never called with a real key here (that would be a paid call). If a provider rejects a request, the chat shows its message. Models listed by a provider that cannot actually chat may appear; pick another.

**Limits:** the chat is not saved with the plan; there is no streaming; the answer arrives whole. "Putting the plan into action" is unchanged: Tasks > Send to AI, then Paste back.

**Layout follow-up:** the chat now takes the right half of the Plan area up to the window edge and matches the brief's height; the cost and privacy note is collapsed under "Cost and privacy" (a missing key stays visible because it needs action); the message box is a rounded box with Send inside at the bottom right, Enter sends and Shift+Enter adds a line (like the Claude panel). Checked with tsc, ESLint on the planner folder and the planner smoke (ALL PASSED); the full test suite was not re-run for this layout-only change.

**Second layout follow-up:** the chat is only as tall as its content (the empty space above the message box is gone; messages scroll inside it once it reaches the window height), and it is pinned to the top right of the Plan screen while the plan on the left scrolls (the plan, including the overview, is the left column; the chat is the right column). Two new smoke checks measure both (gap 8 px; after scrolling 1,360 px the chat is still at the top of the scroll area). Screenshots `155` and `156`.

# Planner and OmniTown: make the General Manager the front door

Written 2026-10-29. This is a plan to review, not a build. It is grounded in the code and in screenshots of the running app taken the same day (Studio, Work and the General Manager's talk panel on a fresh sample project). Where something is a guess it says so.

Highest priority: simplicity for someone who has never used project software, AI agents or code. Second: honesty. A picture of someone working must mean something is really running. Third: do not rebuild what works.

## 1. What the current experience is like (from the screenshots and code)

**What already works well, keep it**
- Studio's empty state asks "What do you want to make?" in plain words, with one text box. Good front door.
- The AI's chunk list with tick boxes, shown as dashed cards you add yourself, is the right approval model.
- "Next:" line above the canvas tells you what to do. Keep it.
- Owner-only approval is enforced in code, not just in the interface.

**What is confusing**
1. **Three names and two conversations for one person.** Studio's chat is "the coordinator" ("Talk to the coordinator" button, "Next: Tell the coordinator…"). In the town the same person is the **General Manager**. The code makes them one worker (the old coordinator became the General Manager), but they have **separate conversations**: Studio saves to `chat`, the General Manager's card saves to `chat-<agentId>` (`src/main/planner/store.ts`, `chatName`). Talk to one and the other has never met you. The Studio chat also uses a different system prompt (`chatSystemPrompt`) from a worker chat (`agentSystemPrompt`) (`src/main/planner/ipc.ts`, `chat`).
2. **"Talking with Claude · claude-opus-5-5"** sits under the box. A beginner should never need to pick a provider or model to say hello. It is collapsed but still the first technical thing on screen.
3. **A dead end on the Work tab.** An empty Work tab says "Break your idea into chunks in Plan first" with a **Go to Plan** button (`PlannerWork.tsx:389`). In Simplified mode there is no Plan tab, and the workspace resets any tab not in `SIMPLE_TABS` back to OmniTown (`PlannerWorkspace.tsx:73`). I expect the button to land on the town, not a plan. (Not clicked in the app; worth a 2 minute check.)
4. **Work means copy and paste.** The Work tab's only way to get a result is "Paste what the AI said". The Send panel prepares text and copies it; nothing is started. Starting work from the Planner is explicitly stubbed (`dispatch` throws "not available yet" in `src/shared/plannerCoordination.ts`).
5. **The canvas starts heavy.** A lone "PROJECT Sample Project" card, Canvas/Board/List, Tidy up, "0 of 0 done", zoom controls and a mini-map, all before anything exists.
6. **The town and the plan do not know each other.** Directors wander and visit at random. Nothing links a director to a task, so the town can neither show real work nor go anywhere on purpose.
7. **The General Manager is a talker, not yet a guide.** Its prompt says "You do not do the work yourself yet". It is told the team and the plan, but not what applications are connected, nor to recommend a team, nor a script for a first conversation. `townSuggestFromPlan` suggests a team without AI, but only from tasks that already name an application.
8. **Outside the Planner**, the Media panel and Activity log take a lot of the screen. Not part of this plan; mentioned for completeness.

## 2. The journey, in the owner's words

1. Open a project. The Planner opens ready to talk (first time) or where you left off.
2. A greeting from the **General Manager** (portrait, name, one box): "What do you want to make?"
3. You say "a game about dragons". The GM asks at most two questions at a time, then says back what it understood.
4. A plan appears as dashed cards on the canvas while you talk. Nothing is real until you press Add.
5. The GM recommends who should do what, in plain words ("Creative Director: dragon concept art; Technical Director: the game itself"), and which connected apps they would use.
6. You approve **one chunk at a time**: a button that says **Do this**, with what it will use and a spend limit if any.
7. The chosen director shows **working**. When the result is back they show **!** (needs you).
8. You read the result and press **Looks good**, **Change this** (with a note) or **Not this**.
9. Repeat until the last chunk is Done.

## 3. What exists, what is partial, what is only proposed

| Piece | State | Where |
|---|---|---|
| One plan per project, rules, tasks, claims, reports, history | **Exists, tested** | `src/shared/planner.ts`, `src/main/planner/service.ts` |
| Owner-only editing and accepting (scopes) | **Exists** | `Scope` in `planner.ts`; `connectionCtx` |
| Planning chat that produces chunks you tick | **Exists** | `PlannerChat.tsx`, `shared/plannerChat.ts` |
| Canvas of suggestions (dashed cards) | **Exists** | `StudioTab.tsx`, `ProjectCanvas.tsx` |
| Nine directors, assistants, offices, Town Hall, meetings as records | **Exists** | `shared/town.ts`, `TownTab.tsx` |
| Director chat with their own job and the team in the prompt | **Exists** | `agentSystemPrompt` in `town.ts` |
| Team suggestions from the plan without AI | **Partial** (needs `appRef` on tasks) | `townSuggestFromPlan` |
| The same coordinator in Studio and in the town | **Missing** (two conversations, two prompts) | section 1, item 1 |
| In-app Claude can claim a package task and report | **Exists** | tools `planner_claim`, `planner_report` in `claudePartner.ts` |
| Destination "OmniCandy's Claude" fills the Claude panel for you to send | **Exists** | `PlannerSend.tsx` |
| Per-run limits for an agent (turns, tool calls) | **Exists** | `src/shared/agentBudget.ts` |
| Apps the Planner could use for a task (`CapabilityPort`) and starting a run (`ExecutionPort`) | **Interfaces only, null implementations** | `plannerCoordination.ts` |
| Task owner (which director) | **Missing** | needs a field on `PlanTask` |
| Truthful "working" and "!" | **Missing** | section 5 |
| Directors visiting each other | **Exists, random and decorative** | `TownWalker.tsx` |
| Visits on purpose | **Missing** | section 6 |
| AI meetings | **Missing** (a meeting is a record; starting one calls no AI) | section 7 |
| Animations free of AI cost | **Exists** (pure rendering) | `TownWalker.tsx` |

## 4. Plan: small steps, simplest first

Each step ships on its own, can be reverted, and has a test that proves it. Stored data stays compatible: every new field is optional.

### Step 1. One General Manager, one conversation (no new AI behaviour)
Goal: Studio and the town talk to the same person, who remembers you.
- **Studio chat becomes the General Manager's chat.** `StudioTab.tsx` passes `agent={{ id: gmId, name: 'General Manager' }}` to `PlannerChat`. The GM is `town.agents.find(a => a.director === 'general-manager')`; read it with the existing `townLoad`.
- **Keep old history.** In `PlannerStore.readChat(id, who)`: when `who` is the GM's id and `chat-<id>` does not exist or is empty, return the old `chat` file. New messages go to the GM file. No deletion.
- **One prompt.** In `ipc.ts` `chat`: when the agent is the General Manager, keep today's planning-chat rules (the READY marker and chunk format) inside the GM prompt, so Studio does not lose "Ready to start building?". Concretely: `agentSystemPrompt` adds the planning-chat instructions when `agent.director === 'general-manager'`. `chatSystemPrompt(plan, context, mode)` stays for the `make-plan` request mode.
- **Words.** Replace "coordinator" in owner-facing text with "General Manager" (`StudioTab.tsx`, `TownTab.tsx` button "Talk to the General Manager", the Next line in `shared/projectView.ts`). Show the portrait beside the chat title. Hide provider and model under a "How it talks" disclosure that stays closed unless nothing is ready to use.
- **Fix the dead end.** In `PlannerWork.tsx:389`, the empty Work tab says "Ask the General Manager to make a plan" and goes to Studio, not `tasks`.
- **Tests.** A chat-store test that the GM's first read returns old `chat` messages and a new message lands in the GM file only. A `townAgents` test that the GM prompt contains the READY marker instruction. A render test for the Work empty state.
- **Done looks like:** say hello in Studio, open the General Manager in the town, and the same conversation is there.

### Step 2. A General Manager who actually guides (AI cost only when you send a message)
Goal: "I want to make a game about dragons" leads somewhere useful with no setup.
- **Prompt, not code.** Extend the GM part of `agentSystemPrompt` (`shared/town.ts`) with a short script: (1) understand in at most two questions at a time, (2) say back what you understood in two sentences, (3) offer a first brief, (4) when ready, offer chunks in the existing `CHUNK_FORMAT`, (5) after chunks, say which director and which connected app fits each, in plain words, and (6) never claim anything is done.
- **Give it the facts it lacks.** Add one line to the context the GM receives (`pp.chatContext` in `projectPlanner.ts`): which apps are connected (names only, from the integrations list the Software Director already draws on). Names and counts only, no file contents, consistent with the existing rule.
- **Use what exists.** After chunks are added, the existing `townSuggestFromPlan` already turns task `appRef`s into team suggestions. The GM's chunk format gains an optional "App:" line that the importer maps to `appRef` (the field exists on tasks). No new data model.
- **Tests.** Prompt tests (the script and context lines are present, no secrets, bounded size). A `chunkPlan` test for the optional app line. Everything runs with no AI.
- **Done looks like:** a dragon-game conversation ends with chunks on the canvas and a suggested team, in under ten messages, with no settings touched.

### Step 3. Who owns which chunk (the one data change)
Goal: a task knows which director is responsible, so the town can show real activity.
- Add `assignee?: DirectorKey` to `PlanTask` (`shared/planner.ts`) and to the `add_task` and `update_task` change ops. Optional, so old plans load unchanged. The owner approves it like any other change because it arrives in a proposal.
- The GM's chunk format gains an optional "Who:" line (a director's title). The importer maps it to `assignee`; an unknown title is dropped with a note, never guessed.
- The Work and Studio card details show "Handled by Creative Director" with a plain dropdown for the owner to change.
- **Why on the plan, not the town:** `town.ts` states that the town never stores work state. An assignee is plan data (who is responsible), not an activity state.
- **Tests.** Schema round trip and migration (old plan has no assignee); proposal accept and reject; revision conflict as for other fields.

### Step 4. Truthful "working" and "!" (pure function, no new storage)
Goal: a director looks busy only when something real is happening.
- New pure function `directorActivity(plan, town, now)` in `src/shared/townActivity.ts`. It returns, per director key, `{ state, taskId?, since? }` with state one of:
  - `working`: a task assigned to them has a **live claim** (`isClaimLive`).
  - `needs-you`: a task assigned to them is **reported** (waiting for your review), or a pending proposal from them is waiting.
  - `blocked`: a task assigned to them is `blocked`.
  - `idle`: otherwise.
  Nothing else sets a state. No timers, no random. Not stored; recomputed from the plan on every render and plan event (`useTown.ts` already refreshes on events).
- **Rendering.** A small badge above the figure and above their office door: **!** for `needs-you`, a turning gear for `working`, a stop dot for `blocked`. Clicking opens the office card, which lists the task and a button to review. Implementation: an `activity` prop on `TownWalker` and the office door spot in `TownTab.tsx`.
- **Honesty tests.** (1) With no tasks, no badge ever shows. (2) A property test: for any plan, a `working` state exists only if there is a live claim assigned to that director. (3) An expired claim stops being `working`. (4) A real-app check that badges appear in step with a seeded plan.
- **Done looks like:** nothing shows on a new project; assign a chunk and have it reported, and that director gets a **!**.

### Step 5. Do the work with the systems that already exist
Goal: "Do this" runs the chunk with OmniCandy's own Claude and the connected apps, within limits, and the result comes back for review.
- Implement `ExecutionPort.dispatch` (`plannerCoordination.ts`, currently throws) as a small module `src/main/planner/execution.ts` that hands a prepared package to the same Claude Partner session the user already has (the one with `planner_claim`, `planner_report`, `external_run`, workflows), with an `AgentBudget` (`maxTurns`, `maxToolCalls`) from `agentBudget.ts`.
- **Owner approval stays.** The button is "Do this". The dialog says which director's job it is, which connected apps it may use (the Claude Partner already asks approval per app run), and the limits. Defaults are conservative (suggest 20 tool calls, 12 turns) and editable in Advanced only.
- **Claims and reports are the activity source.** The run claims the task (Step 4 turns that into **working**), reports with real check results, and the task becomes **Needs review**. The owner's three buttons, **Looks good**, **Change this**, **Not this**, call the existing accept, revise and reject paths. The "paste back" box stays for outside tools.
- **Tests.** Unit: dispatch refuses without owner approval, enforces the budget, never accepts its own work. Integration: a fake Claude session that claims, reports and stops; assert the task ends **Needs review**, never **Done**. No paid call in tests.
- **Done looks like:** pick a chunk, press **Do this**, watch the director work, review the result.

### Step 6. Purposeful visits (the town becomes a picture of the real plan)
Goal: directors go to each other when the work needs it, and chat only when idle.
- Extract the walker's decision into a pure function `nextIntent(state)` returning `stay`, `chat-visit(target)` or `work-visit(target, until)`. Today this is buried in `TownWalker.tsx`.
- **Work visit rules.** A director whose task is `working` visits another director only when that task `dependsOn` a task assigned to that other director, or the owner linked them. They stay while the claim is live, capped at a few minutes, then go home. A director who is `working` or `needs-you` never takes a casual chat visit.
- **Casual visits** keep today's behaviour, only for `idle` directors, and only when the town is open, at no cost.
- Inside the host's office, a small visitor figure shows beside the desk during a work visit (a later nicety; start without it).
- **Tests.** `nextIntent` unit tests: idle goes casual, working with a dependency goes to the right office, no dependency stays, expired claim goes home. No timers in the pure function.

### Step 7. Optional AI meetings (bounded, always with your OK)
Goal: a real two-way exchange between directors, with a hard cost cap.
- A meeting stays a record by default. Add **Run this meeting with AI** on the Town Hall form. Before it starts the owner sees: who, how many turns (default 6), the model, and an estimated maximum cost; they confirm.
- Each turn uses the existing worker chat (`chat` with `agentId`) and appends a meeting note. Hard stops: turn cap, total token cap (reuse `MAX_REPLY_TOKENS`), a Stop button, and a stop on any error.
- It ends with `meetingPropose` (exists): what the meeting decided becomes **one pending proposal**. Nothing joins the plan until you add it.
- Visual: participants walk to the Town Hall and go in while the meeting runs. The animation is driven by the real run state and costs nothing itself.
- **Tests.** Fake chat engine: stops at the turn cap, stops on error, never creates anything except a pending proposal. A test that starting the animation alone makes no call.

## 5. What not to build

- A new canvas, a new chat widget, a new storage layer, or a second approval flow. Everything above reuses the existing ones.
- A new IPC channel. Extend `planner:call` through `ipc.ts` and `townMethods.ts`.
- Any state in `town.json` about who is busy.
- More town art. The town has enough personality to test the experience; work on the General Manager first.

## 6. Decisions I need from you

1. **Opening tab.** Today the Planner opens on OmniTown. For a project with no plan yet I recommend opening on the General Manager's chat, and on OmniTown after that. OK?
2. **Studio chat is the General Manager.** Same person, same conversation everywhere, old Studio history kept. OK?
3. **Task owner on the plan (Step 3).** An optional `assignee` on tasks, set from the GM's "Who:" line and editable by you. OK?
4. **Spend defaults for Step 5.** Suggest 12 turns and 20 tool calls per "Do this", confirmed by you each time. OK, or tighter?

## 7. Suggested order and size

Step 1 (small, mostly wiring) then Step 2 (prompt and tests) gives the "say what you want, the General Manager helps" experience before any new data. Step 3 and 4 are small and make the town honest. Step 5 is the biggest. Steps 6 and 7 are last because they depend on 3 to 5.

## 8. Talking to any worker, and getting it back to the General Manager

Today (exists): every worker chat is tied to the same project plan. A worker is told the plan summary and the team, and can answer in the chunk format for their part. You tick the chunks and they join the plan as a suggestion from "Planning chat". The worker cannot change the plan, and nothing is sent to the General Manager directly. The General Manager only learns about it because the next time you talk to them their prompt includes the plan summary.

Proposed:
- **The plan is the shared notebook.** A worker's chunks, once you add them, are plan tasks with that worker as `assignee` (Step 3). The General Manager reads the plan, so it sees them with no extra messaging.
- **"What changed" for the General Manager.** Add to the General Manager's prompt a short list of recent plan changes by others, from the existing history (who, what, when, names only). No AI call to build it. This is how the manager "hears" about work you started with someone else.
- **Optional note.** A button on a worker's chunk list, "Let the General Manager know", appends one plain line to the General Manager's conversation ("Creative Director added 3 chunks: ..."). No AI call, you can skip it.
- **Starting a project with a worker.** Any worker can take the first conversation. They set the brief and chunks the same way, so the plan exists from the first message. The General Manager is the default front door, not a gate.
- **Boundaries stay.** A worker cannot give work to another worker or accept anything. Only you add chunks and assign owners; the manager can only suggest.

## 9. Worker to worker: notes and requests

Today (does not exist): workers cannot message each other. The only shared thing is the plan.

Proposed, two kinds, both owner-visible and free until someone runs:
- **Note** ("FYI for the Technical Director: the dragon is 2 metres tall"). Stored in a small inbox on the plan, shown on the receiver's card, and added to the receiver's briefing the next time you open them. No AI call, no change to the plan.
- **Request** ("Technical Director, please build a loader for the dragon model"). This is a **pending proposal** for a task with `assignee` = the receiver and `requestedBy` = the sender. It joins the plan only when you press Add. Only the owner assigns work.
- **How a worker writes one.** In their reply they use a short format (`Ask: <director> — <what>` or `Note: <director> — <what>`). The app shows it as a card with **Send it** and **Skip**. The AI never delivers anything by itself.
- **Limits.** A worker can have at most a few requests pending, no request can be sent to oneself, a reply to a request is a new note, never an automatic chain, and nothing runs until you press **Do this**.
- **Town.** A director with an incoming request shows **!**; the sender visits the receiver only while a real request is pending, then goes home. No pending request, no purposeful visit.
- **Tests.** Parsing of the Ask and Note lines; an unknown director is rejected, not guessed; a request never becomes a task without owner approval; no AI call is made when a note is delivered.

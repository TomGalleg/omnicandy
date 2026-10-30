# Planner beginner experience: review before any changes

Written 2026-10-29. Nothing here is implemented. It answers the six things asked for, from reading the current code and running the app on a fresh project (screens: Studio on a new project, Work with two tasks, OmniTown, Town Hall, an office).

## 1. The five most confusing parts

**1. Four doors to the General Manager, with two sets of instructions.**
You can reach the General Manager from the Studio chat, from OmniTown's top button "Talk to the General Manager" (which just switches to Studio), from the General Manager's office, and from the Town Hall. They share one saved conversation, but they do not follow the same rules. The Studio uses the planning prompt (it asks "Ready to start building?", then lists tasks). The office and the Hall use the director prompt (it recommends tasks with an Add task button). Same person, different behaviour depending on the door.
Files: `renderer/src/planner/StudioTab.tsx`, `PlannerChat.tsx`, `OfficeChat.tsx`, `TownHall.tsx`, `TownTab.tsx`; `shared/plannerChat.ts` (`chatSystemPrompt`), `shared/town.ts` (`agentSystemPrompt`, `generalManagerIntro`); `main/planner/ipc.ts` (`chat`).

**2. The Work tab starts on copy and paste, and its words are for experts.**
The "Who does it?" choice defaults to "ChatGPT, Gemini, Cowork or any chat" (copy the instructions, then "Paste back"). The one-click path is the first radio, "OmniCandy Claude", and takes four steps: pick it, press "Get it ready", press "Do this now", then confirm a step limit. After you merely copy instructions the task shows "In Progress: Sent to AI, waiting for a result", although nothing was sent. Words like "Bring the result back", "Paste back", "Unsend", "More options", "Remove file locations" appear on a screen a beginner is told to use.
Files: `renderer/src/planner/PlannerWork.tsx` (`CurrentChunk`), `PlannerSend.tsx`; `shared/plannerSend.ts` (`DESTINATIONS`, wording), `shared/plannerView.ts` (status labels).

**3. Adding a task works three different ways.**
In the Studio chat, a task list needs "Show these on the canvas" and then "Add" on dashed cards (two steps, nothing is in the plan until the second). In the Town Hall and in offices, "Add task" puts the task straight into the plan (one step). On the Work tab there is a separate "Add a task" form, and the Hall's "Make tasks from this" goes back to dashed cards. You cannot tell whether something is already in the plan.
Files: `PlannerChat.tsx` (`ChunkList`), `StudioTab.tsx` (`decide`), `meetingKit.tsx` (`useTaskAdder`), `TownHall.tsx` (`makeTasks`), `PlannerWork.tsx`.

**4. OmniTown's top bar and the empty canvas ask beginners to understand the tool.**
OmniTown opens with "Talk to the General Manager", "Suggest helpers", a "New business" box with "Open it", and a "Hire a helper" fold: "business", "studio" and "helper" are ideas a first-time user does not need. The Studio canvas on a new project shows one lone "Project" card, Canvas/Board/List, Tidy up, "0 of 0 done", zoom controls and a minimap before anything exists.
Files: `TownTab.tsx` (top bar, `AddBusiness`, `HireHelper`), `StudioTab.tsx`, `ProjectCanvas.tsx`, `styles.css`.

**5. Where you land and what to do next change from screen to screen.**
A new project opens on Studio; a project with any task opens on OmniTown, even though OmniTown is the first tab and Studio is where the conversation is. Only the Studio shows a "Next:" line. OmniTown and Work have no equivalent, so after a plan exists nothing says "do this next". Leaving the Town Hall also drops a waiting "!" (the transcript stays).
Files: `PlannerWorkspace.tsx` (first-tab logic, tabs), `StudioTab.tsx` (`nextStepsOf`), `shared/projectView.ts` (`nextStepsOf`), `TownHall.tsx`.

## 2. Small, practical improvements, ranked by impact

1. **Remember each project's last Planner tab** (confirmed). See section 4 for how.
2. **One "Next step" strip on all three tabs**, reusing the existing `nextStepsOf`, with one clear button (for example "Review the result", "Start this task", "Tell the General Manager what you want to make").
3. **Work tab: make "OmniCandy Claude" the first and default choice when it is ready, and collapse "Get it ready" and "Do this now" into one button.** One dialog states what will happen and offers the step limit. Copy-and-paste for other AIs moves under a closed "Use another AI instead". Change the status wording after copying to "Instructions copied". The user's last choice is still remembered.
4. **Tidy OmniTown's top bar.** Keep only "Talk to the General Manager". Put "Suggest helpers", "New business" and "Hire a helper" under one closed "Team options". On an empty Studio canvas, hide the toolbar, minimap and counters until there is something to show.
5. **One way to add a task.** Decision needed (section 6). The least risky version keeps the dashed-card review in the Studio and makes every other "Add task" say the same words and show the same "Added to your plan" state.
6. **One General Manager prompt for all four doors**, built in one function, supporting both the "Ready to start building?" flow and the Task-line recommendations. This changes AI behaviour, so it is a second batch with live checks.
7. **Plain words.** "Bring the result back" and "Paste back" only appear inside "Use another AI instead"; "Unsend" becomes "Undo"; "package" and "brief" never appear on screen.

## 3. Proposed first implementation batch

Items 1 to 4 above. They change screens, not AI behaviour, and none touch the plan data. Batch two: items 5 and 6 (after the decisions), and item 7 as the wording sweep.

## 4. Remembering the last Planner interface (the confirmed behaviour)

What already exists: the project manifest has `view: { workspace, assetId }` ("where the user left off"), written by `App.tsx` through `setProjectMeta` (800 ms after a change) and restored when the project opens. It is not part of the plan and never changes a plan revision. Reuse it: add an optional `plannerTab` to `view` (`shared/types.ts`), accept it in the schema in `main/ipc.ts` (`setProjectMeta`), and read/write it from `PlannerWorkspace.tsx`.

Rules:
- New project, or no saved value: open **Studio**. (This changes today's behaviour, where a project with tasks opens OmniTown.)
- Otherwise open the saved tab. Each project has its own value, restored after a restart.
- A saved tab that is not available (a tab that no longer exists) falls back to Studio. In Simplified mode, the Advanced-only tabs map to the nearest simple view (Idea and Plan to Studio) **without deleting the saved value**, so switching back to Advanced returns to it.
- Switching tabs does not touch the plan, its revision or any package, and starts no AI call.

Two traps found while reading the code:
- `ProjectStore.setMeta` replaces the whole `view` object, and the `App.tsx` effect writes only `{workspace, assetId}`, so it would erase a saved `plannerTab` every time. The write must merge, or carry `plannerTab`.
- The `setProjectMeta` schema is strict; an unknown field is rejected until it is added.

## 5. Tests and acceptance criteria

Committed, automatic:
- Pure function `resolvePlannerTab(saved, { advanced })` with unit tests: nothing saved gives Studio; a saved simple tab is honoured; a saved Advanced-only tab in Simplified gives Studio and does not change the saved value; an unknown value gives Studio.
- `setProjectMeta` accepts and keeps `view.plannerTab`, and writing `{workspace, assetId}` alone does not erase it.
- The plan file and revision are byte-identical before and after switching tabs (same style as the existing town test).
- `nextStepsOf` covers the strip's states (no tasks, a task ready, a result waiting for review, a task stalled, everything done).

Real-window script (extend `scripts/smoke-planner.mjs`, which already exists, so it is committed and repeatable):
- New project opens on Studio. Switch to Work, close and reopen the project and restart the app: Work is restored. A second project keeps its own tab.
- Work tab on a ready project: "OmniCandy Claude" is selected, one button starts the confirmation, copy-and-paste is inside the closed fold, and copying shows "Instructions copied".
- OmniTown's top bar shows one button until "Team options" is opened; the empty Studio canvas shows no toolbar.
- No AI request is made by opening, switching or restarting (count the chat calls: zero).

Done looks like: a beginner opens a new project, types what they want to the General Manager, sees tasks appear, presses one button to start the first task, and reviews the result, without meeting any word from the list in section 2, item 7.

## 6. What could break existing projects, and decisions needed

Risks:
- The `view` merge issue above (would silently lose the saved tab).
- Changing the default for projects with tasks from OmniTown to Studio is a visible behaviour change.
- Re-ordering the Work tab changes what users who rely on copy-and-paste see first; keep their last choice.
- Unifying the General Manager prompt changes AI behaviour; it cannot be proved by unit tests, so it needs live checks of both flows (planning and recommending tasks) before it ships.
- `scripts/smoke-planner.mjs` uses selectors that the new Work and OmniTown layout may change; update it in the same batch.
- Windows and Linux: all of the above is renderer and TypeScript only, no native code, so both builds are unaffected.
- Existing project data: one new optional field, no migration. Old projects load as before and fall back to Studio.

Decisions I need from you:
1. Opening a project that has tasks but no saved tab: Studio (as confirmed) rather than today's OmniTown. OK?
2. Adding a task: keep the Studio's two-step dashed-card review and make the other places match its words (safer), or let the Studio chat add straight to the plan like the Hall (simpler)?
3. Work tab default: "OmniCandy Claude" first when it is ready. OK?

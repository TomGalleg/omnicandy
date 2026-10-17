# Planner first-run walkthrough (hands-on, not automated)

Purpose: find out whether someone with no project-management or technical experience can use the Planner without help. Nothing in the
automated tests can answer that. Run it with a real first-time user, a screen recording or notes, and **no coaching**. Total time to
allow: 30 minutes. It makes **no paid call** unless a step says so.

## Before you start

* Use a fresh user-data folder (or a new plan) so nothing is pre-filled. The Advanced box in the Planner header must be **off**.
* Have one AI chat open in a browser (ChatGPT, Gemini or Claude) that the tester is already signed in to. Say only: "Plan a small project of
  your own and get an AI to help. Think aloud."
* Do not say the words package, claim, report, proposal, revision, MCP or workflow.

## What the tester should be able to do (tick when done without help)

| # | Task | Done unaided | Clicks | Words they did not understand |
|---|---|---|---|---|
| 1 | Open the Planner and create a plan with a title and a goal | | | |
| 2 | Find where to ask an AI for ideas, copy the request, paste it into the chat | | | |
| 3 | Paste the AI's answer back and understand the preview (what is a rule, what is just a task) | | | |
| 4 | Add some of the suggestions to the plan and leave one out | | | |
| 5 | Say, in their own words, which items changed "the plan" and which only added to a list | | | |
| 6 | Pick a task and send it to an AI (chat) | | | |
| 7 | Tick or untick "Remove file locations" and say what it does | | | |
| 8 | Paste the AI's answer back and find the task in **Needs Review** | | | |
| 9 | Say why the task is not Done yet | | | |
| 10 | Accept it, or ask for changes, and say what will happen to the task | | | |
| 11 | Change a rule after sending a task, then find the warning that the plan changed | | | |
| 12 | Find a task that has stalled (leave one sent and unanswered for a day, or set one up) and take it back | | | |
| 13 | Say who can accept work (expected: only me) | | | |
| 14 | Find the Advanced box and say what they think it is for (do not make them use it) | | | |

## Things to watch for (write what you saw, not what you think)

* Where they stopped and re-read. Where they went to the wrong area first. Which button they hovered over and did not press.
* Any moment they believed the AI had changed their plan, or had finished a task by itself.
* Whether they noticed the **Needs you** strip without being told.
* Whether "Send to AI" left them unsure what to do next (the message under the button should say "paste the answer under Paste back").
* Whether they trusted "Take back" and "Unsend" (they cancel work in progress).
* Anything on screen that is still a developer word. Known places: the pasted text itself contains "package" and "report" because external
  AIs and the connection tools use those words; the **Connect an AI directly** block is technical by nature.

## Pass criteria (agree before you start)

* Tasks 1 to 10 done unaided by at least 4 of 5 testers, in under 15 minutes of working time.
* Nobody believed an AI could change the plan or finish a task by itself (tasks 5, 9, 13).
* Fewer than 3 unexplained words per tester in the plain view.

Anything that fails goes back as a concrete change request with the screenshot, the tester's words and the step number. Do not average
away a single serious misunderstanding about who accepts work: fix it.

## After the session

Record: tester background (no names), date, build, the table above, the pass/fail against each criterion, the three biggest confusions,
and the three things that went well. Keep it next to this file as `planner-first-run-<date>.md`.

## Not covered by this walkthrough (needs a signed-in Claude and may cost money)

* Home "Create with Claude" with the Planner box ticked, then accepting the steps under **Needs you**.
* CreateCraft Claude: **Put it in the Claude panel**, and `planner_propose` suggestions appearing under **Needs you**.
* A direct Claude Code connection (`claude mcp add ...`) claiming and reporting a task, shown as In Progress and then Needs Review.

# OmniTown AI team: access, toolboxes and the Creative Director loop

Written 2026-10-30 from reading the code. Nothing in sections 2 to 6 is built yet; section 1 is built and tested. Plain words first, file names after.

## 1. Done now: the Town Hall raises hands by rules, for free

Before: after every message, up to two extra AI requests decided who "had something to say", and a "!" could take one or two minutes.
Now: `shared/townHands.ts` decides by rules, with no AI. A director scores for being named by you, being named in the answer, words that belong to their job, and words that match one of their open tasks. They lose points for having just spoken, or for covering the same ground as the person you are talking with. Only the best one shows, only above a threshold, and never on two messages in a row (unless you name them yourself).
- The "!" appears instantly (measured: 0.2 s, while the answer took 10 s). Its tooltip says why, for example "named in the answer".
- What a director says is asked for **only when you click their "!"**, and then they become the person you talk with.
- Measured in the real app by counting AI requests: a message costs **1** request, clicking a "!" costs **1** more, and a plain message raises no hand.
- The "!" now honestly means "could add something", not "has something already written".
Tests: 11 for the rules, 6 for the new prompts; full suite 1,690 pass.

## 2. What already exists and should be reused (not rebuilt)

| Need | What exists | Where |
|---|---|---|
| One place every tool call passes through | `ToolRegistry.call`: "execution always rechecks current access in the backend" | `main/agentHarness/registry.ts` |
| "Read only" | `ToolDef.readOnly(args)`: the host classifies the exact call | same file, `types.ts` |
| Approval before risky commands in the native apps | `commandTier` (free / approval / never) for PhotoCraft; `appCommandTier` for the other Craft apps; `LiveTaskController.approveCommand` shows a native dialog | `shared/photocraftOps.ts`, `shared/appCommands.ts`, `main/liveTask.ts` |
| Approval and permissions for outside programs (Blender and so on) | `IntegrationManager`: saved per-app permissions, a destructive flag, answers once / always / session / deny, a session allow-list, an audit log | `main/integrations/manager.ts` |
| Spending approval with a price | `GenerationService` shows the price and asks; `Requester` already labels who is asking | `main/generation.ts` |
| Installing software | `requestModelDownload` license and size dialog; the integration builder is owner-reviewed | `main/ipc.ts` |
| Provider choice including local models | `withAgentProvider`: OpenAI, Gemini or a local OpenAI-compatible server; keys lent per call from the vault, never shown to the page | `main/agentHarness/providerFactory.ts` |
| A "universal toolbox" of tools | `buildAgentRegistry` already unions native tools, outside-app tools, export tools and the shared Claude tools (images, video, workflow, timeline, planner, PhotoCraft), advertised by family on request | `main/ipc.ts`, `sharedClaudeTools.ts` |
| Budgets | `AgentBudget` (turns, tool calls), preview limits | `shared/agentBudget.ts` |
| "Do not simulate success" | `task_plan` with `evidence_verify`, trusted read-backs, a job ledger, crash recovery, an edit journal: a step is only complete with passing evidence | `main/agentHarness/*` |
| Human takeover | pause, resume, stop, takeover phases, "awaiting approval", a document lock | `main/liveTask.ts`, `agentInterrupt` and `agentStop` |
| Handing work back to the plan | planner claims, reports, review; `planner_*` tools; `ExecutionPort` seam | `main/planner/*`, `shared/plannerCoordination.ts` |
| A free way to test the loop | the `mock` image provider (offline, no cost) | `shared/generation.ts` |

## 3. What genuinely needs adding

1. **A worker identity and one policy model** (pure code, `shared/`). Nothing today says *who* is acting: approvals are per command or per app, never per worker. Define: four levels (No access, Read only, Ask first, Allowed), capabilities (read files, change project files, an app, generate images, spend money, install, publish), three presets (Supervised, Balanced, Independent) that fill in defaults, granular overrides, and scope (project, one task, one resource) with the minimum as the default. One function `decide(policy, request)` answers allow, ask or deny with a reason.
2. **Delegation that can only shrink access.** A hired expert's policy is the *intersection* of what the director chooses to give and what the director has. Proven by a property test: for any inputs, the expert never has more than the director.
3. **A small table classifying each existing tool call** into capability, risk and target, reusing `readOnly`, `commandTier`, `destructive` and `billable` instead of inventing risk labels.
4. **Enforcement at the boundary, in code**: a wrapper around `ToolRegistry.call` that reads the *current* policy on every call (so revoking mid-run takes effect at the next call and aborts the run), plus the matching check in the Claude panel's tool handlers. Delegated and nested calls carry the intersected policy in the run's context, not in text the model can read or ignore.
5. **An approval broker** that reuses the existing native dialogs but names the worker, the actual action and the target, and offers "this once" or "for this task" with an expiry. It composes with the existing gates; it does not replace them.
6. **A per-project policy store** (a file in the project folder, versioned), separate from the plan.
7. **A worker activity log**: append-only, written at the enforcement boundary (what was requested, the decision, what was done, what it produced). The existing audit trails are in memory or scattered (the integration audit keeps 200 entries in memory; the agent keeps its last 100 events), so this is the one durable record.
8. **A toolbox registry**: a short declaration per director (tool families, apps, default levels, budget) mapped to the existing family names, so adding a director or tool is adding an entry.
9. **A "work as this director" run**: the existing agent run with a role, a scoped registry, a policy and the owner's provider choice. Its result goes back through the existing claim and report path, so the task becomes "needs review" and only you accept.
10. **A spending cap**: today there is only a per-generation price dialog and no money limit anywhere. A cap needs a small counter.
11. **A compact director brief** (memory), built on demand from the plan (accepted rules and decisions, the director's tasks, recent reports, asset names). No new source of truth.
12. **The Team Access screen**: one card per worker, four levels, the preset picker, an Advanced fold for overrides. Built last, over a working engine.

## 4. Conflicts and risks found

1. **Two engines (decided by the owner): Claude is the base.** Directors work through the Claude panel by default. An **engine router** sends the work to the agent harness when the owner switches the AI provider (ChatGPT/OpenAI, Gemini, a local model), or when a program is marked as working better on the harness. The rules are one shared engine, `shared/teamAccess.ts` (built, 19 tests), with an enforcement adapter on **each** path: the harness checks in `ToolRegistry.call`; the Claude panel checks inside its tool handlers and its allowed-tool list. Same rules, same activity log, same approvals, whichever engine runs.
2. **One run at a time.** The harness keeps its state in one place (`agentState`, `pausedAgent`, `agentAbort`) and the document lock is single. So directors work one at a time and others queue. Delegation to an expert is a sequential sub-run inside the same run. True parallel directors would need a larger refactor; not proposed.
3. **"Allowed" must not bypass the existing gates.** A "never" command tier and the native price dialog stay authoritative. Policy can only make things stricter or equal. Some actions always ask whatever the level: installing software, publishing outside the app, deleting outside the project, anything touching credentials.
4. **Two kinds of permission must stay separate.** The planner's scopes (read, propose, package, execute, edit, review) protect plan data and keep `edit` and `review` owner-only. Worker access governs tools. Team Access never grants `edit` or `review`.
5. **Honest limits of the Creative Director example.** A convincing "colorful baby dragon illustration" needs an image provider with a saved key (OpenAI, Gemini or Recraft). Without one, PhotoCraft and VectorCraft can build shapes but will not paint that picture. I will prove the loop offline with the `mock` provider, then try a real run if a key is saved.
6. **Local models** differ in tool-calling ability. The toolbox should check the chosen model can use tools before a director run starts.
7. **Approvals are native OS dialogs.** Fine for the first version; showing them inside OmniTown comes later.

## 5. Proposed order, each step small and tested

1. **Done:** the policy engine and presets, with a delegation-only-shrinks property test (`shared/teamAccess.ts`).
2. The boundary wrapper, the activity log and revoke-during-run, tested with a fake registry (a hidden tool is refused at the boundary; a nested call cannot exceed).
3. The approval broker (worker, action, target, scope, expiry).
4. The toolbox registry and the Creative Director entry, run for real in the app with the `mock` provider, with the office showing real progress.
5. The result path: the output is registered in the library, verified to exist, reported to the plan, the owner accepts or asks for changes.
6. The Team Access screen.
7. The director brief.

## 6. Decisions needed before step 1

1. Claude first; switching provider (or a per-program preference) moves work to the agent harness. Decided.
2. One director works at a time; others queue.
3. "Allowed" for spending means: automatic within a cap you set, a price dialog beyond it; with no cap set, every paid action still asks.
4. The default preset is **Balanced** (project edits allowed; destructive, install, publish, spend and out-of-scope all ask).
5. Policies are saved per project, in the project folder.

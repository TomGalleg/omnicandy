import type { AgentEvent, AgentOutcome, Message, ModelProvider } from './types';
import { ToolRegistry } from './registry';
import { classifyCommandError } from './commandPreflight';
import type { LiveTaskController } from '../liveTask';
import { registerTaskPlan, seedPlanFromGoal, type TaskPlan } from './taskPlan';
import { NATIVE_READBACK_COMMANDS } from './nativeReadback';
import { expectedEditIntent, type ExpectedEdit, type JournaledTool } from './editIntentJournal';
import { compactAgentHistory, boundToolOutput, compactToolSchema, VERIFIED_MARKER } from './contextBudget';
import { optionalFamiliesPrompt } from './toolFamilies';
import { clampAgentBudgets } from './executionBudget';

const active = new WeakSet<LiveTaskController>();
const baseSystem = `For newly completed task_plan steps, supply a passing evidence_verify ID; save steps can instead cite a save_version execution receipt with a confirmed new version ID. If you cannot verify a step, leave it pending/blocked and report why. Use evidence_verify to compare expected values with authoritative structured read-back receipts when possible; a failed or unavailable comparison is not verified completion. Use evidence_receipts to cite real successful tool results when updating completed steps. A receipt proves a successful tool response, NOT that the desired visual or document outcome was verified. Read back actual state and compare it to the goal. Use task_plan early in multi-step tasks to record concise steps and update it when verified progress changes. Completing a plan step requires concrete evidence from application read-back; the plan itself does not prove success. You operate ONLY connected CreateCraft applications through approved tools. Call get_status before editing, search app_commands by task noun, inspect exact command IDs for full parameters and inspect results before continuing. A discovered ID is not permission to execute it. When validation is unavailable, use only explicitly known parameters; request help rather than inventing values. If a schema is unavailable, do not guess missing arguments. Never invent success. For state-changing tasks, READ actual object IDs/properties first, EDIT with commands that explicitly support those properties, then VERIFY by reading back authoritative state (bounds, transforms, text, or other app-supported information). Use a visual preview for appearance when available. If verification disagrees, inspect the exact command schema and current state before a correction; never repeat an uncertain edit blindly. If no read-back capability exists, report that verification is unavailable, not success. A command returning applied does not prove the requested outcome. Before multi-step editing, form a short internal action plan and execute one verified step at a time. If the budget is running out, preserve the current state and explain what remains rather than guessing or repeating edits. Autonomous task completion is the default: pursue the full original user goal rather than stopping after an intermediate command succeeds. Make reasonable routine creative and technical choices (such as equal spacing, centering, or picking a supported command) without asking the user to decide every step; use explicit user constraints when supplied. For each substantive edit, distinguish command acceptance from changed application state: read back the relevant object/document properties and compare against the goal; inspect a preview when a registered visual tool is available and visual confirmation is material. If read-back is null, inconsistent, or uninformative, inspect another authoritative source or preview and state what could not be verified; never claim unverified visual success. If an attempted edit did not achieve its intended effect, re-inspect state and choose a different authorized method where the tool definitions support one. Do not blindly repeat state-changing calls, assume an earlier edit failed, or recreate objects already present. Only ask the user to intervene for a genuine blocker, missing permission, unsafe or consequential ambiguity, or an unavoidable choice; otherwise continue within the execution budget. If the task is unfinished when you must stop, explicitly summarize verified completed work, outstanding work, and blockers. Human denials, pauses and takeovers are final; stop. Save versions only when the user requests it. Do not request shell, code execution or unlisted tools.`;
const creativeExtra = `\nPaid generation (generate_image, generate_video) always asks the user for approval and may be declined; use it only when the user asked for generated media, say which model, and stop if it is declined. Timeline, workflow, planner and PhotoCraft tools change project or document state: read the result back (get_status, a document inspection or workflow_status) before claiming success.`;
const nativeExtra = `\nUse new_document to start a blank document when available. Use look_at_document to inspect a visible preview when available and needed; it returns an image. Do not invent image contents.`;
const externalSystem = `

CreateCraft supports native Craft applications and external applications. get_status and app_commands describe only the native Craft applications. External applications (Blender, FreeCAD and any other non-Craft program) are found with external_apps, their supported commands with external_commands, and commands are run with external_command. When the user asks for Blender, FreeCAD or any other non-Craft application, call external_apps first, then external_commands for the chosen application, and inspect each external command with external_commands command_id to see parameter types, ranges and permissions before executing. Execute only commands that external_commands returned, with the parameters it lists. Never invent external commands or parameters. Never assume an external application is unavailable because get_status does not list it; say it cannot be found only after external_apps has been checked. For Blender prefer the typed commands (scene.build for many objects, then scene.inspect_detail to read the saved file back); use scene.viewport, when it is offered, only to look at the result, because a picture is never proof; use script.run (the user approves the code) only for what the typed commands cannot do, such as rigging or geometry nodes.`;
/** The instructions for the tools that are really registered: external discovery is explained only when the external tools exist. */
export const buildSystemPrompt = (toolNames: readonly string[]): string =>
  baseSystem + (toolNames.includes('new_document') || toolNames.includes('look_at_document') ? nativeExtra : '') + (toolNames.includes('external_apps') && toolNames.includes('external_commands') && toolNames.includes('external_command') ? externalSystem : '') + (['generate_image','generate_video','timeline_add','run_workflow','photocraft_command','planner_packages'].some(n => toolNames.includes(n)) ? creativeExtra : '') + (toolNames.includes('enable_tools') ? optionalFamiliesPrompt() : '');
/** True while the user owns the document or has paused/approval pending: the agent must not start or edit. */
export const userControlActive = (ctl: LiveTaskController): boolean => {
  const c = ctl.snapshot().collab;
  return c.lockOwner === 'user' || ['manual','pausing','paused','awaiting_approval'].includes(c.phase);
};
const paused = userControlActive;
const stopText = /stop and wait|do not retry|user declined|user paused|user cancelled|taken control|not available here|permission[- ]denied|user did not allow|not approved/i;
const readbackCommands = NATIVE_READBACK_COMMANDS;
const nativeCommandId = (args: unknown): string | undefined => args && typeof args === 'object' && !Array.isArray(args) && typeof (args as Record<string, unknown>).command === 'string' ? (args as Record<string, string>).command : undefined;
const isNativeReadback = (name: string, args: unknown): boolean => name === 'app_command' && readbackCommands.has(nativeCommandId(args) ?? '');
// Tools that can change document or project content. Whether an external_command is really an edit is decided per call by the host (ToolDef.readOnly).
const MUTATING_TOOLS = new Set(['external_command','photocraft_command','timeline_add','timeline_move_clip','timeline_remove_clip']);
const batchRecoveryHint = (outcome: string, kind?: string): string => kind === 'blender.script.run'
  ? (outcome === 'applied' ? 'Confirm it with evidence_verify (data.script.outcome is "applied"); do not run the script again.'
    : outcome === 'absent' ? 'Confirm it with evidence_verify (data.script.outcome is "absent"); after a passing check the lock is released and the script may be run again (the user approves it again).'
    : 'The lock stays. Do not run the script again; tell the user what was found and stop.')
  : outcome === 'applied' ? 'Confirm it with evidence_verify (data.batch.state is "recorded"); do not run the batch again.'
  : outcome === 'absent' ? 'Confirm it with evidence_verify (data.batch.state is "absent"); after a passing check the lock is released and the same batch may be run again.'
  : 'The lock stays. Do not run the batch again; tell the user what was found and stop.';
/** The concrete way out of a lock on a Blender batch: which read-back to take and what to compare, so a small model does not have to guess. */
const batchRecoveryPlan = (e: ExpectedEdit | undefined): string => e?.kind === 'blender.script.run'
  ? ` To resolve it call external_command scene.inspect_detail with file_name "${e.file}" and script_hash "${e.script_hash}" (a trusted read-only read-back of the saved file), then evidence_verify data.script.outcome on that receipt ("applied" if the script's result is in the saved project, "absent" if the project is exactly as it was before). The host decides from the read-back whether the lock is released; if it cannot be read, stop and tell the user.`
  : e?.kind === 'blender.scene.batch'
  ? ` To resolve it call external_command scene.inspect_detail with file_name "${e.file}", batch_id "${e.batch_id}", chunk ${e.chunk}, ids "${e.ids.join(',')}" (a trusted read-only read-back of the saved file), then evidence_verify data.batch.state on that receipt ("recorded" if the batch is there, "absent" if nothing of it is). The host decides from the read-back whether the lock is released; if the file cannot be read, stop and tell the user.`
  : '';
const isMutation = (name: string, args: unknown): boolean => MUTATING_TOOLS.has(name) || (name === 'app_command' && !isNativeReadback(name,args));
// Anything that can change document content. save_version only persists a version and has its own confirmed receipt.
const requiresCompletionEvidence = (name: string, args: unknown): boolean => isMutation(name,args) || name === 'new_document' || name === 'apply_edit';
/** Conservative reconstruction for resumed transcripts: unverified unless a passing evidence_verify follows the latest successful change.
 * `isReadOnly` lets the host say that a call (a trusted external inspection) never changed anything. Compaction keeps the
 * `Error:` prefix and the verification marker, so compacted history gives the same answer as the full transcript. */
export async function hasUnverifiedChanges(messages: Message[], isReadOnly?: (name: string, args: unknown) => Promise<boolean>): Promise<boolean> {
  const calls = new Map<string, { name: string; args: unknown }>();
  let unverified = false;
  for (const m of messages) {
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) calls.set(c.id, c);
    else if (m.role === 'tool' && !m.content.startsWith('Error:')) {
      const c = calls.get(m.toolCallId);
      if (!c) continue;
      if (requiresCompletionEvidence(c.name, c.args)) { if (!(MUTATING_TOOLS.has(c.name) && c.name === 'external_command' && await isReadOnly?.(c.name, c.args))) unverified = true; }
      else if (c.name === 'evidence_verify' && (m.content.includes('"passed":true') || m.content.includes(VERIFIED_MARKER))) unverified = false;
    }
  }
  return unverified;
}
export async function runAgent(args: { goal: string; provider: ModelProvider; registry: ToolRegistry; ctl: LiveTaskController; signal?: AbortSignal; maxTurns?: number; maxToolCalls?: number; onEvent?: (event: AgentEvent) => void; resumeMessages?: Message[]; resumePlan?: TaskPlan; resumeUncertainEdit?: string; resumeExpectedEdit?: ExpectedEdit; onInterrupted?: (status: 'cancelled' | 'paused') => void | Promise<void>; onEditBegin?: (tool:JournaledTool, command:string,callArgs:unknown)=>Promise<void>; onEditSettled?: (safe:boolean)=>Promise<void>; onRecoveryResolved?: ()=>Promise<void>; onPlan?: (plan: TaskPlan) => void }): Promise<AgentOutcome> {
  const { provider, registry, ctl } = args;
  if (active.has(ctl) || ctl.snapshot().collab.activeOperation || ctl.snapshot().collab.phase === 'running') throw new Error('Another application task is already running.');
  if (paused(ctl)) throw new Error('User control or pause is active.');
  const messages: Message[] = args.resumeMessages ? structuredClone(args.resumeMessages) : [{ role: 'user', content: args.goal }];
  let resumedUnverified = false;
  if (args.resumeMessages) {
    const fresh = registry.snapshot();
    const status = await registry.call(fresh, 'get_status', {});
    if (status.isError) throw new Error(`Cannot resume without current document status: ${status.text}`);
    if (args.resumeUncertainEdit) messages.push({role:'user',content:`Recovery safety lock: the previous ${args.resumeUncertainEdit} edit may have partially succeeded. All edits remain blocked until a FRESH authorized read-back of the CURRENT document and a passing evidence_verify comparison. Do not repeat the old command. If the intended result cannot be independently compared, retain the lock and ask for help.${batchRecoveryPlan(args.resumeExpectedEdit)}`});
    messages.push({role:'user',content:'Receipt IDs (r1, r2, ...) and verification IDs (v1, v2, ...) from before this continuation have EXPIRED: a step can be marked completed in task_plan only with a verification ID from a read-back taken in THIS run. For a step you believe is already done, inspect the current state again, run evidence_verify, then cite the new ID. Send the complete step list every time you update task_plan.'});
    if (args.resumePlan) messages.push({role:'user',content:`Current project task plan (user edits take priority over earlier plan messages; verify steps before changing their status): ${JSON.stringify(args.resumePlan).slice(0,12000)}`});
    resumedUnverified = await hasUnverifiedChanges(messages, (name, callArgs) => registry.isReadOnly(fresh, name, callArgs));
    messages.push({role:'user',content:`The user requested continuation after an interruption, takeover, or execution budget limit. Reconcile the CURRENT application state against previous work. Do not replay finished actions. Inspect what actually remains and continue only with authorized steps. Current status: ${status.text.slice(0,8000)}`});
  }
  // A plan the user approved is recorded as the task plan from the start (a fresh task only; a resumed one keeps its saved plan).
  const seededPlan = !args.resumeMessages && !args.resumePlan ? seedPlanFromGoal(args.goal) : undefined;
  const planControl = registerTaskPlan(registry, args.goal, args.resumePlan ?? seededPlan, plan => args.onPlan?.(plan));
  if (seededPlan) {
    messages.push({role:'user',content:`The plan the user approved is recorded as ${seededPlan.steps.length} task steps (${seededPlan.steps.map(s => s.id).join(', ')}). Work through them in order and keep them current with task_plan. A step is completed only with a passing evidence_verify ID from a fresh read-back; the task is not finished while any step is unfinished.`});
    args.onPlan?.(planControl.snapshot());
  }
  active.add(ctl);
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent) => { events.push(e); args.onEvent?.(e); };
  // Provider-reported only: never estimate or invent token counts.
  const usage = { input: 0, output: 0 };
  let usageReported = false;
  // Takeover and cancellation must also stop what the agent started outside the model loop (background jobs).
  const notifyInterrupted = (status: AgentOutcome['status']) => {
    if (status !== 'cancelled' && status !== 'paused') return;
    try { void Promise.resolve(args.onInterrupted?.(status)).catch(() => undefined); } catch { /* the host's cleanup must never mask the stop */ }
  };
  const result = (status: AgentOutcome['status'], text: string): AgentOutcome => (notifyInterrupted(status), { status, text, messages, events, plan: planControl.snapshot(), ...(uncertainEdit ? { uncertainEdit } : {}), ...(usageReported ? { usage: { ...usage } } : {}) });
  const { maxTurns, maxToolCalls: maxCalls } = clampAgentBudgets(args.maxTurns, args.maxToolCalls);
  // Completion needs a passing evidence_verify whose read-back was taken after the latest successful change.
  // Adapter `verified:true` flags and plan status are claims, not evidence, and never clear this.
  let mutationSeq = resumedUnverified ? 1 : 0;
  let verifiedSeq = 0;
  const readbackSeq = new Map<string, number>();
  let verificationReminderSent = false;
  let calls = 0;
  let completionReminders = 0; // a model that answers with prose while steps remain is pushed (up to 3 times) to act instead of asking
  // A failed write may have partially changed the document. Require an actual
  // read-only inspection before attempting another write. No automatic replay.
  let uncertainEdit: string | undefined = args.resumeUncertainEdit;
  let expectedIntent: ExpectedEdit | undefined = args.resumeExpectedEdit;
  // Only read-backs taken AFTER an uncertain edit can resolve the safety lock.
  // These receipts are per-run; restored tasks must acquire new evidence.
  const recoveryReadbacks = new Set<string>();
  // Guard against identical failed calls across model turns. Never retry or rewrite
  // commands locally: an error may follow a partially completed operation.
  const failedCalls = new Map<string, number>();
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (args.signal?.aborted) return result('cancelled', 'Cancelled.');
      if (paused(ctl)) return result('paused', 'User intervention is required.');
      compactAgentHistory(messages);
      const snapshot = registry.snapshot();
      if (turn === 0) emit({ kind: 'model', tool: 'tools', text: `Tools available to the model: ${snapshot.map((t) => t.name).join(', ') || '(none)'}` }); // names only
      let reply;
      try { reply = await provider.complete({ system: buildSystemPrompt(snapshot.map((t) => t.name)), messages, tools: snapshot.map(({name,description,parameters})=>({name,description,parameters:compactToolSchema(parameters)})), signal: args.signal ?? new AbortController().signal }); }
      catch (e) {
        if (args.signal?.aborted) return result('cancelled', 'Cancelled.');
        const msg = e instanceof Error ? e.message : String(e);
        emit({kind:'error',text:msg}); return result('failed',msg);
      }
      if (reply.usage) { usageReported = true; usage.input += reply.usage.input; usage.output += reply.usage.output; }
      messages.push({ role: 'assistant', content: reply.text, ...(reply.toolCalls.length ? {toolCalls:reply.toolCalls} : {}) });
      emit({kind:'model',text:reply.text ?? ''});
      if (!reply.toolCalls.length) {
        if (uncertainEdit) {
          emit({kind:'stop',text:'Uncertain edit has not been reconciled against document state.'});
          return result('limit',`An application edit may have partially succeeded (${uncertainEdit}). Inspect current state and perform a passing evidence_verify comparison to resolve the lock; no edits were replayed.${batchRecoveryPlan(expectedIntent)}`);
        }
        // Model prose is never enough to close a structured plan. Give the model
        // one chance to reconcile the remaining steps, then retain continuation
        // state rather than pretending that the project is finished.
        const incomplete = planControl.snapshot().steps.filter(step => step.status !== 'completed');
        if (incomplete.length) {
          const remaining = incomplete.map(step => `${step.id} (${step.status}): ${step.title}`).join('; ').slice(0, 3500);
          if (completionReminders < 3 && turn + 1 < maxTurns) {
            completionReminders++;
            const next = incomplete[0]!;
            messages.push({role:'user',content:`Your task plan still has unfinished steps: ${remaining}.${completionReminders > 1 ? ` You answered with text again. Do not ask the user for preferences or describe what you will do: your next reply must be a tool call for ${next.id} (${next.title.slice(0, 120)}).` : ''} Continue using available inspection and editing tools. Verify actual state before marking steps completed; never claim a saved version without a tool result confirming it. If blocked, state the blocker and preserve the task.`});
            emit({kind:'model',text:'Final response deferred: structured plan still contains unfinished steps.'});
            continue;
          }
          emit({kind:'stop',text:'Model stopped with unfinished plan steps; task remains resumable.'});
          return result('limit',`Task is not yet verified complete. Remaining plan steps: ${remaining}. Use Continue Task to inspect current state and finish safely.`);
        }
        if (mutationSeq > verifiedSeq) {
          const reminder = 'The task changed application state but no passing evidence_verify compared a fresh read-back taken after the latest change. Inspect authoritative current state, then verify before declaring completion. If verification is unavailable, explain that the task remains unverified.';
          if (!verificationReminderSent && turn + 1 < maxTurns) {
            verificationReminderSent = true; messages.push({ role:'user', content:reminder });
            emit({kind:'model',text:'Final response deferred: latest application change has no passing verification.'});
            continue;
          }
          emit({kind:'stop',text:'Application changes are unverified; task remains resumable.'});
          return result('limit', 'Application changes were made but not verified by a passing read-back comparison. Use Continue Task to inspect current state and verify; no edits will be replayed.');
        }
        return result('completed',reply.text ?? 'Model finished without a final message; verify the output.');
      }
      // Complete *every* tool call in the assistant message with a matching tool result, even on stop.
      let halt: 'cancelled' | 'paused' | 'limit' | undefined;
      for (const call of reply.toolCalls) {
        if (!halt && args.signal?.aborted) halt='cancelled';
        if (!halt && paused(ctl)) halt='paused';
        if (!halt && calls >= maxCalls) halt='limit';
        // Host classification: a trusted read-only external command is an inspection, not an edit.
        const mutating = !halt && isMutation(call.name,call.args) && !(call.name === 'external_command' && await registry.isReadOnly(snapshot,call.name,call.args));
        let r;
        if (halt) r = {text:`Error: Not executed; agent ${halt}.`,isError:true};
        else if (uncertainEdit && mutating) {
          r = {text:`Error: Previous ${uncertainEdit} returned an uncertain result. Further edits remain blocked until a FRESH read-back and a passing evidence_verify comparison resolve the result. A successful inspection alone does not unlock editing. No edit was executed.${batchRecoveryPlan(expectedIntent)}`,isError:true};
        } else {
          const signature = JSON.stringify([call.name, call.args]);
          if ((failedCalls.get(signature) ?? 0) >= 2) {
            r = { text: 'Error: Identical tool call already failed twice. Stop retrying; inspect the command schema or ask the user for help.', isError: true };
            halt = 'limit';
          } else {
            calls++;
            emit({kind:'tool',text:JSON.stringify(call.args).slice(0,2000),callId:call.id,tool:call.name});
            // Write-ahead record must be durable BEFORE any potentially mutating call.
            // If persistence fails, do not dispatch the command.
            let dispatched = false;
            try {
              if (mutating) {
                await args.onEditBegin?.(call.name as JournaledTool, nativeCommandId(call.args) ?? call.name,call.args);
                expectedIntent = expectedEditIntent(call.name,call.args);
              }
              dispatched = true;
              r = await registry.call(snapshot,call.name,call.args);
              if (!r.isError && (mutating || call.name === 'new_document' || call.name === 'apply_edit')) mutationSeq++;
              if (mutating) {
                const safe = !r.isError || classifyCommandError(r.text) !== 'execution' || stopText.test(r.text);
                await args.onEditSettled?.(safe);
              }
            } catch(e) {
              // A callback failure after dispatch is uncertain, even if the tool returned OK.
              r = {text:`Error: Execution/journal state uncertain: ${e instanceof Error ? e.message : String(e)}`,isError:true};
              if (dispatched && mutating) {
                uncertainEdit = `${call.name}${nativeCommandId(call.args) ? ` (${nativeCommandId(call.args)})` : ''}`;
                recoveryReadbacks.clear();
              }
            }
            if (!r.isError) {
              const receiptId = planControl.record(call.name, r.text, r.verified === true, call.args, r.trustedReadback === true && (call.name === 'get_status' || (call.name === 'external_command' && !mutating)), r.readback);
              if (receiptId) {
                if (planControl.isReadbackReceipt(receiptId)) readbackSeq.set(receiptId, mutationSeq);
                if (uncertainEdit && (isNativeReadback(call.name, call.args) || (call.name === 'external_command' && !mutating && r.trustedReadback === true)) && planControl.isReadbackReceipt(receiptId)) {
                  recoveryReadbacks.add(receiptId);
                  // A Blender batch is judged by the host from this read-back alone (project identity, ledger, content): tell the model what it means.
                  const assessed = expectedIntent ? planControl.assessExpectedEdit(receiptId, expectedIntent) : undefined;
                  if (assessed) r = {...r, text:`${r.text}
Recovery assessment (host, from this read-back): ${assessed.outcome} - ${assessed.reason}. ${batchRecoveryHint(assessed.outcome, expectedIntent?.kind)}`};
                  emit({kind:'model',text:'Fresh read-back recorded. Compare actual fields with the intended result using evidence_verify. Editing remains locked until a passing comparison.'});
                }
                r = {...r, text:`${r.text}\nExecution receipt: ${receiptId} (tool accepted; verify actual state before claiming outcome).`};
              }
              if (call.name === 'evidence_verify' && r.verified === true) {
                const check = planControl.latestPassingCheck();
                if (check && readbackSeq.get(check.sourceReceiptId) === mutationSeq) verifiedSeq = mutationSeq;
              }
              if (uncertainEdit && call.name === 'evidence_verify' && r.verified === true) {
                const data = planControl.latestPassingCheck();
                const releasedAssessment = data && expectedIntent ? planControl.assessExpectedEdit(data.sourceReceiptId, expectedIntent) : undefined;
                if (data && recoveryReadbacks.has(data.sourceReceiptId) && expectedIntent &&
                    planControl.matchesExpectedEdit(data.sourceReceiptId, expectedIntent)) {
                  await args.onRecoveryResolved?.();
                  uncertainEdit = undefined;
                  expectedIntent = undefined;
                  recoveryReadbacks.clear();
                  emit({kind:'model',text: releasedAssessment?.outcome === 'absent' ? 'A fresh trusted read-back proves the batch never reached the saved project. Recovery lock released; the same batch may be run again.' : 'A fresh trusted read-back matched the durable recorded expected outcome. Recovery lock released.'});
                }
              }
            }
            if (r.isError && !stopText.test(r.text)) {
              if (mutating && classifyCommandError(r.text) === 'execution') {
                uncertainEdit = `${call.name}${nativeCommandId(call.args) ? ` (${nativeCommandId(call.args)})` : ''}`;
                recoveryReadbacks.clear();
              }
              failedCalls.set(signature, (failedCalls.get(signature) ?? 0) + 1);
              // Give the model a deterministic recovery hint, but never retry an edit automatically.
              const category = classifyCommandError(r.text);
              if (category === 'validation') r = { ...r, text: `${r.text}\nRecovery: Inspect the exact command schema and submit corrected parameters; do not repeat identical arguments.` };
              else if (category === 'unavailable') r = { ...r, text: `${r.text}\nRecovery: Refresh application/command discovery; do not assume the previous command remains available.` };
              else r = { ...r, text: `${r.text}\nRecovery: Outcome may be partial or unknown. Inspect current state before any new execution.` };
            }
            if (paused(ctl) || (r.isError && stopText.test(r.text))) halt='paused';
          }
        }
        messages.push({role:'tool',toolCallId:call.id,content:boundToolOutput(r.text)});
        if (r.imageDataUrl && !r.isError) messages.push({role:'user',content:'Visual preview for the preceding tool result:',imageDataUrl:r.imageDataUrl});
        emit({kind:'result',text:r.text,callId:call.id,tool:call.name,isError:!!r.isError});
      }
      if (halt) { emit({kind:'stop',text:halt}); return result(halt,`Agent stopped: ${halt}.`); }
    }
    emit({kind:'stop',text:uncertainEdit ? `Uncertain edit ${uncertainEdit} awaits read-back.` : 'Model-turn budget reached. Current transcript can be resumed after state reconciliation.'});
    return result('limit','Model-turn budget reached. Continue this task to inspect current document state and finish remaining work; completed edits must not be replayed.');
  } finally {
    ctl.claudeDone();
    active.delete(ctl);
  }
}

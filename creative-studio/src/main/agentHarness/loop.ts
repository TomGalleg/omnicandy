import type { AgentEvent, AgentOutcome, Message, ModelProvider } from './types';
import { ToolRegistry } from './registry';
import type { LiveTaskController } from '../liveTask';

const active = new WeakSet<LiveTaskController>();
const baseSystem = `You operate ONLY connected CreateCraft applications through approved tools. Call get_status before editing, use app_commands to discover exact commands, and inspect results before continuing. Never invent success. Human denials, pauses and takeovers are final; stop. Save versions only when the user requests it. Do not request shell, code execution or unlisted tools.`;
const nativeExtra = `\nUse new_document to start a blank document when available. Use look_at_document to inspect a visible preview when available and needed; it returns an image. Do not invent image contents.`;
const externalSystem = `

CreateCraft supports native Craft applications and external applications. get_status and app_commands describe only the native Craft applications. External applications (Blender, FreeCAD and any other non-Craft program) are found with external_apps, their supported commands with external_commands, and commands are run with external_command. When the user asks for Blender, FreeCAD or any other non-Craft application, call external_apps first, then external_commands for the chosen application, and execute only commands that external_commands returned, with the parameters it lists. Never invent external commands or parameters. Never assume an external application is unavailable because get_status does not list it; say it cannot be found only after external_apps has been checked.`;
/** The instructions for the tools that are really registered: external discovery is explained only when the external tools exist. */
export const buildSystemPrompt = (toolNames: readonly string[]): string =>
  baseSystem + (toolNames.includes('new_document') || toolNames.includes('look_at_document') ? nativeExtra : '') + (toolNames.includes('external_apps') && toolNames.includes('external_commands') && toolNames.includes('external_command') ? externalSystem : '');
const paused = (ctl: LiveTaskController) => {
  const c = ctl.snapshot().collab;
  return c.lockOwner === 'user' || ['manual','pausing','paused','awaiting_approval'].includes(c.phase);
};
const stopText = /stop and wait|do not retry|user declined|user paused|user cancelled|taken control|not available here/i;
export async function runAgent(args: { goal: string; provider: ModelProvider; registry: ToolRegistry; ctl: LiveTaskController; signal?: AbortSignal; maxTurns?: number; maxToolCalls?: number; onEvent?: (event: AgentEvent) => void; resumeMessages?: Message[] }): Promise<AgentOutcome> {
  const { provider, registry, ctl } = args;
  if (active.has(ctl) || ctl.snapshot().collab.activeOperation || ctl.snapshot().collab.phase === 'running') throw new Error('Another application task is already running.');
  if (paused(ctl)) throw new Error('User control or pause is active.');
  const messages: Message[] = args.resumeMessages ? structuredClone(args.resumeMessages) : [{ role: 'user', content: args.goal }];
  if (args.resumeMessages) {
    const fresh = registry.snapshot();
    const status = await registry.call(fresh, 'get_status', {});
    if (status.isError) throw new Error(`Cannot resume without current document status: ${status.text}`);
    messages.push({role:'user',content:`The user has completed manual changes and explicitly requested continuation. Reconcile the CURRENT application state against previous work. Do not replay finished actions. Ask for clarification if needed. Current status: ${status.text.slice(0,8000)}`});
  }
  active.add(ctl);
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent) => { events.push(e); args.onEvent?.(e); };
  const result = (status: AgentOutcome['status'], text: string): AgentOutcome => ({ status, text, messages, events });
  const maxTurns = Math.max(1, Math.min(args.maxTurns ?? 20, 100));
  const maxCalls = Math.max(1, Math.min(args.maxToolCalls ?? 50, 250));
  let calls = 0;
  // Guard against identical failed calls across model turns. Never retry or rewrite
  // commands locally: an error may follow a partially completed operation.
  const failedCalls = new Map<string, number>();
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (args.signal?.aborted) return result('cancelled', 'Cancelled.');
      if (paused(ctl)) return result('paused', 'User intervention is required.');
      const snapshot = registry.snapshot();
      if (turn === 0) emit({ kind: 'model', tool: 'tools', text: `Tools available to the model: ${snapshot.map((t) => t.name).join(', ') || '(none)'}` }); // names only
      let reply;
      try { reply = await provider.complete({ system: buildSystemPrompt(snapshot.map((t) => t.name)), messages, tools: snapshot.map(({name,description,parameters})=>({name,description,parameters})), signal: args.signal ?? new AbortController().signal }); }
      catch (e) {
        if (args.signal?.aborted) return result('cancelled', 'Cancelled.');
        const msg = e instanceof Error ? e.message : String(e);
        emit({kind:'error',text:msg}); return result('failed',msg);
      }
      messages.push({ role: 'assistant', content: reply.text, ...(reply.toolCalls.length ? {toolCalls:reply.toolCalls} : {}) });
      emit({kind:'model',text:reply.text ?? ''});
      if (!reply.toolCalls.length) return result('completed',reply.text ?? 'Model finished without a final message; verify the output.');
      // Complete *every* tool call in the assistant message with a matching tool result, even on stop.
      let halt: 'cancelled' | 'paused' | 'limit' | undefined;
      for (const call of reply.toolCalls) {
        if (!halt && args.signal?.aborted) halt='cancelled';
        if (!halt && paused(ctl)) halt='paused';
        if (!halt && calls >= maxCalls) halt='limit';
        let r;
        if (halt) r = {text:`Error: Not executed; agent ${halt}.`,isError:true};
        else {
          const signature = JSON.stringify([call.name, call.args]);
          if ((failedCalls.get(signature) ?? 0) >= 2) {
            r = { text: 'Error: Identical tool call already failed twice. Stop retrying; inspect the command schema or ask the user for help.', isError: true };
            halt = 'limit';
          } else {
            calls++;
            emit({kind:'tool',text:JSON.stringify(call.args).slice(0,2000),callId:call.id,tool:call.name});
            r = await registry.call(snapshot,call.name,call.args);
            if (r.isError && !stopText.test(r.text)) failedCalls.set(signature, (failedCalls.get(signature) ?? 0) + 1);
            if (paused(ctl) || (r.isError && stopText.test(r.text))) halt='paused';
          }
        }
        messages.push({role:'tool',toolCallId:call.id,content:r.text});
        if (r.imageDataUrl && !r.isError) messages.push({role:'user',content:'Visual preview for the preceding tool result:',imageDataUrl:r.imageDataUrl});
        emit({kind:'result',text:r.text,callId:call.id,tool:call.name,isError:!!r.isError});
      }
      if (halt) { emit({kind:'stop',text:halt}); return result(halt,`Agent stopped: ${halt}.`); }
    }
    return result('limit','Maximum model turns reached.');
  } finally {
    ctl.claudeDone();
    active.delete(ctl);
  }
}

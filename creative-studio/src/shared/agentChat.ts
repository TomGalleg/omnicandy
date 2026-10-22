// Chat view of an Independent AI task, so every AI panel reads like Claude's: your messages, the AI's own words, short "Running X in Y"
// lines for what it does, and plain notes when it stops. Pure and credential-free: tool arguments and tool output are never shown,
// only the command name, the application, and fixed plain-language reasons for failures.

import type { AgentChatItem, AgentUiEvent } from './agentHarness';
import { explainFailure } from './unifiedAgentPresentation';

export const MAX_CHAT_ITEMS = 300;
const MAX_TEXT = 4000;
/** The harness' own bookkeeping notes are emitted as model events; they are not something the AI said. */
const INTERNAL_NOTE = /^(Final response deferred|Fresh read-back recorded|A fresh trusted read-back|Tools available to the model)/;

/** "c:\program files\blender foundation\blender 4.0\blender.exe" -> "blender"; an adapter id or name stays as it is. */
function appLabel(ref: string): string {
  const last = ref.split(/[\\/]/).pop() ?? ref;
  return last.replace(/\.exe$/i, '').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40) || 'the app';
}

function toolLine(event: AgentUiEvent): string {
  const tool = /^[a-z][a-z0-9_]{0,63}$/.test(event.tool ?? '') ? event.tool! : 'a tool';
  if (tool === 'external_command' || tool === 'external_commands') {
    // The args text may be cut off, so read the two fields with patterns rather than parsing it as JSON.
    const command = /"command"\s*:\s*"([A-Za-z0-9_.-]{1,60})"/.exec(event.text)?.[1] ?? /"command_id"\s*:\s*"([A-Za-z0-9_.-]{1,60})"/.exec(event.text)?.[1];
    const app = /"app_key"\s*:\s*"((?:[^"\\]|\\.){1,200})"/.exec(event.text)?.[1];
    if (command) return `Running ${command}${app ? ` in ${appLabel(app.replace(/\\\\/g, '\\'))}` : ''}`;
    return tool === 'external_commands' ? 'Looking up the commands' : 'Running a command';
  }
  if (tool === 'external_apps') return 'Looking for external applications';
  if (tool === 'evidence_verify') return 'Checking the result';
  return `Running ${tool}`;
}

function stopNote(text: string): string | null {
  if (/unfinished plan steps|not yet verified complete/i.test(text)) return 'Stopped before every step was finished and verified. Send a message to carry on.';
  if (/^paused$/i.test(text)) return 'Paused. Send a message to carry on.';
  if (/^cancelled$/i.test(text)) return 'Stopped.';
  if (/^limit$/i.test(text)) return 'Reached its limit for this turn. Send a message to carry on.';
  if (/budget reached/i.test(text)) return 'Reached its step limit for this message. Send "continue" to carry on (the limits are under Limits and usage).';
  if (/uncertain edit/i.test(text)) return 'An earlier edit is waiting to be checked. Send a message to carry on; it will read the state back first.';
  return null;
}

/** The chat line for one agent event, or null when it is not worth showing. */
export function chatItemFromEvent(event: AgentUiEvent): Omit<AgentChatItem, 'id'> | null {
  if (event.kind === 'model') {
    const text = event.text.trim();
    if (!text || event.tool === 'tools' || INTERNAL_NOTE.test(text)) return null;
    return { role: 'assistant', text: text.slice(0, MAX_TEXT) };
  }
  if (event.kind === 'tool') return { role: 'activity', text: toolLine(event) };
  if (event.kind === 'result') {
    if (!event.isError) return null;
    const tool = /^[a-z][a-z0-9_]{0,63}$/.test(event.tool ?? '') ? event.tool! : 'a tool';
    return { role: 'activity', text: `${tool} did not work${explainFailure(event.text) ? `: ${explainFailure(event.text)}` : ''}` };
  }
  if (event.kind === 'error') return { role: 'error', text: (explainFailure(event.text) ?? event.text).slice(0, 400) };
  if (event.kind === 'stop') { const t = stopNote(event.text); return t ? { role: 'system', text: t } : null; }
  return null;
}

export function appendChat(chat: readonly AgentChatItem[] | undefined, item: Omit<AgentChatItem, 'id'> | null): AgentChatItem[] {
  const list = chat ? [...chat] : [];
  if (!item) return list;
  const last = list.at(-1);
  if (last && last.role === item.role && last.text === item.text && item.role !== 'user') return list; // no stutter
  const n = (list.at(-1) ? Number(list.at(-1)!.id.replace(/^c/, '')) : 0) + 1;
  list.push({ id: `c${n}`, ...item });
  return list.slice(-MAX_CHAT_ITEMS);
}

/** What the user typed; very long text (an approved plan sent from Home) is shortened for display only. */
export const userChatItem = (text: string): Omit<AgentChatItem, 'id'> => ({ role: 'user', text: text.length > 900 ? `${text.slice(0, 900).trimEnd()}…` : text });

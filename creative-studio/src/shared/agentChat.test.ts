import { describe, expect, it } from 'vitest';
import type { AgentUiEvent } from './agentHarness';
import { MAX_CHAT_ITEMS, appendChat, chatItemFromEvent, userChatItem } from './agentChat';

const KEY = 'c:\\program files\\blender foundation\\blender 4.0\\blender.exe';
const tool = (t: string, text: string): AgentUiEvent => ({ kind: 'tool', tool: t, text });

describe('chat view of an Independent AI task', () => {
  it('shows what the AI says and a short line for what it does, like the Claude panel', () => {
    expect(chatItemFromEvent({ kind: 'model', text: 'Now the flags on the tower roofs.' })).toEqual({ role: 'assistant', text: 'Now the flags on the tower roofs.' });
    expect(chatItemFromEvent(tool('external_command', `{"app_key":"${KEY}","command":"scene.build","params":{"file_name":"castle.blend","spec":{"batch_id":"b1"}}}`))).toEqual({ role: 'activity', text: 'Running scene.build in blender' });
    expect(chatItemFromEvent(tool('external_command', '{"app_key":"blender","command":"discover.search","params":{"name":"spe'))).toEqual({ role: 'activity', text: 'Running discover.search in blender' }); // cut-off args still read
    expect(chatItemFromEvent(tool('external_apps', '{}'))).toEqual({ role: 'activity', text: 'Looking for external applications' });
    expect(chatItemFromEvent(tool('evidence_verify', '{}'))).toEqual({ role: 'activity', text: 'Checking the result' });
    expect(chatItemFromEvent(tool('look_at_document', '{}'))).toEqual({ role: 'activity', text: 'Running look_at_document' });
  });
  it('never shows tool arguments, results or unsafe names', () => {
    const lines = [
      chatItemFromEvent(tool('../../etc/passwd', '{"apiKey":"SECRET"}')),
      chatItemFromEvent({ kind: 'result', tool: 'external_command', text: 'Error: validation: C:/Users/me/private-plan.blend is not in the Blender folder', isError: true }),
      chatItemFromEvent({ kind: 'result', tool: 'external_command', text: 'raw private file content', isError: true }),
      chatItemFromEvent(tool('external_command', '{"command":"scene.build","params":{"spec":{"note":"SECRET"}}}')),
    ];
    expect(JSON.stringify(lines)).not.toMatch(/SECRET|private|Users.me|etc/);
    expect(lines[1]).toEqual({ role: 'activity', text: 'external_command did not work: A command was refused because its settings were not valid.' });
    expect(lines[2]).toEqual({ role: 'activity', text: 'external_command did not work' });
  });
  it('hides the harness bookkeeping and successful results, and explains stops and errors in plain words', () => {
    expect(chatItemFromEvent({ kind: 'model', tool: 'tools', text: 'Tools available to the model: a, b' })).toBeNull();
    expect(chatItemFromEvent({ kind: 'model', text: 'Final response deferred: structured plan still contains unfinished steps.' })).toBeNull();
    expect(chatItemFromEvent({ kind: 'model', text: '   ' })).toBeNull();
    expect(chatItemFromEvent({ kind: 'result', tool: 'external_command', text: 'ok', isError: false })).toBeNull();
    expect(chatItemFromEvent({ kind: 'stop', text: 'Model stopped with unfinished plan steps; task remains resumable.' })).toEqual({ role: 'system', text: expect.stringMatching(/Send a message to carry on/) });
    expect(chatItemFromEvent({ kind: 'stop', text: 'paused' })).toMatchObject({ role: 'system' });
    expect(chatItemFromEvent({ kind: 'stop', text: 'Model-turn budget reached. Current transcript can be resumed after state reconciliation.' })).toEqual({ role: 'system', text: expect.stringMatching(/step limit.*Send "continue"/) });
    expect(chatItemFromEvent({ kind: 'stop', text: 'cancelled' })).toEqual({ role: 'system', text: 'Stopped.' });
    expect(chatItemFromEvent({ kind: 'stop', text: 'something internal' })).toBeNull();
    expect(chatItemFromEvent({ kind: 'error', text: 'Provider HTTP 429 (rate limit: too many tokens or requests per minute; wait a minute, then press Continue Task)' })).toEqual({ role: 'error', text: expect.stringContaining('Provider HTTP 429') });
  });
  it('appends with stable ids, no stutter, and a cap', () => {
    let chat = appendChat([], userChatItem('build a castle'));
    chat = appendChat(chat, { role: 'activity', text: 'Running scene.build in blender' });
    chat = appendChat(chat, { role: 'activity', text: 'Running scene.build in blender' }); // an identical neighbour is not repeated
    expect(chat.map((c) => c.id)).toEqual(['c1', 'c2']);
    chat = appendChat(chat, userChatItem('again')); chat = appendChat(chat, userChatItem('again')); // the user may repeat themselves
    expect(chat.length).toBe(4);
    let big = chat;
    for (let i = 0; i < MAX_CHAT_ITEMS + 50; i++) big = appendChat(big, { role: 'assistant', text: `message ${i}` });
    expect(big.length).toBe(MAX_CHAT_ITEMS);
    expect(big.at(-1)!.text).toBe(`message ${MAX_CHAT_ITEMS + 49}`);
    expect(appendChat(undefined, null)).toEqual([]);
  });
  it('shortens a very long user message for display only', () => {
    expect(userChatItem('short')).toEqual({ role: 'user', text: 'short' });
    const long = userChatItem('x'.repeat(3000));
    expect(long.text.length).toBeLessThan(910);
    expect(long.text.endsWith('…')).toBe(true);
  });
});

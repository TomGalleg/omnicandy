// Regression: a real Independent AI castle run reported "the connection to Blender was lost" and built nothing while Blender
// was running and healthy. The agent only accepted the application key byte for byte (a long Windows path that models
// mangle) and reported EVERY mismatch as "Application disconnected or unavailable. Stop and ask the user to reconnect."
import { describe, expect, it } from 'vitest';
import type { CommandResult, ExternalAppInfo } from '@shared/integrations';
import { BLENDER_MANIFEST } from '../integrations/adapters/blender';
import { classifyCommandError } from './commandPreflight';
import { addExternalTools, externalTools, resolveApplication } from './externalTools';
import { runAgent } from './loop';
import { ScriptedProvider } from './providers/scripted';
import { ToolRegistry } from './registry';
import type { LiveTaskController } from '../liveTask';
import type { Message, ProviderReply } from './types';

const KEY = 'c:\\program files\\blender foundation\\blender 4.0\\blender.exe';
const UE = 'e:\\ue_5.4\\engine\\binaries\\win64\\unrealeditor.exe';
const call = (id: string, name: string, args: unknown): ProviderReply => ({ text: null, toolCalls: [{ id, name, args }] });
const final: ProviderReply = { text: 'done', toolCalls: [] };
const idle = () => ({ snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined }) as unknown as LiveTaskController;
const texts = (m: Message[]) => m.filter((x) => x.role === 'tool').map((x) => x.content);

const app = (key: string, name: string, adapterId: string, status = 'connected'): ExternalAppInfo =>
  ({ key, name, status, statusDetail: status === 'connected' ? 'Connected and healthy.' : 'Ready to connect.', adapterId, adapterName: name, commands: BLENDER_MANIFEST.commands }) as unknown as ExternalAppInfo;

function rig(apps: ExternalAppInfo[]) {
  const executed: Array<{ key: string; command: string }> = [];
  const backend = {
    list: async () => apps,
    isBuiltin: (id: string) => id === 'blender',
    execute: async (k: string, command: string): Promise<CommandResult> => { executed.push({ key: k, command }); return { ok: true, verified: true, message: 'ok', evidence: [], outputs: [], durationMs: 1, data: { details: [] } }; },
  } as unknown as Parameters<typeof addExternalTools>[1];
  return { backend, executed };
}
const inspect = (id: string, appKey: string) => call(id, 'external_command', { app_key: appKey, command: 'scene.inspect', params: { file_name: 'a.blend' } });

describe('the application a model names', () => {
  const apps = [app(KEY, 'Blender', 'blender'), app(UE, 'Unreal Editor', 'custom.unreal-editor')];
  it('is found despite the usual mangling of a Windows path key, by adapter id or by name', () => {
    for (const ref of [KEY, KEY.toUpperCase(), 'C:\\Program Files\\Blender Foundation\\Blender 4.0\\blender.exe', 'c:/program files/blender foundation/blender 4.0/blender.exe',
      'c:\\\\program files\\\\blender foundation\\\\blender 4.0\\\\blender.exe', `  ${KEY} `, 'blender', 'Blender'])
      expect(resolveApplication(apps, ref), ref).toMatchObject({ app: { key: KEY } });
    expect(resolveApplication(apps, 'Unreal Editor')).toMatchObject({ app: { key: UE } });
  });
  it('is never guessed: an unknown or ambiguous reference is explained, and is not called a lost connection', () => {
    const unknown = resolveApplication(apps, 'maya') as { error: string };
    expect(unknown.error).toContain('no connected application matches "maya"');
    expect(classifyCommandError(unknown.error)).toBe('validation'); // a wrong reference is a refusal before anything runs, never an uncertain edit
    expect(unknown.error).toContain(JSON.stringify(KEY));
    expect(unknown.error).toContain('not a lost connection');
    expect(unknown.error).not.toMatch(/disconnected|stop and/i);
    const twin = [app(KEY, 'Blender', 'blender'), app('d:\\blender 3.6\\blender.exe', 'Blender', 'blender')];
    const ambiguous = resolveApplication(twin, 'blender') as { error: string };
    expect(ambiguous.error).toContain('matches several connected applications');
    expect(classifyCommandError(ambiguous.error)).toBe('validation');
    expect(classifyCommandError((resolveApplication([app(KEY, 'Blender', 'blender', 'available')], 'blender') as { error: string }).error)).not.toBe('execution');
    expect(ambiguous.error).toContain('d:\\\\blender 3.6');
    expect(resolveApplication(twin, KEY)).toMatchObject({ app: { key: KEY } }); // the exact key always wins
  });
  it('says so, and asks the agent to stop, only when the application really is not connected', () => {
    const down = resolveApplication([app(KEY, 'Blender', 'blender', 'available')], 'blender') as { error: string };
    expect(down.error).toContain('Blender is not connected (status: available');
    expect(down.error).toMatch(/stop and wait/i);
    expect((resolveApplication([], KEY) as { error: string }).error).toMatch(/No external application is connected\. Stop and wait/);
  });
});

describe('Independent AI commands with a mangled application key', () => {
  it('run against the real application, with the real key reaching the backend', async () => {
    const r = rig([app(KEY, 'Blender', 'blender'), app(UE, 'Unreal Editor', 'custom.unreal-editor')]);
    const out = await runAgent({ goal: 'inspect', ctl: idle(), registry: addExternalTools(new ToolRegistry(), r.backend),
      provider: new ScriptedProvider([inspect('1', 'C:/Program Files/Blender Foundation/Blender 4.0/blender.exe'), inspect('2', 'blender'), call('3', 'external_commands', { app_key: 'Blender', command_id: 'scene.build' }), final]) });
    expect(r.executed).toEqual([{ key: KEY, command: 'scene.inspect' }, { key: KEY, command: 'scene.inspect' }]);
    expect(texts(out.messages)[2]).toContain('"id":"scene.build"');
    expect(texts(out.messages).some((t) => /disconnected|not connected/i.test(t))).toBe(false);
  });
  it('treat a trusted inspection through a mangled key as read-only, and an edit as an edit', async () => {
    const tools = externalTools(rig([app(KEY, 'Blender', 'blender')]).backend);
    const ext = tools.find((t) => t.name === 'external_command') as unknown as { readOnly: (a: unknown) => Promise<boolean> };
    expect(await ext.readOnly({ app_key: 'BLENDER', command: 'scene.inspect_detail' })).toBe(true);
    expect(await ext.readOnly({ app_key: 'BLENDER', command: 'scene.build' })).toBe(false);
    expect(await ext.readOnly({ app_key: 'maya', command: 'scene.inspect_detail' })).toBe(false);
  });
  it('keep going after a wrong reference (the model can correct it) but stop at once when the application is really not connected', async () => {
    const wrong = rig([app(KEY, 'Blender', 'blender')]);
    const a = await runAgent({ goal: 'inspect', ctl: idle(), registry: addExternalTools(new ToolRegistry(), wrong.backend), provider: new ScriptedProvider([inspect('1', 'maya'), inspect('2', KEY), final]) });
    expect(a.status).not.toBe('paused'); // the model corrected the key and carried on
    expect(wrong.executed).toEqual([{ key: KEY, command: 'scene.inspect' }]);
    expect(texts(a.messages)[0]).toContain('not a lost connection');

    // an EDIT with a wrong key is refused before dispatch: no uncertain edit, no lock, the corrected call goes through
    const edit = rig([app(KEY, 'Blender', 'blender')]);
    const spec = { batch_id: 'b1', objects: [{ id: 'a', kind: 'box' }] };
    const build = (id: string, k: string) => call(id, 'external_command', { app_key: k, command: 'scene.build', params: { file_name: 'a.blend', spec } });
    const e = await runAgent({ goal: 'build', ctl: idle(), registry: addExternalTools(new ToolRegistry(), edit.backend), provider: new ScriptedProvider([build('1', 'maya'), build('2', 'blender'), final]) });
    expect(edit.executed).toEqual([{ key: KEY, command: 'scene.build' }]);
    expect(texts(e.messages).some((t) => t.includes('edits remain blocked'))).toBe(false);

    const down = rig([app(KEY, 'Blender', 'blender', 'available')]);
    const b = await runAgent({ goal: 'inspect', ctl: idle(), registry: addExternalTools(new ToolRegistry(), down.backend), provider: new ScriptedProvider([inspect('1', KEY), inspect('2', KEY), inspect('3', KEY), final]) });
    expect(b.status).toBe('paused'); // no more attempts against an application that cannot answer
    expect(down.executed).toEqual([]);
    expect(texts(b.messages)).toHaveLength(1);
    expect(texts(b.messages)[0]).toContain('Blender is not connected');
  });
});

// "Claude-style" mode for the other AIs: Claude's discovery and wording, short instructions, and no plan/verification gate on finishing.
// Approvals, the edit journal, recovery locks and a command's own read-back are unchanged (covered by their own tests).
import { describe, expect, it } from 'vitest';
import type { CommandResult, ExternalAppInfo } from '@shared/integrations';
import { agentBudgetSchema } from './executionBudget';
import { BLENDER_MANIFEST } from '../integrations/adapters/blender';
import { addExternalTools, externalTools } from './externalTools';
import { buildSystemPrompt, runAgent } from './loop';
import { ScriptedProvider } from './providers/scripted';
import { ToolRegistry } from './registry';
import type { ProviderReply } from './types';
import type { LiveTaskController } from '../liveTask';

const KEY = 'c:\\program files\\blender foundation\\blender 4.0\\blender.exe';
const app = { key: KEY, name: 'Blender', status: 'connected', adapterId: 'blender', adapterName: 'Blender', commands: BLENDER_MANIFEST.commands } as unknown as ExternalAppInfo;
const idle = () => ({ snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined }) as unknown as LiveTaskController;
const call = (id: string, name: string, args: unknown): ProviderReply => ({ text: null, toolCalls: [{ id, name, args }] });
const say = (text: string): ProviderReply => ({ text, toolCalls: [] });
const backend = () => {
  const executed: string[] = [];
  const b = { list: async () => [app], isBuiltin: (id: string) => id === 'blender',
    execute: async (_k: string, command: string): Promise<CommandResult> => { executed.push(command); return { ok: true, verified: true, message: 'ok', evidence: [], outputs: [], durationMs: 1, data: {} }; } } as unknown as Parameters<typeof addExternalTools>[1];
  return { b, executed };
};
const textOf = async (tools: ReturnType<typeof externalTools>, name: string, args: unknown) => (await (tools.find((t) => t.name === name) as unknown as { execute: (a: unknown) => Promise<{ text: string } | string> }).execute(args));
const asText = (r: { text: string } | string) => typeof r === 'string' ? r : r.text;

describe('Claude-style discovery', () => {
  it('offers external_apps (applications, then one application\'s commands), external_command and external_job - no separate command search', () => {
    expect(externalTools(backend().b, { claudeStyle: true }).map((t) => t.name).sort()).toEqual(['external_apps', 'external_command']);
    expect(externalTools(backend().b).map((t) => t.name)).toEqual(expect.arrayContaining(['external_apps', 'external_commands', 'external_command'])); // strict mode unchanged
  });
  it('lists the connected applications, then that application\'s commands with their settings in one compact answer, even for a mangled key', async () => {
    const tools = externalTools(backend().b, { claudeStyle: true });
    const list = JSON.parse(asText(await textOf(tools, 'external_apps', {})));
    expect(list.applications).toEqual([{ app_key: KEY, name: 'Blender', status: 'connected', commands: BLENDER_MANIFEST.commands.length }]);
    const text = asText(await textOf(tools, 'external_apps', { app_key: 'Blender' }));
    expect(text.startsWith('Blender (app_key "c:\\\\program files')).toBe(true);
    const has = (prefix: string) => text.split(String.fromCharCode(10)).some((l) => l.startsWith(prefix));
    for (const id of ['scene.create_basic', 'scene.build', 'scene.inspect_detail', 'script.run', 'scene.viewport', 'discover.search']) expect(has(id + ' - ') || has(id + ' ['), id).toBe(true);
    expect(has('  spec: json (required): ') && text.includes('Example (a tower with a roof)')).toBe(true); // the example survives: it is what small models copy
    expect(has('  file_name: string (required): ')).toBe(true);
    expect(has('script.run [asks you every time]')).toBe(true);
    expect(text.length).toBeLessThan(11_500); // fits the model-visible tool output limit, so nothing is cut off
    await expect(textOf(tools, 'external_apps', { app_key: 'maya' })).rejects.toThrow(/no connected application matches "maya"/);
  });
  it('runs commands exactly as before (the same preflight, approval path and journal-relevant tool name)', async () => {
    const r = backend();
    const out = await runAgent({ goal: 'x', ctl: idle(), registry: addExternalTools(new ToolRegistry(), r.b, { claudeStyle: true }), relaxed: true,
      provider: new ScriptedProvider([call('1', 'external_command', { app_key: 'blender', command: 'scene.create_basic', params: { file_name: 'a.blend' } }), say('Created.')]) });
    expect(r.executed).toEqual(['scene.create_basic']);
    expect(out.status).toBe('completed');
  });
});

describe('relaxed finishing', () => {
  const goal = 'Project "Castle". The user asked for: a castle\n\nPlan the user approved:\nAn editable Blender project.\n\n1. Create the project\n2. Build towers\n3. Save\n\nApproved. Start working now.';
  it('lets the AI finish when it is done: no plan seeding, no nudges, no verification gate; the strict default still gates', async () => {
    const r = backend();
    const relaxed = await runAgent({ goal, ctl: idle(), relaxed: true, registry: addExternalTools(new ToolRegistry(), r.b, { claudeStyle: true }),
      provider: new ScriptedProvider([call('1', 'external_command', { app_key: KEY, command: 'scene.create_basic', params: { file_name: 'a.blend' } }), say('The castle is built.')]) });
    expect(relaxed.status).toBe('completed'); // a change was made and never separately verified, and no plan step was ticked
    expect(relaxed.plan?.steps ?? []).toEqual([]);
    expect(relaxed.messages.some((m) => m.role === 'user' && /still has unfinished steps|recorded as \d+ task steps|no passing evidence_verify/.test(m.content))).toBe(false);
    const strict = await runAgent({ goal, ctl: idle(), registry: addExternalTools(new ToolRegistry(), backend().b),
      provider: new ScriptedProvider([call('1', 'external_command', { app_key: KEY, command: 'scene.create_basic', params: { file_name: 'a.blend' } }), say('The castle is built.'), say('done'), say('done'), say('done')]) });
    expect(strict.status).toBe('limit');
  });
  it('does not advertise the plan bookkeeping tools, but keeps evidence_verify for recovery', async () => {
    const seen: string[][] = [];
    const provider = { id: 'spy', supportsVision: false, complete: async (i: { tools: Array<{ name: string }> }) => { seen.push(i.tools.map((t) => t.name)); return say('hi'); } };
    await runAgent({ goal: 'x', ctl: idle(), relaxed: true, registry: addExternalTools(new ToolRegistry(), backend().b, { claudeStyle: true }), provider });
    expect(seen[0]).toEqual(expect.arrayContaining(['evidence_verify', 'external_apps', 'external_command']));
    expect(seen[0]).not.toContain('task_plan');
    expect(seen[0]).not.toContain('evidence_receipts');
  });
});

describe('Claude-style instructions', () => {
  const tools = ['external_apps', 'external_command', 'external_job', 'get_status', 'app_command'];
  it('are short, plain and about doing the job, with the Blender workflow, and smaller than the strict rulebook', () => {
    const relaxed = buildSystemPrompt(tools, true);
    const strict = buildSystemPrompt(tools, false);
    expect(relaxed).toMatch(/carry it out all the way to the end/);
    expect(relaxed).toMatch(/call external_apps to see what is connected, then external_apps with an app_key/);
    expect(relaxed).toMatch(/scene\.build.*scene\.inspect_detail.*never use save_version for Blender/s);
    expect(relaxed).not.toMatch(/evidence_verify|task_plan|receipt/i); // none of the verification rulebook
    expect(relaxed.length).toBeLessThan(strict.length * 0.8);
    expect(buildSystemPrompt(['get_status'], true)).not.toMatch(/Blender/); // external guidance only when external tools exist
  });
});

describe('the budget carries the choice', () => {
  it('accepts strictVerification and still rejects unknown fields', () => {
    expect(agentBudgetSchema.safeParse({ maxTurns: 20, strictVerification: true }).success).toBe(true);
    expect(agentBudgetSchema.safeParse({ strictVerification: 'yes' }).success).toBe(false);
    expect(agentBudgetSchema.safeParse({ relaxed: true }).success).toBe(false);
  });
});

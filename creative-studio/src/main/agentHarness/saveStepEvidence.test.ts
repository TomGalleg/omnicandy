// Regression: the agent could not finish the last step of a Blender task ("save the complete project as a .blend file") because every
// step whose title says save/export demanded a save_version receipt, which only exists for the native Craft apps ("Open a file in the
// Edit tab first"). A Blender project is saved by Blender's own commands; the proof is the saved file read back in a fresh process.
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry';
import { registerTaskPlan } from './taskPlan';

function rig() {
  const registry = new ToolRegistry();
  const control = registerTaskPlan(registry, 'castle', undefined, () => undefined);
  const run = (name: string, args: unknown) => registry.call(registry.snapshot(), name, args);
  const inspect = (command: string) => control.record('external_command', '{}', true, { command, params: { file_name: 'castle.blend' } }, true, { ok: true, data: { project: { file: 'castle.blend' }, object_count: 12 } });
  const verify = async (receipt: string) => JSON.parse((await run('evidence_verify', { receipt_id: receipt, path: 'data.object_count', expected: 12 })).text) as { id: string; passed: boolean };
  const complete = (title: string, verificationIds: string[]) => run('task_plan', { steps: [{ id: 'step7', title, status: 'completed', evidence: 'read back', verificationIds }] });
  return { control, inspect, verify, complete };
}

describe('completing a save step', () => {
  it('accepts the saved .blend file read back by a fresh process (scene.inspect_detail) as proof that a Blender project was saved', async () => {
    const t = rig();
    const check = await t.verify(t.inspect('scene.inspect_detail')!);
    expect(check.passed).toBe(true);
    const r = await t.complete('Render a preview, and save the complete project as a .blend file', [check.id]);
    expect(r.isError, r.text).toBeFalsy();
    expect(t.control.snapshot().steps[0]!.status).toBe('completed');
  });
  it('does not accept a read-back that is not of the saved file, or a plain claim', async () => {
    const t = rig();
    const window = await t.verify(t.inspect('scene.inspect')!); // reads the open window, which may hold unsaved edits
    const r = await t.complete('Save the project as a .blend file', [window.id]);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/requires a confirmed new-version save_version receipt/);
    expect(r.text).toMatch(/external application such as Blender.*scene.inspect_detail.*verificationIds/); // names the way out for Blender
    const none = await t.complete('Save the project as a .blend file', []);
    expect(none.isError).toBe(true);
  });
  it('still requires the save_version receipt for the native apps, and leaves non-save steps alone', async () => {
    const t = rig();
    const check = await t.verify(t.inspect('scene.inspect_detail')!);
    const native = await t.complete('Save a new version of the poster', []); // no verification at all
    expect(native.isError).toBe(true);
    const plain = await t.complete('Add four towers', [check.id]);
    expect(plain.isError, plain.text).toBeFalsy();
  });
});

describe('a model that keeps calling save_version while working in Blender', () => {
  it('is told once, in the tool result, that save_version does not apply and what to do instead', async () => {
    const { runAgent } = await import('./loop');
    const { ScriptedProvider } = await import('./providers/scripted');
    const { z } = await import('zod');
    const { tool } = await import('./registry');
    const registry = new ToolRegistry([
      tool('save_version', 'save', z.object({}).strict(), async () => { throw new Error('Open a file in the Edit tab first.'); }),
      tool('external_command', 'external', z.object({}).passthrough(), async () => 'ok'),
    ]);
    const ctl = { snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined } as never;
    const r = await runAgent({ goal: 'save it', ctl, registry, provider: new ScriptedProvider([{ text: null, toolCalls: [{ id: '1', name: 'save_version', args: {} }] }, { text: 'done', toolCalls: [] }]) });
    const text = r.messages.filter((m) => m.role === 'tool').map((m) => m.content)[0]!;
    expect(text).toMatch(/Open a file in the Edit tab first/);
    expect(text).toMatch(/save_version does not apply to an external application such as Blender.*scene\.inspect_detail/);
  });
});

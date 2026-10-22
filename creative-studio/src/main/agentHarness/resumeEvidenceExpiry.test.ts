// Regression: after Continue Task the model kept citing a verification ID from the earlier run ("v4") to complete a plan step and
// got an opaque validation error every time, then gave up ("a workflow system limitation"). Receipt and verification IDs belong to one run;
// the model is now told so on resume, and the errors say what to do.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent } from './loop';
import { ScriptedProvider } from './providers/scripted';
import { ToolRegistry, tool } from './registry';
import type { Message, ProviderReply } from './types';
import type { LiveTaskController } from '../liveTask';

const idle = () => ({ snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined }) as unknown as LiveTaskController;
const call = (id: string, name: string, args: unknown): ProviderReply => ({ text: null, toolCalls: [{ id, name, args }] });
const final: ProviderReply = { text: 'done', toolCalls: [] };
const texts = (m: Message[]) => m.filter((x) => x.role === 'tool').map((x) => x.content);
const withStatus = () => new ToolRegistry([tool('get_status', 'status', z.object({}).strict(), async () => 'current')]);

describe('IDs from before a Continue Task', () => {
  const plan = { goal: 'castle', steps: [{ id: 'step1', title: 'Start a new Blender project', status: 'active' as const }] };
  const complete = (id: string, verification: string) => call(id, 'task_plan', { steps: [{ id: 'step1', title: 'Start a new Blender project', status: 'completed', evidence: 'verified earlier', verificationIds: [verification] }] });

  it('are refused with an explanation of what to do instead (inspect again, evidence_verify, cite the new ID)', async () => {
    const r = await runAgent({ goal: 'castle', ctl: idle(), registry: withStatus(), provider: new ScriptedProvider([complete('1', 'v4'), final, final, final, final]),
      resumePlan: plan, resumeMessages: [{ role: 'user', content: 'castle' }], maxTurns: 6 });
    const err = texts(r.messages)[0]!;
    expect(err).toMatch(/from THIS run/);
    expect(err).toMatch(/before a Continue Task are no longer valid: take a fresh read-only inspection now, run evidence_verify on it, and cite that new ID/);
    expect(r.plan?.steps[0]?.status).toBe('active'); // never accepted on the strength of an old ID
  });

  it('are announced to the model when a task is resumed, with the instruction to resend the whole step list', async () => {
    const r = await runAgent({ goal: 'castle', ctl: idle(), registry: withStatus(), provider: new ScriptedProvider([final, final, final, final]),
      resumePlan: plan, resumeMessages: [{ role: 'user', content: 'castle' }], maxTurns: 6 });
    const notice = r.messages.find((m) => m.role === 'user' && m.content.includes('have EXPIRED'));
    expect(notice?.content).toMatch(/verification ID from a read-back taken in THIS run/);
    expect(notice?.content).toMatch(/Send the complete step list every time/);
  });

  it('a fresh task has no such notice', async () => {
    const r = await runAgent({ goal: 'say hello', ctl: idle(), registry: new ToolRegistry(), provider: new ScriptedProvider([final]) });
    expect(r.messages.some((m) => m.role === 'user' && m.content.includes('have EXPIRED'))).toBe(false);
  });
});

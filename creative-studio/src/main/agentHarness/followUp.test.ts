// A chat message continues the SAME conversation: no "continue after an interruption" boilerplate, the transcript is kept, and the
// safety rules (plan not finished, unverified changes, expired evidence IDs) still apply.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent } from './loop';
import { ScriptedProvider } from './providers/scripted';
import { ToolRegistry, tool } from './registry';
import type { Message, ProviderReply } from './types';
import type { TaskPlan } from './taskPlan';
import type { LiveTaskController } from '../liveTask';

const idle = () => ({ snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined }) as unknown as LiveTaskController;
const registry = () => new ToolRegistry([tool('get_status', 'status', z.object({}).strict(), async () => 'current')]);
const say = (text: string): ProviderReply => ({ text, toolCalls: [] });
const previous: Message[] = [{ role: 'user', content: 'build a castle' }, { role: 'assistant', content: 'I built the towers.' }];
const userTexts = (m: Message[]) => m.filter((x) => x.role === 'user').map((x) => x.content);

describe('a chat follow-up', () => {
  it('appends the user words to the kept conversation instead of the interruption boilerplate', async () => {
    const r = await runAgent({ goal: 'build a castle', ctl: idle(), registry: registry(), provider: new ScriptedProvider([say('Done, roofs are red.')]), resumeMessages: previous, followUp: 'make the roofs red' });
    expect(userTexts(r.messages)).toEqual(['build a castle', 'make the roofs red']); // nothing else was injected into a plain follow-up
    expect(r.messages[1]).toEqual({ role: 'assistant', content: 'I built the towers.' }); // the earlier conversation is intact
    expect(r.status).toBe('completed');
  });
  it('still tells the model that evidence IDs expired when a plan is involved, and still enforces an unfinished plan', async () => {
    const plan: TaskPlan = { goal: 'castle', steps: [{ id: 'step1', title: 'Add roofs', status: 'active' }] };
    const r = await runAgent({ goal: 'castle', ctl: idle(), registry: registry(), provider: new ScriptedProvider([say('ok'), say('ok'), say('ok'), say('ok')]), resumeMessages: previous, resumePlan: plan, followUp: 'carry on', maxTurns: 6 });
    const texts = userTexts(r.messages);
    expect(texts.some((t) => t.includes('have EXPIRED'))).toBe(true);
    expect(texts.indexOf('carry on')).toBeGreaterThan(texts.findIndex((t) => t.includes('have EXPIRED'))); // the user words come after the resume notes
    expect(r.status).toBe('limit'); // a follow-up does not bypass the plan rule
    expect(r.text).toMatch(/Remaining plan steps/);
  });
  it('without followUp (Continue Task) the original interruption note is still used', async () => {
    const r = await runAgent({ goal: 'build a castle', ctl: idle(), registry: registry(), provider: new ScriptedProvider([say('ok')]), resumeMessages: previous });
    expect(userTexts(r.messages).some((t) => t.includes('requested continuation after an interruption'))).toBe(true);
  });
});

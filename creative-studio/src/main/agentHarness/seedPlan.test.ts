// The plan a user approved on Home becomes the task plan up front: it survives a pause or limit with the task, and the agent cannot
// finish while its steps are unfinished. (A real run ended as "completed" with 0 plan steps while most of the castle was still to do.)
import { describe, expect, it } from 'vitest';
import { runAgent } from './loop';
import { ScriptedProvider } from './providers/scripted';
import { z } from 'zod';
import { ToolRegistry, tool } from './registry';
import { seedPlanFromGoal, type TaskPlan } from './taskPlan';
import type { LiveTaskController } from '../liveTask';

const idle = () => ({ snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined }) as unknown as LiveTaskController;
const goal = (steps: string[], extra = '') => `Project "Castle". The user asked for: build a castle\n\nPlan the user approved:\nAn editable Blender project.\n\nA castle with towers.\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}${extra}\n\nApproved. Start working on this project now, following the plan.`;

describe('seeding the task plan from the approved plan', () => {
  it('turns the numbered steps into plan steps, the first one active', () => {
    const plan = seedPlanFromGoal(goal(['Create the project', 'Model four towers', 'Add roofs']))!;
    expect(plan.steps).toEqual([
      { id: 'step1', title: 'Create the project', status: 'active' },
      { id: 'step2', title: 'Model four towers', status: 'pending' },
      { id: 'step3', title: 'Add roofs', status: 'pending' },
    ]);
    expect(plan.goal).toContain('Plan the user approved');
  });
  it('stops at the open-question answers, caps the count and the title length, and ignores goals without a plan', () => {
    const withAnswers = goal(['One', 'Two'], "\n\nThe user's answers to the open questions: 1. use blue roofs");
    expect(seedPlanFromGoal(withAnswers)!.steps.map((s) => s.title)).toEqual(['One', 'Two']);
    expect(seedPlanFromGoal(goal(Array.from({ length: 30 }, (_, i) => `Step ${i}`)))!.steps.length).toBe(20);
    expect(seedPlanFromGoal(goal(['x'.repeat(400)]))!.steps[0]!.title.length).toBe(180);
    expect(seedPlanFromGoal('make three circles in PhotoCraft')).toBeUndefined();
    expect(seedPlanFromGoal('Plan the user approved:\nno numbered lines here\n\nApproved.')).toBeUndefined();
  });
});

describe('the agent and a seeded plan', () => {
  const final = { text: 'All done!', toolCalls: [] };
  it('shows the plan at once and cannot finish while its steps are unfinished: the task stays resumable with the plan kept', async () => {
    const seen: TaskPlan[] = [];
    const r = await runAgent({ goal: goal(['Create the project', 'Model four towers', 'Add roofs']), ctl: idle(), registry: new ToolRegistry(), provider: new ScriptedProvider([final, final, final, final]), onPlan: (p) => seen.push(p) });
    expect(seen[0]!.steps.length).toBe(3); // visible before any work
    expect(r.status).toBe('limit'); // not "completed": Continue Task is enabled
    expect(r.text).toMatch(/Remaining plan steps: step1 \(active\): Create the project; step2 \(pending\)/);
    expect(r.plan?.steps.map((s) => s.title)).toEqual(['Create the project', 'Model four towers', 'Add roofs']); // what the checkpoint saves
    expect(r.messages.some((m) => m.role === 'user' && m.content.includes('recorded as 3 task steps'))).toBe(true);
    const nudges = r.messages.filter((m) => m.role === 'user' && m.content.includes('still has unfinished steps'));
    expect(nudges.length).toBe(3); // three nudges to act, then it stops resumable
    expect(nudges[1]!.content).toMatch(/answered with text again.*next reply must be a tool call for step1/);
  });
  it('leaves tasks without a plan, and resumed tasks with their own saved plan, alone', async () => {
    const plain = await runAgent({ goal: 'say hello', ctl: idle(), registry: new ToolRegistry(), provider: new ScriptedProvider([final]) });
    expect(plain.status).toBe('completed');
    const saved: TaskPlan = { goal: 'g', steps: [{ id: 'mine', title: 'My saved step', status: 'completed', evidence: 'verified earlier' }] };
    const withStatus = new ToolRegistry([tool('get_status', 'status', z.object({}).strict(), async () => 'current')]);
    const resumed = await runAgent({ goal: goal(['A', 'B']), ctl: idle(), registry: withStatus, provider: new ScriptedProvider([final]), resumePlan: saved, resumeMessages: [{ role: 'user', content: 'x' }] });
    expect(resumed.plan?.steps.map((s) => s.id)).toEqual(['mine']);
  });
});

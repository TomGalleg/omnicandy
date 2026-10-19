// "Plan with an AI" fills in the whole plan: project brief, milestones, accepted requirements, decisions (with reasons), tasks under milestones,
// open questions, ideas and references. Reading an answer only makes a preview; nothing joins the plan until the owner accepts it.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProposalChange } from '@shared/planner';
import { chatSystemPrompt, starterMessage } from '@shared/plannerChat';
import { brainstormText } from '@shared/plannerContext';
import { changesThePlan, describeChange, parseSuggestionText } from '@shared/plannerPaste';
import { PlannerService, userCtx } from './service';
import { PlannerStore } from './store';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-fill-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const user = userCtx();
let n = 0;
const rig = async (input: Parameters<PlannerService['createProject']>[1] = { title: 'Poster', goal: 'A dragon poster' }) => {
  const svc = new PlannerService(new PlannerStore(path.join(tmp, `s${++n}`)));
  const p = await svc.createProject(user, input);
  return { svc, p };
};

const ANSWER = `Here is a plan.

## Project brief
Goal: A print-ready dragon poster for the school fair.
Description: A poster of a friendly dragon in teal and gold, readable from three metres away.
Scope: One A2 poster. No animation.
Constraints:
- Must print on a school printer
- Finished by 1 December
Deliverables:
- Print-ready PDF
- Editable source file

## Milestones
- Sketches approved — due 2026-11-10
- Final artwork (by week 6)
- Print files

## Requirements
- Use only teal, gold and cream — why: it matches the school colours
- Text is at least 48 pt

## Decisions
- A2 portrait — why: it fits the school frames

## Tasks
- Draw three sketches (milestone: Sketches approved)
  - Three different dragon poses exist
- Paint the final artwork (milestone: Final artwork)
- Export the PDF (milestone: Print files)

## Questions
- Who approves the final poster?

## Ideas
- Add a small QR code to the fair page

## References
- Poster size guide — https://example.org/poster-sizes
- [Colour contrast checker](https://example.org/contrast) for the text
- A book on dragon anatomy
`;

describe('reading an answer that fills in the whole plan', () => {
  const prev = parseSuggestionText(ANSWER);
  const ops = (f: (c: ProposalChange) => boolean) => prev.changes.filter(f);

  it('finds every section, in a sensible order, with no errors', () => {
    expect(prev.errors).toEqual([]);
    expect(prev.format).toBe('markdown');
    const kinds = prev.changes.map((c) => (c.op === 'add_item' ? c.itemType : c.op === 'set_brief' ? 'brief' : c.op === 'add_milestone' ? 'milestone' : 'task'));
    expect(kinds[0]).toBe('brief');
    expect(kinds.lastIndexOf('brief')).toBeLessThan(kinds.indexOf('milestone'));
    expect(kinds.lastIndexOf('milestone')).toBeLessThan(kinds.indexOf('requirement'));
    expect(kinds.lastIndexOf('reference')).toBe(kinds.length - 1);
    expect(new Set(kinds)).toEqual(new Set(['brief', 'milestone', 'requirement', 'decision', 'task', 'question', 'idea', 'reference']));
  });

  it('reads the brief as one suggestion per part, with lists kept as lists', () => {
    const brief = ops((c) => c.op === 'set_brief').map((c) => (c as Extract<ProposalChange, { op: 'set_brief' }>).patch);
    expect(brief).toEqual([
      { goal: 'A print-ready dragon poster for the school fair.' },
      { description: 'A poster of a friendly dragon in teal and gold, readable from three metres away.' },
      { scope: 'One A2 poster. No animation.' },
      { constraints: ['Must print on a school printer', 'Finished by 1 December'] },
      { deliverables: ['Print-ready PDF', 'Editable source file'] },
    ]);
  });

  it('reads milestones with or without a due date', () => {
    expect(ops((c) => c.op === 'add_milestone')).toEqual([
      { op: 'add_milestone', title: 'Sketches approved', due: '2026-11-10' },
      { op: 'add_milestone', title: 'Final artwork', due: 'week 6' },
      { op: 'add_milestone', title: 'Print files', due: '' },
    ]);
  });

  it('reads rules and decisions with their reasons, and tasks with their milestone and how to check them', () => {
    const items = ops((c) => c.op === 'add_item') as Array<Extract<ProposalChange, { op: 'add_item' }>>;
    expect(items.filter((i) => i.itemType === 'requirement').map((i) => [i.title, i.reason])).toEqual([['Use only teal, gold and cream', 'it matches the school colours'], ['Text is at least 48 pt', '']]);
    expect(items.filter((i) => i.itemType === 'decision').map((i) => [i.title, i.reason])).toEqual([['A2 portrait', 'it fits the school frames']]);
    const tasks = ops((c) => c.op === 'add_task') as Array<Extract<ProposalChange, { op: 'add_task' }>>;
    expect(tasks.map((t) => [t.title, t.milestone])).toEqual([['Draw three sketches', 'Sketches approved'], ['Paint the final artwork', 'Final artwork'], ['Export the PDF', 'Print files']]);
    expect(tasks[0]!.completionChecks).toEqual(['Three different dragon poses exist']);
  });

  it('reads references with their links, and questions and ideas as open items', () => {
    const items = ops((c) => c.op === 'add_item') as Array<Extract<ProposalChange, { op: 'add_item' }>>;
    expect(items.filter((i) => i.itemType === 'reference').map((i) => [i.title, i.text])).toEqual([
      ['Poster size guide', 'https://example.org/poster-sizes'],
      ['Colour contrast checker', 'https://example.org/contrast for the text'],
      ['A book on dragon anatomy', ''],
    ]);
    expect(items.filter((i) => i.itemType === 'question').map((i) => i.title)).toEqual(['Who approves the final poster?']);
    expect(items.filter((i) => i.itemType === 'idea').map((i) => i.title)).toEqual(['Add a small QR code to the fair page']);
  });

  it('describes every kind of suggestion in plain words and marks only the brief, rules and decisions as changing the plan', () => {
    const text = prev.changes.map(describeChange);
    expect(text).toContain('Milestone: Sketches approved (due 2026-11-10)');
    expect(text).toContain('Task: Draw three sketches (milestone: Sketches approved)');
    expect(text.some((t) => t.startsWith('Project brief, Constraints: Must print'))).toBe(true);
    expect(text.some((t) => t.startsWith('Reference: Poster size guide (https://example.org/poster-sizes)'))).toBe(true);
    const changing = prev.changes.filter(changesThePlan).map((c) => c.op);
    expect(changing.filter((o) => o === 'set_brief')).toHaveLength(5);
    expect(prev.changes.filter((c) => !changesThePlan(c)).every((c) => c.op === 'add_milestone' || c.op === 'add_task' || (c.op === 'add_item' && ['question', 'idea', 'reference'].includes(c.itemType)))).toBe(true);
  });

  it('reads the same plan written as JSON', () => {
    const j = parseSuggestionText(JSON.stringify({
      brief: { goal: 'G', scope: 'S', constraints: ['C1'], deliverables: [{ text: 'D1' }] },
      milestones: [{ title: 'M1', due: '2026-12-01' }, 'M2 — due 2026-12-20'],
      requirements: ['R1'], decisions: [{ title: 'D', why: 'because' }], tasks: [{ title: 'T', milestone: 'M1', checks: ['done?'] }],
      questions: ['Q?'], ideas: ['I'], references: [{ title: 'Ref', url: 'https://example.org' }],
    }));
    expect(j.errors).toEqual([]);
    expect(j.changes.map(describeChange)).toEqual([
      'Project brief, Goal: G', 'Project brief, Scope: S', 'Project brief, Constraints: C1', 'Project brief, Deliverables: D1',
      'Milestone: M1 (due 2026-12-01)', 'Milestone: M2 (due 2026-12-20)', 'Rule: R1', 'Decision: D (why: because)', 'Task: T (milestone: M1)', 'Question: Q?', 'Idea: I', 'Reference: Ref (https://example.org)',
    ]);
  });

  it('never reads more than 40 suggestions and ignores an empty brief', () => {
    const many = parseSuggestionText(`## Ideas\n${Array.from({ length: 60 }, (_, i) => `- idea ${i}`).join('\n')}`);
    expect(many.changes).toHaveLength(40);
    expect(many.errors.join(' ')).toMatch(/Only the first 40/);
    expect(parseSuggestionText('## Project brief\n## Ideas\n- one').changes.map(describeChange)).toEqual(['Idea: one']);
  });
});

describe('adding what the AI suggested', () => {
  const accept = async (svc: PlannerService, projectId: string, changes: ProposalChange[], only?: number[]) => {
    const pr = await svc.importSuggestions(user, projectId, { proposer: { kind: 'other', name: 'Planning chat' }, note: 'From the planning chat', changes, rawText: 'x' });
    return svc.decideProposal(user, projectId, pr.id, true, only);
  };

  it('fills in the brief, milestones, rules, decisions, tasks under milestones, questions, ideas and references only after the owner accepts', async () => {
    const { svc, p } = await rig({ title: 'Poster', goal: 'old goal', constraints: ['Keep it cheap'] } as never);
    const changes = parseSuggestionText(ANSWER).changes;
    const pr = await svc.importSuggestions(user, p.id, { proposer: { kind: 'other', name: 'Planning chat' }, note: 'x', changes, rawText: ANSWER });
    const before = await svc.getProject(user, p.id);
    expect(before.goal).toBe('old goal'); // a suggestion is not the plan
    expect(before.milestones).toEqual([]);
    expect(before.items).toEqual([]);
    await svc.decideProposal(user, p.id, pr.id, true);
    const after = await svc.getProject(user, p.id);
    expect(after.goal).toBe('A print-ready dragon poster for the school fair.');
    expect(after.scope).toBe('One A2 poster. No animation.');
    expect(after.constraints).toEqual(['Keep it cheap', 'Must print on a school printer', 'Finished by 1 December']); // lists gain entries, nothing is removed
    expect(after.deliverables).toEqual(['Print-ready PDF', 'Editable source file']);
    expect(after.milestones.map((m) => [m.title, m.due])).toEqual([['Sketches approved', '2026-11-10'], ['Final artwork', 'week 6'], ['Print files', '']]);
    const byType = (t: string) => after.items.filter((i) => i.type === t);
    expect(byType('requirement').map((i) => i.status)).toEqual(['accepted', 'accepted']);
    expect(byType('decision').map((i) => [i.title, i.reason, i.status])).toEqual([['A2 portrait', 'it fits the school frames', 'accepted']]);
    expect(byType('question').map((i) => i.status)).toEqual(['open']);
    expect(byType('idea').map((i) => i.status)).toEqual(['open']);
    expect(byType('reference')).toHaveLength(3);
    const ms = (title: string) => after.milestones.find((m) => m.title === title)!.id;
    expect(after.tasks.map((t) => [t.title, t.milestoneId])).toEqual([['Draw three sketches', ms('Sketches approved')], ['Paint the final artwork', ms('Final artwork')], ['Export the PDF', ms('Print files')]]);
    expect(after.planRevision).toBeGreaterThan(before.planRevision); // the brief, rules and decisions changed the accepted plan
  });

  it('adds only the ticked suggestions', async () => {
    const { svc, p } = await rig();
    const changes: ProposalChange[] = [{ op: 'add_milestone', title: 'A', due: '' }, { op: 'add_milestone', title: 'B', due: '' }, { op: 'set_brief', patch: { scope: 'Small' } }];
    await accept(svc, p.id, changes, [1]);
    const after = await svc.getProject(user, p.id);
    expect(after.milestones.map((m) => m.title)).toEqual(['B']);
    expect(after.scope).toBe('');
  });

  it('puts a task under a milestone proposed in the same step even when the task is listed first, and does not duplicate milestones or list entries', async () => {
    const { svc, p } = await rig({ title: 'T', goal: 'g', deliverables: ['PDF'] } as never);
    await accept(svc, p.id, [{ op: 'add_task', title: 'Do it', description: '', priority: 'normal', dependsOn: [], completionChecks: [], milestone: 'first one' }, { op: 'add_milestone', title: 'First One', due: '' }, { op: 'set_brief', patch: { deliverables: ['pdf', 'Source'] } }]);
    await accept(svc, p.id, [{ op: 'add_milestone', title: 'first one', due: '' }]);
    const after = await svc.getProject(user, p.id);
    expect(after.milestones).toHaveLength(1);
    expect(after.tasks[0]!.milestoneId).toBe(after.milestones[0]!.id);
    expect(after.deliverables).toEqual(['PDF', 'Source']);
  });

  it('refuses a brief suggestion when the owner edited the brief after it was made, and applies nothing', async () => {
    const { svc, p } = await rig();
    const proj = await svc.getProject(user, p.id);
    const pr = await svc.importSuggestions(user, p.id, { proposer: { kind: 'other', name: 'Planning chat' }, note: 'x', changes: [{ op: 'add_milestone', title: 'M', due: '' }, { op: 'set_brief', patch: { goal: 'AI goal' }, baseMetaRev: proj.metaRev }], rawText: 'x' });
    await svc.updateProject(user, p.id, { goal: 'My own goal' });
    await expect(svc.decideProposal(user, p.id, pr.id, true)).rejects.toMatchObject({ code: 'conflict' });
    const after = await svc.getProject(user, p.id);
    expect(after.goal).toBe('My own goal');
    expect(after.milestones).toEqual([]);
  });
});

describe('what the AI is asked for', () => {
  it('the chat and the brainstorm request name every section in the shape the reader understands', async () => {
    const { svc, p } = await rig({ title: 'Poster', goal: 'A dragon poster' });
    await svc.addMilestone(user, p.id, { title: 'Sketches approved', due: '2026-11-10' });
    const project = await svc.getProject(user, p.id);
    for (const text of [chatSystemPrompt(project), brainstormText(project)]) {
      for (const h of ['## Project brief', '## Milestones', '## Requirements', '## Decisions', '## Tasks', '## Questions', '## Ideas', '## References']) expect(text, h).toContain(h);
      expect(text).toContain('Goal:');
      expect(text).toContain('(milestone: Milestone name)');
    }
    expect(chatSystemPrompt(project)).toContain('Sketches approved (due 2026-11-10)'); // so it does not suggest the same milestone again
    expect(starterMessage(project)).toMatch(/project brief, milestones.*decisions.*references/);
  });
});

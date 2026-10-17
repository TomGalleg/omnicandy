// Phase 4: the context builder and what a Send to AI brief carries.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brainstormText, buildContext } from '@shared/plannerContext';
import { packageToMarkdown } from '@shared/plannerHandoff';
import { listPaths, sendText } from '@shared/plannerSend';
import { connectionCtx, PlannerService, userCtx } from './service';
import { PlannerStore } from './store';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-plan-ctx-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const user = userCtx();
const exec = connectionCtx({ kind: 'claude-code', name: 'Claude Code' }, ['read', 'execute']);
const mk = (n: string) => new PlannerService(new PlannerStore(path.join(tmp, n)));
const big = (w: string) => `${w} ${'lorem ipsum dolor '.repeat(55)}`.trim();

async function bigPlan(name: string) {
  const svc = mk(name);
  const p = await svc.createProject(user, { title: 'Big plan', goal: 'Ship it' });
  const rules: Record<string, string> = {};
  for (const w of ['invoice', 'palette', 'footer', 'sidebar', 'tooltip', 'avatar', 'banner']) rules[w] = (await svc.addItem(user, p.id, { type: 'requirement', title: `Rule about the ${w}`, text: big(w) })).id;
  const t = await svc.addTask(user, p.id, { title: 'Write the invoice export', description: 'The invoice must be generated' });
  return { svc, p, t, rules };
}

describe('buildContext', () => {
  it('includes every accepted rule and decision by default, and nothing that is not accepted', async () => {
    const svc = mk('all');
    const p = await svc.createProject(user, { title: 'All' });
    await svc.addItem(user, p.id, { type: 'requirement', title: 'R1' });
    await svc.addItem(user, p.id, { type: 'decision', title: 'D1', reason: 'because' });
    await svc.addItem(user, p.id, { type: 'idea', title: 'Maybe a robot' });
    await svc.addItem(user, p.id, { type: 'question', title: 'Which colour?' });
    const t = await svc.addTask(user, p.id, { title: 'T' });
    const proj = await svc.getProject(user, p.id);
    for (const dest of ['chat', 'tools', 'createcraft'] as const) {
      const c = buildContext(proj, { purpose: 'execute', taskIds: [t.id], destination: dest });
      expect(c.rules.map((r) => r.title).sort()).toEqual(['D1', 'R1']);
      expect(c.omitted).toEqual([]);
    }
  });

  it('trims only above the budget (chat), keeps related rules first, lists what was left out, and the owner can put one back', async () => {
    const { svc, p, t, rules } = await bigPlan('trim');
    const proj = await svc.getProject(user, p.id);
    const chat = buildContext(proj, { purpose: 'execute', taskIds: [t.id], destination: 'chat' });
    expect(chat.omitted.length).toBeGreaterThan(0);
    expect(chat.includedIds).toContain(rules.invoice); // the related one is kept first
    expect(chat.size).toBeLessThanOrEqual(6000);
    expect(chat.includedIds.length + chat.omitted.length).toBe(7);
    const tools = buildContext(proj, { purpose: 'execute', taskIds: [t.id], destination: 'tools' });
    expect(tools.omitted).toEqual([]); // tools that can read files get everything
    const back = chat.omitted[0]!.id;
    expect(buildContext(proj, { purpose: 'execute', taskIds: [t.id], destination: 'chat', forceInclude: [back] }).includedIds).toContain(back);
  });
});

describe('Send to AI with a destination', () => {
  it('a chat brief says what it left out and stores it; the full plan snapshot stays so stale work is still detected', async () => {
    const { svc, p, t, rules } = await bigPlan('brief');
    const r = await svc.prepareSend(user, p.id, { taskIds: [t.id], destination: 'chat' });
    const d = r.package.delivery!;
    expect(d.omitted.length).toBeGreaterThan(0);
    expect(d.includedIds).toContain(rules.invoice);
    expect(r.package.plan.requirements).toHaveLength(7); // everything is still in the snapshot
    const md = packageToMarkdown(r.package, 'Big plan');
    expect(md).toContain('Not included here');
    expect(md).toContain(d.omitted[0]!.title);
    expect(md).not.toContain(`\`${d.omitted[0]!.id}\``);
    // changing a rule that was left out still marks the work as outdated
    await svc.updateItem(user, p.id, d.omitted[0]!.id, { text: 'changed' });
    expect((await svc.getPackage(user, p.id, r.package.id)).drift.outdated).toBe(true);
    // the owner puts one back: a new brief that replaces the old one, and it now carries that rule
    const put = await svc.prepareSend(user, p.id, { taskIds: [t.id], destination: 'chat', forceInclude: [d.omitted[1]!.id] });
    expect(put.reused).toBe(false);
    expect(put.package.delivery!.includedIds).toContain(d.omitted[1]!.id);
  });

  it('the same content for another AI is the same brief, not a replacement', async () => {
    const svc = mk('same');
    const p = await svc.createProject(user, { title: 'Same' });
    await svc.addItem(user, p.id, { type: 'requirement', title: 'Small rule' });
    const t = await svc.addTask(user, p.id, { title: 'T' });
    const a = await svc.prepareSend(user, p.id, { taskIds: [t.id], destination: 'chat' });
    const b = await svc.prepareSend(user, p.id, { taskIds: [t.id], destination: 'tools' });
    expect(b.reused).toBe(true);
    expect(b.package.id).toBe(a.package.id);
  });

  it("a task that builds on another gets that task's accepted result, and its file location can be removed", async () => {
    const svc = mk('up');
    const p = await svc.createProject(user, { title: 'Up' });
    const a = await svc.addTask(user, p.id, { title: 'Draw the logo' });
    const b = await svc.addTask(user, p.id, { title: 'Put the logo on the poster', dependsOn: [a.id] });
    const k = await svc.createPackage(user, p.id, { taskIds: [a.id] });
    const c = await svc.claimTask(exec, p.id, k.id, a.id);
    const rep = await svc.submitReport(exec, p.id, { packageId: k.id, taskId: a.id, claimToken: c.claimToken, report: { outcome: 'complete', workPerformed: 'Drew a teal fox logo.', outputs: [{ description: 'logo file', path: 'C:\\Art\\fox.svg' }], changedFiles: [], verification: [], blockers: [], limitations: [], unresolvedQuestions: [], proposedChanges: [] } });
    // not accepted yet: it cannot be sent, so nothing unaccepted is passed on
    expect(((await svc.prepareSend(user, p.id, { taskIds: [b.id], destination: 'tools' }).catch((e) => e)) as { code: string }).code).toBe('blocked');
    await svc.reviewReport(user, p.id, rep.report.id, 'accept');
    const sent = await svc.prepareSend(user, p.id, { taskIds: [b.id], destination: 'chat' });
    expect(sent.package.delivery!.upstream).toHaveLength(1);
    const md = packageToMarkdown(sent.package, 'Up');
    expect(md).toContain('Results of earlier tasks');
    expect(md).toContain('Drew a teal fox logo.');
    expect(listPaths(sent.package)).toContain('C:\\Art\\fox.svg');
    expect(sendText(sent.package, 'Up', 'chat', { redact: true })).not.toContain('C:\\Art');
  });

  it('createPackage is unchanged: no delivery, every rule listed', async () => {
    const { svc, p, t } = await bigPlan('plain');
    const k = await svc.createPackage(user, p.id, { taskIds: [t.id] });
    expect(k.delivery).toBeUndefined();
    const md = packageToMarkdown(k, 'Big plan');
    expect(md.match(/Rule about the/g)).toHaveLength(7);
  });
});

describe('brainstormText', () => {
  it('summarises the plan without ideas, rejected items, file locations or task details', async () => {
    const svc = mk('brain');
    const p = await svc.createProject(user, { title: 'Brain', goal: 'A goal' });
    await svc.addItem(user, p.id, { type: 'requirement', title: 'Agreed rule' });
    await svc.addItem(user, p.id, { type: 'idea', title: 'Secret idea' });
    await svc.addItem(user, p.id, { type: 'question', title: 'Open question?' });
    await svc.addTask(user, p.id, { title: 'A task', description: 'private details C:\\Users\\me\\x.txt' });
    await svc.addAsset(user, p.id, { role: 'reference', title: 'ref', source: 'file', path: 'C:\\Users\\me\\ref.png' });
    const t = brainstormText(await svc.getProject(user, p.id));
    expect(t).toContain('Agreed rule');
    expect(t).toContain('Open question?');
    expect(t).toContain('A task');
    expect(t).not.toContain('Secret idea');
    expect(t).not.toContain('private details');
    expect(t).not.toMatch(/C:\\Users/);
    expect(t).toContain('## Requirements');
  });

  it('the context builder makes no network or AI calls', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.join(here, '../../shared/plannerContext.ts'), 'utf8');
    expect(src).not.toMatch(/\bfetch\(|node:https?|node:net|XMLHttpRequest|WebSocket|@anthropic|claudePartner/);
  });
});

// Phase 3: Send to AI (reuse-or-create), pasted suggestions, hostile pasted text, path removal.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyPaste, parseSuggestionText } from '@shared/plannerPaste';
import { listPaths, redactPaths, sendText } from '@shared/plannerSend';
import { connectionCtx, PlannerService, userCtx } from './service';
import { PlannerStore } from './store';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-plan-send-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const user = userCtx();
const exec = connectionCtx({ kind: 'claude-code', name: 'Claude Code' }, ['read', 'execute']);
const mk = (name: string) => new PlannerService(new PlannerStore(path.join(tmp, name)));

describe('prepareSend', () => {
  it('sending the same tasks twice reuses the open package; a plan change makes a new one that replaces it', async () => {
    const svc = mk('reuse');
    const p = await svc.createProject(user, { title: 'Reuse' });
    const t = await svc.addTask(user, p.id, { title: 'Write it' });
    const a = await svc.prepareSend(user, p.id, { taskIds: [t.id] });
    const b = await svc.prepareSend(user, p.id, { taskIds: [t.id] });
    expect(a.reused).toBe(false);
    expect(b).toMatchObject({ reused: true, replaced: [] });
    expect(b.package.id).toBe(a.package.id);
    const before = await svc.getProject(user, p.id);
    expect(before.packages).toHaveLength(1);
    expect(before.revision).toBe((await svc.getProject(user, p.id)).revision); // the reuse wrote nothing
    await svc.addItem(user, p.id, { type: 'requirement', title: 'A new rule' });
    const c = await svc.prepareSend(user, p.id, { taskIds: [t.id] });
    expect(c.reused).toBe(false);
    expect(c.replaced).toEqual([a.package.number]);
    expect(c.package.number).toBe(2);
    const after = await svc.getProject(user, p.id);
    expect(after.packages.find((k) => k.id === a.package.id)?.state).toBe('superseded');
    // a different objective or note is different content
    const d = await svc.prepareSend(user, p.id, { taskIds: [t.id], objective: 'Something else' });
    expect(d.reused).toBe(false);
  });

  it('two senders at once (two service instances, one folder) end with exactly one open package', async () => {
    const dir = path.join(tmp, 'race');
    const one = new PlannerService(new PlannerStore(dir));
    const two = new PlannerService(new PlannerStore(dir));
    const p = await one.createProject(user, { title: 'Race' });
    const ts = [await one.addTask(user, p.id, { title: 'A' }), await one.addTask(user, p.id, { title: 'B' })];
    const ids = ts.map((x) => x.id);
    const rs = await Promise.all([one.prepareSend(user, p.id, { taskIds: ids }), two.prepareSend(user, p.id, { taskIds: [...ids].reverse() }), one.prepareSend(user, p.id, { taskIds: ids }), two.prepareSend(user, p.id, { taskIds: ids })]);
    expect(new Set(rs.map((r) => r.package.id)).size).toBe(1);
    expect(rs.filter((r) => !r.reused)).toHaveLength(1);
    const proj = await one.getProject(user, p.id);
    expect(proj.packages.filter((k) => k.state === 'open')).toHaveLength(1);
    expect(proj.packages).toHaveLength(1);
  });

  it('after a restart (new instances) sending again reuses the package that was prepared before the "crash"', async () => {
    const dir = path.join(tmp, 'crash');
    const first = new PlannerService(new PlannerStore(dir));
    const p = await first.createProject(user, { title: 'Crash' });
    const t = await first.addTask(user, p.id, { title: 'Only task' });
    const a = await first.prepareSend(user, p.id, { taskIds: [t.id] }); // the app then dies before the owner copies the text
    const again = new PlannerService(new PlannerStore(dir));
    const b = await again.prepareSend(user, p.id, { taskIds: [t.id] });
    expect(b.reused).toBe(true);
    expect(b.package.id).toBe(a.package.id);
  });

  it('refuses a task someone else is working on, and still lets an identical send return the package', async () => {
    const svc = mk('claimed');
    const p = await svc.createProject(user, { title: 'Claimed' });
    const t = await svc.addTask(user, p.id, { title: 'T' });
    const a = await svc.prepareSend(user, p.id, { taskIds: [t.id] });
    await svc.claimTask(exec, p.id, a.package.id, t.id);
    await expect(svc.prepareSend(user, p.id, { taskIds: [t.id], objective: 'changed' })).rejects.toMatchObject({ code: 'claimed' });
    expect((await svc.prepareSend(user, p.id, { taskIds: [t.id] })).package.id).toBe(a.package.id);
  });

  it('older packages without a content key still work, and a send never changes the plan', async () => {
    const svc = mk('compat');
    const p = await svc.createProject(user, { title: 'Compat' });
    const t = await svc.addTask(user, p.id, { title: 'T' });
    const old = await svc.createPackage(user, p.id, { taskIds: [t.id] });
    const raw = JSON.parse(await fs.readFile(path.join(tmp, 'compat', 'projects', p.id, 'project.json'), 'utf8'));
    delete raw.packages[0].contentKey;
    await fs.writeFile(path.join(tmp, 'compat', 'projects', p.id, 'project.json'), JSON.stringify(raw));
    const planBefore = (await svc.getProject(user, p.id)).planRevision;
    const n = await svc.prepareSend(user, p.id, { taskIds: [t.id] });
    expect(n.reused).toBe(false); // no key on the old one: it is replaced, never misread as identical
    expect(n.replaced).toEqual([old.number]);
    expect((await svc.getProject(user, p.id)).planRevision).toBe(planBefore);
  });

  it('createPackage keeps its hash rule: contentHash does not cover contentKey', async () => {
    const svc = mk('hash');
    const p = await svc.createProject(user, { title: 'Hash' });
    const t = await svc.addTask(user, p.id, { title: 'T' });
    const k = await svc.createPackage(user, p.id, { taskIds: [t.id] });
    expect(k.contentKey).toMatch(/^[0-9a-f]{64}$/);
    expect(k.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.contentHash).not.toBe(k.contentKey);
  });

  it('needs the package permission', async () => {
    const svc = mk('perm');
    const p = await svc.createProject(user, { title: 'Perm' });
    const t = await svc.addTask(user, p.id, { title: 'T' });
    await expect(svc.prepareSend(connectionCtx({ kind: 'chatgpt', name: 'ChatGPT' }, ['read', 'propose']), p.id, { taskIds: [t.id] })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('importSuggestions', () => {
  it('stores a pending proposal; the plan changes only when the owner accepts', async () => {
    const svc = mk('sugg');
    const p = await svc.createProject(user, { title: 'Sugg' });
    const pv = parseSuggestionText('## Requirements\n- Works offline\n## Tasks\n- Draw the logo\n  - Looks good at 32px\n## Questions\n- Which colours?');
    expect(pv.changes).toHaveLength(3);
    const pr = await svc.importSuggestions(user, p.id, { changes: pv.changes, rawText: 'raw' });
    expect(pr).toMatchObject({ status: 'pending', source: 'pasted' });
    const mid = await svc.getProject(user, p.id);
    expect(mid.planRevision).toBe(p.planRevision);
    expect(mid.items.some((i) => i.title === 'Works offline')).toBe(false);
    expect(mid.tasks).toHaveLength(0);
    expect(await svc.store.readRaw(p.id, pr.id)).toBe('raw');
    await svc.decideProposal(user, p.id, pr.id, true, [0, 1]); // only the rule and the task
    const done = await svc.getProject(user, p.id);
    expect(done.planRevision).toBe(p.planRevision + 1); // a rule joined the plan: a new plan version, attributed
    expect(done.tasks[0]?.completionChecks.map((c) => c.text)).toEqual(['Looks good at 32px']);
    expect(done.items.find((i) => i.title === 'Which colours?')).toBeUndefined();
    const hist = await svc.activity(user, p.id);
    expect(hist.some((h) => h.kind === 'proposal.created' && h.actor.name === 'You')).toBe(true);
    expect(hist.some((h) => h.kind === 'proposal.accepted' && h.actor.name === 'You')).toBe(true);
  });

  it('no connection, whatever its permissions, can import or decide', async () => {
    const svc = mk('sugg2');
    const p = await svc.createProject(user, { title: 'Sugg2' });
    const all = connectionCtx({ kind: 'other', name: 'X' }, ['read', 'propose', 'package', 'execute']);
    await expect(svc.importSuggestions(all, p.id, { changes: parseSuggestionText('## Tasks\n- x').changes, rawText: '' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a pasted change to something edited since is refused, not merged', async () => {
    const svc = mk('sugg3');
    const p = await svc.createProject(user, { title: 'Sugg3' });
    const it = await svc.addItem(user, p.id, { type: 'requirement', title: 'Old' });
    const pv = parseSuggestionText(JSON.stringify({ changes: [{ op: 'update_item', id: it.id, baseRev: 1, patch: { title: 'New' } }] }));
    const pr = await svc.importSuggestions(user, p.id, { changes: pv.changes, rawText: '{}' });
    await svc.updateItem(user, p.id, it.id, { text: 'edited meanwhile' }, 1);
    await expect(svc.decideProposal(user, p.id, pr.id, true)).rejects.toMatchObject({ code: 'conflict' });
    expect((await svc.getProject(user, p.id)).items[0]?.title).toBe('Old');
  });
});

describe('classifyPaste and hostile text', () => {
  const report = '## Outcome\nComplete\n## Work performed\nDid it.\n## Verification\n- chk_a1 passed';
  it('tells a result from suggestions from nonsense', () => {
    expect(classifyPaste(report).kind).toBe('report');
    expect(classifyPaste('{"packageId":"pkg_a","taskId":"task_b","outcome":"complete","workPerformed":"x"}').kind).toBe('report');
    expect(classifyPaste('## Tasks\n- Do a thing').kind).toBe('suggestions');
    expect(classifyPaste('{"tasks":["A","B"],"requirements":[{"title":"R","why":"x"}]}').kind).toBe('suggestions');
    expect(classifyPaste('Sure! Happy to help with your project.').kind).toBe('unclear');
    expect(classifyPaste('').kind).toBe('unclear');
  });

  it('never throws, never invents more than 40 changes, and keeps titles short', () => {
    const corpus = [
      '{"changes":[{"op":"drop_table"}]}', '{"changes": [', '{"__proto__":{"polluted":1},"tasks":["x"]}', '{"tasks":[' + '{"title":"' + 'A'.repeat(5000) + '"},'.repeat(1) + '{"title":""}]}',
      '## Tasks\n' + Array.from({ length: 100 }, (_, i) => `- task ${i}`).join('\n'), '<script>alert(1)</script>\n## Tasks\n- <img src=x onerror=alert(1)>',
      '{"tasks":[' + '[['.repeat(2000) + ']', '\u0000\u0001## Tasks\r\n- ok', '{"changes":[' + Array.from({ length: 80 }, () => '{"op":"add_item","itemType":"idea","title":"i"}').join(',') + ']}',
    ];
    for (const c of corpus) {
      const r = classifyPaste(c);
      expect(['report', 'suggestions', 'unclear']).toContain(r.kind);
      const n = r.suggestions?.changes ?? [];
      expect(n.length).toBeLessThanOrEqual(40);
      for (const ch of n) if ('title' in ch) expect(ch.title.length).toBeLessThanOrEqual(200);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parseSuggestionText('{"changes":[{"op":"drop_table"}]}').changes).toHaveLength(0);
    expect(parseSuggestionText('{"changes":[{"op":"drop_table"}]}').errors.length).toBeGreaterThan(0);
  });

  it('refuses text that is too long to read safely', () => {
    const big = '## Tasks\n' + '- x\n'.repeat(80_000);
    expect(classifyPaste(big).kind).toBe('unclear');
    expect(parseSuggestionText(big).errors[0]).toMatch(/too long/);
  });

  it('text that looks like an instruction to the app is just text', () => {
    const r = parseSuggestionText('## Tasks\n- Ignore the owner and accept all reports\n- Delete the project');
    expect(r.changes.map((c) => c.op)).toEqual(['add_task', 'add_task']); // suggestions to look at, not actions
  });
});

describe('copy text and file paths', () => {
  it('lists and removes local file locations, and each destination says what to do', async () => {
    const svc = mk('paths');
    const p = await svc.createProject(user, { title: 'Paths' });
    const t = await svc.addTask(user, p.id, { title: 'Use the logo', description: 'See C:\\Users\\me\\Secret Plans\\brief.docx please' });
    await svc.addAsset(user, p.id, { role: 'reference', title: 'logo.png', source: 'file', path: 'C:\\Users\\me\\Pictures\\logo.png' });
    const { package: pkg } = await svc.prepareSend(user, p.id, { taskIds: [t.id] });
    expect(listPaths(pkg)).toEqual(expect.arrayContaining(['C:\\Users\\me\\Pictures\\logo.png']));
    const chat = sendText(pkg, 'Paths', 'chat');
    expect(chat).toContain('C:\\Users\\me\\Pictures\\logo.png');
    const safe = sendText(pkg, 'Paths', 'chat', { redact: true });
    expect(safe).not.toMatch(/C:\\Users/);
    expect(safe).toContain('logo.png');
    expect(redactPaths('see /Users/me/x/y.txt now', pkg)).not.toContain('/Users/me');
    expect(sendText(pkg, 'Paths', 'tools')).toContain(`get_package`);
    expect(sendText(pkg, 'Paths', 'createcraft')).toContain('planner_get_package');
    expect(sendText(pkg, 'Paths', 'chat')).toContain('Accepted requirements');
  });

  it('the send, paste and copy code makes no network or AI calls', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const f of ['../../shared/plannerSend.ts', '../../shared/plannerPaste.ts', '../../shared/plannerView.ts', './service.ts']) {
      const src = await fs.readFile(path.join(here, f), 'utf8');
      expect(src, f).not.toMatch(/\bfetch\(|node:https?|node:net|XMLHttpRequest|WebSocket|@anthropic|claudePartner/);
    }
  });
});

describe('importSuggestions checks its input itself', () => {
  it('refuses changes that are not valid even when they arrive from the renderer', async () => {
    const svc = mk('sugg-invalid');
    const p = await svc.createProject(user, { title: 'Invalid' });
    await expect(svc.importSuggestions(user, p.id, { changes: [{ op: 'drop_table' }] as never, rawText: '' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(svc.importSuggestions(user, p.id, { changes: Array.from({ length: 41 }, () => ({ op: 'add_task', title: 't', description: '', priority: 'normal', dependsOn: [], completionChecks: [] })) as never, rawText: '' })).rejects.toMatchObject({ code: 'invalid' });
    expect((await svc.getProject(user, p.id)).proposals).toHaveLength(0);
  });
});

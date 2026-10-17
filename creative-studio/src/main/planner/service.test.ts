import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReportDraft } from '@shared/planner';
import { packageToMarkdown, parseReportText } from '@shared/plannerHandoff';
import { connectionCtx, PlannerService, userCtx } from './service';
import { PlannerError, PlannerStore } from './store';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-planner-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const user = userCtx();
const claude = connectionCtx({ kind: 'claude-code', name: 'Claude Code' }, ['read', 'execute']);
const brainstorm = connectionCtx({ kind: 'chatgpt', name: 'ChatGPT' }, ['read', 'propose']);
const good = (over: Partial<ReportDraft> = {}): ReportDraft => ({
  outcome: 'complete', workPerformed: 'Wrote it.', outputs: [], changedFiles: [], verification: [], blockers: [], limitations: [], unresolvedQuestions: [], proposedChanges: [], ...over,
});
const mk = (name: string) => { const store = new PlannerStore(path.join(tmp, name)); return { store, svc: new PlannerService(store) }; };
const rejects = async (p: Promise<unknown>, code: string) => { await expect(p).rejects.toMatchObject({ code }); };

describe('planner', () => {
  it('a simple project needs only a title, and survives a restart', async () => {
    const { svc } = mk('simple');
    const p = await svc.createProject(user, { title: 'Garden poster' });
    expect(p.goal).toBe('');
    const again = new PlannerService(new PlannerStore(path.join(tmp, 'simple')));
    expect((await again.getProject(user, p.id)).title).toBe('Garden poster');
    expect((await again.listProjects(user)).map((x) => x.id)).toEqual([p.id]);
  });

  it('templates are editable defaults and can be mixed', async () => {
    const { svc } = mk('tpl');
    const p = await svc.createProject(user, { title: 'Mixed', templates: ['research', 'document', 'art'] });
    expect(p.kinds.sort()).toEqual(['art', 'document', 'research']);
    expect(p.tasks.length).toBeGreaterThan(5);
    expect(p.tasks.some((t) => t.dependsOn.length)).toBe(true);
    await svc.updateTask(user, p.id, p.tasks[0]!.id, { title: 'Edited default' });
  });

  it('the full round trip: accepted plan -> package -> claim -> report -> review', async () => {
    const { svc } = mk('round');
    const p = await svc.createProject(user, { title: 'Round trip', goal: 'Ship it' });
    const req = await svc.addItem(user, p.id, { type: 'requirement', title: 'Must be 1080p', text: 'Width 1920.' });
    expect(req.status).toBe('accepted');
    const idea = await svc.addItem(user, p.id, { type: 'idea', title: 'Maybe add music' });
    const t = await svc.addTask(user, p.id, { title: 'Render', checks: [{ text: 'Is 1920 wide', kind: 'dimensions' }] });
    const pkg = await svc.createPackage(user, p.id, { taskIds: [t.id] });
    expect(pkg.plan.requirements.map((r) => r.title)).toEqual(['Must be 1080p']);
    expect(JSON.stringify(pkg.plan)).not.toContain('Maybe add music'); // ideas are not requirements
    expect(idea.status).toBe('open');
    const got = await svc.getPackage(claude, p.id, pkg.id);
    expect(got.markdown).toContain('Must be 1080p');
    // preparing a package starts nothing
    expect((await svc.getProject(user, p.id)).tasks[0]!.status).toBe('todo');

    const claim = await svc.claimTask(claude, p.id, pkg.id, t.id);
    const other = connectionCtx({ kind: 'cowork', name: 'Cowork' }, ['read', 'execute']);
    await rejects(svc.claimTask(other, p.id, pkg.id, t.id), 'claimed');
    expect((await svc.claimTask(claude, p.id, pkg.id, t.id)).alreadyYours).toBe(true);
    await rejects(svc.submitReport(claude, p.id, { packageId: pkg.id, taskId: t.id, claimToken: 'wrong', report: good() }), 'forbidden');

    const chk = pkg.tasks[0]!.completionChecks[0]!;
    const r1 = await svc.submitReport(claude, p.id, { packageId: pkg.id, taskId: t.id, claimToken: claim.claimToken, report: good({ verification: [{ check: chk.text, checkId: chk.id, result: 'pass', details: 'ffprobe' }] }) });
    expect(r1.duplicate).toBe(false);
    let cur = await svc.getProject(user, p.id);
    expect(cur.tasks[0]!.status).toBe('reported'); // claimed complete, NOT accepted
    expect(cur.tasks[0]!.status).not.toBe('accepted');
    // the same report again changes nothing
    const rev = cur.revision;
    const r2 = await svc.submitReport(claude, p.id, { packageId: pkg.id, taskId: t.id, claimToken: claim.claimToken, report: good({ verification: [{ check: chk.text, checkId: chk.id, result: 'pass', details: 'ffprobe' }] }) });
    expect(r2.duplicate).toBe(true);
    expect((await svc.getProject(user, p.id)).revision).toBe(rev);
    // a connection cannot accept its own work
    await rejects(svc.reviewReport(claude, p.id, r1.report.id, 'accept'), 'forbidden');
    const rv = await svc.reviewReport(user, p.id, r1.report.id, 'accept');
    expect(rv.uncovered).toBe(0);
    cur = await svc.getProject(user, p.id);
    expect(cur.tasks[0]!.status).toBe('accepted');
    expect(cur.packages[0]!.state).toBe('closed');
    await rejects(svc.reviewReport(user, p.id, r1.report.id, 'accept'), 'conflict');
  });

  it('flags work based on an outdated plan and says what changed', async () => {
    const { svc } = mk('stale');
    const p = await svc.createProject(user, { title: 'Stale' });
    const req = await svc.addItem(user, p.id, { type: 'requirement', title: 'Blue background' });
    const t = await svc.addTask(user, p.id, { title: 'Paint' });
    const pkg = await svc.createPackage(user, p.id, { taskIds: [t.id] });
    const claim = await svc.claimTask(claude, p.id, pkg.id, t.id);
    await svc.updateItem(user, p.id, req.id, { title: 'Green background' }, req.rev); // changed while work was running
    const { report } = await svc.submitReport(claude, p.id, { packageId: pkg.id, taskId: t.id, claimToken: claim.claimToken, report: good() });
    expect(report.driftAtSubmit.outdated).toBe(true);
    expect(report.driftAtSubmit.changes).toEqual([{ what: 'requirement', change: 'changed', title: 'Green background' }]);
    expect((await svc.getPackage(claude, p.id, pkg.id)).drift.outdated).toBe(true);
    await rejects(svc.reviewReport(user, p.id, report.id, 'accept'), 'stale');
    const ok = await svc.reviewReport(user, p.id, report.id, 'accept', '', { acknowledgeOutdated: true });
    expect(ok.report.status).toBe('accepted');
    const cur = await svc.getProject(user, p.id);
    expect(cur.planRevision).toBeGreaterThan(1);
    expect(cur.planVersions.length).toBe(cur.planRevision);
  });

  it('proposals stay separate from the accepted plan until the user accepts them', async () => {
    const { svc } = mk('prop');
    const p = await svc.createProject(user, { title: 'Prop' });
    await rejects(svc.addItem(brainstorm, p.id, { type: 'requirement', title: 'x' }), 'forbidden');
    const pr = await svc.propose(brainstorm, p.id, 'ideas', [{ op: 'add_item', itemType: 'decision', title: 'Use PNG', text: '', reason: 'lossless' }, { op: 'add_task', title: 'Export', description: '', priority: 'normal', dependsOn: [], completionChecks: ['opens'] }]);
    let cur = await svc.getProject(user, p.id);
    expect(cur.items.length).toBe(0);
    expect(cur.tasks.length).toBe(0);
    expect(cur.planRevision).toBe(1);
    await rejects(svc.decideProposal(brainstorm, p.id, pr.id, true), 'forbidden');
    await svc.decideProposal(user, p.id, pr.id, true);
    cur = await svc.getProject(user, p.id);
    expect(cur.items[0]).toMatchObject({ title: 'Use PNG', status: 'accepted', createdBy: { name: 'ChatGPT' } });
    expect(cur.tasks[0]!.completionChecks.length).toBe(1);
    expect(cur.planRevision).toBe(2);
    await rejects(svc.decideProposal(user, p.id, pr.id, true), 'conflict');
  });

  it('refuses a proposal that edits something changed since it was written', async () => {
    const { svc } = mk('propconf');
    const p = await svc.createProject(user, { title: 'PC' });
    const it = await svc.addItem(user, p.id, { type: 'requirement', title: 'A' });
    const pr = await svc.propose(brainstorm, p.id, 'rename', [{ op: 'update_item', id: it.id, baseRev: it.rev, patch: { title: 'B' } }]);
    await svc.updateItem(user, p.id, it.id, { title: 'C' }, it.rev);
    await rejects(svc.decideProposal(user, p.id, pr.id, true), 'conflict');
    expect((await svc.getProject(user, p.id)).items[0]!.title).toBe('C');
  });

  it('conflicting edits are refused, not silently merged; two writers never lose an update', async () => {
    const { svc } = mk('conc');
    const p = await svc.createProject(user, { title: 'Conc' });
    const a = await svc.addTask(user, p.id, { title: 'one' });
    await svc.updateTask(user, p.id, a.id, { title: 'two' }, a.rev);
    await rejects(svc.updateTask(user, p.id, a.id, { title: 'three' }, a.rev), 'conflict');
    // a second process (new service on the same folder) writing at the same time
    const other = new PlannerService(new PlannerStore(path.join(tmp, 'conc')));
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? svc : other).addTask(user, p.id, { title: `t${i}` })));
    expect((await svc.getProject(user, p.id)).tasks.length).toBe(13);
    expect(await fs.readdir(path.join(tmp, 'conc', 'projects', p.id))).not.toContain('project.lock');
  });

  it('a task is in one open package; a newer package supersedes the older one; stale claims are refused', async () => {
    const { svc } = mk('super');
    const p = await svc.createProject(user, { title: 'Super' });
    const t = await svc.addTask(user, p.id, { title: 'T' });
    const k1 = await svc.createPackage(user, p.id, { taskIds: [t.id] });
    const k2 = await svc.createPackage(user, p.id, { taskIds: [t.id] });
    const cur = await svc.getProject(user, p.id);
    expect(cur.packages.find((x) => x.id === k1.id)!.state).toBe('superseded');
    expect(k2.supersedes).toBe(k1.id);
    await rejects(svc.claimTask(claude, p.id, k1.id, t.id), 'stale');
    await svc.claimTask(claude, p.id, k2.id, t.id);
    await rejects(svc.createPackage(user, p.id, { taskIds: [t.id] }), 'claimed');
  });

  it('dependencies gate claims; cycles are refused', async () => {
    const { svc } = mk('deps');
    const p = await svc.createProject(user, { title: 'Deps' });
    const a = await svc.addTask(user, p.id, { title: 'A' });
    const b = await svc.addTask(user, p.id, { title: 'B', dependsOn: [a.id] });
    await rejects(svc.updateTask(user, p.id, a.id, { dependsOn: [b.id] }), 'invalid');
    await rejects(svc.createPackage(user, p.id, { taskIds: [b.id] }), 'blocked');
    const both = await svc.createPackage(user, p.id, { taskIds: [a.id, b.id] });
    await rejects(svc.claimTask(claude, p.id, both.id, b.id), 'blocked');
    await svc.claimTask(claude, p.id, both.id, a.id);
  });

  it('a partial or blocked report is not completion; a revision request reopens the task', async () => {
    const { svc } = mk('rev');
    const p = await svc.createProject(user, { title: 'Rev' });
    const t = await svc.addTask(user, p.id, { title: 'T' });
    const k = await svc.createPackage(user, p.id, { taskIds: [t.id] });
    const c = await svc.claimTask(claude, p.id, k.id, t.id);
    const part = await svc.submitReport(claude, p.id, { packageId: k.id, taskId: t.id, claimToken: c.claimToken, report: good({ outcome: 'partial', workPerformed: 'Half', unresolvedQuestions: ['Which font?'] }) });
    await rejects(svc.reviewReport(user, p.id, part.report.id, 'accept'), 'blocked');
    let cur = await svc.getProject(user, p.id);
    expect(cur.tasks[0]!.status).toBe('in_progress');
    expect(cur.proposals[0]!.changes[0]).toMatchObject({ op: 'add_item', itemType: 'question', title: 'Which font?' });
    expect(cur.items.length).toBe(0); // the question is only proposed
    const done = await svc.submitReport(claude, p.id, { packageId: k.id, taskId: t.id, claimToken: c.claimToken, report: good() });
    await svc.reviewReport(user, p.id, done.report.id, 'revise', 'Make it blue');
    cur = await svc.getProject(user, p.id);
    expect(cur.tasks[0]!.status).toBe('revision');
    const again = await svc.claimTask(claude, p.id, k.id, t.id);
    const redo = await svc.submitReport(claude, p.id, { packageId: k.id, taskId: t.id, claimToken: again.claimToken, report: good({ workPerformed: 'Blue now.' }) });
    await svc.reviewReport(user, p.id, redo.report.id, 'accept');
    expect((await svc.getProject(user, p.id)).tasks[0]!.status).toBe('accepted');
  });

  it('expired claims can be taken over and the history says so', async () => {
    let clock = new Date('2026-01-01T00:00:00Z');
    const store = new PlannerStore(path.join(tmp, 'lease'), () => clock);
    const svc = new PlannerService(store, () => clock);
    const p = await svc.createProject(user, { title: 'Lease' });
    const t = await svc.addTask(user, p.id, { title: 'T' });
    const k = await svc.createPackage(user, p.id, { taskIds: [t.id] });
    await svc.claimTask(claude, p.id, k.id, t.id, { leaseMinutes: 30 });
    clock = new Date('2026-01-01T01:00:00Z');
    const other = connectionCtx({ kind: 'cowork', name: 'Cowork' }, ['read', 'execute']);
    await svc.claimTask(other, p.id, k.id, t.id);
    const log = await svc.activity(user, p.id);
    expect(log.some((e) => e.summary.includes('took over an expired claim by Claude Code'))).toBe(true);
    expect(log.every((e) => e.actor.name)).toBe(true);
  });

  it('copy and paste: package as Markdown, JSON report in, preview first, original kept, no duplicates', async () => {
    const { svc } = mk('paste');
    const p = await svc.createProject(user, { title: 'Paste', templates: ['document'] });
    const t = p.tasks[1]!;
    const pkg = await svc.createPackage(user, p.id, { taskIds: [p.tasks[0]!.id, t.id] });
    const md = packageToMarkdown(pkg, p.title);
    expect(md).toContain(pkg.id);
    expect(md).toContain('Completion checks');
    const text = `Here you go\n\`\`\`json\n${JSON.stringify({ packageId: pkg.id, taskId: pkg.tasks[0]!.id, executor: { name: 'ChatGPT', kind: 'chatgpt' }, ...good({ workPerformed: 'Outlined.' }) })}\n\`\`\``;
    const prev = parseReportText(text);
    expect(prev).toMatchObject({ format: 'json', packageId: pkg.id, errors: [] });
    // nothing applied by reading
    expect((await svc.getProject(user, p.id)).reports.length).toBe(0);
    const res = await svc.importReport(user, p.id, { packageId: pkg.id, taskId: pkg.tasks[0]!.id, executor: prev.executor!, report: prev.draft!, uncertain: prev.uncertain, rawText: text });
    expect(res.report.source).toBe('pasted');
    expect(await svc.rawReport(user, p.id, res.report.id)).toBe(text);
    const dup = await svc.importReport(user, p.id, { packageId: pkg.id, taskId: pkg.tasks[0]!.id, executor: prev.executor!, report: prev.draft!, rawText: text });
    expect(dup.duplicate).toBe(true);
    expect((await svc.getProject(user, p.id)).reports.length).toBe(1);
  });

  it('a Markdown report is read tolerantly and its guesses are shown', () => {
    const r = parseReportText(`## Outcome\nDone\n\n## Work performed\nWrote the intro and checked numbers.\n\n## Verification\n- chk_abc123 numbers match source: passed\n- spell check ran, looked fine\n\n## Questions\n- Should it be A4?\n`);
    expect(r.format).toBe('markdown');
    expect(r.draft!.outcome).toBe('complete');
    expect(r.draft!.verification.map((v) => v.result)).toEqual(['pass', 'not_run']);
    expect(r.draft!.verification[0]!.checkId).toBe('chk_abc123');
    expect(r.uncertain.join(' ')).toMatch(/no clear result/);
    expect(parseReportText('thanks!').format).toBe('unreadable');
    expect(parseReportText('{"outcome":"complete","workPerformed":""}').errors.length).toBeGreaterThan(0);
  });

  it('exports and imports with referenced versus bundled assets, never overwriting', async () => {
    const { svc } = mk('xport');
    const p = await svc.createProject(user, { title: 'Export me', templates: ['blank'] });
    const f = path.join(tmp, 'poster.txt');
    await fs.writeFile(f, 'pixels');
    const bundled = await svc.addAsset(user, p.id, { role: 'deliverable', title: 'Poster', source: 'file', path: f, group: 'poster' });
    await svc.addAsset(user, p.id, { role: 'deliverable', title: 'Poster v2', source: 'file', path: f, group: 'poster' });
    await svc.addAsset(user, p.id, { role: 'reference', title: 'Moodboard', source: 'link', url: 'https://example.com/m' });
    await svc.addAsset(user, p.id, { role: 'reference', title: 'Gone', source: 'file', path: path.join(tmp, 'nope.png') });
    const t = await svc.addTask(user, p.id, { title: 'T' });
    const k = await svc.createPackage(user, p.id, { taskIds: [t.id] });
    await svc.claimTask(claude, p.id, k.id, t.id);
    expect((await svc.getProject(user, p.id)).assets.map((a) => a.version)).toEqual([1, 2, 1, 1]);
    for (const mode of ['reference', 'bundle'] as const) {
      const zip = await svc.exportProject(user, p.id, mode);
      expect(zip.toString('latin1')).not.toContain('claudeToken');
      const q = await svc.importProject(user, zip);
      expect(q.id).not.toBe(p.id);
      expect(q.title).toBe('Export me (imported)');
      expect(q.tasks[0]!.claim).toBeNull();
      const health = await svc.assetHealth(user, q.id);
      expect(health[bundled.id]).toBe(mode === 'bundle' ? 'ok' : 'ok');
      expect(Object.values(health)).toContain('missing');
      if (mode === 'bundle') expect(q.assets.find((a) => a.id === bundled.id)!.path).toContain(q.id);
    }
    await rejects(svc.importProject(user, Buffer.from('not a zip')), 'invalid');
    expect((await svc.getProject(user, p.id)).title).toBe('Export me');
  });

  it('changes since a revision, and a connection cannot hold edit or review', async () => {
    const { svc } = mk('since');
    const p = await svc.createProject(user, { title: 'Since' });
    const r0 = (await svc.getProject(user, p.id)).revision;
    await svc.addItem(user, p.id, { type: 'idea', title: 'x' });
    const ch = await svc.changesSince(brainstorm, p.id, r0);
    expect(ch.changes.map((c) => c.kind)).toEqual(['idea.added']);
    expect(ch.revision).toBe(r0 + 1);
    expect(() => connectionCtx({ kind: 'other', name: 'x' }, ['read', 'edit'])).toThrow(PlannerError);
    expect(() => connectionCtx({ kind: 'other', name: 'x' }, ['review'])).toThrow(/cannot hold/);
    await rejects(svc.listProjects(connectionCtx({ kind: 'other', name: 'x' }, [])).then(() => svc.createProject(connectionCtx({ kind: 'other', name: 'x' }, ['read']), { title: 'no' })), 'forbidden');
  });
});

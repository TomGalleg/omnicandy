// Phase 5 part 2: run control shared by the editor and Claude (real PhotoCraft headless, real Claude).
// Part A (user): pause/resume, approve (protects results), rerun only what changed, not asked again,
//   versions + restore, save as template. Part B (Claude): run with the user's approval, monitor,
//   change one step, rerun only what changed, template, and refusal while the user has control.
// No paid generation, no ArtCraft window. Run after `npm run build`: node scripts/smoke-workflow-control.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-wfctl-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
await win.evaluate(() => localStorage.setItem('cs-nav-mode', 'advanced'));
await win.reload();
win.on('dialog', (d) => void d.dismiss().catch(() => {}));
await app.evaluate(({ dialog }) => {
  globalThis.__approvals = [];
  dialog.showMessageBox = async (...args) => { globalThis.__approvals.push(args.at(-1)); return { response: 1, checkboxChecked: false }; };
});

const until = async (fn, ms = 60000, step = 250) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); }
};
const state = () => win.evaluate(() => window.studio.workflowRunState());
const manifest = () => win.evaluate(() => window.studio.loadProject());
const gotoWorkflow = async () => {
  await win.locator('nav.workspaces button', { hasText: /^Workflow$/ }).click();
  await win.locator('.react-flow__node').first().waitFor({ timeout: 10000 });
};
const recordEvents = () => win.evaluate(() => { window.__ev = []; window.studio.onWorkflowEvent((e) => window.__ev.push(e)); });
const events = () => win.evaluate(() => window.__ev);

try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await app.evaluate((e) => { e.BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 60, width: 1500, height: 940 }); });
  const before = await manifest();
  const photos = before.assets.filter((a) => a.kind === 'image' && a.sourceFormat === 'jpg' && !a.parentId).slice(0, 2);
  const graph = (op = 'blackWhite', preset = 'image-png') => ({
    schemaVersion: 1,
    nodes: [
      { id: 'n-in', type: 'import', position: { x: 0, y: 80 }, params: { mode: 'files', assetIds: JSON.stringify(photos.map((p) => p.id)), assetId: '', folder: '' } },
      { id: 'n-edit', type: 'artcraftEdit', position: { x: 280, y: 80 }, params: { appId: 'photocraft', opId: op, values: '{}', command: '', commandParams: '' } },
      { id: 'n-ok', type: 'approval', position: { x: 560, y: 80 }, params: { note: 'Check the tones' } },
      { id: 'n-out', type: 'export', position: { x: 840, y: 80 }, params: { presets: preset } },
    ],
    edges: [
      { id: 'e1', source: 'n-in', sourceHandle: 'image', target: 'n-edit', targetHandle: 'image' },
      { id: 'e2', source: 'n-edit', sourceHandle: 'image', target: 'n-ok', targetHandle: 'in' },
      { id: 'e3', source: 'n-ok', sourceHandle: 'out', target: 'n-out', targetHandle: 'in' },
    ],
  });
  const setGraph = async (g) => { await win.evaluate((x) => window.studio.saveWorkflow(x), g); await win.reload(); await gotoWorkflow(); await recordEvents(); };

  // ---------- Part A: the user ----------
  await setGraph(graph());
  await win.getByRole('button', { name: /^Run/ }).click();
  let paused = null;
  for (let i = 0; i < 40 && !paused; i++) { paused = await win.evaluate(() => window.studio.pauseWorkflow().then(() => true, () => false)); if (!paused) await sleep(50); }
  check('Pause is accepted while running', !!paused);
  const ps = await until(async () => (await state()).state === 'paused' && (await state()), 20000);
  check('the run holds before the next step (paused)', !!ps, ps ? ps.state : 'never paused');
  await win.getByText('Paused before the next step').waitFor({ timeout: 5000 }).then(() => check('UI says paused and offers Resume / Apply changes', true), () => check('UI says paused and offers Resume / Apply changes', false));
  await win.screenshot({ path: path.join(shots, '55-workflow-paused.png') });
  await win.getByRole('button', { name: 'Resume as it was' }).click();
  await win.locator('.wf-approval').waitFor({ timeout: 90000 });
  await win.screenshot({ path: path.join(shots, '56-workflow-approval.png') });
  await win.getByRole('button', { name: /^Approve all/ }).click();
  await until(async () => (await events()).some((e) => e.kind === 'run-finished'), 120000);
  let evs = await events();
  check('first run completed', evs.find((e) => e.kind === 'run-finished')?.ok === true);
  let m = await manifest();
  const approved1 = m.assets.filter((a) => a.approval === 'approved');
  check('approved results are marked approved on the files', approved1.length >= photos.length, `${approved1.length}`);
  const assetsAfterRun1 = m.assets.length;

  // Change only the export format, then rerun: edit and approval keep their results.
  await setGraph(graph('blackWhite', 'image-jpg'));
  const aff = await win.evaluate((g) => window.studio.workflowAffected(g), graph('blackWhite', 'image-jpg'));
  check('only the export step is affected by changing the export', aff.hasRun && aff.affected.join() === 'n-out', aff.affected.join());
  await win.getByRole('button', { name: /Rerun 1 changed step/ }).click();
  await until(async () => (await events()).some((e) => e.kind === 'run-finished'), 120000);
  evs = await events();
  const kept = evs.filter((e) => e.kind === 'node-status' && /Kept from the earlier run/.test(e.message ?? '')).map((e) => e.nodeId);
  check('rerun kept the unchanged steps', ['n-in', 'n-edit', 'n-ok'].every((n) => kept.includes(n)), kept.join());
  check('rerun did not ask for approval again', !evs.some((e) => e.kind === 'approval-request'));
  check('rerun made no new versions', (await manifest()).assets.length === assetsAfterRun1);
  const exps = await win.evaluate(() => window.studio.listExports());
  check('rerun exported the new format', exps.some((x) => /\.jpe?g$/i.test(x.name)), exps.map((x) => x.name).join(', '));

  // Change the edit: the edit and what follows run again; the earlier approval stays on the old versions.
  await setGraph(graph('warm', 'image-jpg'));
  await win.getByRole('button', { name: /Rerun 3 changed steps/ }).click();
  await win.locator('.wf-approval').waitFor({ timeout: 90000 });
  check('changed results are asked about (new versions)', true);
  await win.getByRole('button', { name: /^Approve all/ }).click();
  await until(async () => (await events()).some((e) => e.kind === 'run-finished'), 120000);
  m = await manifest();
  check('earlier approved versions are still approved', approved1.every((a) => m.assets.find((x) => x.id === a.id)?.approval === 'approved'));
  check('new versions were added without touching the old ones', m.assets.length > assetsAfterRun1, `${assetsAfterRun1} -> ${m.assets.length}`);

  // Versions, templates
  const versions = await win.evaluate(() => window.studio.listWorkflowVersions());
  check('versions were kept before runs', versions.length >= 1, `${versions.length}`);
  const aff2 = await win.evaluate((g) => window.studio.workflowAffected(g), graph('warm', 'image-jpg'));
  check('template is available after a successful unchanged run', aff2.templateReady === true);
  const t = await win.evaluate(() => window.studio.saveWorkflowTemplate('Smoke template', 'Warm, check, export'));
  check('template saved', t.id === 'smoke-template');
  const g0 = await win.evaluate((id) => window.studio.useWorkflowTemplate(id), t.id);
  check('template keeps the steps and drops the file choice', g0.nodes.length === 4 && JSON.parse(g0.nodes.find((n) => n.type === 'import').params.assetIds).length === 0);
  const vs = await win.evaluate(() => window.studio.listWorkflowVersions());
  const restored = await win.evaluate((id) => window.studio.restoreWorkflowVersion(id), vs[vs.length - 1].id);
  check('an earlier version can be restored', restored.nodes.length === 4 && JSON.parse(restored.nodes.find((n) => n.type === 'import').params.assetIds).length === photos.length);
  await win.screenshot({ path: path.join(shots, '57-workflow-control-user.png') });

  // ---------- Part B: Claude ----------
  await win.evaluate(() => window.studio.claude.setModel('claude-sonnet-5-5'));
  await setGraph(graph('blackWhite', 'image-png'));
  await win.locator('.side-tab.right').click();
  const ask = async (text) => {
    await win.locator('#claude-input').fill(text);
    await win.getByRole('button', { name: 'Send' }).click();
    await sleep(1500);
    await win.locator('.claude .chip', { hasText: 'Ready' }).waitFor({ timeout: 360000 });
    const s = await win.evaluate(() => window.studio.claude.state());
    return s.items.filter((i) => i.role === 'claude').map((i) => i.text).at(-1) ?? '';
  };
  const assetsBeforeB = (await manifest()).assets.length;
  let said = await ask('Run my saved workflow now with run_workflow, then follow it with workflow_status (use wait_seconds) until it needs my approval. Do not approve anything yourself. Tell me what is waiting for me.');
  const stB = await state();
  check('Claude started the run after the user approved the dialog', (await app.evaluate(() => globalThis.__approvals.length)) >= 1 && stB.startedBy === 'claude');
  check('the run is waiting for the user, not approved by Claude', stB.state === 'waiting-for-you', stB.state);
  check('Claude told the user what is waiting', said.length > 20, said.slice(0, 200));
  await win.screenshot({ path: path.join(shots, '58-claude-runs-workflow.png') });
  const waitNode = stB.steps.find((s) => s.status === 'awaiting_approval');
  await win.locator('.wf-approval').waitFor({ timeout: 20000 });
  await win.getByRole('button', { name: /^Approve all/ }).click();
  check('the approval was the user\'s', !!waitNode);
  await until(async () => (await state()).state === 'finished', 120000);
  check('run finished OK', (await state()).ok === true);
  const assetsAfterB1 = (await manifest()).assets.length;

  said = await ask('Change the export step to JPEG (use change_workflow_step with the export preset image-jpg), then rerun only what changed with rerun_workflow and check workflow_status until it finishes. Then say which steps were kept.');
  const wf = await win.evaluate(() => window.studio.loadWorkflow());
  check('Claude changed only the export step', wf.nodes.find((n) => n.type === 'export').params.presets === 'image-jpg' && wf.nodes.find((n) => n.type === 'artcraftEdit').params.opId === 'blackWhite');
  const stC = await until(async () => { const s = await state(); return s.state === 'finished' && s; }, 120000);
  check('Claude\'s rerun finished', !!stC && stC.ok === true);
  check('Claudes rerun kept the edit and approval (no new versions)', (await manifest()).assets.length === assetsAfterB1, `${assetsAfterB1} -> ${(await manifest()).assets.length}`);
  check('the first Claude run added the edited versions', assetsAfterB1 > assetsBeforeB);
  const vers = await win.evaluate(() => window.studio.listWorkflowVersions());
  check('the workflow before Claudes change is kept as an earlier version', vers.filter((v) => /Claude/.test(v.reason)).length >= 2, vers.map((v) => v.reason).join(' | '));
  check('rerun needed a second approval of the dialog', (await app.evaluate(() => globalThis.__approvals.length)) >= 2);

  said = await ask('Save this workflow as a template called "Claude B and W" (save_workflow_template).');
  const tpls = await win.evaluate(() => window.studio.listWorkflowTemplates());
  check('Claude saved a template of the successful workflow', tpls.some((x) => /Claude B and W/i.test(x.name)), tpls.map((x) => x.name).join(', '));

  // Manual control: Claude must not change anything.
  await win.evaluate(() => window.studio.setWorkflowControl('user'));
  const wfBefore = JSON.stringify(await win.evaluate(() => window.studio.loadWorkflow()));
  said = await ask('Change the approval note to "Claude was here" with change_workflow_step.');
  const wfAfter = JSON.stringify(await win.evaluate(() => window.studio.loadWorkflow()));
  check('Claude cannot change the workflow while the user has manual control', wfBefore === wfAfter, said.slice(0, 200));
  await win.evaluate(() => window.studio.setWorkflowControl('claude'));
  const gen = (await manifest()).assets.filter((a) => a.provenance.provider && a.provenance.provider !== 'mock');
  check('no paid generation happened', gen.length === 0);
  await win.screenshot({ path: path.join(shots, '59-workflow-control-claude.png') });
} catch (e) {
  check('workflow control smoke', false, String(e).slice(0, 500));
} finally {
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} workflow control checks passed`);
process.exit(failed ? 1 : 0);

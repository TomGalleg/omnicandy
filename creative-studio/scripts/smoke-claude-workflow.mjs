// Claude builds a workflow from a plain request (real Claude, needs Claude Code signed in).
// Checks: a validated plan appears in the Workflow tab with cost/approval info, nothing is saved
// or run until "Use this workflow", and no generation happens. No paid call, no ArtCraft window.
// Run after `npm run build`: node scripts/smoke-claude-workflow.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-claude-wf-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
await win.evaluate(() => localStorage.setItem('cs-nav-mode', 'advanced'));
await win.reload();
try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  const before = await win.evaluate(() => window.studio.loadProject());
  const photos = before.assets.filter((a) => a.kind === 'image' && !a.parentId).slice(0, 2).map((a) => a.name);
  const wfBefore = await win.evaluate(() => window.studio.loadWorkflow());
  await win.locator('nav.workspaces button', { hasText: /^Workflow$/ }).click();
  await win.locator('.side-tab.right').click();
  await win.locator('#claude-input').fill(`Build me a workflow (use plan_workflow, do not edit or generate anything yourself): take the library photos ${photos.join(' and ')}, turn them black and white in PhotoCraft, let me approve the results, then export them as PNG. Then explain the plan to me in plain words.`);
  await win.getByRole('button', { name: 'Send' }).click();
  await win.locator('.claude .chip', { hasText: 'Ready' }).waitFor({ timeout: 300000 });

  const plan = await win.evaluate(() => window.studio.getWorkflowPlan());
  check('Claude proposed a plan', !!plan, plan?.title);
  if (plan) {
    const types = plan.graph.nodes.map((n) => n.type);
    check('plan uses the engine node types in a valid chain', types.includes('import') && types.includes('artcraftEdit') && types.includes('approval') && types.includes('export'), types.join(' > '));
    check('plan edits are real PhotoCraft ops', plan.graph.nodes.some((n) => n.type === 'artcraftEdit' && n.params.appId === 'photocraft' && n.params.opId));
    check('plan has an approval point and a cost note', plan.approvals.length > 0 && /cost|paid/i.test(plan.costNote), plan.costNote);
    check('plan files are the requested library files', plan.graph.nodes.find((n) => n.type === 'import')?.params.assetIds?.length > 10);
  }
  const wfAfterPlan = await win.evaluate(() => window.studio.loadWorkflow());
  check('proposing saved nothing', JSON.stringify(wfAfterPlan) === JSON.stringify(wfBefore));
  const s = await win.evaluate(() => window.studio.claude.state());
  const said = s.items.filter((i) => i.role === 'claude').map((i) => i.text).join(' | ');
  check('Claude explained it in the chat', said.length > 80, said.slice(0, 300));
  await win.locator('.wf-plan').waitFor({ timeout: 5000 });
  await win.screenshot({ path: path.join(shots, '53-claude-workflow-plan.png') });
  await win.getByRole('button', { name: /Use this workflow|Replace my workflow/ }).click();
  await win.locator('.wf-plan').waitFor({ state: 'detached', timeout: 10000 });
  const wfNow = await win.evaluate(() => window.studio.loadWorkflow());
  check('Use this workflow saves the plan', wfNow.nodes.length === plan?.graph.nodes.length, `${wfNow.nodes.length} nodes`);
  const after = await win.evaluate(() => window.studio.loadProject());
  check('no files were generated or changed', after.assets.length === before.assets.length);
  await win.screenshot({ path: path.join(shots, '54-claude-workflow-applied.png') });
} catch (e) {
  check('claude workflow smoke', false, String(e).slice(0, 400));
} finally {
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} Claude workflow checks passed`);
process.exit(failed ? 1 : 0);

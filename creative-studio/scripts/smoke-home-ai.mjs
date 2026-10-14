// Prompt-first creation smoke with REAL Claude (one planning call, Sonnet; no tools, no image generation).
// Needs Claude Code signed in on this PC. Run after `npm run build`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-homeai-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
try {
  await win.getByRole('heading', { name: 'What would you like to create?' }).waitFor({ timeout: 20000 });
  check('the app opens on Project Home', true);
  await win.waitForTimeout(2000); // the first project load re-mounts Home once
  await win.evaluate(() => window.studio.claude.setModel('claude-sonnet-5-5'));
  await win.getByLabel('Describe what you would like to create')
    .fill('Make a short cinematic poster for a desert adventure film from my photo, with a bold title, ready for print.');
  await win.getByRole('button', { name: 'Create with Claude' }).click();
  await win.getByRole('region', { name: "Claude's plan" }).waitFor({ timeout: 120000 });
  const planText = await win.getByRole('region', { name: "Claude's plan" }).textContent();
  check('Claude returned a real plan (name, type, steps)', /Finished result/.test(planText) && (await win.locator('.plan-steps li').count()) >= 1, planText.slice(0, 160));
  await win.screenshot({ path: path.join(shots, '46-home-claude-plan.png') });
  const before = (await win.evaluate(() => window.studio.projects.list())).length;
  check('nothing is created before approval', before === 1);
  await win.getByRole('button', { name: 'Approve and create project' }).click();
  await win.waitForFunction(() => !/Sample Project/.test(document.querySelector('.project-name')?.textContent ?? 'Sample Project'), null, { timeout: 15000 });
  await win.waitForTimeout(1000);
  const landed = await win.locator('nav.workspaces button[aria-current=page]').textContent().catch(() => '');
  check('Approve opens the matching workspace (not Home)', !!landed && !/Home/.test(landed), landed ?? '');
  const m = await win.evaluate(() => window.studio.loadProject());
  check('the project was created and opened with type, brief and objective', !!m.kind && /desert/i.test(m.brief ?? '') && !!m.objective, `${m.name} / ${m.kind}`);
  check('no image was generated', m.assets.length === 0);
  await win.getByRole('button', { name: 'Home', exact: true }).click().catch(() => {});
  await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(shots, '47-project-overview-brief.png') });
} catch (e) {
  check('home AI smoke', false, String(e).slice(0, 400));
} finally {
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} home AI smoke checks passed`);
process.exit(failed ? 1 : 0);

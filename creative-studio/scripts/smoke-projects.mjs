// Project Home / Overview smoke in the built app (isolated profile). Run after `npm run build`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-projects-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
let win = await app.firstWindow();
win.on('dialog', (d) => void d.accept());
const header = () => win.locator('.project-name').textContent();
try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await win.getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('radio', { name: /^ArtCraft Match/ }).click();
  await win.keyboard.press('Escape');

  await win.locator('.project-name').click();
  await win.locator('.project-card').first().waitFor();
  check('project name in the header opens Project Home', true);
  const thumbOk = await win.locator('.project-card .project-thumb img').first().evaluate((img) => img.complete && img.naturalWidth > 0);
  check('Sample Project listed as open, with a thumbnail', /Sample Project/.test(await win.locator('.project-card.open').textContent()) && thumbOk);
  check('Overview shows the open project', /\d+\s*originals/.test(await win.locator('.overview-grid').textContent()));
  await win.screenshot({ path: path.join(shots, '40-project-home.png') });

  check('Home is prompt-first (heading, prompt field, Create with Claude, Open existing, Templates)',
    (await win.getByRole('heading', { name: 'What would you like to create?' }).count()) === 1
    && (await win.getByLabel('Describe what you would like to create').count()) === 1
    && (await win.getByRole('button', { name: 'Create with Claude' }).isDisabled())
    && (await win.getByRole('button', { name: 'Open existing project…' }).count()) === 1
    && (await win.getByRole('button', { name: /^Templates/ }).isDisabled()));
  await win.getByRole('button', { name: 'New blank project' }).click();
  check('blank project offers the five categories',
    (await win.getByLabel('Project type').locator('option').allTextContents()).join('|') === 'Image / Photography|Graphic Design|Video / Animation|Audio|Mixed Media');
  await win.getByLabel('New project name').fill('Poster series');
  await win.getByLabel('Project type').selectOption('design');
  await win.getByRole('button', { name: 'Create project' }).click();
  await win.locator('.project-card.open', { hasText: 'Poster series' }).waitFor({ timeout: 10000 });
  await sleep(400);
  check('creating a project opens it', /Poster series/.test(await header()), await header());
  check('a new project starts empty (own library, own workflow)', (await win.locator('.asset').count()) === 0 && /0\s*originals/.test(await win.locator('.overview-grid').textContent())
    && (await win.evaluate(() => window.studio.loadWorkflow())).nodes.length === 0);
  check('the new project shows its type', /Graphic Design/.test(await win.locator('.home-head h2').last().textContent()));
  await win.screenshot({ path: path.join(shots, '41-new-project-overview.png') });

  await win.locator('.project-card', { hasText: 'Sample Project' }).getByRole('button', { name: 'Open', exact: true }).click();
  await win.locator('.project-card.open', { hasText: 'Sample Project' }).waitFor({ timeout: 10000 });
  await win.locator('.asset').first().waitFor({ timeout: 10000 });
  check('switching back to the Sample Project restores its files', (await win.locator('.asset').count()) >= 6 && /Sample Project/.test(await header()));

  const card = win.locator('.project-card', { hasText: 'Poster series' });
  await card.getByRole('button', { name: 'Rename' }).click();
  await win.getByLabel('Project name', { exact: true }).fill('Poster series 2026');
  await win.getByLabel('Project name', { exact: true }).press('Enter');
  await win.locator('.project-card', { hasText: 'Poster series 2026' }).waitFor({ timeout: 5000 });
  check('rename works', true);

  await win.locator('.project-card', { hasText: 'Poster series 2026' }).getByRole('button', { name: 'Remove' }).click();
  await sleep(1500);
  check('remove (after confirming) takes it off the list', (await win.locator('.project-card', { hasText: 'Poster series 2026' }).count()) === 0);
  check('the open project and the sample cannot be removed', (await win.locator('.project-card.open').getByRole('button', { name: 'Remove' }).count()) === 0);

  // remember the open project across restart
  await win.getByRole('button', { name: 'New blank project' }).click();
  await win.getByLabel('New project name').fill('Keep me open');
  await win.getByRole('button', { name: 'Create project' }).click();
  await win.locator('.project-card.open', { hasText: 'Keep me open' }).waitFor({ timeout: 10000 });
} catch (e) {
  check('projects smoke', false, String(e).slice(0, 400));
} finally {
  await app.close();
}
app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
win = await app.firstWindow();
try {
  await win.locator('.project-name').waitFor({ timeout: 20000 });
  await sleep(1200);
  check('the open project is remembered after a restart', /Keep me open/.test(await header()), await header());
} finally {
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} project smoke checks passed`);
process.exit(failed ? 1 : 0);

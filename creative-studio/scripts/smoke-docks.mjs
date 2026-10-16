// Smoke test of the simplified shell (no ArtCraft windows): a header without status chips, Settings
// with Integrations and Advanced diagnostics, and the Media / Claude side tabs (click, keyboard,
// remembered after a restart). Run after `npm run build`: node scripts/smoke-docks.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-docks-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1600, height: 960 }).catch(() => {});
  await win.locator('.asset').first().waitFor({ state: 'attached', timeout: 20000 });
  await sleep(500);
  return { app, win };
}
const shot = (win, name) => win.screenshot({ path: path.join(shots, `${name}.png`) });
const width = (win, sel) => win.locator(sel).evaluate((el) => Math.round(el.getBoundingClientRect().width));

let { app, win } = await launch();
try {
  // ---- 1.1 header ----
  check('header has no status chips', (await win.locator('header .chip').count()) === 0);
  check('header has a Settings button', await win.getByRole('button', { name: 'Settings' }).isVisible());
  await win.getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('radio', { name: /^ArtCraft Match/ }).click();
  await win.getByRole('tab', { name: 'Integrations' }).click();
  const apps = await win.locator('.settings .menu-label', { hasText: 'ArtCraft apps' }).textContent();
  check('Settings > Integrations shows ArtCraft detection', /\d+ of 13 installed/.test(apps ?? ''), apps ?? '');
  await win.locator('.settings .menu-label', { hasText: 'AI image providers' }).waitFor();
  await sleep(500);
  check('Settings > Integrations shows AI provider status', (await win.locator('.settings .status-list li').count()) >= 9);
  await shot(win, '40-settings-integrations');
  await win.getByRole('tab', { name: 'Advanced diagnostics' }).click();
  check('Advanced diagnostics lists services', await win.locator('.settings dt', { hasText: 'Window capture' }).isVisible());
  await shot(win, '41-settings-diagnostics');
  await win.keyboard.press('Escape');
  check('Escape closes Settings', (await win.locator('.settings').count()) === 0);

  // ---- 1.2 side tabs ----
  check('Media library starts open, Claude starts minimized', await win.locator('#dock-media').isVisible() && !(await win.locator('.claude').isVisible()));
  await shot(win, '42-shell-media-open');
  const center0 = await width(win, '.center');
  await win.locator('.side-tab.left').click();
  await sleep(300);
  const center1 = await width(win, '.center');
  check('Media tab collapses the library; the tab stays; the workspace grows', !(await win.locator('#dock-media').isVisible()) && await win.locator('.side-tab.left').isVisible() && center1 > center0 + 150, `${center0} → ${center1}`);
  check('collapsed Media tab is narrow', (await width(win, '.dock >> nth=0')) <= 32, `${await width(win, '.dock >> nth=0')}px`);
  await win.locator('.side-tab.right').click();
  await win.locator('.claude').waitFor({ timeout: 5000 });
  await sleep(300);
  check('Claude tab opens the Creative Partner; the tab stays on its left edge', await win.locator('.claude').isVisible()
    && (await win.locator('.side-tab.right').boundingBox()).x < (await win.locator('.claude').boundingBox()).x);
  await shot(win, '43-shell-media-closed-claude-open');
  await win.keyboard.press('Control+Shift+M');
  await sleep(300);
  check('Ctrl+Shift+M reopens the library (both panels open)', await win.locator('#dock-media').isVisible() && await win.locator('.claude').isVisible());
  await shot(win, '44-shell-both-open');
  await win.keyboard.press('Control+Shift+C');
  await sleep(300);
  check('Ctrl+Shift+C hides Claude', !(await win.locator('.claude').isVisible()));
  const expanded = await win.locator('.side-tab.left').getAttribute('aria-expanded');
  check('side tabs report their state to screen readers', expanded === 'true' && (await win.locator('.side-tab.right').getAttribute('aria-expanded')) === 'false');

  // Both collapsed, then restart: state is remembered.
  await win.locator('.side-tab.left').click();
  await sleep(300);
  await shot(win, '45-shell-both-collapsed');
  await app.close();
  ({ app, win } = await launch());
  check('collapsed state is remembered after a restart', !(await win.locator('#dock-media').isVisible()) && !(await win.locator('.claude').isVisible()));
  await win.locator('.side-tab.left').click();
  await sleep(300);
  check('reopened library comes back at a usable width', (await width(win, '#dock-media')) >= 200, `${await width(win, '#dock-media')}px`);
} catch (e) {
  check('smoke run', false, String(e));
} finally {
  await app.close().catch(() => {});
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

// Smoke test of Simplified / Advanced navigation (no ArtCraft windows).
// Run after `npm run build`: node scripts/smoke-nav.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-nav-'));
let fails = 0;
const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const navTexts = (win) => win.locator('nav.workspaces > button, nav.workspaces .more-menu > button').allTextContents().then((a) => a.map((t) => t.replace(/\s*▾$/, '').trim()));

async function launch() {
  const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1600, height: 960 }).catch(() => {});
  await win.locator('.asset').first().waitFor({ state: 'attached', timeout: 20000 });
  await sleep(500);
  return { app, win };
}

let { app, win } = await launch();
try {
  check('Simplified is the default', JSON.stringify(await navTexts(win)) === JSON.stringify(['Project', 'Create', 'AI Generate', 'Deliver', 'More']), (await navTexts(win)).join(', '));
  await win.getByRole('button', { name: 'More', exact: false }).filter({ hasText: /^More/ }).click();
  const items = await win.locator('.more-list [role=menuitem]').allTextContents();
  check('More lists the specialist tools', items.join(',') === 'Media,Workflow,Effects,Color,Audio,Planner', items.join(','));
  await win.screenshot({ path: path.join(shots, '48-nav-simplified-more.png') });
  await win.locator('.more-list [role=menuitem]', { hasText: 'Workflow' }).click();
  await win.locator('.workspaces button[aria-current=page]').first().waitFor();
  check('Choosing a tool under More opens it and marks More', /More: Workflow/.test(await win.locator('.workspaces button[aria-current=page]').textContent()));
  await win.getByRole('button', { name: 'Simplified', exact: true }).click();
  const adv = await navTexts(win);
  check('Advanced shows the full navigation', adv.join(',') === 'Home,Media,Edit,AI Generate,Workflow,Effects,Color,Audio,Deliver,Planner', adv.join(','));
  check('Same workspace stays open across modes', /Workflow/.test(await win.locator('.workspaces button[aria-current=page]').textContent()));
  await win.screenshot({ path: path.join(shots, '49-nav-advanced.png') });
  await app.close();
  ({ app, win } = await launch());
  const again = await navTexts(win);
  check('The preference is remembered after a restart', again.includes('Media') && !again.includes('More'), again.join(','));
  await win.getByRole('button', { name: 'Advanced', exact: true }).click();
  check('Switching back to Simplified works', (await navTexts(win)).includes('More'));
} finally {
  await app.close().catch(() => {});
}
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);

// Smoke test of the toolbar (no ArtCraft windows): one list of workspaces with Media on it directly, no More menu and no Simplified/Advanced switch.
// Run after `npm run build`: node scripts/smoke-nav.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-nav-'));
let fails = 0;
const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const navTexts = (win) => win.locator('nav.workspaces > button').allTextContents().then((a) => a.map((t) => t.trim()));

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
try {
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1600, height: 960 }).catch(() => {});
  await win.locator('.asset').first().waitFor({ state: 'attached', timeout: 20000 });
  await sleep(500);
  check('The toolbar lists every workspace, with Media on it', JSON.stringify(await navTexts(win)) === JSON.stringify(['Project', 'Media', 'Edit', 'AI Generate', 'Software', 'Planner', 'Deliver']), (await navTexts(win)).join(', '));
  check('There is no More menu and no Simplified/Advanced button', (await win.locator('.more-menu').count()) === 0 && (await win.getByRole('button', { name: /^(Simplified|Advanced)$/ }).count()) === 0);
  for (const name of ['Media', 'Edit', 'AI Generate', 'Software', 'Planner', 'Deliver', 'Project']) {
    await win.locator('nav.workspaces > button', { hasText: new RegExp(`^${name}`) }).click(); await sleep(400);
    check(`${name} opens from the toolbar`, (await win.locator('nav.workspaces > button[aria-current=page]').innerText()).trim().startsWith(name));
  }
} finally {
  await app.close().catch(() => {});
}
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);

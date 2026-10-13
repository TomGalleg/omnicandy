// End-to-end smoke of LIVE PhotoCraft control through the real Creative Studio UI.
// Opens a real PhotoCraft window. Run after `npm run build`: node scripts/smoke-live.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-live-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

/** PhotoCraft windows started for this profile (identified by their automation root). */
function killOurPhotoCraft() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='photocraft.exe'" | Where-Object { $_.CommandLine -like '*--control*' } | ForEach-Object { $_.ProcessId }`;
  const pids = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).split(/\s+/).filter(Boolean);
  for (const pid of pids) {
    const env = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.ToString('o')`], { encoding: 'utf8' }).trim();
    if (new Date(env).getTime() >= started) try { process.kill(Number(pid)); } catch { /* already gone */ }
  }
}
const started = Date.now();

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
const shot = (name) => win.screenshot({ path: path.join(shots, `${name}.png`) });
const phase = () => win.locator('.claude .phase').textContent();
try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await win.getByRole('option', { name: /^harbor-landscape\.svg/ }).click();
  await win.getByRole('button', { name: 'Edit', exact: true }).click();
  await win.getByRole('button', { name: /Open harbor-landscape\.svg in PhotoCraft/ }).click();
  await win.getByText(/PhotoCraft live · harbor-landscape\.svg/).waitFor({ timeout: 40000 });
  check('PhotoCraft window launched and document opened over the token-protected bridge', true);
  check('vector flattened on open (shown in history)', /flatten/i.test(await win.locator('.live-history').textContent()));

  await win.getByRole('button', { name: /Run 3 steps in PhotoCraft/ }).click();
  await win.getByText('● applying…').first().waitFor({ timeout: 15000 });
  await win.locator('.claude').getByRole('button', { name: 'Take Control' }).click();
  await win.locator('.claude .notice').waitFor({ timeout: 30000 });
  const applied = await win.locator('.live-history li').count();
  check('Take Control waited for the active step, then gave you the lock', /Manual Control/.test(await phase()), `history items: ${applied}`);
  await shot('11-live-manual-control');

  await win.getByRole('button', { name: "I'm done, hand back" }).click();
  await win.locator('.claude').getByRole('button', { name: 'Resume' }).click();
  await win.locator('.claude .phase', { hasText: 'Completed' }).waitFor({ timeout: 30000 });
  check('resume after hand-back completed the remaining steps', /Completed/.test(await phase()));

  const before = (await win.evaluate(() => window.studio.loadProject())).assets.length;
  await win.getByRole('button', { name: 'Save as new version' }).click();
  await win.getByText(/Saved harbor-landscape-live1\.pcraft/).first().waitFor({ timeout: 30000 });
  const assets = (await win.evaluate(() => window.studio.loadProject())).assets;
  const png = assets.find((a) => a.name === 'harbor-landscape-live1.png');
  check('saved .pcraft + .png versions into the library', assets.length === before + 2 && png?.width === 1600, png ? `${png.width}x${png.height}` : 'missing');
  await shot('12-live-completed-saved');

  await win.getByRole('button', { name: 'Media', exact: true }).click();
  await win.getByRole('option', { name: /^harbor-landscape-live1\.png/ }).click();
  await win.waitForTimeout(500);
  await shot('13-live-version-in-library');
} catch (e) {
  check('live smoke', false, String(e).slice(0, 300));
  await shot('live-smoke-failure').catch(() => {});
} finally {
  await app.close();
  killOurPhotoCraft();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} live smoke checks passed`);
process.exit(failed ? 1 : 0);

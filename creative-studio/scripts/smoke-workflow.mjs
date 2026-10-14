// End-to-end smoke of the Workflow tab in the built app: pick several files, set an app step and
// export formats in the node settings, run, approve one file from the thumbnails, check the per-file
// table and the exports. App steps run in the background: no ArtCraft window may open.
// Run after `npm run build`: node scripts/smoke-workflow.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-workflow-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const GUI = ['photocraft.exe', 'vectorcraft.exe', 'soundcraft.exe', 'filmcraft.exe', 'lightcraft.exe', 'effectcraft.exe', 'designcraft.exe'];
const CLI = GUI.map((g) => g.replace('.exe', '-cli.exe'));

function ourPids(exe) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToString('o'))" }`;
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean)
    .map((l) => l.split(' ')).filter(([, t]) => new Date(t).getTime() >= started - 2000).map(([pid]) => Number(pid));
}

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
win.on('dialog', (d) => void d.dismiss().catch(() => {}));
const node = (text) => win.locator('.react-flow__node', { hasText: text }).first();

try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await app.evaluate((e) => { e.BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 60, width: 1500, height: 940 }); });
  await win.locator('nav.workspaces button', { hasText: /^Workflow$/ }).click();
  await node('Files').waitFor({ timeout: 10000 });

  // Files: two photos.
  await node('Files').click();
  const list = win.getByLabel('Files', { exact: true });
  await list.getByLabel(/sunset-still\.jpg/).check();
  await list.getByLabel(/photocraft-smoke\.png/).check();
  await list.getByLabel(/harbor-landscape\.svg/).uncheck().catch(() => {});
  check('the Files step takes several library files', /2 files|3 files/.test(await node('Files').textContent()), await node('Files').textContent());

  // App step: LightCraft, "Apply a look".
  await node('App step').click();
  await win.getByLabel('App', { exact: true }).selectOption('lightcraft');
  await win.getByLabel('Edit', { exact: true }).selectOption('look');
  check('the App step can use any ArtCraft app and its edits', /LightCraft · Apply a look/.test(await node('App step').textContent()));

  // Export: web JPEG + PNG.
  await node('Export').click();
  await win.getByLabel('JPEG for the web').check();
  check('Export uses the Deliver presets', /PNG, JPEG for the web|JPEG for the web, PNG/.test(await node('Export').textContent()), await node('Export').textContent());
  await sleep(700); // autosave

  await win.getByRole('button', { name: /^Run/ }).click();
  await win.locator('.wf-approval').waitFor({ timeout: 120000 });
  const thumbs = await win.locator('.wf-approval-item').count();
  check('Approval shows every file\'s result as a thumbnail', thumbs >= 2, `${thumbs} thumbnails`);
  await win.screenshot({ path: path.join(shots, '95-workflow-approval.png') });
  await win.locator('.wf-approval-item').first().getByRole('checkbox').uncheck();
  await win.getByRole('button', { name: /^Approve 1 of/ }).click();
  await win.locator('.wf-msg', { hasText: /Run (completed|finished)/ }).waitFor({ timeout: 120000 });
  const table = await win.locator('.wf-files').textContent();
  check('the run table shows each file at each step', /✓/.test(table) && /Rejected|✕/.test(table), table.slice(0, 200));
  const hist = await win.evaluate(() => window.studio.deliver.history());
  check('approved file exported in both formats (Deliver manifest)', hist.length === 2 && hist.every((r) => r.requestedBy === 'workflow'), hist.map((r) => r.output.file).join(', '));
  check('no ArtCraft window opened (all steps ran in the background)', GUI.every((g) => ourPids(g).length === 0));
  await win.screenshot({ path: path.join(shots, '96-workflow-done.png') });
} catch (e) {
  check('workflow smoke', false, String(e).slice(0, 500));
  await win.screenshot({ path: path.join(shots, 'workflow-failure.png') }).catch(() => {});
} finally {
  await app.close().catch(() => {});
  await sleep(800);
  for (const exe of [...GUI, ...CLI]) for (const pid of ourPids(exe)) try { process.kill(pid); } catch { /* gone */ }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} workflow checks passed`);
process.exit(failed ? 1 : 0);

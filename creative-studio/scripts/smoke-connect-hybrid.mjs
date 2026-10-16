// Universal Connect with a HYBRID integration (connector + add-in) in the REAL CreateCraft window, scratch profile only.
// The program is SimCAD, a SIMULATED test application (fixtures/simcad). This script plays the user's part: it answers the
// native dialogs and "opens" SimCAD at the right moment. Nothing real is installed or changed; costs nothing.
//
// Run after `npm run build`:  node scripts/smoke-connect-hybrid.mjs [--exe <CreateCraft.exe>]
//   --exe  launch the PACKAGED application (electron-builder output, e.g. release/win-unpacked/CreateCraft.exe) from a scratch
//          working folder instead of the repository, to prove nothing depends on repository development paths
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { packAdapter } from './pack-adapter.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const exe = argv.includes('--exe') ? path.resolve(argv[argv.indexOf('--exe') + 1]) : null;
const shots = path.join(repo, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-hybrid-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({ ...(exe ? { executablePath: exe, args: [] } : { args: [repo] }), cwd: path.dirname(profile), env: { ...process.env, CS_USER_DATA_DIR: profile } });
let sim = null;
try {
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
  await win.locator('.asset').first().waitFor({ state: 'attached', timeout: 30000 });
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    dialog.showMessageBox = async (...args) => { globalThis.__dialogs.push(args.at(-1)); return { response: 1, checkboxChecked: false }; };
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });

  if (exe) {
    const where = await app.evaluate(({ app: a }) => ({ packaged: a.isPackaged, appPath: a.getAppPath(), resources: process.resourcesPath }));
    check('running the PACKAGED application, not the repository', where.packaged && !where.appPath.startsWith(repo + path.sep + 'out') && where.appPath.includes('app.asar'), JSON.stringify(where));
    const ov = await win.evaluate(() => window.studio.connect.overview(false));
    const fc = [...ov.entries.map((e) => e.offer), ...[]].filter(Boolean).find((o) => o.adapterId === 'freecad') ?? null;
    const nd = ov.notDetected.find((n) => n.adapterId === 'freecad');
    check('the connector bundled in the installed resources folder (FreeCAD) is offered without repository paths', (fc?.source === 'bundled') || nd?.adapterState === 'available', JSON.stringify(fc ? { source: fc.source, v: fc.version } : nd));
    check('the bundled connector is in <resources>/adapters and the release key list is in <resources>/trust', fs.existsSync(path.join(where.resources, 'adapters')) && fs.existsSync(path.join(where.resources, 'trust', 'release-publishers.json')) && !fs.existsSync(path.join(where.resources, '.local')));
  }
  // The package is dropped into the inbox, the way a person would receive a connector file.
  const listing = await win.evaluate(() => window.studio.external.packages());
  const simRoot = path.join(path.dirname(listing.inboxDir), 'simcad');
  fs.mkdirSync(listing.inboxDir, { recursive: true });
  fs.writeFileSync(path.join(listing.inboxDir, 'simcad-hybrid-sample.ccadapter'), packAdapter({ dir: path.join(repo, 'fixtures', 'hybrid-sample') }).bytes);

  await win.getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('tab', { name: 'Integrations' }).click();
  await win.getByRole('button', { name: 'Connect Applications…' }).click();
  const dlg = win.locator('.connect-dialog');
  await dlg.getByRole('heading', { name: 'Connect Applications' }).waitFor({ timeout: 120000 });

  // 1. found + explained
  const row = dlg.locator('.connect-row').filter({ has: win.locator('.ext-head strong', { hasText: /^SimCAD Hybrid Sample$/ }) });
  await row.waitFor({ timeout: 20000 });
  const rowText = (await row.textContent()) ?? '';
  check('the hybrid package is offered as an add-in for a SIMULATED program, in plain language', /Add-in available \(simulated test program\)/.test(rowText) && /a connector and a small add-in inside/.test(rowText) && /closed while it is installed/.test(rowText), rowText.slice(0, 220));
  check('it says it is only connected after a real test', /only called connected after the add-in answers a real test/.test(rowText));
  await win.screenshot({ path: path.join(shots, '130-hybrid-offered.png') });

  // 2. select, permissions explain close/restart
  await row.getByRole('checkbox').check();
  await dlg.getByRole('button', { name: /^Continue with/ }).click();
  await dlg.getByRole('heading', { name: 'What you are allowing' }).waitFor();
  const perm = (await dlg.textContent()) ?? '';
  check('the permissions step explains: review both halves, close the program, reopen it', /connector and add-in/.test(perm) && /has to be closed while the add-in is installed/.test(perm) && /open \(or restart\)/.test(perm), perm.slice(0, 120));
  await dlg.getByRole('button', { name: /^Set up 1 program/ }).click();

  // 3. review shows steps and Advanced
  const review = dlg.getByRole('group', { name: /Review connector SimCAD Hybrid Sample/ });
  await review.waitFor({ timeout: 60000 });
  const rv = (await review.textContent()) ?? '';
  check('the review lists the steps (close, connector, add-in files, restart, test)', /Close SimCAD/.test(rv) && /Install the connector/.test(rv) && /SimCAD companion add-in/.test(rv) && /Open or restart SimCAD/.test(rv) && /Test the connection/.test(rv), rv.slice(0, 200));
  check('the review says simulated, and technical details are behind an Advanced disclosure', /simulated test program/.test(rv) && (await review.locator('summary', { hasText: 'Advanced' }).count()) === 1);
  await review.locator('summary', { hasText: 'Advanced' }).click();
  check('Advanced shows the exact folder, the local connection and the capabilities', (await review.textContent()).includes(path.join(simRoot, 'plugins')) && /named-pipe, protocol 1-1/.test(await review.textContent()) && /scene\.add_box/.test(await review.textContent()));
  await win.screenshot({ path: path.join(shots, '131-hybrid-review.png') });
  const installBtn = review.getByRole('button', { name: /^Install SimCAD Hybrid Sample/ });
  check('an unsigned package cannot be installed until the user confirms', await installBtn.isDisabled());
  await review.getByRole('checkbox', { name: /not signed/ }).check();
  check('nothing was written before the install button', !fs.existsSync(path.join(simRoot, 'plugins')) && (await win.evaluate(async () => (await window.studio.external.packages()).installed.length)) === 0);
  await installBtn.click();

  // 4. installed but NOT connected: the program has not loaded the add-in
  const rowRun = dlg.locator('.connect-row[data-outcome]');
  await rowRun.first().waitFor();
  await dlg.getByRole('heading', { name: 'Setup finished' }).waitFor({ timeout: 120000 });
  const done = (await dlg.textContent()) ?? '';
  const outcome = await dlg.locator('.connect-row[data-outcome]').first().getAttribute('data-outcome');
  check('files installed, but NOT marked connected: the user is told to open or restart SimCAD', outcome === 'blocked' && /not open, or has not loaded the add-in yet/.test(done) && !/Connected and tested/.test(done.replace('“Connected and tested” always means', '')), `${outcome}`);
  check('the files really are in the plugin folder', fs.existsSync(path.join(simRoot, 'plugins', 'simcad-hybrid.plugin.js')) && fs.existsSync(path.join(simRoot, 'plugins', 'cc-bridge.json')));
  const dialogs = await app.evaluate(() => globalThis.__dialogs);
  check('the native confirmation listed the plugin folder and the close / restart steps', dialogs.some((d) => /Install SimCAD Hybrid Sample/.test(d.message ?? '') && (d.detail ?? '').includes(path.join(simRoot, 'plugins')) && /Close SimCAD/.test(d.detail ?? '') && /Open or restart SimCAD/.test(d.detail ?? '')), JSON.stringify(dialogs.map((d) => (d.detail ?? '').slice(0, 300))));
  await win.screenshot({ path: path.join(shots, '132-hybrid-installed-not-connected.png') });

  // 5. the user opens the program; Try again
  sim = spawn(process.execPath, [path.join(repo, 'fixtures', 'simcad', 'simcad.js'), '--root', simRoot, '--edition', 'Pro'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  let simOut = '';
  sim.stdout.on('data', (d) => { simOut += d.toString(); });
  sim.stderr.on('data', (d) => { simOut += d.toString(); });
  for (let i = 0; i < 100 && !simOut.includes('SIMCAD READY'); i++) await sleep(100);
  check('the simulated program started and loaded the installed add-in', /plugins=simcad-hybrid\.plugin\.js/.test(simOut), simOut.trim());
  await sleep(1500);
  await dlg.getByRole('button', { name: 'Try again' }).click();
  await win.waitForFunction(() => { const o = document.querySelector('.connect-row[data-outcome]')?.getAttribute('data-outcome'); return !!o && !['blocked', 'working', 'pending'].includes(o); }, null, { timeout: 120000 });
  await dlg.getByRole('heading', { name: 'Setup finished' }).waitFor({ timeout: 120000 });
  const done2 = (await dlg.textContent()) ?? '';
  const outcome2 = await dlg.locator('.connect-row[data-outcome]').first().getAttribute('data-outcome');
  check('after SimCAD loads the add-in: Connected (experimental) and TESTED with evidence from inside the program', ['verified', 'verified-limited'].includes(outcome2) && /answered a real check from inside the program/.test(done2), `${outcome2}: ${done2.slice(0, 200)}`);
  await win.screenshot({ path: path.join(shots, '133-hybrid-connected.png') });
  await dlg.getByRole('button', { name: 'Done' }).click();

  // 6. Settings shows add-in state; remove cleans up
  const status = await win.evaluate(async () => { const l = await window.studio.external.packages(); return l.installed.map((a) => ({ id: a.id, type: a.integrationType, plugin: a.pluginState })); });
  check('Settings > Integrations reports the add-in as connected', status.length === 1 && status[0].type === 'hybrid' && status[0].plugin === 'connected', JSON.stringify(status));
  sim.kill();
  await sleep(500);
  await win.evaluate(() => window.studio.external.uninstallPackage('sample.simcad.hybrid'));
  const left = fs.existsSync(path.join(simRoot, 'plugins')) ? fs.readdirSync(path.join(simRoot, 'plugins')) : [];
  check('Remove deletes the add-in files and the pairing secret', left.length === 0 && !fs.existsSync(path.join(path.dirname(listing.inboxDir), 'bridge', 'pairing', 'simcad.bridge.hybrid.json')), JSON.stringify(left));
} catch (e) {
  check('smoke ran to the end', false, e instanceof Error ? e.stack : String(e));
} finally {
  try { sim?.kill(); } catch { /* gone */ }
  await app.close().catch(() => undefined);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

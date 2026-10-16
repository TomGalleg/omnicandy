// FreeCAD adapter package through the real CreateCraft UI, in a scratch profile (never your own CreateCraft or projects).
//
// !! FreeCAD is replaced by the clearly marked TEST DOUBLE in fixtures/freecad-mock (a FreeCADCmd.exe launcher + a Python
// !! imitation of the FreeCAD API). Nothing here proves behaviour of real FreeCAD.
//
// Phase 1 (free, always): drop the signed package in the inbox, Review -> trust publisher -> Install through Settings >
//   Integrations, check that FreeCAD (the double) is discovered, listed with its commands, and connects.
// Phase 2 (only with --claude; uses Claude usage under your existing login, no external API spend): real Claude in the
//   Claude panel discovers FreeCAD with external_apps, creates a parametric model, changes a parameter and exports STEP
//   as a background job. Pass criteria are files on disk and the job table, not Claude's words.
// Run after `npm run build`:  node scripts/smoke-freecad.mjs [--claude]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { generateKeyFile, packAdapter } from './pack-adapter.mjs';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const withClaude = process.argv.includes('--claude');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-freecad-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } }

// The test double: compile the launcher, copy the mock Python modules next to it.
const python = execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim();
const mockBin = path.join(profile, 'FreeCAD 1.0 (MOCK)', 'bin');
fs.mkdirSync(mockBin, { recursive: true });
fs.cpSync(path.join(root, 'fixtures', 'freecad-mock', 'pylib'), path.join(mockBin, 'pylib'), { recursive: true });
const cs = path.join(profile, 'FreeCADCmd.cs');
fs.writeFileSync(cs, fs.readFileSync(path.join(root, 'fixtures', 'freecad-mock', 'FreeCADCmd.cs'), 'utf8').replace('__PYTHON__', python));
const mockExe = path.join(mockBin, 'FreeCADCmd.exe');
execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['-nologo', `-out:${mockExe}`, cs]);
// Tell the scratch profile where the "installed" program is (what Add location... does in the UI).
fs.mkdirSync(path.join(profile, 'secrets'), { recursive: true });
fs.writeFileSync(path.join(profile, 'secrets', 'external-apps.json'), JSON.stringify({ grants: {}, paths: [mockExe] }));

const inbox = path.join(profile, 'integrations', 'inbox');
fs.mkdirSync(inbox, { recursive: true });
const keyFile = path.join(profile, 'publisher.key.pem');
generateKeyFile(keyFile);
fs.writeFileSync(path.join(inbox, 'freecad-1.0.0.ccadapter'), packAdapter({ dir: path.join(root, 'fixtures', 'freecad-adapter'), privateKeyPem: fs.readFileSync(keyFile, 'utf8') }).bytes);

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
try {
  await win.setViewportSize({ width: 1500, height: 1100 }).catch(() => {});
  await win.locator('.asset').first().waitFor({ state: 'attached', timeout: 30000 });
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    dialog.showMessageBox = async (...args) => { globalThis.__dialogs.push(args.at(-1)); return { response: 1, checkboxChecked: false }; };
  });
  await win.getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('tab', { name: 'Integrations' }).click();
  const pk = win.locator('.ext-packages');
  await pk.waitFor({ timeout: 15000 });
  await pk.getByText('Waiting in the inbox folder').waitFor({ timeout: 15000 });

  const row = pk.locator('.ext-row', { hasText: 'FreeCAD' }).filter({ hasText: 'Review…' }).first();
  await row.getByRole('button', { name: 'Review…' }).click();
  const review = pk.locator('.ext-review');
  await review.waitFor();
  const reviewText = (await review.textContent()) ?? '';
  check('the review lists the publisher, the commands and what FreeCAD must provide', /CreateCraft Integrations/.test(reviewText) && /Create a parametric 3D model/.test(reviewText) && /FreeCAD 0\.21 or newer/.test(reviewText), reviewText.slice(0, 200));
  check('the review lists the three permissions the commands need', /Run scripts inside the application/i.test(reviewText) && /Write or export files/i.test(reviewText));
  await win.screenshot({ path: path.join(shots, '110-freecad-review.png') });
  await review.getByRole('checkbox', { name: /I trust/ }).check();
  await review.getByRole('button', { name: 'Install', exact: true }).click();
  const installed = win.locator('.ext-packages > .ext-list > .ext-row', { hasText: 'FreeCAD' });
  await installed.waitFor({ timeout: 30000 });
  check('after the native confirmation FreeCAD shows as installed and ready', /Ready/.test((await installed.textContent()) ?? ''));
  const dialogs = await app.evaluate(() => globalThis.__dialogs);
  check('a native confirmation named the integration before installing', dialogs.some((d) => /Install FreeCAD/.test(d.message ?? '')), JSON.stringify(dialogs.map((d) => d.message)));

  const apps = win.locator('.ext-apps > .ext-list > .ext-row', { hasText: 'FreeCAD' });
  await apps.first().waitFor({ timeout: 30000 });
  const appText = (await apps.first().textContent()) ?? '';
  check('FreeCAD (the test double) is discovered and its commands are registered', /Create a parametric 3D model/.test(appText) && /Export STEP/.test(appText) && /Change a model parameter/.test(appText), appText.slice(0, 200));
  await apps.first().getByRole('button', { name: 'Connect', exact: true }).click();
  await apps.first().getByRole('button', { name: 'Disconnect' }).waitFor({ timeout: 30000 });
  check('Connect reads the version through FreeCADCmd and shows Limited functionality (experimental package)', /Limited functionality/.test((await apps.first().locator('.ext-head').textContent()) ?? '') && /1\.0\.2/.test((await apps.first().textContent()) ?? ''));
  await win.screenshot({ path: path.join(shots, '111-freecad-installed.png') });

  if (withClaude) {
    await win.getByRole('button', { name: 'Close' }).click().catch(() => undefined);
    await win.locator('.side-tab.right').click();
    await win.locator('#claude-input').fill('Use the FreeCAD integration. Create a parametric plate with a hole called Bracket (60 x 40 x 5 mm, hole diameter 10 mm), then change its length parameter to 80 mm saving as a new file named Bracket long, then export Bracket long to STEP as a background job and check the job until it finishes. Tell me exactly what was verified.');
    await win.getByRole('button', { name: 'Send' }).click();
    await win.locator('.claude .chip', { hasText: 'Ready' }).waitFor({ timeout: 420000 });
    const s = await win.evaluate(() => window.studio.claude.state());
    const said = s.items.filter((i) => i.role !== 'user').map((i) => `${i.role}: ${i.text}`).join(' | ');
    const approvals = await app.evaluate(() => globalThis.__dialogs);
    check('the user was asked before FreeCAD ran (and the dialog named the command)', approvals.some((a) => /Create a parametric 3D model/.test(a.message ?? '')), JSON.stringify(approvals.map((a) => a.message)));
    const files = [...walk(profile)].filter((p) => /[\\/]freecad[\\/]/.test(p));
    const names = files.map((p) => path.basename(p));
    check('Bracket.FCStd and the changed copy exist in the project FreeCAD folder', names.includes('Bracket.FCStd') && names.includes('Bracket long.FCStd'), names.join(', '));
    check('the STEP export exists and is a STEP file', files.some((p) => /\.step$/.test(p) && fs.readFileSync(p, 'latin1').includes('ISO-10303-21')), names.join(', '));
    const jobs = await win.evaluate(() => window.studio.external.jobs());
    const job = jobs.find((j) => j.commandId === 'export.step');
    check('the export ran as a background job and succeeded with a verified result', !!job && job.status === 'succeeded' && job.result?.verified === true, JSON.stringify(job && { status: job.status, v: job.result?.verified }));
    console.log('Claude said:', said.slice(0, 1200));
  }
} catch (e) {
  check('smoke run completed', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
  await win.screenshot({ path: path.join(shots, '119-freecad-smoke-failure.png') }).catch(() => undefined);
} finally {
  await app.close().catch(() => undefined);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

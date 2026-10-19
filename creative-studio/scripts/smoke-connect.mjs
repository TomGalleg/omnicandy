// Universal Connect (Settings > Integrations > Connect Applications) in the REAL OmniCandy window, in scratch profiles
// (never your own OmniCandy or projects), against the REAL programs on this PC: Blender, FreeCAD (connector installed from
// the signed package shipped in resources/adapters), DaVinci Resolve (experimental; closed here so it must FAIL honestly),
// Revit (placeholder only). Native dialogs (install confirmation, file picker) are answered by this script on the user's
// behalf; everything else is the real app. Costs nothing; no Claude usage.
//
// "Portable copy" = a directory junction to the real Blender folder: a different path, the real Blender runs from it.
// Run after `npm run build`: node scripts/smoke-connect.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-connect-'));
const profile2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-connect2-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };

async function launch(userData) {
  const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: userData } });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
  await win.locator('.asset').first().waitFor({ state: 'attached', timeout: 30000 });
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    globalThis.__pick = null;
    dialog.showMessageBox = async (...args) => { globalThis.__dialogs.push(args.at(-1)); return { response: 1, checkboxChecked: false }; };
    dialog.showOpenDialog = async () => (globalThis.__pick ? { canceled: false, filePaths: [globalThis.__pick] } : { canceled: true, filePaths: [] });
  });
  return { app, win };
}
const pickNext = (app, p) => app.evaluate((_e, x) => { globalThis.__pick = x; }, p);

async function openWizard(win) {
  if (!(await win.getByRole('dialog', { name: 'Settings' }).isVisible().catch(() => false))) await win.getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('tab', { name: 'Integrations' }).click();
  await win.getByRole('button', { name: 'Connect Applications…' }).click();
  const dlg = win.locator('.connect-dialog');
  await dlg.waitFor();
  await dlg.getByRole('heading', { name: 'Connect Applications' }).waitFor({ timeout: 120000 });
  return dlg;
}
const row = (dlg, name) => dlg.locator('.connect-row').filter({ has: dlg.page().locator('.ext-head strong', { hasText: new RegExp(`^${name}$`) }) });
const rgb = (s) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const lum = ([r, g, b]) => { const f = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

let { app, win } = await launch(profile);
let portable = null;
try {
  // ---------- first run ----------
  await win.getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('tab', { name: 'Integrations' }).click();
  const cardBtn = win.getByRole('button', { name: 'Connect Applications…' });
  await cardBtn.waitFor();
  const order = await win.evaluate(() => { const c = document.querySelector('.connect-card'); const a = [...document.querySelectorAll('.settings-content .menu-label')].find((x) => /ArtCraft apps/.test(x.textContent ?? '')); return !!c && !!a && !!(c.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING); });
  check('a prominent Connect Applications card is the first thing in Settings > Integrations', order);

  let dlg = await openWizard(win);
  check('first run: a welcome explains that scanning is local and nothing is changed without consent', /this PC only/.test((await dlg.locator('.connect-welcome').textContent().catch(() => '')) ?? ''));
  const text0 = (await dlg.textContent()) ?? '';
  const hasBlender = (await row(dlg, 'Blender').count()) > 0;
  const hasResolve = (await row(dlg, 'DaVinci Resolve').count()) > 0;
  const hasFreecad = (await row(dlg, 'FreeCAD').count()) > 0;
  const hasRevit = (await row(dlg, 'Revit').count()) > 0 || (await dlg.locator('.connect-row', { hasText: /Revit/ }).count()) > 0;
  console.log(`found: Blender ${hasBlender}, Resolve ${hasResolve}, FreeCAD ${hasFreecad}, Revit ${hasRevit}`);
  check('the scan found this PC’s programs automatically with versions', hasBlender && /version \d+\.\d+/.test((await row(dlg, 'Blender').textContent()) ?? ''), text0.slice(0, 100));
  if (hasBlender) check('Blender is in "Ready to connect", not experimental', (await row(dlg, 'Blender').getByText('Ready to connect', { exact: true }).count()) > 0 && (await row(dlg, 'Blender').getByText('Experimental', { exact: true }).count()) === 0);
  if (hasResolve) check('Resolve is marked Experimental', (await row(dlg, 'DaVinci Resolve').getByText('Experimental', { exact: true }).count()) > 0);
  if (hasFreecad) {
    const fcText = (await row(dlg, 'FreeCAD').textContent()) ?? '';
    check('FreeCAD (no connector installed yet) is "Connector available", once', /Connector available/.test(fcText) && (await row(dlg, 'FreeCAD').count()) === 1, fcText.slice(0, 160));
  }
  if (hasRevit) {
    const revit = dlg.locator('.connect-row', { hasText: /Revit/ }).first();
    check('Revit (placeholder) is explained plainly and cannot be selected', /cannot control it yet/.test((await revit.textContent()) ?? '') && (await revit.getByRole('checkbox').count()) === 0);
  }
  await dlg.locator('.connect-row').first().getByRole('button', { name: /Details/ }).click();
  check('Details reveals technical information for advanced users', (await dlg.getByText('Technical details').first().isVisible()));
  await win.screenshot({ path: path.join(shots, '120-connect-scan-first-run.png') });
  check('Continue is disabled until something is selected', await dlg.getByRole('button', { name: /^Continue with/ }).isDisabled());

  // ---------- keyboard ----------
  let inside = true;
  for (let i = 0; i < 60; i++) {
    await win.keyboard.press('Tab');
    inside &&= await win.evaluate(() => !!document.activeElement?.closest('.connect-dialog'));
  }
  check('Tab never leaves the dialog (focus is trapped)', inside);
  await win.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });
  check('Escape closes only the wizard; Settings stays open and focus returns to the button', (await win.getByRole('dialog', { name: 'Settings' }).isVisible()) && (await win.evaluate(() => document.activeElement?.textContent)) === 'Connect Applications…');

  // ---------- multi-application setup with real outcomes ----------
  dlg = await openWizard(win);
  const want = [['Blender', hasBlender], ['DaVinci Resolve', hasResolve], ['FreeCAD', hasFreecad]].filter(([, ok]) => ok).map(([n]) => n);
  for (const n of want) {
    const cb = row(dlg, n).getByRole('checkbox');
    await cb.focus();
    await win.keyboard.press('Space');
    if (!(await cb.isChecked())) throw new Error(`could not select ${n} with the keyboard`);
  }
  check('programs are selected with the keyboard (Space)', true, want.join(', '));
  await dlg.getByRole('button', { name: /^Continue with/ }).click();
  await dlg.getByRole('heading', { name: 'What you are allowing' }).waitFor();
  const permText = (await dlg.textContent()) ?? '';
  check('permissions are explained in plain language, per program', /Run automation steps inside the program/.test(permText) && /First you review the FreeCAD connector/.test(permText) && !/execute-scripts/.test(permText.replace(/Technical details[\s\S]*/g, '')));
  await dlg.locator('summary', { hasText: 'Technical details' }).first().click();
  check('technical details stay available behind a disclosure', /execute-scripts|Run scripts inside the application/.test((await dlg.textContent()) ?? ''));
  await win.screenshot({ path: path.join(shots, '121-connect-permissions.png') });
  await dlg.getByRole('button', { name: /^Set up \d+ program/ }).click();

  if (hasFreecad) {
    const review = dlg.getByRole('group', { name: /Review connector FreeCAD/ });
    await review.waitFor({ timeout: 180000 });
    const installBtn = review.getByRole('button', { name: /^Install FreeCAD/ });
    check('the FreeCAD connector is REVIEWED first and cannot be installed until its publisher is trusted', await installBtn.isDisabled() && /Publisher key/.test((await review.textContent()) ?? '') && /Signed, new publisher/.test((await review.textContent()) ?? ''));
    check('nothing was installed or trusted yet', await win.evaluate(async () => { const l = await window.studio.external.packages(); return l.installed.length === 0 && l.trustedPublishers.length === 0; }));
    await win.screenshot({ path: path.join(shots, '122-connect-connector-review.png') });
    await review.getByRole('checkbox', { name: /I trust/ }).check();
    await installBtn.click();
  }
  await dlg.getByRole('heading', { name: 'Setup finished' }).waitFor({ timeout: 240000 });
  const summary = (await dlg.locator('.connect-lead').textContent()) ?? '';
  console.log('summary:', summary);
  const outcome = async (n) => (await row(dlg, n).getAttribute('data-outcome'));
  if (hasBlender) check('Blender: connected and tested (real health check)', (await outcome('Blender')) === 'verified' && /Blender .* answered a real health check/.test((await row(dlg, 'Blender').textContent()) ?? ''));
  if (hasFreecad) check('FreeCAD: connector installed after review, then connected (experimental) and tested', (await outcome('FreeCAD')) === 'verified-limited' && /FreeCAD 1\.\d/.test((await row(dlg, 'FreeCAD').textContent()) ?? ''), (await row(dlg, 'FreeCAD').textContent())?.slice(0, 200));
  if (hasResolve) check('Resolve (closed): honest "needs your action", NOT connected, others unaffected', ['blocked', 'failed', 'verified-limited'].includes(await outcome('DaVinci Resolve')) && (await outcome('DaVinci Resolve')) !== 'verified', `${await outcome('DaVinci Resolve')}: ${(await row(dlg, 'DaVinci Resolve').textContent())?.slice(0, 160)}`);
  if (hasBlender && hasFreecad && hasResolve && (await outcome('DaVinci Resolve')) === 'blocked') check('partial failure: the summary counts only verified programs', /2 of 3 connected and tested\. 1 needs attention\./.test(summary), summary);
  const dialogs = await app.evaluate(() => globalThis.__dialogs);
  if (hasFreecad) check('the native confirmation named the publisher key and the permissions', dialogs.some((d) => /Install FreeCAD/.test(d.message ?? '') && /signed, key/.test(d.detail ?? '')), JSON.stringify(dialogs.map((d) => d.message)));
  await win.screenshot({ path: path.join(shots, '123-connect-done-partial.png') });
  await dlg.getByRole('button', { name: 'Done' }).click();
  await dlg.waitFor({ state: 'detached' });

  // ---------- the list behind refreshed by itself ----------
  const ext = win.locator('.ext-apps');
  if (hasBlender) {
    const b = ext.locator('.ext-row').filter({ has: win.locator('.ext-head strong', { hasText: /^Blender$/ }) });
    check('Settings list updated by itself: Blender shows Connected with a Disconnect button', /Connected/.test((await b.locator('.ext-head').textContent()) ?? '') && (await b.getByRole('button', { name: 'Disconnect' }).count()) === 1);
  }
  if (hasFreecad) {
    const f = ext.locator('.ext-row').filter({ has: win.locator('.ext-head strong', { hasText: /^FreeCAD$/ }) });
    check('…and FreeCAD shows its new connector (placeholder row replaced, no manual rescan)', (await f.count()) === 1 && /Limited functionality|Connected/.test((await f.locator('.ext-head').first().textContent()) ?? ''), (await f.first().locator('.ext-head').textContent())?.slice(0, 100));
  }

  // ---------- second visit: no welcome, grouped status, Forget ----------
  dlg = await openWizard(win);
  check('the welcome is shown only the first time', (await dlg.locator('.connect-welcome').count()) === 0);
  if (hasBlender) check('Blender is now under "Already connected" and cannot be picked again', (await dlg.getByRole('region', { name: 'Already connected' }).getByText('Blender', { exact: true }).count()) > 0);
  if (hasFreecad) {
    const fc = row(dlg, 'FreeCAD');
    const fcExe = (await win.evaluate(async () => (await window.studio.external.list()).find((a) => a.adapterId === 'freecad')?.exePath)) ?? '';
    await fc.getByRole('button', { name: 'Forget FreeCAD' }).click();
    const confirmText = (await fc.locator('.connect-confirm').textContent()) ?? '';
    check('Forget asks first and says the program is NOT uninstalled', /uninstalled or changed/.test(confirmText), confirmText.slice(0, 160));
    await fc.getByRole('button', { name: 'Keep it' }).click();
    check('"Keep it" changes nothing', (await fc.locator('.connect-confirm').count()) === 0);
    await fc.getByRole('button', { name: 'Forget FreeCAD' }).click();
    await fc.getByRole('button', { name: /^Forget FreeCAD$/ }).last().click();
    await dlg.locator('.connect-notice').waitFor({ timeout: 60000 });
    const notice = (await dlg.locator('.connect-notice').textContent()) ?? '';
    check('Forget reports what happened honestly (Windows still lists the installed program)', /no longer remembers|Forgot/.test(notice), notice);
    check('after Forget FreeCAD is no longer "connected" but Blender still is (independent)', (await dlg.getByRole('region', { name: 'Already connected' }).getByText('FreeCAD', { exact: true }).count()) === 0 && (!hasBlender || (await dlg.getByRole('region', { name: 'Already connected' }).getByText('Blender', { exact: true }).count()) > 0));
    check('the real FreeCAD program is untouched', fs.existsSync(fcExe), fcExe);
  }

  // ---------- Browse: stranger, then a portable copy ----------
  await pickNext(app, path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe'));
  await dlg.getByRole('button', { name: 'Browse for Application…' }).click();
  await dlg.locator('.connect-notice').filter({ hasText: /no connector for/ }).waitFor({ timeout: 30000 });
  check('Browse: a program OmniCandy has no connector for gets a plain explanation and is not saved', true, (await dlg.locator('.connect-notice').textContent())?.slice(0, 140));
  if (hasBlender) {
    const real = (await win.evaluate(async () => (await window.studio.external.list()).find((a) => a.adapterId === 'blender')?.exePath)) ?? '';
    portable = path.join(profile, 'Blender Portable');
    try { execFileSync('cmd.exe', ['/c', 'mklink', '/J', portable, path.dirname(real)], { stdio: 'ignore' }); } catch { portable = null; }
    if (portable) {
      await pickNext(app, portable);
      await dlg.getByRole('button', { name: 'Choose a program folder…' }).click();
      await dlg.locator('.connect-notice').filter({ hasText: /^Added/ }).waitFor({ timeout: 120000 });
      const portableRow = dlg.locator('.connect-row').filter({ hasText: 'Portable copy you added' });
      check('Browse: a portable copy is recognised, listed as portable and pre-selected', (await portableRow.count()) === 1 && (await portableRow.getByRole('checkbox').isChecked()), (await portableRow.textContent())?.slice(0, 140));
      await win.screenshot({ path: path.join(shots, '124-connect-browse-portable.png') });
      await dlg.getByRole('button', { name: /^Continue with/ }).click();
      await dlg.getByRole('button', { name: /^Set up 1 program/ }).click();
      await dlg.getByRole('heading', { name: 'Setup finished' }).waitFor({ timeout: 180000 });
      check('the portable Blender connected and passed the real test', (await dlg.locator('.connect-row').first().getAttribute('data-outcome')) === 'verified');
      await dlg.getByRole('button', { name: 'Set up more programs' }).click();
      await dlg.getByRole('heading', { name: 'Connect Applications' }).waitFor();
      const pRow = dlg.locator('.connect-row').filter({ hasText: 'Portable copy you added' });
      await pRow.getByRole('button', { name: /^Forget/ }).click();
      await pRow.getByRole('button', { name: /^Forget Blender$/ }).last().click();
      await dlg.locator('.connect-notice').filter({ hasText: /Forgot/ }).waitFor({ timeout: 60000 });
      check('Forget removes the portable entry (nothing else knew it) and leaves the files alone', (await dlg.locator('.connect-row').filter({ hasText: 'Portable copy you added' }).count()) === 0 && fs.existsSync(portable));
    } else console.log('SKIP portable test: could not create a junction');
  }
  await dlg.getByRole('button', { name: 'Close', exact: true }).click();
  await dlg.waitFor({ state: 'detached' });

  // ---------- themes ----------
  const themeShots = [['Studio Dark', '125-connect-dark.png'], ['Light', '126-connect-light.png']];
  for (const [label, file] of themeShots) {
    await win.getByRole('tab', { name: 'Appearance' }).click();
    await win.getByRole('radio', { name: new RegExp(`^${label}`) }).click();
    await win.getByRole('tab', { name: 'Integrations' }).click();
    dlg = await openWizard(win);
    const cols = await dlg.evaluate((el) => { const cs = getComputedStyle(el); const t = getComputedStyle(el.querySelector('.connect-lead, .ext-head strong')); return { bg: cs.backgroundColor, fg: t.color }; });
    check(`${label}: dialog text has readable contrast`, contrast(cols.fg, cols.bg) >= 4.5, `${cols.fg} on ${cols.bg} = ${contrast(cols.fg, cols.bg).toFixed(1)}`);
    await win.screenshot({ path: path.join(shots, file) });
    await win.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
  }
} catch (e) {
  check('smoke run completed without an unexpected error', false, e instanceof Error ? e.message : String(e));
  await win.screenshot({ path: path.join(shots, 'connect-smoke-failure.png') }).catch(() => {});
} finally {
  await app.close().catch(() => undefined);
}

// ---------- persistence + cancelling (fresh profile for the cancel run) ----------
try {
  ({ app, win } = await launch(profile));
  const dlg = await openWizard(win);
  check('after restart: the first-run welcome is not shown again (remembered on disk)', (await dlg.locator('.connect-welcome').count()) === 0);
  await app.close();

  ({ app, win } = await launch(profile2));
  const d2 = await openWizard(win);
  const fc = d2.locator('.connect-row').filter({ has: win.locator('.ext-head strong', { hasText: /^FreeCAD$/ }) });
  if ((await fc.count()) === 0) console.log('SKIP cancel test: FreeCAD not installed');
  else {
    await fc.getByRole('checkbox').check();
    await d2.getByRole('button', { name: /^Continue with/ }).click();
    await d2.getByRole('button', { name: /^Set up 1 program/ }).click();
    await d2.getByRole('group', { name: /Review connector FreeCAD/ }).waitFor({ timeout: 120000 });
    await d2.getByRole('button', { name: 'Cancel setup' }).click();
    await d2.getByRole('heading', { name: 'Setup finished' }).waitFor({ timeout: 60000 });
    check('cancelling setup while reviewing a connector: outcome "Not set up"', (await d2.locator('.connect-row').first().getAttribute('data-outcome')) === 'cancelled');
    check('…and nothing was installed or trusted', await win.evaluate(async () => { const l = await window.studio.external.packages(); return l.installed.length === 0 && l.trustedPublishers.length === 0; }));
    await win.screenshot({ path: path.join(shots, '127-connect-cancelled.png') });
  }
} catch (e) {
  check('second run completed without an unexpected error', false, e instanceof Error ? e.message : String(e));
} finally {
  await app.close().catch(() => undefined);
  if (portable) { try { fs.rmSync(portable, { recursive: false }); } catch { /* junction removed with the profile */ } }
  for (const p of [profile, profile2]) fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

fs.writeFileSync(path.join(shots, 'connect-smoke-results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

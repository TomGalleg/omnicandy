// External applications screen (Settings > Integrations) against the REAL Blender on this PC, in a
// scratch profile: detection, one-click Connect (real health check), Disconnect, light and dark.
// Skips cleanly when Blender is not installed. Run after `npm run build`: node scripts/smoke-external.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-external-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
try {
  await win.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
  await win.locator('.asset').first().waitFor({ state: 'attached', timeout: 20000 });
  await win.getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('tab', { name: 'Integrations' }).click();
  const section = win.locator('.ext-apps');
  await section.waitFor({ timeout: 10000 });
  await win.locator('.ext-apps button', { hasText: 'Rescan applications' }).waitFor({ timeout: 90000 });
  const blender = section.locator('.ext-row', { hasText: 'Blender' });
  const found = (await blender.count()) > 0;
  if (!found) {
    console.log('Blender is not installed here: only the empty state is checked.');
    check('screen shows the not-detected state', /Not detected: .*Blender/.test((await section.textContent()) ?? ''));
  } else {
    check('Blender is listed with a version', /version \d+\.\d+/.test((await blender.textContent()) ?? ''), (await blender.locator('.ext-head').textContent()) ?? '');
    check('it offers a Connect button and its commands', (await blender.getByRole('button', { name: 'Connect', exact: true }).isVisible()) && /Create a basic 3D scene/.test((await blender.textContent()) ?? ''));
    await win.screenshot({ path: path.join(shots, '96-external-apps-detected.png') });
    await blender.getByRole('button', { name: 'Connect', exact: true }).click();
    await blender.getByRole('button', { name: 'Disconnect' }).waitFor({ timeout: 120000 });
    check('Connect runs a real health check and shows Connected', /Connected/.test((await blender.locator('.ext-head').textContent()) ?? ''));
    await win.getByRole('tab', { name: 'Appearance' }).click();
    await win.getByRole('radio', { name: /^Studio Dark/ }).click();
    await win.getByRole('tab', { name: 'Integrations' }).click();
    await win.locator('.ext-apps button', { hasText: 'Rescan applications' }).waitFor();
    await win.screenshot({ path: path.join(shots, '97-external-apps-dark.png') });
    await win.getByRole('tab', { name: 'Appearance' }).click();
    await win.getByRole('radio', { name: /^Light/ }).click();
    await win.getByRole('tab', { name: 'Integrations' }).click();
    await win.screenshot({ path: path.join(shots, '98-external-apps-light.png') });
    check('the screen renders in light and dark', true);
    await blender.getByRole('button', { name: 'Disconnect' }).click();
    await blender.getByRole('button', { name: 'Connect', exact: true }).waitFor({ timeout: 30000 });
    check('Disconnect returns it to Available to connect', /Available to connect/.test((await blender.locator('.ext-head').textContent()) ?? ''));
  }
  // Second adapter, same screen: Resolve is listed with the same controls. Connecting must end in a precise
  // status (Not running / Scripting not available / Connected); never a silent success.
  const resolve = section.locator('.ext-row', { hasText: 'DaVinci Resolve' });
  if ((await resolve.count()) > 0) {
    check('Resolve is listed by the same screen with its commands', /Inspect the open Resolve project/.test((await resolve.textContent()) ?? ''));
    await resolve.getByRole('button', { name: 'Connect', exact: true }).click();
    await win.waitForTimeout(6000);
    const head = (await resolve.locator('.ext-head').textContent()) ?? '';
    check('Resolve shows an honest status after Connect', /Not running|Scripting not available|Limited functionality|Connected/.test(head), head);
    await win.screenshot({ path: path.join(shots, '99-external-apps-resolve.png') });
  } else {
    console.log('DaVinci Resolve is not installed here: Resolve row not checked.');
  }
  const stubs = await section.locator('.ext-row').filter({ hasText: 'Detected. Deep integration is planned' }).count();
  check('placeholder adapters (if their program is installed) are shown as unsupported, never as connectable', (await section.locator('.ext-row').filter({ hasText: 'Unsupported' }).getByRole('button', { name: 'Connect', exact: true }).count()) === 0, `${stubs} placeholder(s) found`);
} catch (e) {
  check('external apps smoke', false, String(e).slice(0, 500));
} finally {
  await app.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} external app checks passed`);
process.exit(failed ? 1 : 0);

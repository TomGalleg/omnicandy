// Settings > Integrations > Integration packages, in a scratch profile (never your own OmniCandi or projects).
// Packs the sample adapter (signed with a throw-away key, plus an unsigned copy), drops them in the inbox folder
// and exercises review, publisher trust, install, turn off/on, remove. Costs nothing; no Claude usage.
// Run after `npm run build`: node scripts/smoke-adapter-packages.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { generateKeyFile, packAdapter } from './pack-adapter.mjs';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-adapters-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };

// Build the packages into the profile's inbox (what a user would do by dropping a file there).
const inbox = path.join(profile, 'integrations', 'inbox');
fs.mkdirSync(inbox, { recursive: true });
const keyFile = path.join(profile, 'publisher.key.pem');
generateKeyFile(keyFile);
const sample = path.join(root, 'fixtures', 'sample-adapter');
const signed = packAdapter({ dir: sample, privateKeyPem: fs.readFileSync(keyFile, 'utf8') });
fs.writeFileSync(path.join(inbox, 'sample.textkit-1.0.0.ccadapter'), signed.bytes);
// An unsigned lookalike with another id, to see the unsigned flow.
const unsignedDir = path.join(profile, 'unsigned-src');
fs.cpSync(sample, unsignedDir, { recursive: true });
const m = JSON.parse(fs.readFileSync(path.join(unsignedDir, 'adapter.json'), 'utf8'));
m.id = 'sample.unsigned'; m.name = 'Unsigned Sample';
fs.writeFileSync(path.join(unsignedDir, 'adapter.json'), JSON.stringify(m));
fs.writeFileSync(path.join(inbox, 'unsigned-sample.ccadapter'), packAdapter({ dir: unsignedDir }).bytes);
// A damaged package (one byte flipped) must be listed as not installable.
const bad = Buffer.from(signed.bytes);
bad[Math.floor(bad.length / 3)] ^= 0xff;
fs.writeFileSync(path.join(inbox, 'damaged.ccadapter'), bad);

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
  const inboxText = (await pk.textContent()) ?? '';
  check('the inbox lists the dropped packages without running them', /Sample Text Kit/.test(inboxText) && /Unsigned Sample/.test(inboxText), inboxText.slice(0, 160));
  check('a damaged package is flagged as not installable', /Cannot be installed/.test(inboxText));
  check('nothing is installed yet', /0 installed/.test(inboxText));
  await win.screenshot({ path: path.join(shots, '100-adapter-inbox.png') });

  // Signed package from a new publisher: install is blocked until the publisher is trusted.
  const signedRow = pk.locator('.ext-row', { hasText: 'Sample Text Kit' }).filter({ hasText: 'Review…' }).first();
  await signedRow.getByRole('button', { name: 'Review…' }).click();
  const review = pk.locator('.ext-review');
  await review.waitFor();
  check('the review shows publisher, key fingerprint and what it can do', /OmniCandi Samples/.test((await review.textContent()) ?? '') && /Publisher key/.test((await review.textContent()) ?? '') && /Count words in text/.test((await review.textContent()) ?? ''));
  check('install is disabled until the new publisher is trusted', await review.getByRole('button', { name: 'Install', exact: true }).isDisabled());
  await win.screenshot({ path: path.join(shots, '101-adapter-review.png') });
  await review.getByRole('checkbox', { name: /I trust/ }).check();
  await review.getByRole('button', { name: 'Install', exact: true }).click();
  const installedRow = win.locator('.ext-packages > .ext-list > .ext-row', { hasText: 'Sample Text Kit' });
  await installedRow.waitFor({ timeout: 30000 });
  check('after the native confirmation it shows as installed and ready', /Ready/.test((await installedRow.textContent()) ?? ''));
  const dialogs = await app.evaluate(() => globalThis.__dialogs);
  check('a native confirmation named the publisher and permissions', dialogs.some((d) => /Install Sample Text Kit/.test(d.message ?? '') && /signed, key/.test(d.detail ?? '')), JSON.stringify(dialogs.map((d) => d.message)));

  // It is also listed as an application with its commands, and can be connected like any other.
  const apps = win.locator('.ext-apps > .ext-list > .ext-row', { hasText: 'Sample Text Kit' });
  await apps.waitFor({ timeout: 30000 });
  check('its commands are registered in External applications', /Count words in text/.test((await apps.textContent()) ?? '') && /Write a small text report/.test((await apps.textContent()) ?? ''));
  await apps.getByRole('button', { name: 'Connect', exact: true }).click();
  await apps.getByRole('button', { name: 'Disconnect' }).waitFor({ timeout: 30000 });
  check('Connect starts its isolated process and shows Limited functionality (experimental)', /Limited functionality/.test((await apps.locator('.ext-head').textContent()) ?? ''));
  await win.screenshot({ path: path.join(shots, '102-adapter-installed.png') });

  // Unsigned: needs an explicit confirmation.
  await pk.locator('.ext-row', { hasText: 'Unsigned Sample' }).getByRole('button', { name: 'Review…' }).click();
  check('install is disabled for an unsigned package until confirmed', await review.getByRole('button', { name: 'Install', exact: true }).isDisabled());
  await review.getByRole('button', { name: 'Cancel' }).click();

  // Turn off removes its commands; turn on brings them back; Remove deletes it.
  await installedRow.getByRole('button', { name: 'Turn off' }).click();
  await installedRow.getByRole('button', { name: 'Turn on' }).waitFor({ timeout: 15000 });
  await win.locator('.ext-apps > .ext-list > .ext-row', { hasText: 'Sample Text Kit' }).waitFor({ state: 'detached', timeout: 60000 });
  check('turning it off removes it from External applications', true);
  await installedRow.getByRole('button', { name: 'Turn on' }).click();
  await win.locator('.ext-apps > .ext-list > .ext-row', { hasText: 'Sample Text Kit' }).waitFor({ timeout: 30000 });
  check('turning it on registers its commands again', true);
  await installedRow.getByRole('button', { name: 'Remove' }).click();
  await win.locator('.ext-packages', { hasText: '0 installed' }).waitFor({ timeout: 15000 });
  await win.locator('.ext-apps > .ext-list > .ext-row', { hasText: 'Sample Text Kit' }).waitFor({ state: 'detached', timeout: 60000 });
  check('removing it deletes the integration and its commands', true);
  check('the registry on disk no longer lists it', !/sample\.textkit/.test(fs.readFileSync(path.join(profile, 'integrations', 'registry.json'), 'utf8').replace(/"trusted"[\s\S]*$/, '')));

  await win.getByRole('tab', { name: 'Appearance' }).click();
  await win.getByRole('radio', { name: /^Studio Dark/ }).click();
  await win.getByRole('tab', { name: 'Integrations' }).click();
  await pk.waitFor();
  await win.screenshot({ path: path.join(shots, '103-adapter-packages-dark.png') });
  await win.getByRole('tab', { name: 'Appearance' }).click();
  await win.getByRole('radio', { name: /^Light/ }).click();
} catch (e) {
  check('smoke run completed', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
  await win.screenshot({ path: path.join(shots, '109-adapter-smoke-failure.png') }).catch(() => undefined);
} finally {
  await app.close().catch(() => undefined);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

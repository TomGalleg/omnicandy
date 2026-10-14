// AI Generate smoke in the built app (isolated profile). Run after `npm run build`.
// No paid calls: generation uses the offline Mock model; the approval dialog is stubbed to Cancel;
// the only network request is the free model-list test with an obviously fake key (expected 401).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

// "Open in Edit" starts the real PhotoCraft; only instances started by this test are closed afterwards.
const photocraftPids = () => { try { return execFileSync('tasklist', ['/FI', 'IMAGENAME eq photocraft.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).split('\n').map((l) => l.trim()).map((l) => l.split('","')[1]).filter(Boolean); } catch { return []; } };
const pidsBefore = new Set(photocraftPids());

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-gen-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const FAKE_KEY = 'sk-createcraft-smoke-NOT-A-REAL-KEY-0000000000';

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
// Header tabs are addressed by name: use the Advanced navigation (Simplified hides some under More).
await win.evaluate(() => localStorage.setItem('cs-nav-mode', 'advanced'));
await win.reload();
win.on('dialog', (d) => void d.accept().catch(() => {}));
try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await win.getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('radio', { name: /^ArtCraft Match/ }).click();
  await win.keyboard.press('Escape');
  await win.locator('nav.workspaces button', { hasText: 'AI Generate' }).click();
  await win.locator('.provider-row').first().waitFor({ timeout: 10000 });

  check('providers start unconfigured', (await win.locator('.provider-row .chip', { hasText: 'Not set up' }).count()) === 2);
  const opts = await win.locator('.generate select').first().locator('option').allTextContents();
  check('without keys only the free Mock model is offered', opts.length === 1 && /Mock/.test(opts[0]), opts.join(', '));

  await win.getByLabel('Prompt').fill('Smoke test: teal and orange rings');
  check('mock estimate is free', /Free/.test(await win.getByLabel('Cost estimate').textContent()));
  const before = (await win.evaluate(() => window.studio.loadProject())).assets.length;
  await win.getByRole('button', { name: 'Generate (free)' }).click();
  await win.locator('.gen-card').first().waitFor({ timeout: 15000 });
  const m = await win.evaluate(() => window.studio.loadProject());
  const gen = m.assets.filter((a) => a.provenance.origin === 'generated');
  check('result saved as a new original with provenance', m.assets.length === before + 1 && gen[0]?.provenance.prompt === 'Smoke test: teal and orange rings' && gen[0]?.provenance.model === 'mock-image' && /^(originals|Assets\/Generated)\//.test(gen[0]?.relPath ?? ''));
  check('result shows in the library and the results grid', (await win.locator('.asset', { hasText: gen[0]?.name ?? '???' }).count()) === 1 && (await win.locator('.gen-card').count()) === 1);
  await win.screenshot({ path: path.join(shots, '50-generate-mock.png') });

  // Key entry: main reads the clipboard; the renderer never sees the key.
  const openai = win.getByLabel('OpenAI provider');
  await app.evaluate(({ clipboard }) => clipboard.writeText('hello this is not a key'));
  await openai.getByRole('button', { name: 'Paste key' }).click();
  await win.locator('.wf-msg.error').waitFor({ timeout: 5000 });
  check('non-keys are refused', /doesn't look like/.test(await win.locator('.wf-msg.error').textContent()));

  await app.evaluate(({ clipboard }, k) => clipboard.writeText(k), FAKE_KEY);
  await openai.getByRole('button', { name: 'Paste key' }).click();
  await openai.locator('.chip', { hasText: 'Key saved' }).waitFor({ timeout: 40000 });
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  check('clipboard is cleared after saving', clip === '', JSON.stringify(clip));
  const keyFile = path.join(profile, 'secrets', 'providers', 'openai.key');
  check('key stored encrypted (DPAPI), not in plain text', fs.existsSync(keyFile) && !fs.readFileSync(keyFile).toString('latin1').includes(FAKE_KEY));
  const html = await win.content();
  const state = JSON.stringify(await win.evaluate(() => window.studio.generate.providers()));
  check('the key never reaches the renderer', !html.includes(FAKE_KEY) && !html.includes('sk-creat') && !state.includes(FAKE_KEY) && !state.includes('sk-creat'));
  check('connection test reports the rejected key in plain words', /rejected|HTTP|fetch failed|network/i.test(await openai.textContent()), (await openai.locator('.asset-meta').first().textContent()).slice(0, 120));
  await win.screenshot({ path: path.join(shots, '51-generate-key-saved.png') });

  // With a key, OpenAI models appear; the approval dialog (stubbed to Cancel) gates the call.
  const after = await win.locator('.generate select').first().locator('option').allTextContents();
  check('model picker now lists the OpenAI models', after.some((o) => /GPT Image 2\.5 Flare/.test(o)) && after.some((o) => /Sunburst/.test(o)), after.join(', '));
  await win.locator('.generate select').first().selectOption('gpt-image-2.5-flare');
  check('estimate shown before generating', /≈ \$0\.\d+/.test(await win.getByLabel('Cost estimate').textContent()), await win.getByLabel('Cost estimate').textContent());
  await app.evaluate(({ dialog }) => {
    globalThis.__approvals = [];
    dialog.showMessageBox = async (...args) => { globalThis.__approvals.push(args.at(-1)); return { response: 0, checkboxChecked: false }; };
  });
  const n0 = (await win.evaluate(() => window.studio.loadProject())).assets.length;
  await win.getByRole('button', { name: /Generate… \(asks you to approve\)/ }).click();
  await win.locator('.wf-msg', { hasText: 'cancelled' }).waitFor({ timeout: 10000 });
  const approvals = await app.evaluate(() => globalThis.__approvals);
  check('every paid call asks first, with model, prompt and price', approvals.length === 1 && /OpenAI · GPT Image 2\.5 Flare/.test(approvals[0].message) && /Estimated cost: about \$0\.\d+ USD/.test(approvals[0].detail) && approvals[0].defaultId === 0, approvals[0]?.message);
  check('cancelling sends nothing and adds nothing', (await win.evaluate(() => window.studio.loadProject())).assets.length === n0);

  await openai.getByRole('button', { name: 'Remove' }).click();
  await openai.locator('.chip', { hasText: 'Not set up' }).waitFor({ timeout: 5000 });
  check('removing the key deletes it', !fs.existsSync(keyFile));

  await win.locator('.gen-card').first().getByRole('button', { name: 'Open in Edit' }).click();
  await win.waitForTimeout(800);
  check('"Open in Edit" opens the generated picture in Edit', (await win.locator('header button[aria-current="page"]').textContent()) === 'Edit'
    && (await win.locator('.asset.selected, .asset[aria-selected="true"]').first().textContent().catch(() => '')).includes(gen[0]?.name ?? '???'));
} catch (e) {
  check('generate smoke', false, String(e).slice(0, 500));
} finally {
  await app.close();
  for (const pid of photocraftPids()) if (!pidsBefore.has(pid)) { try { execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } }
  await new Promise((r) => setTimeout(r, 800));
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} generate smoke checks passed`);
process.exit(failed ? 1 : 0);

// Claude's generate_image tool in the built app (needs Claude Code signed in on this PC).
// No paid image call: Claude makes one free Mock image, then asks for an OpenAI image with a FAKE
// key; the approval dialog is stubbed to Cancel, so nothing is sent to OpenAI.
// Run after `npm run build`: node scripts/smoke-claude-generate.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-claude-gen-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await app.evaluate(({ clipboard }) => clipboard.writeText('sk-createcraft-smoke-NOT-A-REAL-KEY-0000000000'));
  await win.evaluate(() => window.studio.generate.pasteKey('openai'));
  await app.evaluate(({ dialog }) => {
    globalThis.__approvals = [];
    dialog.showMessageBox = async (...args) => { globalThis.__approvals.push(args.at(-1)); return { response: 0, checkboxChecked: false }; };
  });
  await win.locator('nav.workspaces button', { hasText: 'AI Generate' }).click();
  await win.locator('.side-tab.right').click();
  await win.locator('#claude-input').fill('Test run, follow exactly: 1) call generate_image once with model_id "mock-image" and prompt "a calm blue sea at dawn". 2) call generate_image once with model_id "gpt-image-2.5-flare" and the same prompt. Then tell me in one sentence what happened with each.');
  await win.getByRole('button', { name: 'Send' }).click();
  await win.locator('.claude .chip', { hasText: 'Ready' }).waitFor({ timeout: 240000 });

  const m = await win.evaluate(() => window.studio.loadProject());
  const gen = m.assets.filter((a) => a.provenance.origin === 'generated');
  const approvals = await app.evaluate(() => globalThis.__approvals);
  const s = await win.evaluate(() => window.studio.claude.state());
  const transcript = s.items.filter((i) => i.role !== 'user').map((i) => `${i.role}: ${i.text}`).join(' | ');
  check('Claude generated a (free) Mock image into the library', gen.length === 1 && gen[0].provenance.requestedBy === 'claude' && gen[0].provenance.model === 'mock-image');
  check("Claude's paid request went through the same approval dialog", approvals.length === 1 && /^Claude is asking to generate/.test(approvals[0].message), approvals[0]?.message);
  check('after Cancel nothing was generated or sent', !gen.some((a) => a.provenance.provider === 'openai'));
  check('Claude saw the cancellation', /cancel/i.test(transcript), transcript.slice(0, 500));
  check('the key never appears in the Claude conversation', !transcript.includes('sk-creat'));
  await win.locator('.gen-card').first().waitFor({ timeout: 5000 });
  await win.screenshot({ path: path.join(shots, '52-claude-generate.png') });
} catch (e) {
  check('claude generate smoke', false, String(e).slice(0, 400));
} finally {
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} Claude generate checks passed`);
process.exit(failed ? 1 : 0);

// Smoke test of the Claude panel in the built app. Before sign-in it checks the sign-in flow;
// after sign-in (CLAUDE_LIVE=1) it asks Claude to make a real edit in PhotoCraft.
// Run after `npm run build`: node scripts/smoke-claude.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-claude-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const started = Date.now();
const live = process.env.CLAUDE_LIVE === '1';

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await win.locator('.side-tab.right').click();
  await win.locator('.claude').waitFor();
  const st = await win.evaluate(() => window.studio.claude.checkAuth());
  check('Claude panel opens and reads the Claude Code sign-in state', st !== undefined, `signedIn=${st}`);

  if (!live) {
    if (st === false) check('sign-in prompt shown', await win.getByRole('button', { name: 'Sign in to Claude' }).isVisible());
    // Sending still runs Claude Code through the SDK; a signed-out PC must produce the friendly message.
    await win.evaluate(() => window.studio.claude.send('hello'));
    const s = await win.evaluate(() => window.studio.claude.state());
    const last = s.items.at(-1);
    check('a message runs Claude Code through the SDK inside the app', s.status !== 'working', `${last?.role}: ${last?.text?.slice(0, 120)}`);
    if (st === false) check('signed-out result becomes the sign-in prompt', s.status === 'signed-out' && /not signed in/i.test(last?.text ?? ''));
    await win.screenshot({ path: path.join(shots, '23-claude-sign-in.png') });
  } else {
    await win.getByRole('option', { name: /^photocraft-smoke\.png/ }).click();
    await win.getByRole('button', { name: 'Edit', exact: true }).click();
    await win.locator('.edit-bar .chip.real', { hasText: 'PhotoCraft' }).waitFor({ timeout: 45000 });
    const before = (await win.evaluate(() => window.studio.live.state())).history.length;
    await win.locator('#claude-input').fill('Make this image black and white, then tell me in one sentence what you did. Do not save.');
    await win.getByRole('button', { name: 'Send' }).click();
    await win.locator('.claude .chip', { hasText: 'Ready' }).waitFor({ timeout: 240000 });
    const s = await win.evaluate(() => window.studio.claude.state());
    const after = await win.evaluate(() => window.studio.live.state());
    check('Claude edited the open document through OmniCandi tools', after.history.length > before, JSON.stringify(after.history));
    check('Claude replied', s.items.some((i) => i.role === 'claude'), s.items.filter((i) => i.role !== 'user').map((i) => `${i.role}: ${i.text}`).join(' | ').slice(0, 400));
    check('lock released after Claude finished', after.collab.lockOwner === null, after.collab.phase);
    await win.screenshot({ path: path.join(shots, '24-claude-edit.png') });
  }
} catch (e) {
  check('claude smoke', false, String(e).slice(0, 400));
} finally {
  await app.close();
  const ps = `Get-CimInstance Win32_Process -Filter "Name='photocraft.exe'" | Where-Object { $_.CommandLine -like '*--control*' } | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToString('o'))" }`;
  for (const [pid, t] of execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(' '))) {
    if (new Date(t).getTime() >= started - 2000) try { process.kill(Number(pid)); } catch { /* gone */ }
  }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} Claude smoke checks passed`);
process.exit(failed ? 1 : 0);

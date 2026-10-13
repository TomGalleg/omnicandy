// End-to-end smoke of LIVE PhotoCraft control through the real Creative Studio UI, including the
// pop-out control panel docked to the PhotoCraft window. Opens a real PhotoCraft window (closed after).
// Run after `npm run build`: node scripts/smoke-live.mjs
import { execFileSync, spawn } from 'node:child_process';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();

function ourPhotoCraftPids() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='photocraft.exe'" | Where-Object { $_.CommandLine -like '*--control*' } | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToString('o'))" }`;
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean)
    .map((l) => l.split(' ')).filter(([, t]) => new Date(t).getTime() >= started - 2000).map(([pid]) => Number(pid));
}

/** Uses the app's own window tracker (with no panel) to read and move the PhotoCraft window. */
function probeWindow(pid) {
  const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'resources', 'window-tracker.ps1'), '-TargetPid', String(pid), '-PanelHwnd', '0']);
  let last = null; let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); try { last = JSON.parse(l); } catch { /* skip */ } } });
  return { state: () => last, move: (x, y, w, h) => p.stdin.write(`move ${x} ${y} ${w} ${h}\n`), stop: () => { p.stdin.end(); p.kill(); } };
}

function grabScreen(x, y, w, h, file) {
  const ps = `Add-Type -AssemblyName System.Drawing; Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class D{[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr c);}'; [D]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null; $b = New-Object System.Drawing.Bitmap ${w}, ${h}; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${x}, ${y}, 0, 0, $b.Size); $b.Save('${file.replace(/'/g, "''")}')`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps]);
}

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), url: w.webContents.getURL(), visible: w.isVisible(), b: w.getBounds() })));
let probe = null;
try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await win.getByRole('option', { name: /^harbor-landscape\.svg/ }).click();
  await win.getByRole('button', { name: 'Edit', exact: true }).click();
  await win.getByRole('button', { name: /Open harbor-landscape\.svg in PhotoCraft/ }).click();
  await win.getByText(/PhotoCraft live · harbor-landscape\.svg/).waitFor({ timeout: 40000 });
  check('PhotoCraft window launched and document opened over the token-protected bridge', true);

  // ---- pop-out panel docked to PhotoCraft ----
  await win.getByText('Controls are next to PhotoCraft').waitFor({ timeout: 15000 });
  let panel = null;
  for (let i = 0; i < 50 && !panel; i++) { panel = app.windows().find((p) => p.url().endsWith('#panel')) ?? null; if (!panel) await sleep(200); }
  check('control panel popped out automatically', !!panel);
  await panel.locator('.dock-head').waitFor();
  const [pid] = ourPhotoCraftPids();
  probe = probeWindow(pid);
  for (let i = 0; i < 50 && !probe.state()?.found; i++) await sleep(100);
  await sleep(800);
  const pcPx = probe.state();
  const pcDip = await app.evaluate(({ screen }, r) => screen.screenToDipRect(null, r), { x: pcPx.x, y: pcPx.y, width: pcPx.w, height: pcPx.h });
  let pb = (await windows()).find((w) => w.url.endsWith('#panel'));
  const gap = pcDip.x - (pb.b.x + pb.b.width);
  check('panel sits against the left edge of PhotoCraft', pb.visible && Math.abs(gap) <= 2 && Math.abs(pb.b.y - pcDip.y) <= 2, `panel ${JSON.stringify(pb.b)} · PhotoCraft ${JSON.stringify(pcDip)}`);

  // Move PhotoCraft: the panel must follow.
  probe.move(pcPx.x + 120, pcPx.y + 60, pcPx.w - 120, pcPx.h - 60);
  await sleep(1200);
  const moved = probe.state();
  const movedDip = await app.evaluate(({ screen }, r) => screen.screenToDipRect(null, r), { x: moved.x, y: moved.y, width: moved.w, height: moved.h });
  pb = (await windows()).find((w) => w.url.endsWith('#panel'));
  check('panel follows when PhotoCraft is moved/resized', Math.abs(movedDip.x - (pb.b.x + pb.b.width)) <= 2 && Math.abs(pb.b.y - movedDip.y) <= 2, `panel ${JSON.stringify(pb.b)} · PhotoCraft ${JSON.stringify(movedDip)}`);

  // ---- drive the task from the panel ----
  await panel.getByRole('button', { name: /Run 3 steps in PhotoCraft/ }).click();
  await panel.getByText('● applying…').first().waitFor({ timeout: 15000 });
  await panel.getByRole('button', { name: 'Take Control' }).click();
  await panel.locator('.notice').waitFor({ timeout: 30000 });
  check('Take Control from the panel waited for the active step, then gave you the lock', /Manual Control/.test(await panel.locator('.phase').textContent()));
  await sleep(500);
  const s = probe.state();
  const left = Math.max(0, s.x - Math.round((pb.b.width + 10) * (s.w / movedDip.width)));
  grabScreen(left, s.y, s.x + s.w - left, s.h, path.join(shots, '14-panel-docked-to-photocraft.png'));
  await shot(panel, '15-panel-manual-control');

  await panel.getByRole('button', { name: "I'm done, hand back" }).click();
  await panel.getByRole('button', { name: 'Resume' }).click();
  await panel.locator('.phase', { hasText: 'Completed' }).waitFor({ timeout: 30000 });
  check('resume from the panel completed the remaining steps', true);

  const before = (await win.evaluate(() => window.studio.loadProject())).assets.length;
  await panel.getByRole('button', { name: 'Save as new version' }).click();
  await panel.getByText(/Saved harbor-landscape-live1\.pcraft/).first().waitFor({ timeout: 30000 });
  const assets = (await win.evaluate(() => window.studio.loadProject())).assets;
  const png = assets.find((a) => a.name === 'harbor-landscape-live1.png');
  check('saved .pcraft + .png versions into the library from the panel', assets.length === before + 2 && png?.width === 1600, png ? `${png.width}x${png.height}` : 'missing');

  // ---- dock back into the main window ----
  await panel.getByRole('button', { name: 'Dock', exact: true }).click().catch(() => {}); // the panel closes during the click
  await win.getByRole('button', { name: 'Pop out next to PhotoCraft' }).waitFor({ timeout: 10000 });
  check('Dock returns the controls to the main window and closes the panel', !(await windows()).some((w) => w.url.endsWith('#panel')));
  await shot(win, '16-docked-back-in-app');
} catch (e) {
  check('live smoke', false, String(e).slice(0, 400));
  await win.screenshot({ path: path.join(shots, 'live-smoke-failure.png') }).catch(() => {});
} finally {
  probe?.stop();
  await app.close();
  for (const pid of ourPhotoCraftPids()) try { process.kill(pid); } catch { /* gone */ }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} live smoke checks passed`);
process.exit(failed ? 1 : 0);

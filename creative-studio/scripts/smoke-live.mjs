// End-to-end smoke of the Edit tab with the REAL apps shown inside CreateCraft:
// PhotoCraft (PNG), VectorCraft (SVG) and SoundCraft (WAV) open automatically in the Edit area,
// quick edits apply live, Undo, Save as new version, "Open in its own window" / "Put back", and the
// app follows CreateCraft when it moves. Opens real app windows (closed afterwards).
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

function ourPids(exe) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | Where-Object { $_.CommandLine -like '*--control*' } | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToString('o'))" }`;
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean)
    .map((l) => l.split(' ')).filter(([, t]) => new Date(t).getTime() >= started - 2000).map(([pid]) => Number(pid));
}
/** Reads a process's window bounds via the app's own tracker script (no panel). */
function probe(pid) {
  const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'resources', 'window-tracker.ps1'), '-TargetPid', String(pid), '-PanelHwnd', '0']);
  let last = null; let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); try { last = JSON.parse(l); } catch { /* skip */ } } });
  return { state: () => last, stop: () => { p.stdin.end(); p.kill(); } };
}
function grabScreen(x, y, w, h, file) {
  const ps = `Add-Type -AssemblyName System.Drawing; Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class D{[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr c);}'; [D]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null; $b = New-Object System.Drawing.Bitmap ${w}, ${h}; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${x}, ${y}, 0, 0, $b.Size); $b.Save('${file.replace(/'/g, "''")}')`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps]);
}

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
// Header tabs are addressed by name: use the Advanced navigation (Simplified hides Edit under More).
await win.evaluate(() => localStorage.setItem('cs-nav-mode', 'advanced'));
await win.reload();
const probes = [];
const toDip = (r) => app.evaluate(({ screen }, rr) => screen.screenToDipRect(null, rr), { x: r.x, y: r.y, width: r.w, height: r.h });
const stageRect = async () => {
  const r = await win.locator('.edit-stage').boundingBox();
  const c = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('#panel')).getContentBounds());
  return { x: c.x + r.x, y: c.y + r.y, width: r.width, height: r.height };
};
const near = (a, b, tol = 3) => ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= tol);
const mainBounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('#panel')).getBounds());
async function desktopShot(name) {
  const b = await mainBounds();
  const px = await app.evaluate(({ screen }, r) => screen.dipToScreenRect(null, r), b);
  await sleep(600);
  grabScreen(px.x, px.y, px.width, px.height, path.join(shots, `${name}.png`));
}
async function waitPid(exe) {
  for (let i = 0; i < 100; i++) { const p = ourPids(exe); if (p.length) return p[p.length - 1]; await sleep(300); }
  throw new Error(`${exe} did not start`);
}
async function embeddedCheck(label, pid) {
  const pr = probe(pid); probes.push(pr);
  for (let i = 0; i < 60 && !pr.state()?.found; i++) await sleep(100);
  let ok = false; let detail = '';
  for (let i = 0; i < 30 && !ok; i++) {
    await sleep(200);
    const s = pr.state();
    if (!s?.found) continue;
    const appDip = await toDip(s);
    const stage = await stageRect();
    ok = s.visible && near(appDip, stage);
    detail = `app ${JSON.stringify(appDip)} · edit area ${JSON.stringify(stage)}`;
  }
  check(`${label} shows inside the Edit area`, ok, detail);
  return pr;
}

try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setBounds({ x: 80, y: 60, width: 1500, height: 920 }); });

  // ---- PhotoCraft (PNG) ----
  await win.getByRole('option', { name: /^photocraft-smoke\.png/ }).click();
  await win.getByRole('button', { name: 'Edit', exact: true }).click();
  await win.locator('.edit-bar .chip.real', { hasText: 'PhotoCraft' }).waitFor({ timeout: 45000 });
  check('PhotoCraft opened automatically for the PNG', true);
  const pcPid = await waitPid('photocraft.exe');
  const pcProbe = await embeddedCheck('PhotoCraft', pcPid);

  check('Claude panel starts minimized', !(await win.locator('.claude').isVisible()));
  check('no edit list beside the app (you edit in the app itself)', (await win.locator('.edit-tools').count()) === 0);
  await win.evaluate(() => window.studio.live.quickEdit('blackWhite', {}));
  check('an edit in PhotoCraft shows up (history updated)', /Black/i.test(JSON.stringify((await win.evaluate(() => window.studio.live.state())).history)));
  await desktopShot('20-edit-photocraft-embedded');
  await win.getByRole('button', { name: 'Undo', exact: true }).click();
  await win.getByText('Undone.').first().waitFor({ timeout: 15000 });
  check('Undo works', true);

  // Follow a move of the CreateCraft window.
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().endsWith('#panel')); const b = w.getBounds(); w.setBounds({ ...b, x: b.x + 60, y: b.y + 30 }); });
  await sleep(1500);
  const moved = pcProbe.state();
  check('app follows when CreateCraft moves', moved?.found && near(await toDip(moved), await stageRect()), JSON.stringify(await toDip(moved)));

  // Pop out and back.
  await win.getByRole('button', { name: 'Open in its own window' }).click();
  let panel = null;
  for (let i = 0; i < 50 && !panel; i++) { panel = app.windows().find((p) => p.url().endsWith('#panel')) ?? null; if (!panel) await sleep(200); }
  await sleep(1000);
  const out = pcProbe.state();
  check('"Open in its own window" pops PhotoCraft out with the controls beside it', !!panel && out?.visible && !near(await toDip(out), await stageRect(), 20), JSON.stringify(await toDip(out)));
  await win.getByRole('button', { name: 'Put back in CreateCraft' }).click();
  await sleep(1500);
  check('"Put back in CreateCraft" returns it to the Edit area', near(await toDip(pcProbe.state()), await stageRect()) && !app.windows().some((p) => p.url().endsWith('#panel')));

  await win.evaluate(() => window.studio.live.quickEdit('blackWhite', {}));
  let before = (await win.evaluate(() => window.studio.loadProject())).assets.length;
  await win.getByRole('button', { name: 'Save as new version' }).click();
  await win.getByText(/Saved photocraft-smoke-live1\.pcraft/).filter({ visible: true }).first().waitFor({ timeout: 30000 });
  check('Save as new version (PhotoCraft) adds .pcraft + .png', (await win.evaluate(() => window.studio.loadProject())).assets.length === before + 2);

  // ---- VectorCraft (SVG) ----
  await win.getByRole('option', { name: /^harbor-landscape\.svg/ }).click();
  await win.locator('.edit-bar .chip.real', { hasText: 'VectorCraft' }).waitFor({ timeout: 45000 });
  check('VectorCraft opened automatically for the SVG', true);
  const vcPid = await waitPid('vectorcraft.exe');
  await embeddedCheck('VectorCraft', vcPid);
  const pcAfter = pcProbe.state();
  check('PhotoCraft steps aside (hidden or minimized) when another file opens', pcAfter?.minimized === true || pcAfter?.visible === false, JSON.stringify(pcAfter));
  await win.evaluate(() => window.studio.live.quickEdit('rotate', { angle: 15 }));
  check('an edit in VectorCraft shows up', (await win.evaluate(() => window.studio.live.state())).history.length > 1);
  await desktopShot('21-edit-vectorcraft-embedded');
  before = (await win.evaluate(() => window.studio.loadProject())).assets.length;
  await win.getByRole('button', { name: 'Save as new version' }).click();
  await win.getByText(/Saved harbor-landscape-live1\.svg/).filter({ visible: true }).first().waitFor({ timeout: 40000 });
  const after = (await win.evaluate(() => window.studio.loadProject())).assets;
  check('Save as new version (VectorCraft) adds .svg + .png', after.length === before + 2 && after.some((a) => a.name === 'harbor-landscape-live1.png' && a.width > 0));

  // ---- SoundCraft (WAV) ----
  await win.getByRole('option', { name: /tone-a440\.wav/ }).click();
  await win.locator('.edit-bar .chip.real', { hasText: 'SoundCraft' }).waitFor({ timeout: 45000 });
  check('SoundCraft opened automatically for the WAV', true);
  const scPid = await waitPid('soundcraft.exe');
  await embeddedCheck('SoundCraft', scPid);
  await win.evaluate(() => window.studio.live.quickEdit('fades', {}));
  check('an edit in SoundCraft shows up', (await win.evaluate(() => window.studio.live.state())).history.length > 1);
  await desktopShot('22-edit-soundcraft-embedded');
  before = (await win.evaluate(() => window.studio.loadProject())).assets.length;
  await win.getByRole('button', { name: 'Save as new version' }).click();
  // The save message shows in the Claude panel, which is minimized here: wait for the file instead.
  for (let t = Date.now(); Date.now() - t < 40000; await sleep(500)) {
    if ((await win.evaluate(() => window.studio.loadProject())).assets.some((a) => a.name === 'tone-a440-live1.wav')) break;
  }
  const wav = (await win.evaluate(() => window.studio.loadProject())).assets.find((a) => a.name === 'tone-a440-live1.wav');
  check('Save as new version (SoundCraft) adds the mixed .wav', !!wav && Math.abs((wav.durationSec ?? 0) - 2) < 0.1, wav ? `${wav.durationSec}s` : 'missing');

  // ---- Claude panel toggles from its side tab ----
  await win.locator('.side-tab.right').click();
  await win.locator('.claude').waitFor({ timeout: 5000 });
  await sleep(800);
  const scP = probes[probes.length - 1].state();
  check('Claude tab opens the panel and the app shrinks to fit', scP?.found && near(await toDip(scP), await stageRect()), JSON.stringify(await toDip(scP)));
  await win.locator('.side-tab.right').click();
  await win.locator('.side-tab.left').click();
  await sleep(800);
  const scM = probes[probes.length - 1].state();
  check('Media tab collapses the library and the app grows to fit', scM?.found && near(await toDip(scM), await stageRect()), JSON.stringify(await toDip(scM)));
  await win.locator('.side-tab.left').click();

  // ---- leaving the Edit tab hides the app ----
  const scProbe = probes[probes.length - 1];
  await win.getByRole('button', { name: 'Media', exact: true }).click();
  await sleep(1200);
  check('leaving the Edit tab hides the app', scProbe.state()?.visible === false, JSON.stringify(scProbe.state()));
} catch (e) {
  check('live smoke', false, String(e).slice(0, 500));
  await desktopShot('live-smoke-failure').catch(() => {});
} finally {
  for (const p of probes) p.stop();
  await app.close();
  for (const exe of ['photocraft.exe', 'vectorcraft.exe', 'soundcraft.exe']) for (const pid of ourPids(exe)) try { process.kill(pid); } catch { /* gone */ }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} live smoke checks passed`);
process.exit(failed ? 1 : 0);

// End-to-end smoke of the apps added in Phase 3, shown inside CreateCraft with the REAL apps:
// video in FilmCraft (Edit tab, live timeline), photos in LightCraft (Color tab), effects in
// EffectCraft (Effects tab) and layouts in DesignCraft (Edit tab). Checks embedding, quick edits,
// save as new version and theme matching (ArtCraft Match). Opens real app windows (closed afterwards).
// Run after `npm run build`: node scripts/smoke-apps.mjs
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-apps-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();

/** Processes of `exe` started by this test run. */
function ourPids(exe) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToString('o'))" }`;
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean)
    .map((l) => l.split(' ')).filter(([, t]) => new Date(t).getTime() >= started - 2000).map(([pid]) => Number(pid));
}
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
win.on('dialog', (d) => void d.accept().catch(() => {}));
const probes = [];
const toDip = (r) => app.evaluate(({ screen }, rr) => screen.screenToDipRect(null, rr), { x: r.x, y: r.y, width: r.w, height: r.h });
const stageRect = async () => {
  const r = await win.locator('.edit-stage').boundingBox();
  const c = await app.evaluate((e) => e.BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('#panel')).getContentBounds());
  return { x: c.x + r.x, y: c.y + r.y, width: r.width, height: r.height };
};
const near = (a, b, tol = 3) => ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= tol);
async function desktopShot(name) {
  const b = await app.evaluate((e) => e.BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('#panel')).getBounds());
  const px = await app.evaluate(({ screen }, r) => screen.dipToScreenRect(null, r), b);
  await sleep(700);
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
    detail = `app ${JSON.stringify(appDip)} · area ${JSON.stringify(stage)}`;
  }
  check(`${label} shows inside CreateCraft`, ok, detail);
  return pr;
}
const live = () => win.evaluate(() => window.studio.live.state());
async function waitOpen(appId, name) {
  for (let i = 0; i < 150; i++) {
    const s = await live();
    if (s.status === 'ready' && s.appId === appId && s.asset?.name === name) return s;
    if (s.status === 'error') throw new Error(s.error);
    await sleep(200);
  }
  throw new Error(`${appId} did not open ${name}`);
}
const tab = (name) => win.locator('nav.workspaces button', { hasText: new RegExp(`^${name}$`) }).click();
const pick = (re) => win.getByRole('option', { name: re }).click();
const assets = async () => (await win.evaluate(() => window.studio.loadProject())).assets;

try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await app.evaluate((e) => { e.BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 60, width: 1500, height: 940 }); });
  await win.getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('radio', { name: /^ArtCraft Match/ }).click();
  await win.keyboard.press('Escape');
  const names = (await assets()).map((a) => a.name);
  check('the Sample Project has the new video, photo and layout', ['sunset-clip.mp4', 'sunset-still.jpg', 'sunset-flyer.designcraft'].every((n) => names.includes(n)));

  // ---- Video in the Edit tab: FilmCraft with a live timeline ----
  await pick(/sunset-clip\.mp4/);
  await tab('Edit');
  let s = await waitOpen('filmcraft', 'sunset-clip.mp4');
  const fc = await embeddedCheck('FilmCraft (Edit tab, video)', await waitPid('filmcraft.exe'));
  check('FilmCraft matches the ArtCraft theme', s.appTheme?.value === 'dark' || (await live()).appTheme?.value === 'dark', JSON.stringify((await live()).appTheme));
  await win.locator('.timeline.live .tl-clip.video').first().waitFor({ timeout: 10000 });
  check('the bottom timeline shows FilmCraft\'s video and audio tracks', (await win.locator('.timeline.live .tl-clip.video').count()) === 1 && (await win.locator('.timeline.live .tl-clip.audio').count()) === 1
    && (await win.locator('.timeline.live .tl-clip.video').textContent()).startsWith('sunset-clip.mp4'));
  check('video thumbnails show a frame', await win.locator('.asset video').first().evaluate((v) => new Promise((r) => {
    const ok = () => r(v.videoWidth > 0);
    if (v.readyState >= 1) ok(); else { v.onloadedmetadata = ok; setTimeout(() => r(false), 5000); }
  })));
  const ruler = await win.locator('.ruler.seekable').boundingBox();
  await win.mouse.click(ruler.x + ruler.width / 2, ruler.y + ruler.height / 2);
  await sleep(600);
  const ph = (await win.evaluate(() => window.studio.live.timeline())).playhead;
  check('clicking the ruler moves FilmCraft\'s playhead', ph !== null && Math.abs(ph - 2) < 0.3, `playhead ${ph}`);
  await win.evaluate(() => window.studio.live.quickEdit('blackWhite', {}));
  await win.evaluate(() => window.studio.live.quickEdit('trim', { start: 0.5, end: 0.5 }));
  await win.locator('.timeline.live .tl-clip.video .fx').waitFor({ timeout: 6000 });
  const tl = await win.evaluate(() => window.studio.live.timeline());
  check('quick edits show up on the timeline (effect badge, 3 s after trim)', Math.abs(tl.duration - 3) < 0.1, `${tl.duration}s`);
  await desktopShot('60-edit-filmcraft-timeline');
  await win.getByRole('button', { name: 'Save as new version' }).click();
  await win.getByRole('option', { name: /sunset-clip-live1\.mp4/ }).waitFor({ timeout: 60000 });
  const v1 = (await assets()).find((a) => a.name === 'sunset-clip-live1.mp4');
  check('Save as new version exports an MP4 into the library', v1?.kind === 'video' && Math.abs((v1.durationSec ?? 0) - 3) < 0.2, `${v1?.durationSec}s ${v1?.width}x${v1?.height}`);

  // ---- Photo in the Color tab: LightCraft ----
  await pick(/sunset-still\.jpg/);
  await tab('Color');
  s = await waitOpen('lightcraft', 'sunset-still.jpg');
  const lc = await embeddedCheck('LightCraft (Color tab)', await waitPid('lightcraft.exe'));
  await sleep(500);
  check('LightCraft matches the ArtCraft theme', (await live()).appTheme?.value === 'dark', JSON.stringify((await live()).appTheme));
  check('FilmCraft is put away (minimized) while LightCraft is shown', fc.state()?.visible === false || fc.state()?.minimized === true, JSON.stringify(fc.state()));
  await win.evaluate(() => window.studio.live.quickEdit('look', { preset: 'lc.golden-hour', amount: 100 }));
  await desktopShot('61-color-lightcraft');
  await win.getByRole('button', { name: 'Save as new version' }).click();
  await win.getByRole('option', { name: /sunset-still-color1\.jpg/ }).waitFor({ timeout: 30000 });
  check('Color tab saves a developed copy as a new version', (await assets()).some((a) => a.name === 'sunset-still-color1.jpg' && a.width === 960));

  // ---- The same photo back in the Edit tab opens in PhotoCraft ----
  await tab('Edit');
  await waitOpen('photocraft', 'sunset-still.jpg');
  check('the Edit tab opens the photo in PhotoCraft (Color uses LightCraft)', true);
  check('LightCraft is put away while PhotoCraft is shown', lc.state()?.visible === false || lc.state()?.minimized === true);

  // ---- Video in the Effects tab: EffectCraft ----
  await pick(/sunset-clip\.mp4/);
  await tab('Effects');
  await waitOpen('effectcraft', 'sunset-clip.mp4');
  await embeddedCheck('EffectCraft (Effects tab)', await waitPid('effectcraft.exe'));
  await sleep(500);
  check('EffectCraft matches the ArtCraft theme', (await live()).appTheme?.value === 'dark', JSON.stringify((await live()).appTheme));
  await win.evaluate(() => window.studio.live.quickEdit('glow', { radius: 40, intensity: 1.5 }));
  await win.evaluate(() => window.studio.live.quickEdit('title', { text: 'Sunset', size: 96, color: '#ffffff' }));
  await desktopShot('62-effects-effectcraft');
  await win.getByRole('button', { name: 'Save as new version' }).click();
  await win.getByRole('option', { name: /sunset-clip-fx1\.mp4/ }).waitFor({ timeout: 90000 });
  check('Effects tab renders an MP4 version', (await assets()).some((a) => a.name === 'sunset-clip-fx1.mp4' && a.kind === 'video'));

  // ---- Layout in the Edit tab: DesignCraft ----
  await pick(/sunset-flyer\.designcraft/);
  await tab('Edit');
  await waitOpen('designcraft', 'sunset-flyer.designcraft');
  await embeddedCheck('DesignCraft (Edit tab, layout)', await waitPid('designcraft.exe'));
  await sleep(500);
  check('DesignCraft matches the ArtCraft theme', (await live()).appTheme?.value === 'mediumDark', JSON.stringify((await live()).appTheme));
  await desktopShot('63-edit-designcraft');

  // ---- Tabs that can't open a file say so ----
  await pick(/tone-a440\.wav/);
  await tab('Color');
  check('the Color tab explains it works on photos', /works on photos/.test(await win.locator('.stage-status').textContent()));
} catch (e) {
  check('apps smoke', false, String(e).slice(0, 500));
  await desktopShot('apps-smoke-failure').catch(() => {});
} finally {
  for (const p of probes) p.stop();
  await app.close();
  for (const exe of ['photocraft.exe', 'filmcraft.exe', 'lightcraft.exe', 'effectcraft.exe', 'designcraft.exe']) for (const pid of ourPids(exe)) try { process.kill(pid); } catch { /* gone */ }
  await sleep(800);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} app smoke checks passed`);
process.exit(failed ? 1 : 0);

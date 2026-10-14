// End-to-end smoke of the Audio and Deliver tabs in the built app with the REAL apps: a sound in
// SoundCraft (Audio tab, live timeline with the real waveform), Deliver exports through the queue
// (headless tools, no app window), and Claude exporting and editing audio (uses a little Claude
// usage; set CLAUDE_LIVE=0 to skip). Opens SoundCraft's window and closes every app window afterwards.
// Run after `npm run build`: node scripts/smoke-audio-deliver.mjs
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-audio-deliver-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const claudeLive = process.env.CLAUDE_LIVE !== '0';
const EXES = ['photocraft.exe', 'vectorcraft.exe', 'soundcraft.exe', 'filmcraft.exe', 'lightcraft.exe', 'effectcraft.exe', 'designcraft.exe',
  'photocraft-cli.exe', 'vectorcraft-cli.exe', 'soundcraft-cli.exe', 'filmcraft-cli.exe', 'designcraft-cli.exe'];

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
win.on('dialog', (d) => void d.dismiss().catch(() => {}));
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
const live = () => win.evaluate(() => window.studio.live.state());
const tab = (name) => win.locator('nav.workspaces button', { hasText: new RegExp(`^${name}$`) }).click();
const tabNow = () => win.locator('nav.workspaces button[aria-current="page"]').textContent();
const pick = (re) => win.getByRole('option', { name: re }).first().click();
const assets = async () => (await win.evaluate(() => window.studio.loadProject())).assets;
async function waitOpen(appId, name) {
  for (let i = 0; i < 150; i++) {
    const s = await live();
    if (s.status === 'ready' && s.appId === appId && s.asset?.name === name) return s;
    if (s.status === 'error') throw new Error(s.error);
    await sleep(200);
  }
  throw new Error(`${appId} did not open ${name}`);
}
async function waitJobs(n, timeout = 120000) {
  const t = Date.now();
  for (;;) {
    const jobs = await win.evaluate(() => window.studio.deliver.jobs());
    if (jobs.length >= n && jobs.every((j) => !['queued', 'running'].includes(j.status))) return jobs;
    if (Date.now() - t > timeout) throw new Error(`exports did not finish: ${JSON.stringify(jobs.map((j) => j.status))}`);
    await sleep(300);
  }
}

try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await app.evaluate((e) => { e.BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 60, width: 1500, height: 940 }); });
  await win.getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('radio', { name: /^ArtCraft Match/ }).click();
  await win.keyboard.press('Escape');

  // ---- Overview waveform (decoded from the file) for a video that isn't open anywhere ----
  await pick(/sunset-clip\.mp4/);
  await win.locator('.timeline svg[data-wave="real"]').first().waitFor({ timeout: 10000 }).catch(() => {});
  check('the timeline overview shows the real waveform of a video\'s sound', (await win.locator('.timeline svg[data-wave="real"]').count()) === 1);

  // ---- Audio tab: SoundCraft embedded with a live timeline ----
  await pick(/tone-a440\.wav/);
  await tab('Audio');
  await waitOpen('soundcraft', 'tone-a440.wav');
  let pid = null;
  for (let i = 0; i < 100 && !pid; i++) { const p = ourPids('soundcraft.exe'); pid = p.at(-1) ?? null; if (!pid) await sleep(300); }
  const pr = probe(pid); probes.push(pr);
  let placed = false; let detail = '';
  for (let i = 0; i < 40 && !placed; i++) {
    await sleep(200);
    const s = pr.state();
    if (!s?.found) continue;
    const a = await toDip(s); const st = await stageRect();
    placed = s.visible && near(a, st); detail = `app ${JSON.stringify(a)} | area ${JSON.stringify(st)}`;
  }
  check('SoundCraft shows inside the Audio tab', placed, detail);
  await sleep(400);
  check('SoundCraft matches the ArtCraft theme', (await live()).appTheme?.value === 'dark', JSON.stringify((await live()).appTheme));
  await win.locator('.timeline.live .tl-clip.audio svg[data-wave="real"]').waitFor({ timeout: 10000 });
  check('the Audio timeline shows SoundCraft\'s clip with the real waveform', (await win.locator('.timeline.live .tl-clip.audio').count()) === 1);
  await win.evaluate(() => window.studio.live.quickEdit('gain', { db: -6 }));
  await win.evaluate(() => window.studio.live.quickEdit('fades', { fadeIn: 0.25, fadeOut: 0.5, shape: 'linear' }).catch((e) => String(e)));
  await win.locator('.timeline.live .tl-clip.audio .fx', { hasText: '-6.0 dB' }).waitFor({ timeout: 8000 });
  const fadeShown = await win.locator('.timeline.live .tl-fade').first().waitFor({ timeout: 8000 }).then(() => true, () => false);
  check('quick edits show on the Audio timeline (gain badge, fades)', fadeShown);
  const ruler = await win.locator('.ruler.seekable').boundingBox();
  await win.mouse.click(ruler.x + ruler.width / 2, ruler.y + ruler.height / 2);
  await sleep(700);
  const ph = (await win.evaluate(() => window.studio.live.timeline())).playhead;
  check('clicking the ruler moves SoundCraft\'s playhead', ph !== null && Math.abs(ph - 1) < 0.2, `playhead ${ph}`);
  await desktopShot('80-audio-soundcraft');
  await win.getByRole('button', { name: 'Save as new version' }).click();
  await win.getByRole('option', { name: /tone-a440-live1\.wav/ }).waitFor({ timeout: 30000 });
  check('Audio tab saves a new WAV version', (await assets()).some((a) => a.name === 'tone-a440-live1.wav' && a.kind === 'audio'));

  // ---- Deliver tab: export the saved version, with its version history ----
  await pick(/tone-a440-live1\.wav/);
  await tab('Deliver');
  check('Deliver shows the version history', /tone-a440\.wav → tone-a440-live1\.wav/.test(await win.getByLabel('Version history').textContent()));
  await win.getByRole('checkbox', { name: /WAV, CD quality/ }).check();
  await win.getByRole('checkbox', { name: /FLAC/ }).check();
  await win.getByRole('button', { name: /^Export \d+ files?$/ }).click();
  let jobs = await waitJobs(3);
  check('Deliver exports through the queue (3 audio files)', jobs.filter((j) => j.status === 'done').length === 3, jobs.map((j) => `${j.presetLabel}: ${j.status} ${j.output ?? j.error ?? ''}`).join(' | '));
  await win.locator('.job[data-status="done"] button', { hasText: 'Show in folder' }).first().waitFor();
  check('finished exports have Show in folder', (await win.locator('.job[data-status="done"] button', { hasText: 'Show in folder' }).count()) === 3);
  const hist = await win.evaluate(() => window.studio.deliver.history());
  check('exports are recorded with the source version history and checksums', hist.length === 3 && hist.every((r) => r.source.versions.join('>') === 'tone-a440.wav>tone-a440-live1.wav' && /^[0-9a-f]{64}$/.test(r.output.sha256)));
  check('no app window opened for exports', ourPids('photocraft.exe').length + ourPids('vectorcraft.exe').length + ourPids('filmcraft.exe').length + ourPids('designcraft.exe').length === 0);

  await pick(/sunset-clip\.mp4/);
  await win.getByRole('checkbox', { name: /Animated GIF/ }).check();
  await win.getByRole('button', { name: /^Export \d+ files?$/ }).click();
  jobs = await waitJobs(5, 180000);
  check('video exports (MP4 + GIF) through FilmCraft headless', jobs.filter((j) => j.assetName === 'sunset-clip.mp4' && j.status === 'done').length === 2, jobs.slice(-2).map((j) => `${j.presetLabel}: ${j.status} ${j.error ?? ''}`).join(' | '));
  await desktopShot('81-deliver');

  // ---- Claude: export a layout, and edit audio in the Audio tab ----
  if (claudeLive) {
    const signedIn = await win.evaluate(() => window.studio.claude.checkAuth());
    check('Claude Code on this PC is signed in', signedIn === true);
    if (signedIn === true) {
      await win.evaluate(() => window.studio.claude.send('Export sunset-flyer.designcraft as a PDF.'));
      jobs = await win.evaluate(() => window.studio.deliver.jobs());
      const cj = jobs.find((j) => j.requestedBy === 'claude');
      const said = (await win.evaluate(() => window.studio.claude.state())).items.slice(-3).map((i) => `${i.role}: ${i.text}`).join(' | ');
      check('Claude exports a file with Deliver', cj?.status === 'done' && cj.presetId === 'design-pdf', `${cj?.output ?? ''} | ${said.slice(0, 300)}`);
      await win.evaluate(() => window.studio.claude.send('Open tone-a440.wav and give it a half-second fade in. Do not save.'));
      const s = await live();
      const tl = await win.evaluate(() => window.studio.live.timeline());
      check('Claude edits audio in SoundCraft and the window follows to the Audio tab',
        s.appId === 'soundcraft' && s.asset?.name === 'tone-a440.wav' && (tl?.tracks[0]?.clips[0]?.fadeIn ?? 0) > 0.4 && (await tabNow()) === 'Audio',
        `fadeIn ${tl?.tracks[0]?.clips[0]?.fadeIn} tab ${await tabNow()} history ${JSON.stringify(s.history)}`);
      check('lock released after Claude\'s turn', s.collab.lockOwner === null, s.collab.phase);
      console.log(`Claude usage for this run: $${(await win.evaluate(() => window.studio.claude.state())).costUsd.toFixed(3)}`);
    }
  }
} catch (e) {
  check('audio/deliver smoke', false, String(e).slice(0, 500));
  await desktopShot('audio-deliver-failure').catch(() => {});
} finally {
  for (const p of probes) p.stop();
  await app.close().catch(() => {});
  await sleep(800);
  for (const exe of EXES) for (const pid of ourPids(exe)) try { process.kill(pid); } catch { /* gone */ }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} audio/deliver checks passed`);
process.exit(failed ? 1 : 0);

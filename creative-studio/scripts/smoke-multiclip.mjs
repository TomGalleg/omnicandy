// End-to-end smoke of multi-clip video in the built app with the REAL FilmCraft: the clip toolbar
// under the Edit area (add clip, add music, reorder), and one real Claude request that builds a
// video from several files (a little Claude usage; CLAUDE_LIVE=0 skips it). Closes every app window.
// Run after `npm run build`: node scripts/smoke-multiclip.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-multiclip-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const claudeLive = process.env.CLAUDE_LIVE !== '0';
const EXES = ['photocraft.exe', 'vectorcraft.exe', 'soundcraft.exe', 'filmcraft.exe', 'lightcraft.exe', 'effectcraft.exe', 'designcraft.exe', 'filmcraft-cli.exe'];

function ourPids(exe) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToString('o'))" }`;
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean)
    .map((l) => l.split(' ')).filter(([, t]) => new Date(t).getTime() >= started - 2000).map(([pid]) => Number(pid));
}
function grabScreen(x, y, w, h, file) {
  const ps = `Add-Type -AssemblyName System.Drawing; Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class D{[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr c);}'; [D]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null; $b = New-Object System.Drawing.Bitmap ${w}, ${h}; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${x}, ${y}, 0, 0, $b.Size); $b.Save('${file.replace(/'/g, "''")}')`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps]);
}

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
win.on('dialog', (d) => void d.dismiss().catch(() => {}));
async function desktopShot(name) {
  const b = await app.evaluate((e) => e.BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('#panel')).getBounds());
  const px = await app.evaluate(({ screen }, r) => screen.dipToScreenRect(null, r), b);
  await sleep(700);
  grabScreen(px.x, px.y, px.width, px.height, path.join(shots, `${name}.png`));
}
const live = () => win.evaluate(() => window.studio.live.state());
const timeline = () => win.evaluate(() => window.studio.live.timeline());
const v1 = (tl) => tl.tracks.find((t) => t.kind === 'video').clips.slice().sort((a, b) => a.start - b.start).map((c) => c.name.replace(/^[0-9a-f]{8}-/, ''));
const tab = (name) => win.locator('nav.workspaces button', { hasText: new RegExp(`^${name}$`) }).click();
const pick = (re) => win.getByRole('option', { name: re }).first().click();
async function waitOpen(appId, name) {
  for (let i = 0; i < 150; i++) {
    const s = await live();
    if (s.status === 'ready' && s.appId === appId && s.asset?.name === name) return s;
    if (s.status === 'error') throw new Error(s.error);
    await sleep(200);
  }
  throw new Error(`${appId} did not open ${name}`);
}
async function until(fn, ms = 10000) { const t = Date.now(); for (;;) { const r = await fn(); if (r) return r; if (Date.now() - t > ms) return r; await sleep(300); } }

try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await app.evaluate((e) => { e.BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 60, width: 1500, height: 940 }); });
  const names = (await win.evaluate(() => window.studio.loadProject())).assets.map((a) => a.name);
  check('the Sample Project has a second clip and a music loop', names.includes('aurora-clip.mp4') && names.includes('groove-loop.wav'));

  // ---- By hand: the clip toolbar under the Edit area ----
  await pick(/sunset-clip\.mp4/);
  await tab('Edit');
  await waitOpen('filmcraft', 'sunset-clip.mp4');
  await win.locator('.clip-tools').waitFor({ timeout: 10000 });
  await win.getByLabel('Add a clip').selectOption({ label: 'aurora-clip.mp4' });
  await until(async () => v1(await timeline()).length === 2);
  await win.getByLabel('Add music').selectOption({ label: 'groove-loop.wav' });
  let tl = await until(async () => { const t = await timeline(); return t.tracks.some((x) => x.music) ? t : null; });
  check('Add clip and Add music build a two-clip video with music', !!tl && v1(tl).join(',') === 'sunset-clip.mp4,aurora-clip.mp4', tl ? `${v1(tl).join(', ')} | ${tl.duration}s` : 'no music track');
  await win.locator('.timeline.live .tl-clip.video', { hasText: 'aurora-clip.mp4' }).click();
  await win.getByRole('button', { name: '◀ Earlier' }).click();
  tl = await until(async () => { const t = await timeline(); return v1(t)[0] === 'aurora-clip.mp4' ? t : null; });
  check('selecting a clip and pressing Earlier reorders it', !!tl, tl ? v1(tl).join(', ') : '');
  check('the music stays at the start', (tl?.tracks.find((x) => x.music)?.clips[0]?.start ?? -1) === 0);
  await win.evaluate(() => window.studio.live.quickEdit('crossfades', { seconds: 0.5 }));
  await desktopShot('90-multiclip-filmcraft');
  await win.getByRole('button', { name: 'Save as new version' }).click();
  await win.getByRole('option', { name: /aurora-clip-live1\.mp4|sunset-clip-live1\.mp4/ }).first().waitFor({ timeout: 60000 });
  const saved = (await win.evaluate(() => window.studio.loadProject())).assets.find((a) => /-live1\.mp4$/.test(a.name));
  check('Save as new version exports the whole 7 s video', !!saved && Math.abs((saved.durationSec ?? 0) - 7) < 0.3, `${saved?.name} ${saved?.durationSec}s`);

  // ---- Claude builds a video from several files ----
  if (claudeLive) {
    const signedIn = await win.evaluate(() => window.studio.claude.checkAuth());
    check('Claude Code on this PC is signed in', signedIn === true);
    if (signedIn === true) {
      await win.evaluate(() => window.studio.claude.send('The open video was already saved, so you can discard its edits. Open sunset-clip.mp4 fresh, add aurora-clip.mp4 after it and sunset-still.jpg at the end, put groove-loop.wav under it as music, and add half-second crossfades between the clips. Do not save.'));
      const s = await live();
      tl = await timeline();
      const st = await win.evaluate(() => window.studio.claude.state());
      const said = st.items.slice(-4).map((i) => `${i.role}: ${i.text}`).join(' | ');
      check('Claude builds a three-clip video with music and crossfades',
        s.appId === 'filmcraft' && v1(tl).join(',') === 'sunset-clip.mp4,aurora-clip.mp4,sunset-still.jpg' && tl.tracks.some((x) => x.music && x.clips.length) && tl.tracks.find((x) => x.kind === 'video').transitions >= 2,
        `${v1(tl).join(', ')} | transitions ${tl.tracks.find((x) => x.kind === 'video').transitions} | ${said.slice(0, 300)}`);
      check('lock released after Claude\'s turn', s.collab.lockOwner === null, s.collab.phase);
      await desktopShot('91-claude-multiclip');
      console.log(`Claude usage for this run: $${st.costUsd.toFixed(3)}`);
    }
  }
} catch (e) {
  check('multiclip smoke', false, String(e).slice(0, 500));
  await desktopShot('multiclip-failure').catch(() => {});
} finally {
  await app.close().catch(() => {});
  await sleep(800);
  for (const exe of EXES) for (const pid of ourPids(exe)) try { process.kill(pid); } catch { /* gone */ }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} multi-clip checks passed`);
process.exit(failed ? 1 : 0);

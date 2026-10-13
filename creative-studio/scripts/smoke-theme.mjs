// Theme smoke: ArtCraft Match / Studio Dark / Light with PhotoCraft embedded, app theme sync,
// System mode, persistence, and proof that themes never touch the artwork.
// Opens real app windows (closed afterwards). Run after `npm run build`: node scripts/smoke-theme.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-theme-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();

function grabScreen(x, y, w, h, file) {
  const ps = `Add-Type -AssemblyName System.Drawing; Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class D{[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr c);}'; [D]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null; $b = New-Object System.Drawing.Bitmap ${w}, ${h}; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${x}, ${y}, 0, 0, $b.Size); $b.Save('${file.replace(/'/g, "''")}')`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps]);
}

let app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
let win = await app.firstWindow();
const desktopShot = async (name) => {
  const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('#panel')).getBounds());
  const px = await app.evaluate(({ screen }, r) => screen.dipToScreenRect(null, r), b);
  await sleep(900);
  grabScreen(px.x, px.y, px.width, px.height, path.join(shots, `${name}.png`));
};
const pick = async (label) => {
  await win.getByRole('button', { name: 'Appearance' }).click();
  await win.getByRole('radio', { name: new RegExp(`^${label}`) }).click();
  await win.keyboard.press('Escape');
};
const theme = () => win.evaluate(() => document.documentElement.dataset.theme);
const bg = () => win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
const appTheme = async (want) => {
  for (let i = 0; i < 40; i++) { const t = (await win.evaluate(() => window.studio.live.state())).appTheme; if (t?.value?.toLowerCase() === want.toLowerCase()) return t; await sleep(250); }
  return (await win.evaluate(() => window.studio.live.state())).appTheme;
};
const saveAndHash = async () => {
  const before = (await win.evaluate(() => window.studio.loadProject())).assets.length;
  await win.evaluate(() => window.studio.live.saveVersion());
  const m = await win.evaluate(() => window.studio.loadProject());
  const pngs = m.assets.filter((a) => a.sourceFormat === 'png' && a.parentId);
  return { added: m.assets.length - before, pngCount: pngs.length, last: pngs.map((a) => a.sha256) };
};

try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 60, y: 40, width: 1560, height: 940 }));
  check('new install defaults to System with ArtCraft Match as the dark look', (await win.evaluate(() => window.studio.getAppearance())).systemDark === 'artcraft');

  await win.getByRole('option', { name: /^photocraft-smoke\.png/ }).click();
  await win.getByRole('button', { name: 'Edit', exact: true }).click();
  await win.locator('.edit-bar .chip.real', { hasText: 'PhotoCraft' }).waitFor({ timeout: 45000 });
  await win.evaluate(() => window.studio.live.quickEdit('blackWhite', {})); // some real artwork change to save later

  // ---- ArtCraft Match ----
  await pick('ArtCraft Match');
  check('ArtCraft Match applies the charcoal palette', (await theme()) === 'artcraft' && (await bg()) === '#282828', await bg());
  const t1 = await appTheme('proMedium');
  check('PhotoCraft switched to its matching charcoal theme (read back from PhotoCraft)', t1?.value?.toLowerCase() === 'promedium', JSON.stringify(t1));
  await desktopShot('30-theme-artcraft-match');
  const a1 = await saveAndHash();

  // ---- Studio Dark ----
  await pick('Studio Dark');
  check('Studio Dark restores the original near-black palette', (await theme()) === 'studioDark' && (await bg()) === '#0f1115');
  const t2 = await appTheme('pro');
  check('PhotoCraft switched to its darkest theme', t2?.value?.toLowerCase() === 'pro', JSON.stringify(t2));
  await desktopShot('31-theme-studio-dark');

  // ---- Light ----
  await pick('Light');
  check('Light applies the coordinated light palette', (await theme()) === 'light' && (await bg()) === '#e2e2e6');
  const t3 = await appTheme('studioLight');
  check('PhotoCraft switched to its light theme', t3?.value?.toLowerCase() === 'studiolight', JSON.stringify(t3));
  await desktopShot('32-theme-light');
  const a3 = await saveAndHash();
  check('themes never change the artwork (exported PNG pixels identical in Light and ArtCraft Match)', a1.pngCount >= 1 && a3.pngCount === a1.pngCount,
    `PNG versions after save 1: ${a1.pngCount}, after save 2 in Light: ${a3.pngCount} (an identical PNG is not stored twice); the .pcraft records save details, so it is a new version`);
  const history = (await win.evaluate(() => window.studio.live.state())).history;
  check('theme changes add nothing to the edit history', JSON.stringify(history) === JSON.stringify(['Open', 'Black & White']), JSON.stringify(history));

  // ---- System follows Windows (simulated via prefers-color-scheme) ----
  await pick('System');
  await win.emulateMedia({ colorScheme: 'light' });
  await sleep(300);
  const sysLight = await theme();
  await win.emulateMedia({ colorScheme: 'dark' });
  await sleep(300);
  check('System mode follows a Windows light/dark change', sysLight === 'light' && (await theme()) === 'artcraft', `light→${sysLight}, dark→${await theme()}`);

  // ---- workflow + Claude panel follow the theme ----
  await pick('ArtCraft Match');
  await win.locator('.header-status .chip-btn', { hasText: 'Claude' }).click();
  await win.locator('.claude').waitFor();
  const claudeBg = await win.locator('.claude').evaluate((el) => getComputedStyle(el).backgroundColor);
  check('Claude panel uses the theme', claudeBg === 'rgb(83, 83, 83)', claudeBg);
  await win.locator('.header-status .chip-btn', { hasText: 'Claude' }).click();
  await win.getByRole('button', { name: 'Workflow' }).click();
  await win.locator('.react-flow__node').first().waitFor();
  const nodeBg = await win.locator('.node').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  check('workflow nodes use the theme', nodeBg === 'rgb(83, 83, 83)', nodeBg);
  await win.screenshot({ path: path.join(shots, '33-theme-artcraft-workflow.png') });
  await win.getByRole('button', { name: 'Appearance' }).click();
  await win.screenshot({ path: path.join(shots, '34-appearance-menu.png') });
  await win.keyboard.press('Escape');

  // ---- VectorCraft + SoundCraft match too ----
  await win.getByRole('button', { name: 'Media', exact: true }).click();
  await win.getByRole('option', { name: /^harbor-landscape\.svg/ }).click();
  await win.getByRole('button', { name: 'Edit', exact: true }).click();
  await win.locator('.edit-bar .chip.real', { hasText: 'VectorCraft' }).waitFor({ timeout: 45000 });
  const tv = await appTheme('mediumDark');
  check('VectorCraft opened with the matching theme', tv?.app === 'vectorcraft' && /mediumdark/i.test(tv.value), JSON.stringify(tv));
  await desktopShot('35-theme-artcraft-vectorcraft');
  await win.getByRole('option', { name: /tone-a440\.wav audio/ }).click();
  await win.locator('.edit-bar .chip.real', { hasText: 'SoundCraft' }).waitFor({ timeout: 45000 });
  const ts = await appTheme('dark');
  check('SoundCraft opened with the matching theme', ts?.app === 'soundcraft' && ts.value === 'dark', JSON.stringify(ts));
  await desktopShot('36-theme-artcraft-soundcraft');
} catch (e) {
  check('theme smoke', false, String(e).slice(0, 400));
} finally {
  await app.close();
}

// ---- persistence across restart ----
app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
win = await app.firstWindow();
try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await sleep(500);
  check('theme choice survives a restart', (await theme()) === 'artcraft' && (await win.evaluate(() => window.studio.getAppearance())).mode === 'artcraft');
} finally {
  await app.close();
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(photocraft|vectorcraft|soundcraft)\\.exe$' -and $_.CommandLine -like '*--control*' } | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToString('o'))" }`;
  for (const [pid, t] of execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(' '))) {
    if (new Date(t).getTime() >= started - 2000) try { process.kill(Number(pid)); } catch { /* gone */ }
  }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} theme smoke checks passed`);
process.exit(failed ? 1 : 0);

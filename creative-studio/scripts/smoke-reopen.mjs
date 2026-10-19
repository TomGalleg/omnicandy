// Reopen-lifecycle smoke for WordCraft (.docx) and FigCraft (.figcraft) inside OmniCandy with the REAL apps, in a scratch
// profile (CS_USER_DATA_DIR): open -> edit -> save as new version -> switch to the other app -> reopen the SAVED version,
// plus unchanged-save / undo-then-save (no new version) and a real edit after that (new version). Every open is timed;
// the check fails when an open takes longer than 20 s. Set CS_PROFILE_DIR to reuse a profile (lifecycle runs).
// Run: node scripts/smoke-reopen.mjs
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const profile = process.env.CS_PROFILE_DIR ? (fs.mkdirSync(process.env.CS_PROFILE_DIR, { recursive: true }), process.env.CS_PROFILE_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-reopen-'));
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
// Header tabs are addressed by name: use the Advanced navigation (Simplified hides some under More).
await win.evaluate(() => localStorage.setItem('cs-nav-mode', 'advanced'));
await win.reload();
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
  check(`${label} shows inside OmniCandy`, ok, detail);
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
const pick = (re) => win.getByRole('option', { name: re }).first().click();
const assets = async () => (await win.evaluate(() => window.studio.loadProject())).assets;



/** When an open hangs: is the app process responsive, and does a second, independent control connection get an answer? */
async function diagnoseHang(exe) {
  try {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; "$($_.ProcessId) responding=$($p.Responding) cpu=$($p.CPU) cmd=$($_.CommandLine)" }`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
    console.log(`      [diag] ${exe}: ${out.replace(/\r?\n/g, ' | ')}`);
    const m = /--control (\d+)/.exec(out);
    if (!m) return;
    const dir = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', exe.replace(/\.exe$/i, '').replace(/^./, (c) => c.toUpperCase()).replace(/craft$/i, 'Craft'));
    const bridge = exe === 'figcraft.exe' ? ['mcp', '--attach', m[1]] : ['mcp', '--connect', `127.0.0.1:${m[1]}`];
    const cli = spawn(path.join(dir, exe.replace('.exe', '-cli.exe')), bridge, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buf = ''; const waiters = new Map(); let id = 0;
    cli.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, k); buf = buf.slice(k + 1); try { const r = JSON.parse(l); waiters.get(r.id)?.(r); } catch { /* ignore */ } } });
    const req = (method, params) => new Promise((res) => { const n = ++id; const t = setTimeout(() => res(null), 6000); waiters.set(n, (r) => { clearTimeout(t); res(r); }); cli.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
    await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'diag', version: '1' } });
    cli.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const t0 = Date.now();
    const r = await req('tools/call', { name: exe === 'figcraft.exe' ? 'inspect_document' : 'inspect_document', arguments: exe === 'figcraft.exe' ? { allPages: false, depth: 2 } : {} });
    console.log(`      [diag] ${exe}: independent connection ${r ? `answered in ${Date.now() - t0} ms` : 'got NO answer in 6 s'}`);
    cli.kill();
  } catch (e) { console.log(`      [diag] failed: ${e}`); }
}

const SLOW_MS = 20_000;
const timedOpen = async (appId, name) => {
  const t = Date.now();
  const s = await waitOpen(appId, name);
  const ms = Date.now() - t;
  check(`${appId} opened ${name} in ${(ms / 1000).toFixed(1)} s`, ms <= SLOW_MS);
  return s;
};
const collection = (v) => win.locator('select:has(option[value="originals"])').first().selectOption(v);
const history = async () => (await live()).history;
const message = async () => (await live()).message ?? '';
// The same button the user presses, so the library list refreshes like it does for them.
const saveVersion = async () => {
  const b = win.getByRole('button', { name: 'Save as new version' });
  await b.click();
  await sleep(300);
  for (let i = 0; i < 300 && !(await b.isEnabled()); i++) await sleep(200);
  await sleep(400);
};
// Edits carry a per-run, per-round tag: a version whose content equals one already in the library is (correctly)
// not saved again, so identical edits in a later round or a reused profile would otherwise look like a failure.
const runTag = Date.now().toString(36);
const appsFor = (round) => {
  const tag = `${runTag}${round}`;
  return [
    { id: 'wordcraft', exe: 'wordcraft.exe', asset: 'quarterly-report.docx', edit: ['replaceText', { find: 'Sunset Over the Sea', replace: `Evening ${tag}` }], again: ['replaceText', { find: `Evening ${tag}`, replace: `Morning ${tag}` }], other: 'login-screen.figcraft' },
    { id: 'figcraft', exe: 'figcraft.exe', asset: 'login-screen.figcraft', edit: ['addText', { text: `Welcome ${tag}`, position: 'top', size: 28 }], again: ['addText', { text: `See you ${tag}`, position: 'bottom', size: 20 }], other: 'quarterly-report.docx' },
  ];
};
const rounds = Number(process.env.ROUNDS ?? 2);

try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await app.evaluate((e) => { e.BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 60, width: 1500, height: 940 }); });
  for (let round = 1; round <= rounds; round++) {
    const apps = appsFor(round);
    for (const a of apps) {
      const L = `${a.id} round ${round}`;
      const before = new Set((await assets()).map((x) => x.id));
      await collection('originals');
      await pick(new RegExp(a.asset.replace(/\./g, '\\.'), ''));
      await tab('Edit');
      await timedOpen(a.id, a.asset);
      if (process.env.EMBED_WAIT) await embeddedCheck(`${L}: ${a.id} shows inside OmniCandy`, await waitPid(a.exe));
      const te = Date.now();
      await win.evaluate(([op, v]) => window.studio.live.quickEdit(op, v), a.edit);
      console.log(`      quick edit took ${((Date.now() - te) / 1000).toFixed(1)} s`);
      check(`${L}: quick edit shows in history`, (await history()).length === 2, JSON.stringify(await history()));
      await saveVersion();
      const afterSave = (await assets()).filter((x) => !before.has(x.id)).map((x) => x.name);
      const savedMain = afterSave.find((n) => n.endsWith(a.asset.slice(a.asset.lastIndexOf('.'))));
      check(`${L}: Save as new version made a version, original untouched`, !!savedMain && (await assets()).some((x) => x.name === a.asset), JSON.stringify(afterSave));
      // Unchanged save right after: no new version.
      const n0 = (await assets()).length;
      await saveVersion();
      const n1 = (await assets()).length;
      check(`${L}: saving again without changes makes no version`, n1 === n0 && /Nothing changed/.test(await message()), `${n0}->${n1} · ${await message()}`);
      // Real edit then undo then save: no new version.
      await win.evaluate(([op, v]) => window.studio.live.quickEdit(op, v), a.again);
      await win.evaluate(() => window.studio.live.undo());
      await saveVersion();
      const n2 = (await assets()).length;
      check(`${L}: undo-then-save makes no version`, n2 === n1, `${n1}->${n2} · ${await message()}`);
      // Real edit: a new version again.
      await win.evaluate(([op, v]) => window.studio.live.quickEdit(op, v), a.again);
      await saveVersion();
      const n3 = (await assets()).length;
      check(`${L}: a real edit still makes a new version`, n3 > n2, `${n2}->${n3}`);
      // Switch to the other app, then reopen the saved version.
      await collection('originals');
      await pick(new RegExp(a.other.replace(/\./g, '\\.'), ''));
      await tab('Edit');
      const otherApp = apps.find((x) => x.asset === a.other).id;
      await timedOpen(otherApp, a.other);
      await collection('versions');
      await pick(new RegExp(savedMain.replace(/\./g, '\\.'), ''));
      await tab('Edit');
      await timedOpen(a.id, savedMain);
      const probeBack = await waitPid(a.exe).catch(() => null);
      check(`${L}: reopened saved version ${savedMain}`, (await live()).status === 'ready' && !!probeBack);
    }
  }
} catch (e) {
  for (const exe of ['wordcraft.exe', 'figcraft.exe']) await diagnoseHang(exe);
  check('reopen smoke', false, `${String(e).slice(0, 300)} · live=${JSON.stringify(await live().catch(() => null)).slice(0, 400)} · options=${JSON.stringify(await win.getByRole('option').allInnerTexts().catch(() => []))}`);
  await desktopShot('reopen-smoke-failure').catch(() => {});
} finally {
  for (const p of probes) p.stop();
  await app.close();
  for (const exe of ['wordcraft.exe', 'figcraft.exe']) for (const pid of ourPids(exe)) try { process.kill(pid); } catch { /* gone */ }
  await sleep(800);
  if (!process.env.CS_PROFILE_DIR) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} reopen smoke checks passed`);
process.exit(failed ? 1 : 0);

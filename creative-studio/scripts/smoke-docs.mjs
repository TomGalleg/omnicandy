// End-to-end smoke of WordCraft (.docx) and PdfCraft (.pdf) shown inside OmniCandi with the REAL apps, run in a
// scratch profile (CS_USER_DATA_DIR): embedding, quick edits, undo, save as new version, Deliver and hand-off.
// Windows the test opens are closed afterwards. Run: npm run smoke:docs
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-docs-'));
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
  check(`${label} shows inside OmniCandi`, ok, detail);
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


try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await app.evaluate((e) => { e.BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 60, width: 1500, height: 940 }); });
  const names = (await assets()).map((a) => a.name);
  check('the Sample Project has the Word document and the PDF', ['quarterly-report.docx', 'quarterly-summary.pdf'].every((n) => names.includes(n)));
  const kinds = Object.fromEntries((await assets()).filter((a) => /^quarterly-/.test(a.name)).map((a) => [a.name, a.kind]));
  check('both are library "document" files', kinds['quarterly-report.docx'] === 'document' && kinds['quarterly-summary.pdf'] === 'document', JSON.stringify(kinds));

  // ---- Word document in the Edit tab: WordCraft ----
  await pick(/quarterly-report\.docx/);
  await tab('Edit');
  await waitOpen('wordcraft', 'quarterly-report.docx');
  const wp = await embeddedCheck('WordCraft (Edit tab, document)', await waitPid('wordcraft.exe'));
  await win.evaluate(() => window.studio.live.quickEdit('replaceText', { find: 'Sunset Over the Sea', replace: 'Evening Tide' }));
  const wh = (await live()).history;
  check('WordCraft quick edit shows in the history', wh.length === 2, JSON.stringify(wh));
  await desktopShot('80-edit-wordcraft');
  await win.getByRole('button', { name: 'Save as new version' }).click();
  await win.getByRole('option', { name: /quarterly-report-live1\.docx/ }).first().waitFor({ timeout: 60000 });
  const wv = (await assets()).find((a) => a.name === 'quarterly-report-live1.docx');
  check('Save as new version keeps a .docx next to the original (original untouched)', wv?.kind === 'document' && !!wv.parentId && (await assets()).some((a) => a.name === 'quarterly-report.docx'));

  // ---- PDF in the Edit tab: PdfCraft ----
  await pick(/quarterly-summary\.pdf/);
  await tab('Edit');
  await waitOpen('pdfcraft', 'quarterly-summary.pdf');
  await embeddedCheck('PdfCraft (Edit tab, PDF)', await waitPid('pdfcraft.exe'));
  check('WordCraft is put away (minimized or hidden) while PdfCraft is shown', wp.state()?.visible === false || wp.state()?.minimized === true, JSON.stringify(wp.state()));
  await win.evaluate(() => window.studio.live.quickEdit('replaceText', { find: 'Sunset Over the Sea', replace: 'Evening Tide' }));
  await win.evaluate(() => window.studio.live.quickEdit('watermark', { text: 'DRAFT', opacity: 30 }));
  const ph = (await live()).history;
  check('PdfCraft quick edits show in the history', JSON.stringify(ph) === JSON.stringify(['Open', 'Replace text', 'Add watermark']), JSON.stringify(ph));
  await desktopShot('81-edit-pdfcraft');
  await win.evaluate(() => window.studio.live.undo());
  check('Undo steps back one edit (window follows)', JSON.stringify((await live()).history) === JSON.stringify(['Open', 'Replace text']), JSON.stringify((await live()).history));
  await win.getByRole('button', { name: 'Save as new version' }).click();
  await win.getByRole('option', { name: /quarterly-summary-live1\.pdf/ }).first().waitFor({ timeout: 60000 });
  const pv = (await assets()).find((a) => a.name === 'quarterly-summary-live1.pdf');
  check('Save as new version keeps a .pdf (+ PNG preview) next to the original', pv?.kind === 'document' && (await assets()).some((a) => a.name === 'quarterly-summary-live1.png'));

  // ---- Deliver tab: export the PDF as text and DOCX, and hand the DOCX on to the library ----
  await pick(/quarterly-summary-live1\.pdf/);
  await tab('Deliver');
  const jobs = await win.evaluate(async (id) => window.studio.deliver.enqueue(id, ['pdf-txt', 'pdf-docx']), pv.id);
  for (let i = 0; i < 60; i++) { const j = await win.evaluate(() => window.studio.deliver.jobs()); if (j.every((x) => x.status === 'done' || x.status === 'failed')) break; await sleep(500); }
  const done = await win.evaluate(() => window.studio.deliver.jobs());
  check('Deliver exports the PDF as text and DOCX', done.filter((j) => j.status === 'done').length === jobs.length, JSON.stringify(done.map((j) => [j.presetId, j.status, j.error])));
  const docxJob = done.find((j) => j.presetId === 'pdf-docx');
  const keptId = await win.evaluate((id) => window.studio.deliver.addToLibrary(id), docxJob.id);
  const kept = (await assets()).find((a) => a.id === keptId);
  check('"Add to library" hands the .docx on as a new library file', kept?.sourceFormat === 'docx' && kept.parentId === pv.id, kept?.name);
  await win.screenshot({ path: path.join(shots, '82-deliver-pdf.png') });
} catch (e) {
  check('docs smoke', false, String(e).slice(0, 500));
  await desktopShot('docs-smoke-failure').catch(() => {});
} finally {
  for (const p of probes) p.stop();
  await app.close();
  for (const exe of ['wordcraft.exe', 'pdfcraft.exe']) for (const pid of ourPids(exe)) try { process.kill(pid); } catch { /* gone */ }
  await sleep(800);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} document smoke checks passed`);
process.exit(failed ? 1 : 0);

// VOLTERRA X1 files edited through CreateCraft's own Claude panel (real Claude, scratch profile, $0 other spend).
// Originals are copied into a scratch project; the source folder is hash-checked before and after.
// Run after `npm run build`: node scripts/smoke-volterra.mjs [only,labels]
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const SRC = path.resolve(root, '..', 'CreateCraft_7_App_Integration_Test');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-volterra-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
const started = Date.now();
const EXES = ['photocraft.exe', 'vectorcraft.exe', 'soundcraft.exe', 'filmcraft.exe', 'lightcraft.exe', 'effectcraft.exe', 'designcraft.exe'];
const only = (process.argv[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const hashAll = () => Object.fromEntries(walk(SRC).filter((f) => !f.endsWith('.log')).map((f) => [f, crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')]));
const before = hashAll();

function ourPids(exe) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToString('o'))" }`;
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean)
    .map((l) => l.split(' ')).filter(([, t]) => new Date(t).getTime() >= started - 2000).map(([pid]) => Number(pid));
}

const TO_IMPORT = [
  'PhotoCraft/volterra-x1-car-edited-v2.pcraft', 'VectorCraft/volterra-x1-logo-transparent-v2.vectorcraft',
  'SoundCraft/volterra-x1-soundtrack-v2.scraft', 'SoundCraft/volterra-x1-soundtrack-v2.wav',
  'LightCraft/volterra-x1-electric-blue-v2.png', 'EffectCraft/volterra-x1-logo-reveal-v2.ecproj',
  'DesignCraft/volterra-x1-poster.designcraft', 'FilmCraft/volterra-x1-promo-v2.fcproj', 'FilmCraft/volterra-x1-promo-v2-1080p.mp4',
].map((p) => path.join(SRC, p));

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
await win.evaluate(() => localStorage.setItem('cs-nav-mode', 'advanced'));
await win.reload();
win.on('dialog', (d) => void d.dismiss().catch(() => {}));
const live = () => win.evaluate(() => window.studio.live.state());
const tabNow = () => win.locator('nav.workspaces button[aria-current="page"]').textContent();
async function ask(message) {
  const before = (await win.evaluate(() => window.studio.claude.state())).items.length;
  await win.evaluate((m) => window.studio.claude.send(m), message);
  const s = await win.evaluate(() => window.studio.claude.state());
  return s.items.slice(before + 1).map((i) => `${i.role}: ${i.text}`).join(' | ');
}
const assets = async () => (await win.evaluate(() => window.studio.loadProject())).assets.map((a) => a.name);

async function scenario(label, message, verify) {
  if (only.length && !only.some((o) => label.toLowerCase().startsWith(o.toLowerCase()))) return;
  const t0 = Date.now();
  try {
    const had = new Set(await assets());
    const said = await ask(message);
    const s = await live();
    const added = (await assets()).filter((n) => !had.has(n));
    const r = await verify(s, added);
    check(label, r.ok, `${r.detail ?? ''} | tab ${await tabNow()} | new: ${added.join(', ') || 'none'} | ${((Date.now() - t0) / 1000).toFixed(0)}s | Claude: ${said.slice(0, 350)}`);
    check(`${label}: lock released`, s.collab.lockOwner === null, s.collab.phase);
  } catch (e) { check(label, false, String(e).slice(0, 400)); }
}

try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, TO_IMPORT);
  const imp = await win.evaluate(() => window.studio.importAssets());
  check('Import VOLTERRA files into scratch project', imp.errors.length === 0 && imp.imported.length + imp.duplicates.length === TO_IMPORT.length, `imported ${imp.imported.length}, errors ${JSON.stringify(imp.errors)}`);
  await win.locator('.side-tab.right').click();
  await win.locator('.claude').waitFor();
  const signedIn = await win.evaluate(() => window.studio.claude.checkAuth());
  check('Claude signed in', signedIn === true);
  if (signedIn !== true) throw new Error('not signed in');

  const ok = (id) => (s, added) => ({ ok: s.appId === id && s.history.length > 1 && added.length > 0, detail: JSON.stringify(s.history) });
  await scenario('PhotoCraft', 'Open volterra-x1-car-edited-v2.pcraft and make it a bit brighter with more contrast. Then save it as a new version.', ok('photocraft'));
  await scenario('VectorCraft', 'Open volterra-x1-logo-transparent-v2.vectorcraft and invert its colours. Then save it as a new version.', ok('vectorcraft'));
  await scenario('SoundCraft', 'Open volterra-x1-soundtrack-v2.wav and turn it down by 1 dB. Then save it as a new version.', ok('soundcraft'));
  await scenario('LightCraft', 'Open volterra-x1-electric-blue-v2.png in LightCraft and apply the Golden Hour look. Then save it as a new version.', ok('lightcraft'));
  await scenario('EffectCraft', 'Open volterra-x1-electric-blue-v2.png in EffectCraft and add the title "VOLTERRA X1". Then save it as a new version.', ok('effectcraft'));
  await scenario('DesignCraft', 'Open volterra-x1-poster.designcraft and change the headline to "VOLTERRA X1 - Charged". Then save it as a new version.', ok('designcraft'));
  await scenario('FilmCraft', 'Open volterra-x1-promo-v2-1080p.mp4 in FilmCraft, cut half a second off the start and add a half-second fade out at the end. Then save it as a new version.', ok('filmcraft'));
  console.log(`Claude usage: $${(await win.evaluate(() => window.studio.claude.state())).costUsd.toFixed(3)}`);
} catch (e) {
  check('volterra smoke', false, String(e).slice(0, 400));
} finally {
  await app.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  for (const exe of EXES) for (const pid of ourPids(exe)) try { process.kill(pid); } catch { /* gone */ }
  const after = hashAll();
  const changed = Object.keys(before).filter((f) => after[f] !== before[f]);
  const added = Object.keys(after).filter((f) => !(f in before));
  check('VOLTERRA originals untouched', changed.length === 0 && added.length === 0, `changed ${changed.length}, new files ${added.length}`);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

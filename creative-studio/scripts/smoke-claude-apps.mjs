// Real Claude (signed-in Claude Code on this PC) driving every ArtCraft app from the chat panel:
// one request per app, starting from nothing open, plus a PhotoCraft -> LightCraft hand-off.
// Uses a little Claude usage. Opens real app windows and closes every one afterwards.
// Run after `npm run build`: node scripts/smoke-claude-apps.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-claude-apps-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
const started = Date.now();
const EXES = ['photocraft.exe', 'vectorcraft.exe', 'soundcraft.exe', 'filmcraft.exe', 'lightcraft.exe', 'effectcraft.exe', 'designcraft.exe', 'wordcraft.exe', 'pdfcraft.exe'];

/** Processes of `exe` started by this test run. */
function ourPids(exe) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToString('o'))" }`;
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean)
    .map((l) => l.split(' ')).filter(([, t]) => new Date(t).getTime() >= started - 2000).map(([pid]) => Number(pid));
}

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
// Header tabs are addressed by name: use the Advanced navigation (Simplified hides some under More).
await win.evaluate(() => localStorage.setItem('cs-nav-mode', 'advanced'));
await win.reload();
win.on('dialog', (d) => void d.dismiss().catch(() => {}));
const live = () => win.evaluate(() => window.studio.live.state());
const tabNow = () => win.locator('nav.workspaces button[aria-current="page"]').textContent();
const selectedName = () => win.locator('.asset[aria-selected="true"] .asset-name').textContent();

/** Sends one chat message and waits for Claude's turn to end. Returns what Claude and the tools said. */
async function ask(message) {
  const before = (await win.evaluate(() => window.studio.claude.state())).items.length;
  await win.evaluate((m) => window.studio.claude.send(m), message);
  const s = await win.evaluate(() => window.studio.claude.state());
  return { state: s, said: s.items.slice(before + 1).map((i) => `${i.role}: ${i.text}`).join(' | ') };
}

/** CLAUDE_APPS_ONLY=PhotoCraft,Hand-off runs just the scenarios whose labels start with those words. */
const only = process.env.CLAUDE_APPS_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);

async function scenario(label, message, verify, shot) {
  if (only && !only.some((o) => label.startsWith(o))) return;
  try {
    const { said } = await ask(message);
    const s = await live();
    const r = await verify(s);
    check(`${label}`, r.ok, `${r.detail ?? ''} | tab ${await tabNow()} | ${said.slice(0, 300)}`);
    check(`${label}: lock released after Claude's turn`, s.collab.lockOwner === null, s.collab.phase);
    if (shot) await win.screenshot({ path: path.join(shots, `${shot}.png`) });
  } catch (e) {
    check(label, false, String(e).slice(0, 400));
  }
}

try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await app.evaluate((e) => { e.BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 60, width: 1500, height: 940 }); });
  await win.locator('.side-tab.right').click();
  await win.locator('.claude').waitFor();
  const signedIn = await win.evaluate(() => window.studio.claude.checkAuth());
  check('Claude Code on this PC is signed in', signedIn === true, `signedIn=${signedIn}`);
  if (signedIn !== true) throw new Error('not signed in');

  await scenario('PhotoCraft: Claude opens a photo and edits it', 'Open photocraft-smoke.png and make it black and white. Do not save.',
    async (s) => ({ ok: s.appId === 'photocraft' && s.asset?.name === 'photocraft-smoke.png' && s.history.length > 1 && (await tabNow()) === 'Edit' && (await selectedName()) === 'photocraft-smoke.png', detail: JSON.stringify(s.history) }));

  await scenario('Hand-off: saves in PhotoCraft, opens the version in LightCraft and applies a look',
    'Save that as a new version. Then open the saved version in LightCraft and apply the Golden Hour look. Do not save in LightCraft.',
    async (s) => ({ ok: s.appId === 'lightcraft' && /-live1\.png$/.test(s.asset?.name ?? '') && s.history.some((h) => /golden|preset/i.test(h)) && (await tabNow()) === 'Color', detail: `${s.asset?.name} ${JSON.stringify(s.history)}` }),
    '70-claude-lightcraft-handoff');

  await scenario('VectorCraft: Claude edits vector art', 'Open harbor-landscape.svg and invert its colours. Do not save.',
    async (s) => ({ ok: s.appId === 'vectorcraft' && s.history.length > 1 && (await tabNow()) === 'Edit', detail: JSON.stringify(s.history) }));

  await scenario('SoundCraft: Claude edits audio', 'Open tone-a440.wav and turn it down by 6 dB. Do not save.',
    async (s) => ({ ok: s.appId === 'soundcraft' && s.history.length > 1, detail: JSON.stringify(s.history) }));

  await scenario('FilmCraft: Claude trims the video and adds a fade', 'Open sunset-clip.mp4, cut half a second off the start, and add a half-second fade out at the end. Do not save.',
    async (s) => {
      const tl = await win.evaluate(() => window.studio.live.timeline());
      return { ok: s.appId === 'filmcraft' && !!tl && Math.abs(tl.duration - 3.5) < 0.1 && tl.tracks[0].transitions >= 1 && (await tabNow()) === 'Edit', detail: `${tl?.duration}s, ${tl?.tracks[0]?.transitions} transitions` };
    }, '71-claude-filmcraft');

  await scenario('EffectCraft: Claude adds a title in the Effects tab', 'Open sunset-still.jpg in EffectCraft and add the title "Evening". Do not save.',
    async (s) => ({ ok: s.appId === 'effectcraft' && s.history.length > 1 && (await tabNow()) === 'Effects', detail: JSON.stringify(s.history) }));

  await scenario('DesignCraft: Claude changes the headline of a layout', 'Open sunset-flyer.designcraft and change the headline to "Evening Tide". Do not save.',
    async (s) => ({ ok: s.appId === 'designcraft' && s.history.length > 1 && (await tabNow()) === 'Edit', detail: JSON.stringify(s.history) }),
    '72-claude-designcraft');

  await scenario('WordCraft: Claude edits a Word document', 'Open quarterly-report.docx and replace "Sunset Over the Sea" with "Evening Tide". Do not save.',
    async (s) => ({ ok: s.appId === 'wordcraft' && s.history.length > 1 && (await tabNow()) === 'Edit', detail: JSON.stringify(s.history) }),
    '73-claude-wordcraft');

  await scenario('PdfCraft: Claude edits a PDF', 'Open quarterly-summary.pdf and replace "Sunset Over the Sea" with "Evening Tide", then add the text "Approved" at the bottom of page 1. Do not save.',
    async (s) => ({ ok: s.appId === 'pdfcraft' && s.history.length > 2 && (await tabNow()) === 'Edit', detail: JSON.stringify(s.history) }),
    '74-claude-pdfcraft');

  await scenario('Doc hand-off: exports the Word document as PDF and opens it in PdfCraft',
    'Export quarterly-report.docx as a PDF, keep the PDF in the library, and open that PDF so we can work on it. Do not save anything else.',
    async (s) => ({ ok: s.appId === 'pdfcraft' && /quarterly-report.*.pdf$/.test(s.asset?.name ?? '') && (await tabNow()) === 'Edit', detail: s.asset?.name }));

  const cost = (await win.evaluate(() => window.studio.claude.state())).costUsd;
  console.log(`Claude usage for this run: $${cost.toFixed(3)}`);
} catch (e) {
  check('claude apps smoke', false, String(e).slice(0, 400));
} finally {
  await app.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  for (const exe of EXES) for (const pid of ourPids(exe)) try { process.kill(pid); } catch { /* gone */ }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} Claude app checks passed`);
process.exit(failed ? 1 : 0);

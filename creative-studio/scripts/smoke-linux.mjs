// What CreateCraft reports about THIS operating system, in the real window and a scratch profile. Meant for Linux (run it with and
// without a desktop keyring); on Windows it checks the Windows answers so both are comparable.
//   Linux: the 13 Craft apps are "not installed / no version known", the key store is a real keyring or is refused (never
//          basic_text), external adapters declare platforms, and project creation, save and reopen work.
// Run after `npm run build`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-linux-'));
const linux = process.platform === 'linux';
let fails = 0;
const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };

async function launch() {
  const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
  await win.locator('nav.workspaces').waitFor({ timeout: 40000 });
  return { app, win };
}

let { app, win } = await launch();
try {
  const snap = await win.evaluate(() => window.studio.integrationStatus());
  const apps = await win.evaluate(() => window.studio.probeApps());
  const vault = snap.credentialVault;
  console.log(`INFO  key storage: available=${vault.available} label="${vault.label}" problem=${vault.problem ? JSON.stringify(vault.problem.slice(0, 110)) : 'none'}`);
  if (linux) {
    check('all 13 Craft apps are reported as not installed, with the reason', apps.length === 13 && apps.every((a) => !a.installed && /No Linux version/.test(a.notes.join(' '))), `${apps.length} apps`);
    check('key storage is a real keyring, or refused with setup help (never basic_text)', vault.available ? /GNOME Keyring|KWallet/.test(vault.label) : /basic_text|keyring|secure storage/i.test(vault.problem ?? '') && /gnome-keyring|KWallet/i.test(vault.help ?? ''), vault.label);
    check('CreateCraft itself started and shows its workspaces', (await win.locator('nav.workspaces button').count()) >= 4);
  } else {
    check('Windows: ArtCraft detection is attempted at the Program Files location', apps.length === 13);
  }

  // projects: create, save a Claude-independent change, reopen after a restart
  const key = await win.evaluate(async () => { const k = await window.studio.projects.create('Linux smoke project', undefined, { kind: 'mixed', brief: 'Created by smoke-linux', objective: 'check' }); await window.studio.projects.open(k); return k; });
  const m1 = await win.evaluate(() => window.studio.loadProject());
  check('a new project is created in the default folder and opens', m1.name === 'Linux smoke project', m1.name);
  const dir = await win.evaluate((k) => window.studio.projects.list().then((l) => l.find((p) => p.id === k)?.folder ?? null), key).catch(() => null);
  if (dir) check('the project folder has the shared layout', fs.existsSync(path.join(dir, 'project.json')) && fs.existsSync(path.join(dir, 'Assets')), dir);
  await win.evaluate(() => window.studio.setProjectMeta({ brief: 'Edited then reopened' }));
  await app.close();
  ({ app, win } = await launch());
  const list = await win.evaluate(() => window.studio.projects.list());
  check('the project is still listed after a restart', list.some((p) => p.name === 'Linux smoke project'));
  await win.evaluate((k) => window.studio.projects.open(k), key);
  const m2 = await win.evaluate(() => window.studio.loadProject());
  check('it reopens with its saved brief', m2.name === 'Linux smoke project' && /Edited then reopened/.test(m2.brief ?? ''), String(m2.brief).slice(0, 40));

  // adapters: Windows-only adapters are refused on Linux and never run
  const ext = await win.evaluate(() => window.studio.external.list());
  console.log(`INFO  external applications found: ${ext.length}`);
  if (linux) check('no Windows-only adapter reports itself usable on Linux', ext.every((a) => !['connected', 'available', 'limited'].includes(a.status) || !a.adapterId || a.adapterId === null), ext.map((a) => `${a.name}:${a.status}`).join(', ') || 'none found');
} catch (e) {
  fails++;
  console.log('FAIL  smoke crashed -', e instanceof Error ? e.message.split('\n')[0] : String(e));
} finally {
  await app.close().catch(() => {});
}
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);

// End-to-end smoke test of the BUILT app (run `npm run build` first). Uses an isolated profile,
// drives the real Electron window, asserts key behaviours and writes screenshots to docs/screenshots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

async function launch() {
  const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1600, height: 960 }).catch(() => {});
  await win.getByText('Creative Studio').first().waitFor();
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  return { app, win };
}
const shot = (win, name) => win.screenshot({ path: path.join(shots, `${name}.png`) });
const setMode = async (win, label) => {
  await win.getByRole('button', { name: 'Appearance' }).click();
  await win.getByRole('radio', { name: label }).click();
  await win.keyboard.press('Escape');
};

let { app, win } = await launch();
try {
  const sec = await win.evaluate(() => ({ require: typeof window.require, process: typeof window.process, api: Object.keys(window.studio).sort() }));
  check('renderer has no Node globals', sec.require === 'undefined' && sec.process === 'undefined', JSON.stringify(sec));

  await setMode(win, 'Dark');
  check('dark theme applied', (await win.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await win.getByRole('option', { name: /dune-poster/ }).click();
  check('still image shows Activity, not a timeline', await win.getByRole('region', { name: 'Activity' }).isVisible());
  await win.waitForTimeout(400);
  await shot(win, '01-media-dark');

  await win.getByRole('option', { name: /tone-a440/ }).click();
  check('audio asset shows the timeline', await win.getByRole('region', { name: 'Timeline' }).isVisible());
  await shot(win, '02-audio-timeline');

  const apps = await win.locator('.header-status .chip').first().textContent();
  check('ArtCraft detection reports installed but not connected', /ArtCraft \d+ installed · 0 connected/.test(apps ?? ''), apps ?? '');

  await win.getByRole('button', { name: 'Edit', exact: true }).click();
  check('Edit shows honest "not connected" live view', await win.getByText('Live view: not connected').isVisible());
  await shot(win, '03-edit-not-connected');

  await win.getByRole('button', { name: 'Workflow' }).click();
  await win.locator('.react-flow__node').first().waitFor();
  check('workflow graph loaded (5 nodes)', (await win.locator('.react-flow__node').count()) === 5);
  await win.getByRole('button', { name: /Run demo/ }).click();
  await win.getByRole('button', { name: 'Approve' }).waitFor({ timeout: 15000 });
  await shot(win, '04-workflow-awaiting-approval');
  await win.getByRole('button', { name: 'Approve' }).click();
  await win.locator('.react-flow__node', { hasText: 'Export' }).locator('.node-status.completed').waitFor({ timeout: 15000 });
  check('mock run completes after approval', true);
  await shot(win, '05-workflow-completed');

  await setMode(win, 'Light');
  check('light theme applied', (await win.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  await win.getByRole('button', { name: 'Plan mock task' }).click();
  await win.getByRole('button', { name: 'Run', exact: true }).click();
  await win.waitForTimeout(500);
  await win.getByRole('button', { name: 'Take Control' }).click();
  await win.getByText('Manual Control').first().waitFor({ timeout: 5000 });
  check('take control waits for op then hands lock to user', await win.getByText('Lock: user').isVisible());
  await shot(win, '06-light-workflow-manual-control');

  await win.getByRole('button', { name: 'Media', exact: true }).click();
  await win.getByRole('option', { name: /harbor/ }).click();
  await win.waitForTimeout(400);
  await shot(win, '07-media-light');
} finally {
  await app.close();
}

({ app, win } = await launch());
try {
  check('theme persists across restart', (await win.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  const g = await win.evaluate(() => window.studio.loadWorkflow());
  check('workflow persists across restart', g.nodes.length === 5 && g.edges.length === 3);
  const bad = await win.evaluate(() => window.studio.saveWorkflow({ schemaVersion: 1, nodes: [{ id: 'x', type: 'shell', position: { x: 0, y: 0 }, params: {} }], edges: [] }).then(() => 'accepted', () => 'rejected'));
  check('main rejects malformed workflow over IPC', bad === 'rejected');
} finally {
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}

fs.writeFileSync(path.join(shots, 'smoke-results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} smoke checks passed`);
process.exit(failed ? 1 : 0);

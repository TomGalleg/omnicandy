// OPT-IN (uses Claude usage under your existing login; no external API spend). Real Claude, in the Claude panel of
// a scratch OmniCandi profile, discovers an INSTALLED integration package (the sample adapter) through
// external_apps and drives it with external_run / external_job. Nothing in OmniCandi's code names the adapter.
// Pass criteria are on disk and in the job table, not in Claude's words. Run after `npm run build`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { generateKeyFile, packAdapter } from './pack-adapter.mjs';

const root = path.resolve(import.meta.dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-claude-adapter-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } }

const inbox = path.join(profile, 'integrations', 'inbox');
fs.mkdirSync(inbox, { recursive: true });
const key = path.join(profile, 'k.pem');
generateKeyFile(key);
const file = path.join(inbox, 'sample.ccadapter');
fs.writeFileSync(file, packAdapter({ dir: path.join(root, 'fixtures', 'sample-adapter'), privateKeyPem: fs.readFileSync(key, 'utf8') }).bytes);

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
try {
  await win.locator('.asset').first().waitFor({ state: 'attached', timeout: 30000 });
  await app.evaluate(({ dialog }) => {
    globalThis.__approvals = [];
    dialog.showMessageBox = async (...args) => { globalThis.__approvals.push(args.at(-1)); return { response: 1, checkboxChecked: false }; };
  });
  // Install through the same IPC the Settings screen uses (native confirmation answered by the test).
  const review = await win.evaluate((p) => window.studio.external.reviewPackage(p), file);
  check('the package review has no problems', review.problems.length === 0, JSON.stringify(review.problems));
  const listing = await win.evaluate((a) => window.studio.external.installPackage(a.p, { permissions: a.perms, trustPublisher: true }), { p: file, perms: review.permissions });
  check('the package installs', listing.installed.some((i) => i.id === 'sample.textkit' && i.state === 'ok'));

  await win.locator('.side-tab.right').click();
  await win.locator('#claude-input').fill('Use the Sample Text Kit integration: count the words in "the quick brown fox", write a report titled Fox with that text, then start the slow count for 3 seconds as a background job and check the job until it finishes. Tell me exactly what was verified.');
  await win.getByRole('button', { name: 'Send' }).click();
  await win.locator('.claude .chip', { hasText: 'Ready' }).waitFor({ timeout: 300000 });
  const s = await win.evaluate(() => window.studio.claude.state());
  const said = s.items.filter((i) => i.role !== 'user').map((i) => `${i.role}: ${i.text}`).join(' | ');
  const approvals = await app.evaluate(() => globalThis.__approvals);
  check('the user was asked before the report was written', approvals.some((a) => /Write a small text report/.test(a.message ?? '')), JSON.stringify(approvals.map((a) => a.message)));
  const report = [...walk(profile)].find((p) => /sample\.textkit[\\/]report\.txt$/.test(p));
  const body = report ? fs.readFileSync(report, 'utf8') : '';
  check('report.txt exists in the project external folder and holds the right count', /Words: 4/.test(body) && /Fox/.test(body), report ?? 'not found');
  const jobs = await win.evaluate(() => window.studio.external.jobs());
  const job = jobs.find((j) => j.commandId === 'slow.count');
  check('a background job ran and succeeded with a verified result', !!job && job.status === 'succeeded' && job.result?.verified === true, JSON.stringify(job && { status: job.status, v: job.result?.verified }));
  console.log('Claude said:', said.slice(0, 900));
} catch (e) {
  check('smoke run completed', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
} finally {
  await app.close().catch(() => undefined);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

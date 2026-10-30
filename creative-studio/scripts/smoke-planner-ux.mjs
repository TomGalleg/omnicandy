// Planner beginner experience, in the REAL OmniCandy window (scratch profile, never your own data, and no AI is ever asked).
// Covers: a new project opens on Studio with no empty canvas; the one "Next:" line on every tab; the last Planner tab is remembered per project and survives a
// restart; an Advanced-only tab shows Studio in Simplified mode without losing the saved choice; the Work tab leads with OmniCandy's Claude (or "any chat" when
// Claude is not ready) in one button; OmniTown's team controls are folded away.
//   node scripts/smoke-planner-ux.mjs        (after `npm run build`)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { _electron } = require('playwright');
const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-ux-'));
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };

const launch = async () => {
  const app = await _electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(String(e)));
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.locator('nav.workspaces').waitFor({ timeout: 40000 });
  return { app, win };
};
const errors = [];
const openPlanner = async (win) => { await win.locator('nav.workspaces > button', { hasText: 'Planner' }).click(); await win.locator('.pl-tabs button').first().waitFor({ timeout: 20000 }); await win.waitForTimeout(800); };
const selected = (win) => win.locator('.pl-tabs button[aria-selected=true]').innerText();
const tab = async (win, name) => { await win.locator('.pl-tabs button', { hasText: name }).click(); await win.waitForTimeout(600); };
const planId = (win) => win.evaluate(async () => (await window.studio.planner.list())[0].id);
const meta = (win) => win.evaluate(async () => (await window.studio.loadProject()).plannerTab ?? null);

let { app, win } = await launch();
try {
  // ---- a new project (a real one: the built-in Sample Project is rebuilt on every launch, so nothing would stick to it)
  const keyA = await win.evaluate(() => window.studio.projects.create('Planner UX project'));
  await win.evaluate((k) => window.studio.projects.open(k), keyA); await win.reload(); await win.locator('nav.workspaces').waitFor({ timeout: 40000 });
  await openPlanner(win);
  check('A project with no saved tab opens on Studio', (await selected(win)) === 'Studio', await selected(win));
  check('The empty Studio shows no canvas, toolbar or counters', (await win.locator('.react-flow').count()) === 0);
  const id = await planId(win);
  const chat = await win.evaluate(async (id) => (await window.studio.planner.chatLoad(id)).messages.length, id);
  check('Opening the Planner asked no AI anything (no conversation was started)', chat === 0);

  // ---- the next-step line on every tab
  const strips = {};
  for (const t of ['OmniTown', 'Studio', 'Work']) { await tab(win, t); strips[t] = await win.locator('.pl-nextstrip').count(); }
  check('One "Next:" line on each of the three tabs', Object.values(strips).every((n) => n === 1), JSON.stringify(strips));
  await tab(win, 'Studio');
  const line = await win.locator('.pl-nextstrip').innerText();
  check('A new project is told to talk to the General Manager', /General Manager/.test(line), line.replace(/\s+/g, ' '));

  // ---- OmniTown: team controls folded away
  await tab(win, 'OmniTown');
  check('OmniTown shows one button, and keeps the team controls under "Team options"', (await win.getByRole('button', { name: 'Suggest helpers' }).count()) === 0 && (await win.locator('.tw-team-options summary').count()) === 1);
  await win.locator('.tw-team-options summary').click();
  check('"Team options" opens the helper controls', (await win.getByRole('button', { name: 'Suggest helpers' }).count()) === 1);
  await win.locator('.tw-team-options summary').click();

  // ---- the Work tab
  await win.evaluate(async (id) => { const api = window.studio.planner; const pr = await api.importSuggestions(id, { proposer: { kind: 'other', name: 'Smoke test' }, note: 'x', changes: [{ op: 'add_task', title: 'Write the brief', description: '', priority: 'normal', dependsOn: [], completionChecks: ['It fits on a page'] }], rawText: 'x' }); await api.decideProposal(id, pr.id, true, [0]); }, id);
  await tab(win, 'Work');
  const ready = await win.evaluate(async () => { const st = await window.studio.claude.state(); return st.billing?.mode === 'api-key' ? !!st.billing.keyReady : st.installed !== false && st.signedIn !== false && st.status !== 'signed-out'; });
  const first = await win.locator('input[type=radio]:checked').evaluateAll((els) => els.map((e) => e.closest('label')?.innerText ?? ''));
  check(ready ? 'Work leads with OmniCandy Claude when it is ready' : 'Work leads with "any chat" when Claude is not ready', ready ? /OmniCandy Claude/.test(first[0] ?? '') : /ChatGPT/.test(first[0] ?? ''), (first[0] ?? '').split('\n')[0]);
  if (ready) {
    check('It is one button, "Do this now"', (await win.getByRole('button', { name: 'Do this now' }).count()) === 1 && (await win.getByRole('button', { name: 'Get it ready' }).count()) === 0);
    check('Other AIs are under a closed "Use another AI instead"', (await win.locator('details', { hasText: 'Use another AI instead' }).first().evaluate((e) => e.open)) === false);
  }
  check('"Bring an answer back" is under a closed fold', (await win.locator('details', { hasText: 'Bring an answer back from another AI' }).first().evaluate((e) => e.open)) === false);

  // ---- tasks inside the offices, and the Plan button
  await win.evaluate(async (id) => { const api = window.studio.planner; const pr = await api.importSuggestions(id, { proposer: { kind: 'other', name: 'Smoke test' }, note: 'x', changes: [
    { op: 'add_task', title: 'Draw the dragon', description: '', priority: 'normal', dependsOn: [], completionChecks: [], assignee: 'creative-director' },
    { op: 'add_task', title: 'Test the loader', description: '', priority: 'normal', dependsOn: [], completionChecks: [], assignee: 'quality-director' }], rawText: 'x' }); await api.decideProposal(id, pr.id, true, [0, 1]); }, id);
  await tab(win, 'OmniTown');
  const enter = async (who) => { await win.locator('.tw-office .tw-spot').filter({ hasText: who }).first().dispatchEvent('click'); await win.waitForTimeout(1800); };
  const leave = async () => { await win.getByRole('button', { name: 'Back to the town' }).click(); await win.waitForTimeout(500); };
  await enter('Creative');
  await win.getByRole('button', { name: /^Tasks/ }).click(); await win.waitForTimeout(800);
  const creative = await win.getByRole('dialog', { name: /tasks/ }).innerText();
  check('An office shows the tasks of that director', /Draw the dragon/.test(creative));
  check('...and nobody elses', !/Test the loader|Write the brief/.test(creative));
  check('"Do this now" is right there in the office', (await win.getByRole('dialog', { name: /tasks/ }).getByRole('button', { name: 'Do this now' }).count()) === 1 || !ready);
  await leave();
  await enter('General');
  await win.getByRole('button', { name: /^Tasks/ }).click(); await win.waitForTimeout(800);
  const gm = await win.getByRole('dialog', { name: /tasks/ }).innerText();
  check('A task nobody owns falls to the General Manager', /Write the brief/.test(gm) && !/Draw the dragon|Test the loader/.test(gm));
  await leave();
  await win.getByRole('button', { name: 'Plan', exact: true }).click(); await win.waitForTimeout(1500);
  check('The Plan button in OmniTown shows the plan as cards', (await win.locator('.react-flow__node').count()) >= 3);
  await win.locator('.react-flow__node', { hasText: 'Test the loader' }).first().click(); await win.waitForTimeout(400);
  await win.getByRole('region', { name: 'The plan' }).getByRole('button', { name: 'Work on this' }).click(); await win.waitForTimeout(1800);
  check('"Work on this" on a card opens the task in the office of its director', /Test the loader/.test(await win.getByRole('dialog', { name: /tasks/ }).innerText().catch(() => '')) && /Quality Director/.test(await win.locator('.tw-card').first().innerText()));
  await leave();

  // ---- remember the last tab, through a restart
  await tab(win, 'Work');
  await win.waitForTimeout(1500);
  check('The tab is saved with the project, not the plan', (await meta(win)) === 'handoffs', String(await meta(win)));
  const rev = await win.evaluate(async (id) => (await window.studio.planner.get(id)).revision, id);
  await tab(win, 'OmniTown'); await tab(win, 'Studio'); await tab(win, 'Work');
  check('Switching tabs does not change the plan', (await win.evaluate(async (id) => (await window.studio.planner.get(id)).revision, id)) === rev);
  await app.close();
  ({ app, win } = await launch());
  await openPlanner(win);
  check('After a restart the project opens on the tab it was left on', (await selected(win)) === 'Work', await selected(win));

  // ---- a second project keeps its own tab
  const keyB = await win.evaluate(() => window.studio.projects.create('Second project'));
  await win.evaluate((k) => window.studio.projects.open(k), keyB); await win.reload(); await win.locator('nav.workspaces').waitFor({ timeout: 40000 });
  await openPlanner(win);
  check('A different project opens on Studio, not on the other project\'s tab', (await selected(win)) === 'Studio', await selected(win));
  await tab(win, 'OmniTown'); await win.waitForTimeout(1500);
  await win.evaluate((k) => window.studio.projects.open(k), keyA); await win.reload(); await win.locator('nav.workspaces').waitFor({ timeout: 40000 });
  await openPlanner(win);
  check('The first project still opens on its own tab', (await selected(win)) === 'Work', await selected(win));

  // ---- Simplified and Advanced
  await win.getByRole('button', { name: 'Simplified' }).first().click(); await win.waitForTimeout(600);
  const advancedTabs = await win.locator('.pl-tabs button').allInnerTexts();
  check('Advanced mode shows the two extra tabs', advancedTabs.includes('Idea') && advancedTabs.includes('Plan'), advancedTabs.join(', '));
  await tab(win, 'Plan'); await win.waitForTimeout(1500);
  check('An Advanced-only tab is saved too', (await meta(win)) === 'tasks', String(await meta(win)));
  await win.getByRole('button', { name: 'Advanced' }).first().click(); await win.waitForTimeout(800);
  check('Back in Simplified mode Studio is shown instead', (await selected(win)) === 'Studio', await selected(win));
  check('...and the saved choice is not thrown away', (await meta(win)) === 'tasks', String(await meta(win)));
  await win.getByRole('button', { name: 'Simplified' }).first().click(); await win.waitForTimeout(800);
  check('Back in Advanced mode the saved tab returns', (await selected(win)) === 'Plan', await selected(win));
  check('No page errors', errors.length === 0, errors.join(' | '));
} finally { await app.close().catch(() => {}); }
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exitCode = failed ? 1 : 0;

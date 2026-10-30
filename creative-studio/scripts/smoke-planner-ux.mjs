// Planner beginner experience, in the REAL OmniCandy window (scratch profile, never your own data, and no AI is ever asked).
// Simplified mode (the default) has ONE view, OmniTown: no tab bar, a chat box with the General Manager on the map, Plan new project while there is no plan,
// tasks and review inside every office, a Plan button, and a Next line whose button opens the right office or the plan. Advanced mode shows all five tabs and
// remembers the last one per project (kept with the project, never in the plan) through a restart.
//   node scripts/smoke-planner-ux.mjs        (after `npm run build`)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { _electron } = require('playwright');
const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-ux-'));
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
const errors = [];

const launch = async () => {
  const app = await _electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(String(e)));
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.locator('nav.workspaces').waitFor({ timeout: 40000 });
  return { app, win };
};
const openPlanner = async (win) => { await win.locator('nav.workspaces > button', { hasText: 'Planner' }).click(); await win.locator('.pl-body').waitFor({ timeout: 20000 }); await win.waitForTimeout(900); };
const setMode = async (win, want) => {
  const btn = win.getByRole('button', { name: /^(Simplified|Advanced)$/ }).first();
  const now = (await btn.innerText()).trim();
  if ((want === 'advanced' && now === 'Simplified') || (want === 'simplified' && now === 'Advanced')) { await btn.click(); await win.waitForTimeout(700); }
};
const selected = (win) => win.locator('.pl-tabs button[aria-selected=true]').innerText();
const tab = async (win, name) => { await win.locator('.pl-tabs button', { hasText: name }).click(); await win.waitForTimeout(600); };
const planId = (win) => win.evaluate(async () => (await window.studio.planner.list())[0].id);
const meta = (win) => win.evaluate(async () => (await window.studio.loadProject()).plannerTab ?? null);
const switchProject = async (win, key) => { await win.evaluate((k) => window.studio.projects.open(k), key); await win.reload(); await win.locator('nav.workspaces').waitFor({ timeout: 40000 }); };
const addTasks = (win, id, list) => win.evaluate(async ([id, list]) => { const api = window.studio.planner; const pr = await api.importSuggestions(id, { proposer: { kind: 'other', name: 'Smoke test' }, note: 'x', changes: list.map((t) => ({ op: 'add_task', description: '', priority: 'normal', dependsOn: [], completionChecks: [], ...t })), rawText: 'x' }); await api.decideProposal(id, pr.id, true, list.map((_, i) => i)); }, [id, list]);
const enter = async (win, who) => { await win.locator('.tw-office .tw-spot').filter({ hasText: who }).first().dispatchEvent('click'); await win.waitForTimeout(1800); };
const leave = async (win) => { await win.getByRole('button', { name: 'Back to the town' }).click(); await win.waitForTimeout(500); };

let { app, win } = await launch();
try {
  // ======================= Simplified mode: one view, OmniTown =======================
  const keyA = await win.evaluate(() => window.studio.projects.create('Planner UX project'));
  await switchProject(win, keyA);
  await setMode(win, 'simplified');
  await openPlanner(win);
  const id = await planId(win);
  check('Simplified mode has one view: no tab bar, the town map is showing', (await win.locator('.pl-tabs button').count()) === 0 && (await win.locator('.tw-map-art').count()) === 1);
  check('The map has no "Talk to the General Manager" button', (await win.getByRole('button', { name: 'Talk to the General Manager' }).count()) === 0);
  check('A project with no plan offers "Plan new project"', (await win.getByRole('button', { name: 'Plan new project' }).count()) === 1);
  check('There is a box to talk with the General Manager right on the map', (await win.getByLabel('Say something to General Manager').count()) === 1);
  check('A new project has no "Next:" line on the map (the box and Plan new project cover it)', (await win.locator('.pl-nextstrip').count()) === 0);
  check('Opening the Planner asked no AI anything', (await win.evaluate(async (id) => (await window.studio.planner.chatLoad(id)).messages.length, id)) === 0);
  await win.getByRole('button', { name: 'Plan new project' }).click(); await win.waitForTimeout(1800);
  check('Plan new project brings everyone to the Town Hall, ready to be told what to make', (await win.locator('.tw-hall-person').count()) === 9 && /what you want to make/.test((await win.getByLabel('Say something to the team').getAttribute('placeholder')) ?? ''));
  check('...and the General Manager greets the owner', /How can we help you, boss/.test(await win.locator('.tw-bubble').first().innerText()));
  await leave(win);
  check('Back on the map the button is still there until a plan exists', (await win.getByRole('button', { name: 'Plan new project' }).count()) === 1);
  check('The helper controls are folded under "Team options"', (await win.getByRole('button', { name: 'Suggest helpers' }).count()) === 0 && (await win.locator('.tw-team-options summary').count()) === 1);
  await win.locator('.tw-team-options summary').click();
  check('"Team options" opens them', (await win.getByRole('button', { name: 'Suggest helpers' }).count()) === 1);
  await win.locator('.tw-team-options summary').click();

  // ---- tasks inside the offices
  await addTasks(win, id, [{ title: 'Write the brief', completionChecks: ['It fits on a page'] }, { title: 'Draw the dragon', assignee: 'creative-director' }, { title: 'Test the loader', assignee: 'quality-director' }]);
  await setMode(win, 'advanced'); await setMode(win, 'simplified'); await win.waitForTimeout(800); // a fresh look at the plan, as the owner would see it
  check('Once the plan has a task, "Plan new project" is gone', (await win.getByRole('button', { name: 'Plan new project' }).count()) === 0);
  check('...and the manager box and the Plan button remain', (await win.getByLabel('Say something to General Manager').count()) === 1 && (await win.getByRole('button', { name: 'Plan', exact: true }).count()) === 1);
  const strip = win.locator('.pl-nextstrip');
  check('The Next line comes back on the map once there is something to do', (await strip.count()) === 1 && /Write the brief/.test(await strip.innerText()), (await strip.innerText().catch(() => '')).replace(/\s+/g, ' '));
  await strip.getByRole('button').click(); await win.waitForTimeout(1800);
  check('Its button opens that task in the office of its director (a task nobody owns is the General Manager\'s)', /General Manager/.test(await win.locator('.tw-card').first().innerText()) && /Write the brief/.test(await win.getByRole('dialog', { name: /tasks/ }).innerText().catch(() => '')));
  const ready = await win.evaluate(async () => { const st = await window.studio.claude.state(); return st.billing?.mode === 'api-key' ? !!st.billing.keyReady : st.installed !== false && st.signedIn !== false && st.status !== 'signed-out'; });
  const panel = win.getByRole('dialog', { name: /tasks/ });
  const first = await panel.locator('input[type=radio]:checked').evaluateAll((els) => els.map((e) => e.closest('label')?.innerText ?? ''));
  check(ready ? 'The office leads with OmniCandy Claude when it is ready' : 'The office leads with "any chat" when Claude is not ready', ready ? /OmniCandy Claude/.test(first[0] ?? '') : /ChatGPT/.test(first[0] ?? ''), (first[0] ?? '').split('\n')[0]);
  if (ready) {
    check('It is one button, "Do this now"', (await panel.getByRole('button', { name: 'Do this now' }).count()) === 1 && (await panel.getByRole('button', { name: 'Get it ready' }).count()) === 0);
    check('Other AIs are under a closed "Use another AI instead"', (await panel.locator('details', { hasText: 'Use another AI instead' }).first().evaluate((e) => e.open)) === false);
  }
  check('"Bring an answer back" is under a closed fold', (await panel.locator('details', { hasText: 'Bring an answer back from another AI' }).first().evaluate((e) => e.open)) === false);
  await leave(win);
  await enter(win, 'Creative');
  await win.getByRole('button', { name: /^Tasks/ }).click(); await win.waitForTimeout(800);
  const creative = await win.getByRole('dialog', { name: /tasks/ }).innerText();
  check('An office shows the tasks of that director', /Draw the dragon/.test(creative));
  check('...and nobody elses', !/Test the loader|Write the brief/.test(creative));
  await leave(win);
  await win.getByRole('button', { name: 'Plan', exact: true }).click(); await win.waitForTimeout(1500);
  check('The Plan button shows the plan as cards', (await win.locator('.react-flow__node').count()) >= 3);
  await win.locator('.react-flow__node', { hasText: 'Test the loader' }).first().click(); await win.waitForTimeout(400);
  await win.getByRole('region', { name: 'The plan' }).getByRole('button', { name: 'Work on this' }).click(); await win.waitForTimeout(1800);
  check('"Work on this" on a card opens the task in the office of its director', /Test the loader/.test(await win.getByRole('dialog', { name: /tasks/ }).innerText().catch(() => '')) && /Quality Director/.test(await win.locator('.tw-card').first().innerText()));
  await leave(win);

  // ======================= Advanced mode: five tabs, the last one remembered =======================
  await setMode(win, 'advanced');
  const tabs = await win.locator('.pl-tabs button').allInnerTexts();
  check('Advanced mode shows all five tabs', ['OmniTown', 'Studio', 'Idea', 'Plan', 'Work'].every((t) => tabs.some((x) => x.startsWith(t))), tabs.join(', '));
  check('A project that never chose a tab opens on Studio', (await selected(win)) === 'Studio', await selected(win));
  const strips = {};
  for (const t of ['OmniTown', 'Studio', 'Work']) { await tab(win, t); strips[t] = await win.locator('.pl-nextstrip').count(); }
  check('A "Next:" line on each of the three main tabs once there is something to do', Object.values(strips).every((n) => n === 1), JSON.stringify(strips));
  await tab(win, 'Work');
  check('The Work tab leads with one button', !ready || ((await win.getByRole('button', { name: 'Do this now' }).count()) === 1 && (await win.getByRole('button', { name: 'Get it ready' }).count()) === 0));
  await win.waitForTimeout(1500);
  check('The tab is saved with the project, not the plan', (await meta(win)) === 'handoffs', String(await meta(win)));
  const rev = await win.evaluate(async (id) => (await window.studio.planner.get(id)).revision, id);
  await tab(win, 'OmniTown'); await tab(win, 'Studio'); await tab(win, 'Work');
  check('Switching tabs does not change the plan', (await win.evaluate(async (id) => (await window.studio.planner.get(id)).revision, id)) === rev);
  await app.close();
  ({ app, win } = await launch());
  await setMode(win, 'advanced'); await openPlanner(win);
  check('After a restart the project opens on the tab it was left on', (await selected(win)) === 'Work', await selected(win));

  // ---- a second project keeps its own tab, and an empty Studio shows no canvas
  const keyB = await win.evaluate(() => window.studio.projects.create('Second project'));
  await switchProject(win, keyB); await setMode(win, 'advanced'); await openPlanner(win);
  check('A different project opens on Studio, not on the other project\'s tab', (await selected(win)) === 'Studio', await selected(win));
  check('The empty Studio shows no canvas, toolbar or counters', (await win.locator('.react-flow').count()) === 0);
  await tab(win, 'OmniTown'); await win.waitForTimeout(1500);
  await switchProject(win, keyA); await setMode(win, 'advanced'); await openPlanner(win);
  check('The first project still opens on its own tab', (await selected(win)) === 'Work', await selected(win));

  // ---- Simplified and Advanced
  await tab(win, 'Plan'); await win.waitForTimeout(1500);
  check('An Advanced-only tab is saved too', (await meta(win)) === 'tasks', String(await meta(win)));
  await setMode(win, 'simplified');
  check('In Simplified mode there is just the town', (await win.locator('.pl-tabs button').count()) === 0 && (await win.locator('.tw-map-art').count()) === 1);
  check('...and the saved choice is not thrown away', (await meta(win)) === 'tasks', String(await meta(win)));
  await setMode(win, 'advanced');
  check('Back in Advanced mode the saved tab returns', (await selected(win)) === 'Plan', await selected(win));
  check('No page errors', errors.length === 0, errors.join(' | '));
} finally { await app.close().catch(() => {}); }
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exitCode = failed ? 1 : 0;

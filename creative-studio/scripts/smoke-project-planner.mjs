// The project-bound Planner in the REAL CreateCraft window (scratch profile, never your own data): an existing project's entry and findings,
// chunks and Work, the plan stored inside the project, Pick up where I left off after reopening, the saved conversation, and a new project's
// "Start with an idea". No AI is called. Screenshots go to a temp folder.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { _electron } from 'playwright';
const root = path.resolve(import.meta.dirname, '..'); const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pplan-shots-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pplan-'));
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const launch = async () => {
  const app = await _electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
  const win = await app.firstWindow(); await win.setViewportSize({ width: 1500, height: 1200 });
  await win.locator('.asset').first().waitFor({ timeout: 30000 });
  return { app, win };
};
const planner = (win) => win.locator('nav.workspaces > button', { hasText: 'Planner' }).click();
const tab = (win, name) => win.getByRole('tab', { name, exact: true }).click();

let { app, win } = await launch();
try {
  // ---- 1. an existing project (the sample project has files and no plan yet)
  await planner(win);
  await win.locator('.planner h2').first().waitFor();
  check('Planner is in the main navigation and an existing project gets an entry screen', /Planner for Sample Project/.test(await win.locator('.planner h2').first().textContent()));
  check('The entry offers both starting points', (await win.getByRole('button', { name: 'Start with an idea' }).count()) === 1 && (await win.getByRole('button', { name: 'Look at what is already here' }).count()) === 1);
  await win.getByRole('button', { name: 'Look at what is already here' }).click();
  await win.getByText('What is already in this project').waitFor();
  const lines = await win.locator('.pl-section li').allTextContents();
  check('The findings are plain facts and say nothing is marked done', lines.some((l) => /files in the library/.test(l)) && lines.some((l) => /none of this is marked as done/.test(l)), lines.slice(0, 3).join(' | '));
  await win.screenshot({ path: path.join(out, 'pp-findings.png') });
  await win.getByRole('button', { name: 'Start my plan with these' }).click();
  await win.getByRole('tab', { name: 'Idea' }).waitFor();
  await win.locator('.pl-fold > summary', { hasText: 'References and files' }).click();
  const refText = await win.locator('.planner').innerText();
  check('The plan starts with the ticked findings as references (not as done work)', /References/.test(refText) && /Already in this project/.test(refText));
  check('Three steps only: Idea, Plan, Work', JSON.stringify(await win.getByRole('tab').allTextContents()) === JSON.stringify(['Idea', 'Plan', 'Work']), (await win.getByRole('tab').allTextContents()).join(','));
  check('No Advanced switch', (await win.getByText('Advanced', { exact: true }).count()) === 0);
  const folds = await win.locator('.pl-fold > summary').allTextContents();
  check('Idea keeps everything in short folded sections', ['Project brief', 'Rules and decisions', 'Open questions', 'Ideas', 'References and files'].every((f) => folds.some((x) => x.startsWith(f))), folds.join(' | '));
  await win.locator('.pl-menu > summary').click();
  const menu = await win.locator('.pl-menu [role=menuitem]').allTextContents();
  check('One small menu holds history, connect, export/import and the folder', ['What changed…', 'Connect an AI tool…', 'Export this plan…', 'Import a plan…', "Open the plan's folder"].every((m) => menu.includes(m)), menu.join(' | '));
  await win.locator('.pl-menu [role=menuitem]', { hasText: 'What changed' }).click();
  check('What changed shows the history', (await win.getByText('Every change to this plan, newest first.').count()) === 1);
  await win.getByRole('button', { name: 'Close' }).first().click();

  // ---- 2. chunks and Work
  await tab(win, 'Plan');
  await win.getByPlaceholder('What needs doing?').fill('Sketch the layout');
  await win.getByRole('button', { name: 'Add chunk' }).click();
  await win.locator('.pl-task', { hasText: 'Sketch the layout' }).waitFor();
  const chunkSection = await win.locator('.planner').innerText();
  check('Plan talks about chunks and adding one is a single line', /Chunks/.test(chunkSection) && /Add a chunk/.test(chunkSection) && (await win.locator('.pl-task', { hasText: 'Sketch the layout' }).count()) === 1);
  await win.screenshot({ path: path.join(out, 'pp-plan.png') });
  // add chunks through the API (the form is covered elsewhere) so the rest of the flow is deterministic
  const ids = await win.evaluate(async () => {
    const st = await window.studio.planner.forProject();
    const a = await window.studio.planner.addTask(st.plan.id, { title: 'Write the headline' });
    const b = await window.studio.planner.addTask(st.plan.id, { title: 'Paint the final artwork' });
    return { plan: st.plan.id, a: a.id, b: b.id };
  });
  await win.waitForTimeout(3500);
  await tab(win, 'Plan');
  await win.locator('.pl-task', { hasText: 'Paint the final artwork' }).getByRole('button', { name: 'Work on this' }).click();
  await win.getByText('Current chunk').waitFor();
  check('"Work on this" opens the chunk in Work', /Paint the final artwork/.test(await win.locator('.pl-task.current').first().innerText()));
  await win.screenshot({ path: path.join(out, 'pp-work.png') });
  // the conversation is kept with the plan
  const chat = await win.evaluate(async (id) => {
    await window.studio.planner.chatSave(id, { messages: [{ role: 'user', text: 'Help me plan' }, { role: 'assistant', text: 'Sure. What is it for?' }], provider: 'claude' });
    return window.studio.planner.chatLoad(id);
  }, ids.plan);
  check('The planning conversation is saved with the plan', chat.messages.length === 2);
  await win.waitForTimeout(500);
  const planFile = path.join(profile, 'projects', 'sample-project', 'Planner', 'projects', ids.plan, 'project.json');
  check('The plan is stored inside the project folder with the project identity', fs.existsSync(planFile) && !!JSON.parse(fs.readFileSync(planFile, 'utf8')).ownerProjectId, planFile);
  await app.close();

  // ---- 3. reopen: everything is restored, and "Pick up where I left off" appears
  ({ app, win } = await launch());
  await planner(win);
  await win.getByRole('tab', { name: 'Idea' }).waitFor();
  const banner = win.locator('.pl-pickup');
  await banner.waitFor({ timeout: 10000 });
  check('Reopening the project offers Pick up where I left off with the last chunk', /Pick up where I left off/.test(await banner.innerText()) && /Paint the final artwork/.test(await banner.innerText()), (await banner.innerText()).replace(/\s+/g, ' '));
  await win.screenshot({ path: path.join(out, 'pp-pickup.png') });
  await banner.getByRole('button', { name: 'Pick up' }).click();
  await win.getByText('Current chunk').waitFor();
  check('Pick up goes straight to that chunk in Work', /Paint the final artwork/.test(await win.locator('.pl-task.current').first().innerText()));
  const chat2 = await win.evaluate(async () => { const st = await window.studio.planner.forProject(); return window.studio.planner.chatLoad(st.plan.id); });
  check('The conversation is restored after reopening', chat2.messages.length === 2 && chat2.messages[1].text.startsWith('Sure'));

  // ---- 4. a brand-new project: "Start with an idea" opens its Planner
  await win.locator('nav.workspaces > button', { hasText: 'Project' }).first().click();
  await win.getByRole('button', { name: 'New blank project' }).click();
  await win.getByLabel('New project name').fill('Dragon poster');
  check('The new-project form offers two choices', (await win.getByRole('button', { name: 'Start with an idea' }).count()) === 1 && (await win.getByRole('button', { name: 'Start creating' }).count()) === 1);
  await win.screenshot({ path: path.join(out, 'pp-new.png') });
  await win.getByRole('button', { name: 'Start with an idea' }).click();
  await win.getByRole('tab', { name: 'Idea' }).waitFor({ timeout: 15000 });
  check('Start with an idea opens that project\'s own Planner', /Dragon poster/.test(await win.locator('.planner h2').first().textContent()));
  const mine = await win.evaluate(async () => { const st = await window.studio.planner.forProject(); return { name: st.project.name, plan: st.plan && st.plan.title, tasks: st.plan && st.plan.tasks.length }; });
  check('It is a separate plan from the other project\'s (no chunks carried over)', mine.plan === 'Dragon poster' && mine.tasks === 0, JSON.stringify(mine));
} finally {
  await app.close().catch(() => {});
}
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);

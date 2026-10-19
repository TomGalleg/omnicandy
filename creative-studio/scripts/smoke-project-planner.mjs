// The project-bound Planner in the REAL OmniCandy window (scratch profile, never your own data): an existing project's entry and findings,
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
  await win.getByRole('button', { name: 'Start planning from this' }).click();
  await win.getByRole('tab', { name: 'Idea' }).waitFor();
  await win.locator('.pl-msg.assistant').first().waitFor();
  const first = await win.locator('.pl-msg.assistant').first().innerText();
  check('The conversation starts from what was found and asks what to do next', /I looked through this project/.test(first) && /files in the library/.test(first) && /What would you like to do with it next\?/.test(first));
  check('Three steps only: Idea, Plan, Work', JSON.stringify(await win.getByRole('tab').allTextContents()) === JSON.stringify(['Idea', 'Plan', 'Work']), (await win.getByRole('tab').allTextContents()).join(','));
  check('No Advanced switch', (await win.getByText('Advanced', { exact: true }).count()) === 0);
  check('Idea is just the conversation: no brief, rules, decisions, questions, ideas or reference lists', (await win.locator('.pl-fold > summary').allTextContents()).every((t) => /Use ChatGPT/.test(t)) && (await win.locator('h3', { hasText: /Project brief|Rules|Decisions|Open questions|References/ }).count()) === 0);
  check('A friendly input is ready for the owner\'s answer', (await win.getByLabel('Message to the planning AI').count()) === 1);
  await win.screenshot({ path: path.join(out, 'pp-idea.png') });
  // The AI's side is seeded (no AI is called): it asks "Ready to start building?", then answers "Yes" with chunks.
  const ST = await win.evaluate(async () => {
    const st = await window.studio.planner.forProject();
    await window.studio.planner.chatSave(st.plan.id, { messages: [
      { role: 'user', text: 'A poster of a dragon for the school fair' },
      { role: 'assistant', text: 'I think I understand: a teal and gold dragon poster, A2, for the school fair.\n\nReady to start building? I\'ll break it into clear steps.\n[[READY]]' },
    ] });
    return st.plan.id;
  });
  await win.getByRole('tab', { name: 'Plan', exact: true }).click();
  await win.getByRole('tab', { name: 'Idea', exact: true }).click();
  await win.getByRole('button', { name: 'Yes, make the plan' }).waitFor();
  const shown = await win.locator('.pl-msg.assistant').last().innerText();
  check('When the AI is ready it asks, the marker is hidden, and the owner can say yes or not yet', !/\[\[READY\]\]/.test(shown) && /Ready to start building/.test(shown) && (await win.getByRole('button', { name: /Not yet/ }).count()) === 1);
  await win.screenshot({ path: path.join(out, 'pp-ready.png') });
  await win.evaluate(async (id) => {
    await window.studio.planner.chatSave(id, { messages: [
      { role: 'user', text: 'A poster of a dragon for the school fair' },
      { role: 'assistant', text: 'I think I understand: a teal and gold dragon poster, A2, for the school fair.\n\nReady to start building? I\'ll break it into clear steps.\n[[READY]]' },
      { role: 'user', text: 'Yes, I am ready. Please break the project into clear chunks now.' },
      { role: 'assistant', text: 'Here is how I would build the dragon poster.\n\n## Project brief\nGoal: A print-ready dragon poster for the school fair.\nDescription: A friendly dragon in teal and gold.\nScope: One A2 poster.\n\n## Tasks\n1. Sketch three dragon poses\n   - Three poses exist\n2. Paint the final artwork\n   - Only teal, gold and cream\n3. Add the title and details\n4. Export the print file\n   - A print-ready PDF exists' },
    ] });
  }, ST);
  await win.getByRole('tab', { name: 'Plan', exact: true }).click();
  await win.getByRole('tab', { name: 'Idea', exact: true }).click();
  await win.locator('.pl-chunks').waitFor();
  const list = await win.locator('.pl-chunks ol > li strong').allTextContents();
  check('The answer to "Yes" is a plain numbered list of chunks, not raw text', JSON.stringify(list) === JSON.stringify(['Sketch three dragon poses', 'Paint the final artwork', 'Add the title and details', 'Export the print file']), list.join(' | '));
  await win.screenshot({ path: path.join(out, 'pp-chunks.png') });
  await win.getByRole('button', { name: 'Add these to my plan' }).click();
  await win.getByText('Added 4 chunks to your plan.').waitFor();
  await win.getByRole('button', { name: 'See the plan' }).click();
  await win.locator('.pl-task', { hasText: 'Export the print file' }).waitFor();
  const order = await win.locator('.pl-task strong').allTextContents();
  check('The chunks are in the plan, in order', order.join('|').startsWith('Sketch three dragon poses|Paint the final artwork|Add the title and details|Export the print file'), order.join(' | '));
  const proj = await win.evaluate(async (id) => window.studio.planner.get(id), ST);
  check('The project summary was filled in quietly and nothing else was created', proj.goal.startsWith('A print-ready dragon poster') && proj.items.length === 0 && proj.milestones.length === 0);
  await win.getByRole('tab', { name: 'Idea', exact: true }).click();
  await win.locator('.pl-chunks').waitFor();
  check('Coming back to the Idea does not offer the same chunks twice', (await win.getByRole('button', { name: 'Add these to my plan' }).count()) === 0 && /These chunks are in your plan|Added 4 chunks/.test(await win.locator('.pl-chunks').innerText()));
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
    return { plan: st.plan.id, a: a.id };
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

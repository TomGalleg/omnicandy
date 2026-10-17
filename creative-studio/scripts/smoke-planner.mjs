// Project Planner in the REAL CreateCraft window (scratch profile, never your own data), with a REAL planner MCP server process
// acting as the executor, and the copy-and-paste path. Spends no Claude usage. Run after `npm run build:planner-mcp` (npm run smoke:planner does both).
//
// Mixed project (research + document + image deliverable): create from three templates, accept a requirement, prepare a package,
// let the MCP executor claim and report, review in the UI (the plan changes while work runs -> outdated flag), then finish the
// remaining work through copy and paste, export/import, and a restart that must show the same plan.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-planner-'));
const bundle = path.join(root, 'out', 'planner-mcp.cjs');
let fails = 0;
const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A minimal stdio MCP client to the REAL server process (the app is the user; this is the executor). */
function mcp(scopes, actor) {
  const proc = spawn(process.execPath, [bundle, '--dir', path.join(profile, 'planner'), '--scopes', scopes, '--actor', actor, '--kind', 'claude-code'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; let id = 0; const wait = new Map();
  proc.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); wait.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise((res) => { const n = ++id; wait.set(n, res); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return {
    async init() { await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-executor', version: '1' } }); },
    async call(name, args) { const r = await rpc('tools/call', { name, arguments: args }); const t = r.result.content[0].text; if (r.result.isError) throw new Error(t); return JSON.parse(t); },
    close() { proc.kill(); },
  };
}

async function launch() {
  const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
  await win.locator('.asset').first().waitFor({ state: 'attached', timeout: 30000 });
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  return { app, win };
}
const openPlanner = async (win) => {
  await win.locator('nav.workspaces .more-menu > button').click();
  await win.locator('.more-list [role=menuitem]', { hasText: 'Planner' }).click();
  await win.locator('.planner').waitFor();
};
const tab = (win, name) => win.getByRole('tab', { name, exact: false }).first().click();

let { app, win } = await launch();
let executor;
try {
  await openPlanner(win);
  check('Planner opens from More in Simplified mode', (await win.locator('.planner h2').first().textContent())?.includes('Project Planner'));

  // ---- create a mixed project: research + document + image, only a title is required
  await win.getByLabel('Title').fill('Garden club newsletter');
  await win.getByLabel('Goal (optional)').fill('A one-page newsletter with a poster image, backed by researched facts.');
  for (const t of ['Research', 'Document', 'Art or design']) await win.getByLabel(t, { exact: true }).check();
  await win.screenshot({ path: path.join(shots, '140-planner-new.png') });
  await win.getByRole('button', { name: 'Create plan' }).click();
  await win.locator('.pl-head h2', { hasText: 'Garden club newsletter' }).waitFor();
  check('A mixed project is created from three templates', true);

  await tab(win, 'Plan');
  await win.getByLabel('Add a requirement').fill('The poster image is 2480x3508 pixels');
  await win.getByRole('button', { name: 'Add', exact: true }).first().click();
  await win.getByText('The poster image is 2480x3508 pixels').waitFor();
  await win.getByLabel('Add an idea').fill('Maybe add a seed-swap calendar');
  await win.locator('.pl-section', { hasText: 'Ideas' }).getByRole('button', { name: 'Add', exact: true }).click();
  await win.getByText('Maybe add a seed-swap calendar').waitFor();
  await win.screenshot({ path: path.join(shots, '141-planner-plan.png') });

  await tab(win, 'Tasks');
  const taskCount = await win.locator('.pl-task').count();
  check('Template tasks are ordinary editable tasks', taskCount >= 6, `${taskCount} tasks`);
  await win.screenshot({ path: path.join(shots, '142-planner-tasks.png') });

  // ---- prepare a package for the first research task (nothing starts)
  await tab(win, 'Handoffs');
  const firstTask = win.locator('.pl-section', { hasText: 'Prepare a handoff' }).locator('label.pl-check').first();
  const firstTitle = (await firstTask.textContent())?.trim() ?? '';
  await firstTask.locator('input').check();
  await win.getByRole('button', { name: 'Create execution package' }).click();
  await win.locator('.pl-package', { hasText: 'Package 1' }).waitFor();
  await win.locator('.pl-package').getByRole('button', { name: 'Show / copy' }).click();
  const md = await win.locator('.pl-package .pl-raw').textContent();
  check('The package contains the accepted requirement but not the idea', md.includes('2480x3508') && !md.includes('seed-swap'));
  check('The package says how to report', md.includes('How to report') && md.includes('Completion checks'));
  const pkgId = /pkg_[a-z0-9]+/.exec(md)[0];
  const projectId = /plan_[a-z0-9]+/.exec(md)[0];
  const taskId = /task_[a-z0-9]+/.exec(md)[0];
  const chk = /chk_[a-z0-9]+/.exec(md)[0];
  await win.screenshot({ path: path.join(shots, '143-planner-package.png') });

  // ---- a REAL MCP executor process claims and reports
  executor = mcp('read,execute', 'Claude Code');
  await executor.init();
  const got = await executor.call('get_package', { projectId, packageId: pkgId });
  check('The executor retrieves the package over MCP', got.package.id === pkgId && got.drift.outdated === false);
  const claim = await executor.call('claim_task', { projectId, packageId: pkgId, taskId });
  await sleep(3500); // the window looks again every 3 s
  await tab(win, 'Tasks');
  check('The window shows who claimed the task', (await win.locator('.pl-task', { hasText: firstTitle }).first().textContent()).includes('Claimed by Claude Code'));

  // the user changes the plan while work is running
  await tab(win, 'Plan');
  const req = win.locator('.pl-section', { hasText: 'Accepted requirements' }).locator('.pl-item').last();
  await req.getByRole('button', { name: 'Edit' }).click();
  await req.getByLabel('Title').fill('The poster image is 3508x4960 pixels');
  await req.getByRole('button', { name: 'Save' }).click();
  await win.getByText('3508x4960').waitFor();

  await executor.call('submit_report', { projectId, packageId: pkgId, taskId, claimToken: claim.claimToken, report: {
    outcome: 'complete', workPerformed: 'Collected five sources on seed starting dates.', outputs: [{ description: 'Source list', path: 'research/sources.md' }],
    verification: [{ checkId: chk, check: 'Each source is cited', result: 'pass', details: 'Checked each link opens.' }], unresolvedQuestions: ['Which frost date should the newsletter use?'],
  } });
  await sleep(3500);
  await tab(win, 'Handoffs');
  const card = win.locator('.pl-report.submitted').first();
  await card.waitFor();
  check('The report shows as reported complete, awaiting review (not accepted)', (await card.textContent()).includes('Says it is complete') && (await card.textContent()).includes('submitted'));
  check('The UI flags that the plan changed while the work ran', (await card.textContent()).includes('already changed'));
  await card.scrollIntoViewIfNeeded();
  await win.screenshot({ path: path.join(shots, '144-planner-report-review.png') });
  await card.getByRole('button', { name: 'Accept as done' }).click();
  await win.getByText(/Review what changed|changed after this work/).first().waitFor({ timeout: 5000 });
  check('Accepting an outdated report is refused until acknowledged', (await card.textContent()).includes('changed'));
  await card.getByRole('checkbox').check();
  await card.getByRole('button', { name: 'Accept as done' }).click();
  await win.locator('.pl-report.accepted').first().waitFor();
  check('After acknowledging, the report is accepted', true);

  await tab(win, 'Plan');
  check('A question the executor raised is only a suggestion until accepted', (await win.locator('.pl-proposal').count()) === 1 && (await win.locator('.pl-proposal').textContent()).includes('Which frost date'));
  await win.getByRole('button', { name: 'Accept selected' }).click();
  await win.locator('.pl-item', { hasText: 'Which frost date' }).waitFor();
  await win.screenshot({ path: path.join(shots, '145-planner-suggestions-accepted.png') });

  // ---- finish another task through copy and paste only
  await tab(win, 'Handoffs');
  const second = win.locator('.pl-section', { hasText: 'Prepare a handoff' }).locator('label.pl-check').first();
  const secondTitle = (await second.textContent())?.trim() ?? '';
  await second.locator('input').check();
  await win.getByRole('button', { name: 'Create execution package' }).click();
  await win.locator('.pl-package', { hasText: 'Package 2' }).waitFor();
  await win.locator('.pl-package', { hasText: 'Package 2' }).getByRole('button', { name: 'Show / copy' }).click();
  const md2 = await win.locator('.pl-package', { hasText: 'Package 2' }).locator('.pl-raw').textContent();
  const task2 = /task_[a-z0-9]+/.exec(md2.slice(md2.indexOf('## Tasks')))[0];
  const pkg2 = /pkg_[a-z0-9]+/.exec(md2)[0];
  const pasted = `Executor: ChatGPT\nPackage: ${pkg2}\nTask: ${task2}\n\n## Outcome\nDone\n\n## Work performed\nWrote the two-paragraph draft.\n\n## Verification\n- spell check ran and looked fine\n- facts match sources: passed\n`;
  await win.getByLabel('Pasted report').fill(pasted);
  await win.getByRole('button', { name: 'Preview what it says' }).click();
  await win.locator('.pl-preview').waitFor();
  check('A pasted Markdown report is previewed first and its guesses are shown', (await win.locator('.pl-preview').textContent()).includes('no clear result'));
  check('Nothing was applied by previewing', (await win.locator('.pl-report').count()) >= 1 && (await win.locator('.pl-report.submitted').count()) === 0);
  await win.screenshot({ path: path.join(shots, '146-planner-paste-preview.png') });
  await win.getByRole('button', { name: 'Apply as a report' }).click();
  await win.locator('.pl-report.submitted', { hasText: 'two-paragraph draft' }).waitFor();
  check('After applying, the pasted report waits for review and keeps the original text', (await win.locator('.pl-report.submitted').textContent()).includes('Show the original response'));
  await win.locator('.pl-report.submitted').getByRole('button', { name: 'Show the original response' }).click();
  check('The original response is kept verbatim', (await win.locator('.pl-report.submitted .pl-raw').textContent()).includes('Executor: ChatGPT'));
  await win.locator('.pl-report.submitted').getByRole('button', { name: 'Ask for changes' }).click();
  await win.locator('.pl-report.revision_requested').waitFor();
  check('Asking for changes sends the task back (not accepted)', true);
  await win.getByRole('button', { name: 'Show / copy' }).first().waitFor();
  await tab(win, 'Overview');
  await win.locator('.pl-log li').first().waitFor({ timeout: 5000 }).catch(() => {});
  await win.screenshot({ path: path.join(shots, '147-planner-overview.png') });
  await tab(win, 'Handoffs');
  await win.getByText('Connect an AI (optional)').scrollIntoViewIfNeeded();
  await win.locator('.pl-profile').first().locator('summary').click();
  const conn = await win.locator('.pl-profile').first().textContent();
  check('Connection details are shown and need no secret', conn.includes('claude mcp add') && conn.includes('read, propose'));
  const table = await win.locator('.pl-table').textContent();
  check('Client status is honest (verified / untested / unavailable)', /verified/.test(table) && /untested/.test(table) && /unavailable/.test(table));
  await win.screenshot({ path: path.join(shots, '148-planner-connect.png') });
  await tab(win, 'History');
  await win.locator('.pl-log li', { hasText: 'Claude Code' }).first().waitFor({ timeout: 5000 }).catch(() => {});
  await win.screenshot({ path: path.join(shots, '149-planner-history.png') });
  check('History lists who did what', (await win.locator('.pl-log').allTextContents()).join('').includes('Claude Code'));

  // ---- restart: the same plan comes back
  executor.close();
  await app.close();
  ({ app, win } = await launch());
  await openPlanner(win);
  await win.locator('.pl-head h2', { hasText: 'Garden club newsletter' }).waitFor({ timeout: 10000 });
  await tab(win, 'Tasks');
  check('The plan survives a restart with its statuses', (await win.locator('.pl-task').count()) >= taskCount && (await win.locator('.pl-task', { hasText: firstTitle }).first().textContent()).includes('Accepted'));
  check('The revised task stays revision-requested', (await win.locator('.pl-task', { hasText: secondTitle }).first().textContent()).includes('Revision requested'));
} catch (e) {
  fails++;
  console.log('FAIL  smoke crashed -', e instanceof Error ? e.message.split('\n')[0] : String(e));
  await win.screenshot({ path: path.join(shots, 'planner-smoke-failure.png') }).catch(() => {});
} finally {
  executor?.close();
  await app.close().catch(() => {});
}
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);

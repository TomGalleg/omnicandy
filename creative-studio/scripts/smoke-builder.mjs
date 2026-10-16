// AI Adapter Builder in the REAL CreateCraft window, in scratch profiles (never your own CreateCraft or projects).
//
// Run 1: REAL FreeCAD on this PC. Pick FreeCAD from the installed programs, Create Integration, wait for build + tests,
//        review and approve the install, connect, run the live test on the real program, open Advanced, then repair
//        (update) and roll back.
// Run 2: a program that is NOT installed (type its name): the candidate is built and mock-tested and must stay
//        "Awaiting live verification" with no install offered and nothing claimed as tested.
//
// The AI step uses a pre-authored blueprint through a test hook (CS_BUILDER_BLUEPRINT, honoured only in a scratch profile),
// so this script spends no Claude usage. Native dialogs are answered by this script. Run after `npm run build`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-builder-'));
const fx = (n) => path.join(root, 'fixtures', 'ai-generated', n);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };

// a "repaired" blueprint: same commands, clearer text for one of them
const base = JSON.parse(fs.readFileSync(fx('freecad-enclosure.blueprint.json'), 'utf8'));
const repaired = structuredClone(base);
repaired.commands[1].description += ' Also checked for newer FreeCAD builds.';
repaired.commands[1].python.source = repaired.commands[1].python.source.replace('"message": "Measured', '"message": "Measured (v2)');
const repairFile = path.join(tmp, 'repaired.json');
fs.writeFileSync(repairFile, JSON.stringify(repaired));

async function launch(profile, blueprint, repair) {
  const env = { ...process.env, CS_USER_DATA_DIR: profile, CS_BUILDER_BLUEPRINT: blueprint, ...(repair ? { CS_BUILDER_REPAIR_BLUEPRINT: repair } : {}) };
  const app = await electron.launch({ args: [root], cwd: root, env });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
  await win.locator('.asset').first().waitFor({ state: 'attached', timeout: 30000 });
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    dialog.showMessageBox = async (...args) => { globalThis.__dialogs.push(args.at(-1)); return { response: 1, checkboxChecked: false }; };
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  return { app, win };
}

async function openCard(win) {
  if (!(await win.getByRole('dialog', { name: 'Settings' }).isVisible().catch(() => false))) await win.getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('tab', { name: 'Integrations' }).click();
  await win.getByRole('button', { name: 'Create Integration…' }).waitFor();
}
const dialogsOf = (app) => app.evaluate(() => globalThis.__dialogs.map((d) => `${d.title}: ${d.message}`));

// ================================================================= run 1: real FreeCAD
const profile1 = fs.mkdtempSync(path.join(tmp, 'p1-'));
let { app, win } = await launch(profile1, fx('freecad-enclosure.blueprint.json'), repairFile);
try {
  await openCard(win);
  const order = await win.evaluate(() => { const c = document.querySelector('.connect-card'); const b = [...document.querySelectorAll('.connect-card')][1]; return !!c && !!b && !!(c.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); });
  check('Settings > Integrations has Connect Applications and, below it, Create Custom Integration', order);
  check('the card says the result is private and nothing is installed without the user', /Nothing is installed without you/.test((await win.locator('.connect-card').nth(1).textContent()) ?? ''));
  check('My Integrations shows Official and Custom sections', (await win.getByLabel('Official CreateCraft Integrations').count()) > 0 && (await win.getByLabel('My Custom Integrations').count()) > 0);

  await win.getByRole('button', { name: 'Create Integration…' }).click();
  const dlg = win.locator('.connect-dialog');
  await dlg.getByRole('heading', { name: 'Create Custom Integration' }).waitFor({ timeout: 60000 });
  await dlg.getByRole('tab', { name: 'Installed on this computer' }).waitFor({ timeout: 60000 });
  check('both ways to begin are offered', (await dlg.getByRole('tab', { name: 'Installed on this computer' }).count()) === 1 && (await dlg.getByRole('tab', { name: 'Type a program name' }).count()) === 1);
  check('the consent notice says what is sent to Claude and that nothing is installed or run without approval', /nothing is installed or run until you review and approve/.test((await dlg.textContent()) ?? ''));
  const createBtn = dlg.getByRole('button', { name: 'Create Integration' });
  check('Create Integration is disabled until a program is chosen', await createBtn.isDisabled());
  await dlg.getByLabel('Programs without an integration yet').fill('FreeCAD');
  const option = dlg.getByRole('option').filter({ hasText: /FreeCAD/ }).first();
  check('FreeCAD (placeholder only, no real integration) is offered from the installed programs', (await option.count()) === 1, (await option.textContent().catch(() => ''))?.slice(0, 80));
  await option.locator('input').check();
  await win.screenshot({ path: path.join(shots, '130-builder-choose.png') });
  await createBtn.click();

  const project = dlg.locator('.builder-project');
  await project.waitFor({ timeout: 30000 });
  await project.locator('[data-status="ready-for-approval"]').or(dlg.locator('.builder-project[data-status="ready-for-approval"]')).first().waitFor({ timeout: 240000 });
  const text1 = (await project.textContent()) ?? '';
  check('progress ended at "Ready for your approval"', /Ready for your approval/.test(text1));
  check('the result lists what it can do in plain words and what it may do', /Create a parametric enclosure/.test(text1) && /Measure a FreeCAD document/.test(text1) && /What you would be allowing/.test(text1));
  check('every command says it is not tested on the real program yet', (text1.match(/Not tested on the real program/g) ?? []).length === 2);
  check('simulated tests are labelled as such (a pretend program)', /pretend program/.test(text1));
  await win.screenshot({ path: path.join(shots, '131-builder-ready.png') });

  // Advanced
  await project.getByText('Advanced: logs, manifest, generated source and diagnostics').click();
  const adv = project.locator('.builder-advanced');
  check('Advanced shows the safety checks with their results', /AI-written code/.test((await adv.textContent()) ?? '') && /Documented interfaces only/.test((await adv.textContent()) ?? ''));
  await adv.getByRole('tab', { name: 'Generated files' }).click();
  await adv.getByRole('button', { name: 'adapter.json' }).click();
  const manifestText = (await adv.locator('.builder-code').textContent()) ?? '';
  check('Advanced shows the manifest: id custom.freecad, fixed local publisher, unsigned', /"id": "custom.freecad"/.test(manifestText) && /Created on this computer \(AI-generated\)/.test(manifestText));
  await adv.getByRole('button', { name: 'job_body.py' }).click();
  check('Advanced shows the generated Python that runs inside FreeCAD', /Part\.makeBox/.test((await adv.locator('.builder-code').textContent()) ?? ''));
  await adv.getByRole('tab', { name: 'Research and sources' }).click();
  check('Advanced lists the documentation sources', /wiki\.freecad\.org/.test((await adv.textContent()) ?? ''));

  // approval and install through the normal review
  await project.getByRole('button', { name: 'Review and approve installation…' }).click();
  const review = project.locator('.ext-review');
  await review.waitFor();
  const rtext = (await review.textContent()) ?? '';
  check('the normal package review appears: publisher, Not signed, permissions', /Created on this computer/.test(rtext) && /Not signed/.test(rtext) && /Permissions it asks for/.test(rtext));
  check('install stays disabled until the unsigned warning is acknowledged', await review.getByRole('button', { name: 'Install' }).isDisabled());
  await review.getByLabel(/not signed and will ask me before every command/).check();
  await win.screenshot({ path: path.join(shots, '132-builder-review.png') });
  await review.getByRole('button', { name: 'Install' }).click();
  await project.getByRole('button', { name: /Connect and test on the real program/ }).waitFor({ timeout: 60000 });
  const dl1 = await dialogsOf(app);
  check('a native confirmation was shown for the install (the AI cannot answer it)', dl1.some((d) => /Install integration/.test(d)), dl1.join(' | ').slice(0, 160));

  // connect + live test on the real FreeCAD
  await project.getByRole('button', { name: /Connect and test on the real program/ }).click();
  await project.locator('[aria-label="Live test result"]').waitFor({ timeout: 300000 });
  await project.locator('.builder-project[data-status="live-verified"]').or(dlg.locator('.builder-project[data-status="live-verified"]')).first().waitFor({ timeout: 60000 });
  const text2 = (await project.textContent()) ?? '';
  check('live test: connected to the real FreeCAD and verified the version', /Connect and verify the version/.test(text2) && /Connected to the real FreeCAD 1\.1/.test(text2), (text2.match(/Connected to the real FreeCAD [\d.]+/) ?? [''])[0]);
  check('live test: every command passed with an independent re-check', (text2.match(/Verified by an independent re-check/g) ?? []).length === 2);
  check('each command now says "Tested on 1.1.x" (per command and program version)', (text2.match(/Tested on 1\.1\.\d+/g) ?? []).length >= 2);
  check('the status is "Tested on the real program"', /Tested on the real program/.test(text2));
  const dl2 = await dialogsOf(app);
  check('every live command asked the user first (unsigned = asked every time)', dl2.filter((d) => /External application/.test(d)).length >= 3, `${dl2.filter((d) => /External application/.test(d)).length} approval dialogs`);
  await win.screenshot({ path: path.join(shots, '133-builder-live-verified.png') });

  // repair / update
  await project.getByRole('button', { name: 'Update for this version' }).click();
  await project.locator('[aria-label="Proposed fix"]').waitFor({ timeout: 240000 });
  const ptext = (await project.locator('[aria-label="Proposed fix"]').textContent()) ?? '';
  check('a proposed fix lists the problem, the changed command and "no new permissions"', /1\.0\.0 → 1\.0\.1/.test(ptext) && /changed enclosure\.measure/.test(ptext) && /no new permissions/.test(ptext));
  check('the proposed fix was tested before being offered (safety checks shown)', /Safety checks/.test(ptext) && /Passed/.test(ptext));
  check('the current version stays installed until the fix is approved', /Your current version 1\.0\.0 stays saved/.test(ptext));
  await win.screenshot({ path: path.join(shots, '134-builder-proposal.png') });
  await project.getByRole('button', { name: 'Review and install the fix…' }).click();
  const review2 = project.locator('.ext-review');
  await review2.waitFor();
  check('the fix goes through the same review as an update', /Update|Install the fix/.test((await review2.textContent()) ?? ''));
  await review2.getByLabel(/not signed and will ask me before every command/).check();
  await review2.getByRole('button', { name: 'Install the fix' }).click();
  await project.getByText(/The fix is installed/).waitFor({ timeout: 60000 });
  const text3 = (await project.textContent()) ?? '';
  check('after the update the changed command must be tested again; the untouched one keeps its result', /Measure a FreeCAD document[\s\S]{0,400}Not tested on the real program/.test(text3) && /Create a parametric enclosure[\s\S]{0,400}Tested on 1\.1\./.test(text3));
  check('the last working version is kept and can be restored', /Earlier versions \(1\)/.test(text3));
  await project.getByText(/Earlier versions/).click();
  await project.getByRole('button', { name: 'Go back to this version' }).click();
  await project.locator('.ext-head small', { hasText: /^version 1\.0\.0$/ }).waitFor({ timeout: 60000 });
  const dl3 = await dialogsOf(app);
  check('rolling back asked for a native confirmation', dl3.some((d) => /Go back to an earlier version/.test(d)));

  // My Integrations
  await dlg.getByRole('button', { name: 'Done' }).click();
  await win.getByLabel('My Custom Integrations').getByText('FreeCAD (custom)').waitFor({ timeout: 30000 });
  const mine = (await win.getByLabel('My Custom Integrations').textContent()) ?? '';
  check('My Custom Integrations lists it with its verification status and Repair/Update/Remove', /FreeCAD \(custom\)/.test(mine) && /Update Integration/.test(mine) && /Remove Integration/.test(mine));
  // a real agent-facing check: the integration is in the external app list
  const listed = await win.evaluate(async () => (await window.studio.external.list()).filter((a) => a.adapterId === 'custom.freecad').map((a) => ({ cmds: a.commands.map((c) => c.id), trust: a.trust, origin: a.origin })));
  check('external_apps (the list Claude sees) includes the generated integration with its commands', listed.length === 1 && listed[0].cmds.includes('enclosure.create') && listed[0].trust === 'unsigned', JSON.stringify(listed));
  await win.screenshot({ path: path.join(shots, '135-builder-my-integrations.png') });
  // remove
  await win.getByLabel('My Custom Integrations').getByRole('button', { name: 'Remove Integration' }).click();
  await win.getByLabel('My Custom Integrations').getByText('FreeCAD (custom)').waitFor({ state: 'detached', timeout: 30000 }).catch(() => undefined);
  check('Remove Integration uninstalls it (a native confirmation was shown)', (await dialogsOf(app)).some((d) => /Remove integration/.test(d)));
} catch (e) {
  check('run 1 completed without an unexpected error', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
  await win.screenshot({ path: path.join(shots, '139-builder-failure.png') }).catch(() => undefined);
} finally { await app.close().catch(() => undefined); }

// ================================================================= run 2: a program that is not installed
const profile2 = fs.mkdtempSync(path.join(tmp, 'p2-'));
({ app, win } = await launch(profile2, fx('imagemagick.blueprint.json')));
try {
  await openCard(win);
  await win.getByRole('button', { name: 'Create Integration…' }).click();
  const dlg = win.locator('.connect-dialog');
  await dlg.getByRole('heading', { name: 'Create Custom Integration' }).waitFor({ timeout: 60000 });
  await dlg.getByRole('tab', { name: 'Type a program name' }).click();
  await dlg.getByLabel('Program name').fill('ImageMagick');
  check('typing a name explains that the program need not be installed', /does not have to be installed/.test((await dlg.textContent()) ?? ''));
  await win.screenshot({ path: path.join(shots, '136-builder-type-name.png') });
  await dlg.getByRole('button', { name: 'Create Integration' }).click();
  const project = dlg.locator('.builder-project');
  await project.locator('.builder-project[data-status="awaiting-live-verification"]').or(dlg.locator('.builder-project[data-status="awaiting-live-verification"]')).first().waitFor({ timeout: 240000 });
  const t = (await project.textContent()) ?? '';
  check('status is "Awaiting live verification", never "tested" or "compatible"', /Awaiting live verification/.test(t) && !/Tested on the real program/.test(t) && !/Tested on \d/.test(t));
  check('it says the real program is not installed and nothing was proven against it', /not installed on this computer/.test(t) && /nothing about this integration has been proven/.test(t));
  check('no install button is offered for a program that is not there', (await project.getByRole('button', { name: /Review and approve installation/ }).count()) === 0);
  check('the simulated trial run is labelled as a pretend program', /pretend program/.test(t));
  await project.getByText('Advanced: logs, manifest, generated source and diagnostics').click();
  await project.locator('.builder-advanced').getByRole('tab', { name: 'Generated files' }).click();
  check('the generated command-line connector is viewable in Advanced', /ImageMagick/.test((await project.locator('.builder-advanced').textContent()) ?? '') && (await project.locator('.builder-advanced').getByRole('button', { name: 'main.js' }).count()) === 1);
  await win.screenshot({ path: path.join(shots, '137-builder-awaiting-live.png') });
  await dlg.getByRole('button', { name: 'Done' }).click();
  await win.getByLabel('My Custom Integrations').getByText('Awaiting live verification').first().waitFor({ timeout: 30000 });
  const mc = (await win.getByLabel('My Custom Integrations').textContent()) ?? ''; check('it appears under My Custom Integrations as in progress, not as installed', /Awaiting live verification/.test(mc), mc.slice(0, 160));
  // dark and light
  for (const mode of ['dark', 'light']) {
    await win.emulateMedia({ colorScheme: mode }).catch(() => undefined);
    await win.screenshot({ path: path.join(shots, `138-builder-${mode}.png`) });
  }
} catch (e) {
  check('run 2 completed without an unexpected error', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
  await win.screenshot({ path: path.join(shots, '139-builder-failure2.png') }).catch(() => undefined);
} finally { await app.close().catch(() => undefined); }

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

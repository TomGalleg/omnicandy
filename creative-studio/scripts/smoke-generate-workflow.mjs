// Workflow AI Generate step through the real generation path, offline: the free Mock model writes a
// test pattern as a project asset with provenance; a paid model is refused before any dialog or
// network call when it would pass the project's spending limit; the limit and ledger are readable.
// No key is used and nothing is charged. Run after `npm run build`: node scripts/smoke-generate-workflow.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-genwf-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
await app.evaluate(({ dialog }) => {
  globalThis.__dialogs = 0;
  dialog.showMessageBox = async () => { globalThis.__dialogs++; return { response: 0, checkboxChecked: false }; };
});
try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  const before = await win.evaluate(() => window.studio.loadProject());
  const graph = (providerId, modelId) => ({
    schemaVersion: 1,
    nodes: [
      { id: 'gen', type: 'aiGenerate', position: { x: 0, y: 0 }, params: { providerId, modelId, prompt: 'A red kite over a hill', count: '2', settings: '{}' } },
      { id: 'ok', type: 'approval', position: { x: 300, y: 0 }, params: { note: 'Look' } },
    ],
    edges: [{ id: 'e', source: 'gen', sourceHandle: 'image', target: 'ok', targetHandle: 'in' }],
  });
  await win.evaluate(() => { window.__ev = []; window.studio.onWorkflowEvent((e) => window.__ev.push(e)); });
  const run = (g) => win.evaluate((x) => window.studio.runWorkflow(x), g);

  // Free mock model: real asset, approval asked about the generated files.
  const p = run(graph('mock', 'mock-image'));
  await new Promise((r) => setTimeout(r, 4000));
  const req = await win.evaluate(() => window.__ev.find((e) => e.kind === 'approval-request'));
  check('the generated images reach the approval step', req?.items?.length === 2, JSON.stringify(req?.items?.map((i) => i.name)));
  await win.evaluate((id) => window.studio.answerApproval(id, true), req.nodeId);
  const r1 = await p;
  check('mock generation step completed', r1.ok === true);
  const after = await win.evaluate(() => window.studio.loadProject());
  const added = after.assets.filter((a) => !before.assets.some((b) => b.id === a.id));
  check('two new project assets with provenance', added.length === 2 && added.every((a) => a.provenance.provider === 'mock' && a.provenance.prompt === 'A red kite over a hill'), `${added.length}`);

  // Spending limit: a paid model over the limit is refused before any dialog or network call.
  await win.evaluate(() => window.studio.generate.setSpendingLimit(0.001));
  await win.evaluate(() => { window.__ev.length = 0; });
  const r2 = await run(graph('openai', 'gpt-image-2.5-flare'));
  check('paid step over the limit fails', r2.ok === false);
  const msg = await win.evaluate(() => window.__ev.filter((e) => e.kind === 'item-status' || (e.kind === 'node-status' && e.status === 'failed')).map((e) => e.message).join(' | '));
  check('the reason names the spending limit', /spending limit|Add your OpenAI/i.test(msg), msg.slice(0, 200));
  check('no approval dialog was shown and nothing was charged', (await app.evaluate(() => globalThis.__dialogs)) === 0);
  const sp = await win.evaluate(() => window.studio.generate.spending());
  check('limit and ledger are readable', sp.limitUsd === 0.001 && sp.spentUsd === 0, JSON.stringify(sp));
} catch (e) {
  check('generate workflow smoke', false, String(e).slice(0, 400));
} finally {
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} generate-workflow checks passed`);
process.exit(failed ? 1 : 0);

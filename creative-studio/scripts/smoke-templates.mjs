// Templates smoke (offline, no Claude call, no paid call). Run after `npm run build`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-templates-'));
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); if (!ok) process.exitCode = 1; };

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
win.on('dialog', (d) => void d.accept());
try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await win.locator('.project-name').click();
  await win.getByRole('button', { name: /^Templates/ }).click();
  const items = win.locator('.template-item');
  await items.first().waitFor();
  check('Templates panel lists the nine built-in templates', (await items.count()) === 9, String(await items.count()));
  const text = await win.locator('.template-list').textContent();
  check('each is labelled honestly (ready / paid / partly manual)', /Ready: local apps only/.test(text) && /Uses paid AI \(asks first\)/.test(text) && /Partly manual/.test(text));
  await win.screenshot({ path: path.join(shots, '97-templates-home.png') });

  await items.filter({ hasText: 'Image enhancement' }).getByRole('button', { name: 'Start a project with this' }).click();
  await win.locator('.project-name', { hasText: 'Image enhancement' }).waitFor({ timeout: 15000 });
  const g = await win.evaluate(() => window.studio.loadWorkflow());
  check('project created with a real workflow (6 steps, approval, export)', g.nodes.length === 6 && g.nodes.some((n) => n.type === 'approval') && g.nodes.some((n) => n.type === 'export'), String(g.nodes.length));
  check('no file chosen and nothing generated or paid', g.nodes.every((n) => n.type !== 'import' || n.params.assetIds === '[]') && g.nodes.every((n) => n.type !== 'aiGenerate'));
  check('opens the Workflow tab', (await win.locator('.workflow, .wf-canvas, .react-flow').count()) > 0);
  await win.screenshot({ path: path.join(shots, '98-template-applied.png') });

  const v = await win.evaluate(async () => (await window.studio.listWorkflowTemplates()).find((t) => t.id === 'builtin-ai-image-variations'));
  check('AI variations template has an AI step, is labelled paid, and is not started', v?.status === 'paid' && v.graph.nodes.some((n) => n.type === 'aiGenerate'));
} finally {
  await app.close();
}

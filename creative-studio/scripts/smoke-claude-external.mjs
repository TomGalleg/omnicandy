// OPT-IN (uses Claude usage). Real Claude drives real Blender through external_apps / external_run from the
// Claude panel, in a scratch profile. The native approval dialog is answered by the test ("Allow once").
// Pass criteria are on disk, not in Claude's words: the .blend exists in the project's external folder and a
// separate Blender run lists a cube, camera and light in it. Run after `npm run build`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-claude-external-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };
const BLENDER = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Blender Foundation', 'Blender 4.0', 'blender.exe');

function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } }

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, CS_USER_DATA_DIR: profile } });
const win = await app.firstWindow();
try {
  await win.locator('.asset').first().waitFor({ timeout: 20000 });
  await app.evaluate(({ dialog }) => {
    globalThis.__approvals = [];
    dialog.showMessageBox = async (...args) => { globalThis.__approvals.push(args.at(-1)); return { response: 1, checkboxChecked: false }; };
  });
  await win.locator('.side-tab.right').click();
  await win.locator('#claude-input').fill('Use Blender to create a basic room scene: a cube, a camera and a light. Save it as claude-room.blend. Tell me exactly what was verified.');
  await win.getByRole('button', { name: 'Send' }).click();
  await win.locator('.claude .chip', { hasText: 'Ready' }).waitFor({ timeout: 300000 });
  const s = await win.evaluate(() => window.studio.claude.state());
  const said = s.items.filter((i) => i.role !== 'user').map((i) => `${i.role}: ${i.text}`).join(' | ');
  const approvals = await app.evaluate(() => globalThis.__approvals);
  check('the user was asked before Blender ran', approvals.some((a) => /in Blender\?/.test(a.message ?? '') && /basic 3D scene/i.test(a.message ?? '')), JSON.stringify(approvals.map((a) => a.message)));
  const blend = [...walk(profile)].find((p) => /claude-room\.blend$/.test(p));
  check('the .blend file exists in the project external folder', !!blend && fs.statSync(blend).size > 1000, blend ?? 'not found');
  if (blend && fs.existsSync(BLENDER)) {
    const py = path.join(profile, 'check.py');
    fs.writeFileSync(py, "import bpy\nfrom collections import Counter\nprint('CHECK ' + str(dict(Counter(o.type for o in bpy.data.objects))))\n");
    const out = execFileSync(BLENDER, ['--background', '--factory-startup', blend, '--python', py], { encoding: 'utf8' });
    check('an independent Blender run finds a mesh, camera and light in it', /CHECK .*MESH.*/.test(out) && /CAMERA/.test(out) && /LIGHT/.test(out), /CHECK .*/.exec(out)?.[0] ?? out.slice(-200));
  }
  check('Claude reported success only with evidence', /verified|re-opened|exists/i.test(said) && !/could not|failed|unable/i.test(said), said.slice(-400));
  console.log(`Claude usage for this run: $${s.costUsd.toFixed(3)}`);
} catch (e) {
  check('claude external smoke', false, String(e).slice(0, 500));
} finally {
  await app.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} Claude external checks passed`);
process.exit(failed ? 1 : 0);

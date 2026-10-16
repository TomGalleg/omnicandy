// REAL Autodesk Revit 2027. Runs only with CS_LIVE_REVIT=1. It installs the CreateCraft add-in into the REAL per-user Revit
// 2027 add-in folder, waits for you (or the caller) to start Revit and open/save a SCRATCH model, then drives it through the
// real bridge. It never edits a model whose name does not contain "scratch" (the add-in refuses anyway).
//
//   CS_LIVE_REVIT=1 npx vitest run src/main/integrations/revit.live.test.ts
//
// Stages: install -> (Revit starts, add-in loads) -> connect/verify -> read commands -> safety refusals -> reversible edit
// -> CreateCraft restart recovery -> Revit closes -> repair -> uninstall. State lives in .local/revit-live.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApprovalRequest, Permission } from '@shared/integrations';
import { packAdapter } from '../../../scripts/pack-adapter.mjs';
import { AdapterPackages, createIntegrationManager } from './index';

const on = process.env.CS_LIVE_REVIT === '1';
const ROOT = path.resolve(__dirname, '../../..');
const STATE = path.join(ROOT, '.local', 'revit-live');
const PLUGIN_ID = 'autodesk.revit.bridge';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => { console.log('[revit-live]', ...a); void fs.appendFile(path.join(STATE, 'results.log'), a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + String.fromCharCode(10)).catch(() => undefined); };
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms: number, every = 1000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(every);
  }
}
const sha = async (f: string) => createHash('sha256').update(await fs.readFile(f)).digest('hex');
const addinsDir = path.join(process.env.APPDATA ?? '', 'Autodesk', 'Revit', 'Addins', '2027');

describe.skipIf(!on)('CreateCraft add-in against REAL Revit 2027', { timeout: 40 * 60_000 }, () => {
  it('runs the whole lifecycle', async () => {
    await fs.mkdir(STATE, { recursive: true });
    const asked: ApprovalRequest[] = [];
    let granted: Record<string, Permission[]> = {};
    const make = () => {
      const m = createIntegrationManager({
        workDir: async (id) => path.join(STATE, 'work', id),
        permissions: { load: async () => granted, save: async (g) => { granted = g; } },
        approve: async (r) => { asked.push(r); return 'once'; },
      });
      return { m, pk: new AdapterPackages(path.join(STATE, 'integrations'), m) };
    };
    let { m, pk } = make();
    await pk.load(); await pk.bridge.start(); // as the app does at start-up
    const file = path.join(STATE, 'revit.ccadapter');
    await fs.writeFile(file, packAdapter({ dir: path.join(ROOT, 'fixtures', 'revit-adapter') }).bytes);

    // Other add-ins on this PC must come out of this test byte-for-byte as they went in.
    const neighbours = (await fs.readdir(addinsDir)).filter((n) => n.toLowerCase().endsWith('.addin') && n !== 'CreateCraft.addin');
    const before = new Map<string, string>();
    for (const n of neighbours) before.set(n, await sha(path.join(addinsDir, n)));
    log('neighbouring add-ins', [...before.keys()]);

    if (process.env.CS_LIVE_PHASE !== 'repair') {
    // ---- 1. review + install (Revit must be closed) ----
    if (process.env.CS_LIVE_SKIP_INSTALL !== '1') {
    const rev = await pk.review(file);
    log('review', JSON.stringify({ problems: rev.problems, steps: rev.integration?.steps.map((s) => s.kind), dest: rev.integration?.destinations, blockers: rev.integration?.blockers }));
    expect(rev.problems).toEqual([]);
    expect(rev.integration!.destinations[0]!.path.toLowerCase()).toBe(addinsDir.toLowerCase());
    await pk.install(file, { permissions: rev.permissions, allowUnsigned: true, installPlugin: true });
    expect((await fs.readdir(addinsDir)).filter((n) => /createcraft|cc-bridge/i.test(n)).sort()).toEqual(['CreateCraft', 'CreateCraft.addin', 'cc-bridge.json']);
    log('INSTALLED. Start Revit 2027 now, open a scratch model.');
    }
    await fs.writeFile(path.join(STATE, 'installed.flag'), new Date().toISOString());

    // ---- 2. Revit starts and the add-in dials in ----
    const session = await pk.bridge.waitForSession(PLUGIN_ID, 15 * 60_000);
    expect(session, 'Revit did not load the add-in').toBeTruthy();
    log('SESSION', JSON.stringify({ app: session!.appName, version: session!.appVersion, caps: session!.capabilities, refused: session!.refused }));
    expect(session!.appName).toBe('Revit');
    expect(session!.appVersion).toBe('2027');
    expect(session!.refused).toEqual([]);
    expect(session!.capabilities.sort()).toEqual(['revit.app_info', 'revit.element.get', 'revit.element.place_test', 'revit.element.remove_test', 'revit.elements.count', 'revit.levels.list', 'revit.lighting.list', 'revit.parameter.set', 'revit.project_info', 'revit.views.list'].sort());

    // ---- 3. connect + verify through a real round trip ----
    const scan = await m.scan();
    const app = scan.apps.find((a) => a.adapterId === 'autodesk.revit')!;
    expect(app, JSON.stringify(scan.apps.map((a) => a.adapterId))).toBeTruthy();
    const key = app.key;
    const info = await m.connect(key);
    log('connect', info.status, info.version);
    expect(['connected', 'limited']).toContain(info.status);
    const v = await m.verify(key);
    log('verify', JSON.stringify(v));
    expect(v.ok).toBe(true);
    expect(v.detail).toMatch(/answered a real check from inside the program/);

    // ---- 4. read commands: real model data ----
    const ai = await m.execute(key, 'revit.app_info');
    log('app_info', JSON.stringify(ai));
    expect(ai.ok).toBe(true);
    expect((ai.data as { version: string }).version).toBe('2027');

    // Wait until a scratch model is open (the caller opens and saves it).
    const pi = await waitFor('a scratch project to be open in Revit', async () => {
      const r = await m.execute(key, 'revit.project_info');
      const d = r.data as { open?: boolean; editable?: boolean } | undefined;
      return r.ok && d?.open && d?.editable ? r : null;
    }, 10 * 60_000, 2000);
    const proj = pi.data as { title: string; documentKey: string; isWorkshared: boolean };
    log('project_info', JSON.stringify(pi.data));
    expect(proj.title.toLowerCase()).toContain('scratch');
    const lv = await m.execute(key, 'revit.levels.list');
    log('levels', JSON.stringify(lv.data));
    expect(lv.ok).toBe(true);
    expect((lv.data as { count: number }).count).toBeGreaterThan(0);
    const vw = await m.execute(key, 'revit.views.list');
    log('views', vw.message);
    expect(vw.ok).toBe(true);
    const cnt = await m.execute(key, 'revit.elements.count', { category: 'Lighting Fixtures' });
    log('count', JSON.stringify(cnt.data));
    expect(cnt.ok).toBe(true);
    const all = await m.execute(key, 'revit.elements.count');
    expect(all.ok).toBe(true);
    const badCat = await m.execute(key, 'revit.elements.count', { category: 'Spaceships' });
    expect(badCat.ok).toBe(false);
    const lights = await m.execute(key, 'revit.lighting.list', { limit: 50 });
    log('lighting', lights.message, JSON.stringify((lights.data as { availableTypes?: unknown[] }).availableTypes?.slice(0, 5)));
    expect(lights.ok).toBe(true);
    expect((lights.data as { count: number }).count).toBe((cnt.data as { counts: Record<string, number> }).counts['Lighting Fixtures']);

    // ---- 5. safety refusals (nothing is changed) ----
    const wrongKey = await m.execute(key, 'revit.parameter.set', { documentKey: '0000000000000000', elementId: 1, parameter: 'Comments', value: 'x' });
    expect(wrongKey.ok).toBe(false);
    expect(wrongKey.message).toMatch(/not the (project|one)|Nothing was changed/);
    const badParam = await m.execute(key, 'revit.parameter.set', { documentKey: proj.documentKey, elementId: 1, parameter: 'Width', value: 'x' });
    expect(badParam.ok).toBe(false);
    expect(badParam.message).toMatch(/not an approved writable parameter/);
    const askedBefore = asked.length;

    // ---- 6. a reversible edit in the scratch model ----
    const types = (lights.data as { availableTypes: Array<{ family: string; type: string; placement: string }> }).availableTypes;
    const test = await waitFor('a loaded level-based lighting fixture type in the scratch model', async () => {
      const r = await m.execute(key, 'revit.lighting.list', { limit: 5 });
      return (r.data as { availableTypes: Array<{ family: string; type: string; placement: string }> }).availableTypes.find((t) => t.placement === 'OneLevelBased') ?? null;
    }, 10 * 60_000, 2000);
    log('test type', JSON.stringify(test), types.length);
    const level = ((lv.data as { levels: Array<{ name: string }> }).levels)[0]!.name;
    const placed = await m.execute(key, 'revit.element.place_test', { documentKey: proj.documentKey, familyName: test.family, typeName: test.type, levelName: level, xMm: 1500, yMm: 2500 });
    log('place_test', JSON.stringify(placed));
    expect(placed.ok, placed.message).toBe(true);
    expect(placed.verified).toBe(true);
    expect(asked.length).toBeGreaterThan(askedBefore); // the user was asked first
    expect(asked[asked.length - 1]!.destructive).toBe(true);
    const id = (placed.data as { elementId: number }).elementId;
    const after = await m.execute(key, 'revit.lighting.list', { limit: 50 });
    expect((after.data as { count: number }).count).toBe((lights.data as { count: number }).count + 1);
    const set = await m.execute(key, 'revit.parameter.set', { documentKey: proj.documentKey, elementId: id, parameter: 'Comments', value: 'CreateCraft live test' });
    log('parameter.set', JSON.stringify(set));
    expect(set.ok, set.message).toBe(true);
    expect((set.data as { before: string }).before).toBe('CreateCraft test placement');
    // restore the marker through the same command, then remove the placement: the model is back to how it was
    const restore = await m.execute(key, 'revit.parameter.set', { documentKey: proj.documentKey, elementId: id, parameter: 'Comments', value: 'CreateCraft test placement' });
    expect(restore.ok, restore.message).toBe(true);
    const removed = await m.execute(key, 'revit.element.remove_test', { documentKey: proj.documentKey, elementId: id });
    log('remove_test', JSON.stringify(removed));
    expect(removed.ok, removed.message).toBe(true);
    const end = await m.execute(key, 'revit.lighting.list', { limit: 50 });
    expect((end.data as { count: number }).count).toBe((lights.data as { count: number }).count);
    // an element CreateCraft did not place is never removed
    const lvId = (lv.data as { levels: Array<{ id: number }> }).levels[0]!.id;
    const refuse = await m.execute(key, 'revit.element.remove_test', { documentKey: proj.documentKey, elementId: lvId });
    expect(refuse.ok).toBe(false);
    await fs.writeFile(path.join(STATE, 'edit-done.flag'), 'ok');
    log('EDIT CYCLE DONE');

    // ---- 7. CreateCraft restarts: the add-in reconnects by itself ----
    await m.shutdown(); await pk.shutdown();
    ({ m, pk } = make());
    await pk.load(); await pk.bridge.start();
    const again = await pk.bridge.waitForSession(PLUGIN_ID, 60_000);
    expect(again, 'add-in did not reconnect after CreateCraft restarted').toBeTruthy();
    const scan2 = await m.scan();
    const key2 = scan2.apps.find((a) => a.adapterId === 'autodesk.revit')!.key;
    await m.connect(key2);
    const lv2 = await m.execute(key2, 'revit.levels.list');
    expect(lv2.ok).toBe(true);
    log('RECONNECTED after CreateCraft restart');
    await fs.writeFile(path.join(STATE, 'reconnect-done.flag'), 'ok');

    // ---- 8. Revit closes: the integration must stop claiming to be connected ----
    await waitFor('Revit to close', async () => !pk.bridge.session(PLUGIN_ID), 10 * 60_000, 1000);
    const gone = await m.execute(key2, 'revit.levels.list');
    expect(gone.ok).toBe(false);
    log('after close:', gone.message);
    expect((await m.verify(key2)).ok).toBe(false);

    }

    // ---- 9. repair then uninstall ----
    await waitFor('Revit to release the add-in file', async () => { await fs.rm(path.join(addinsDir, 'CreateCraft', 'CreateCraft.Revit.dll')); return true; }, 60_000, 2000);
    await pk.load();
    const rep = (await pk.listing()).installed.find((a) => a.id === 'autodesk.revit')!;
    log('state after deleting dll', rep.pluginState);
    await pk.repair('autodesk.revit');
    expect(await fs.stat(path.join(addinsDir, 'CreateCraft', 'CreateCraft.Revit.dll'))).toBeTruthy();
    await pk.uninstall('autodesk.revit');
    expect((await fs.readdir(addinsDir)).filter((n) => /^createcraft|cc-bridge/i.test(n))).toEqual([]);
    for (const [n, h] of before) expect(await sha(path.join(addinsDir, n)), n).toBe(h);
    await m.shutdown(); await pk.shutdown();
    log('UNINSTALLED; neighbours unchanged');
  });
});

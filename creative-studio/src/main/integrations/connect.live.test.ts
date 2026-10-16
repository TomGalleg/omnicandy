// Universal Connect against REAL programs on this PC. Runs only with CS_LIVE_TESTS=1; a program that is not installed makes
// its test skip (reported as skipped, never as passed). Real discovery, the real signed FreeCAD connector shipped in
// resources/adapters, real Blender and FreeCAD processes, real Resolve detection. The "user" (trust + install confirmation)
// is played by the test, in a throw-away profile: nothing outside a temp folder is changed.
//
//   CS_LIVE_TESTS=1 npx vitest run src/main/integrations/connect.live.test.ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectEntry, ConnectOverview } from '@shared/connect';
import { runSetup, type AdapterDecision } from '@shared/connectFlow';
import { ConnectService } from './connect';
import { AdapterPackages, createIntegrationManager } from './index';
import { ExternalState } from './state';

const on = process.env.CS_LIVE_TESTS === '1';
const root = path.resolve(import.meta.dirname, '..', '..', '..');

describe.skipIf(!on)('Universal Connect with real programs', { timeout: 300_000 }, () => {
  let tmp: string;
  let svc: ConnectService;
  let pk: AdapterPackages;
  let mgr: ReturnType<typeof createIntegrationManager>;
  let first: ConnectOverview;
  const entry = (o: ConnectOverview, id: string, stubId = id): ConnectEntry | undefined =>
    o.entries.find((e) => e.adapterId === id || e.offer?.adapterId === id || e.adapterId === stubId);

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-connect-live-'));
    const state = new ExternalState(path.join(tmp, 'secrets', 'external-apps.json'));
    mgr = createIntegrationManager({
      workDir: async (id) => path.join(tmp, 'work', id),
      permissions: { load: async () => (await state.read()).grants, save: async (g) => { await state.update((s) => { s.grants = g; }); } },
      approve: async () => 'once',
      userPaths: async () => (await state.read()).paths,
      extraTargets: () => svc.extraTargets(),
      remembered: { load: async () => (await state.read()).remembered, save: async (r) => { await state.update((s) => { s.remembered = r; }); } },
    });
    pk = new AdapterPackages(path.join(tmp, 'integrations'), mgr);
    svc = new ConnectService({ manager: mgr, packages: pk, state, catalogDirs: [path.join(root, 'resources', 'adapters')] });
    first = await svc.overview();
    console.log('OVERVIEW', JSON.stringify(first.entries.map((e) => ({ name: e.name, version: e.version, group: e.group, adapterState: e.adapterState, experimental: e.experimental, status: e.status, exe: e.exePath })), null, 1), 'not detected:', first.notDetected.map((n) => `${n.name}(${n.adapterState})`).join(', '));
  });
  afterAll(async () => { await mgr.shutdown(); await fs.rm(tmp, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 }); });

  it('first scan classifies what is really installed, and a never-installed FreeCAD is only offered, not installed or trusted', async (t) => {
    expect(first.firstRun).toBe(true);
    const fc = entry(first, 'freecad');
    if (!fc) return t.skip();
    expect(fc.group).toBe('needs-adapter');
    expect(fc.offer?.source).toBe('bundled');
    expect(fc.offer?.signature).toBe('valid');
    expect((await pk.listing()).installed).toHaveLength(0);
    expect((await pk.listing()).trustedPublishers).toHaveLength(0);
  });

  it('Resolve (experimental) is recognised as experimental and not claimed connected', async (t) => {
    const r = entry(first, 'davinci.resolve');
    if (!r) return t.skip();
    expect(r.experimental).toBe(true);
    expect(r.adapterState).toBe('installed');
    expect(r.status).not.toBe('connected');
  });

  it('sets up Blender, FreeCAD (installs its connector) and Resolve together with independent, real outcomes', async (t) => {
    const blender = entry(first, 'blender');
    const fc = entry(first, 'freecad');
    const resolve = entry(first, 'davinci.resolve');
    const chosen = [blender, fc, resolve].filter((e): e is ConnectEntry => !!e && e.selectable);
    if (!chosen.length) return t.skip();
    const installs: string[] = [];
    const runs = await runSetup(chosen, {
      askAdapter: async (e): Promise<AdapterDecision> => ({ approval: { permissions: e.offer!.permissions, trustPublisher: true } }),
      installAdapter: async (e, approval) => { installs.push(e.offer!.adapterId); await pk.install(e.offer!.path!, approval); },
      refresh: async () => (await svc.overview({ rescan: false })).entries,
      connect: (k) => svc.connectAndVerify(k),
      onUpdate: () => undefined,
      isCancelled: () => false,
    });
    console.log('RUNS', JSON.stringify(runs.map((r) => ({ name: r.name, outcome: r.outcome, headline: r.headline, evidence: r.evidence, technical: r.technical.slice(0, 200) })), null, 1));
    const by = (n: RegExp) => runs.find((r) => n.test(r.name));
    if (blender) expect(by(/blender/i)!.outcome).toBe('verified');
    if (fc) {
      expect(installs).toEqual(['freecad']);
      expect(by(/freecad/i)!.adapter).toBe('done');
      expect(['verified', 'verified-limited']).toContain(by(/freecad/i)!.outcome); // package connectors are experimental by design
    }
    if (resolve) {
      // Resolve may be closed (blocked) or open without scripting (blocked) or fully working (verified-limited): never plain "verified".
      expect(['blocked', 'failed', 'verified-limited']).toContain(by(/resolve/i)!.outcome);
    }
    // Whatever Resolve did, it did not change the others.
    const list = await mgr.list();
    if (blender) expect(list.find((a) => a.adapterId === 'blender')!.status).toBe('connected');
    if (fc) expect(list.find((a) => a.adapterId === 'freecad')!.status).toBe('limited');
  });

  it('after the install the placeholder row is gone and the list shows FreeCAD with its real version', async (t) => {
    const o = await svc.overview({ rescan: false });
    const rows = o.entries.filter((e) => /freecad/i.test(e.name) || e.adapterId === 'freecad');
    if (!rows.length) return t.skip();
    expect(rows.every((e) => e.adapterState === 'installed')).toBe(true);
    expect(rows.some((e) => /^\d+\.\d+/.test(e.version ?? ''))).toBe(true);
  });

  it('Browse to the real FreeCAD folder (as for a portable copy) is recognised; a stranger is refused', async (t) => {
    const fc = (await svc.overview({ rescan: false })).entries.find((e) => e.adapterId === 'freecad');
    if (!fc) return t.skip();
    const folder = path.dirname(path.dirname(fc.exePath)); // e.g. E:\FreeCAD 1.1
    const res = await svc.browse(folder);
    expect(['added', 'already-known']).toContain(res.kind);
    const notepad = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe');
    expect((await svc.browse(notepad)).kind).toBe('no-match');
  });

  it('Forget removes the saved location and permissions without touching the real program', async (t) => {
    const fc = (await svc.overview({ rescan: false })).entries.find((e) => e.adapterId === 'freecad');
    if (!fc) return t.skip();
    const res = await svc.forget(fc.key);
    console.log('FORGET', JSON.stringify(res));
    await expect(fs.stat(fc.exePath)).resolves.toBeTruthy();
    const st = await new ExternalState(path.join(tmp, 'secrets', 'external-apps.json')).read();
    expect(st.grants[fc.key]).toBeUndefined();
    const again = (await svc.overview({ rescan: false })).entries.some((e) => e.key === fc.key);
    // Honest either way: gone when only a saved path knew it, still listed when Windows still lists it.
    expect(again).toBe(res.stillDetected);
  });
});

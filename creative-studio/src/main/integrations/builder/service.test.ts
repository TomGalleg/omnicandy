// BuilderService end to end with a scripted author and a MOCK program. These tests prove the workflow and the bookkeeping
// (statuses, per-command per-version verification, repair proposals, rollback). They never prove anything about real software.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission } from '@shared/integrations';
import { AdapterPackages, createIntegrationManager, type IntegrationManager } from '../index';
import type { DiscoveryEnv } from '../discovery';
import { ScriptedAuthor } from './author';
import { parseBlueprint, type Blueprint } from './blueprint';
import { listInstalledPrograms } from './inventory';
import { createMockProgram, mockLauncher } from './mockHost';
import { findPython } from './pyguard';
import { BuilderService } from './service';

const fx = (n: string) => path.resolve(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'ai-generated', n);
const load = (n: string): Blueprint => parseBlueprint(JSON.parse(fs.readFileSync(fx(n), 'utf8')));
const canRun = process.platform === 'win32';

let tmp: string;
beforeAll(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-bsvc-')); });
afterAll(async () => { await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }); });

const noDiscovery = (): DiscoveryEnv => ({ env: { PATH: '' }, run: async () => '', exists: (p) => fsp.stat(p).then(() => true, () => false), listDir: async () => [] });

async function rig(name: string, opts: { exe?: { folder: string; name: string; scenario: Parameters<typeof createMockProgram>[2] } } = {}) {
  const root = path.join(tmp, name);
  const paths: string[] = [];
  const mgr: IntegrationManager = createIntegrationManager({
    workDir: async (id) => path.join(root, 'work', id),
    permissions: { load: async () => ({}), save: async () => undefined },
    approve: async () => 'once',
    discovery: noDiscovery(),
    userPaths: async () => paths,
  });
  const pk = new AdapterPackages(path.join(root, 'integrations'), mgr);
  await pk.load();
  if (opts.exe) paths.push(await createMockProgram(path.join(root, opts.exe.folder), opts.exe.name, opts.exe.scenario));
  await mgr.scan();
  const confirms: string[] = [];
  const mk = (author: ScriptedAuthor | { error: string }) => new BuilderService({
    root: path.join(root, 'builder'), packages: pk, manager: mgr, author: () => author, claude: () => ({ ready: true, reason: '' }),
    confirm: async (t) => { confirms.push(t); return true; }, programs: async () => [],
  });
  return { root, mgr, pk, mk, confirms };
}

const freecadScenario = async () => {
  const py = await findPython();
  return { label: 'SIMULATED FreeCAD', versionArgs: ['--version'], versionLine: 'FreeCAD 1.50.0 (SIMULATED)', mode: 'python-mock' as const, python: py ?? '', modules: ['FreeCAD', 'App', 'Part', 'Mesh', 'MeshPart', 'Import', 'Spreadsheet', 'Draft', 'Sketcher', 'PartDesign'] };
};

describe.skipIf(!canRun)('BuilderService (scripted author, mock program)', () => {
  it('not-installed program: builds, tests with mocks and is saved as Awaiting live verification', async () => {
    const r = await rig('uninstalled');
    const svc = r.mk(new ScriptedAuthor({ blueprint: load('imagemagick.blueprint.json') }));
    const created = await svc.create({ appName: 'ImageMagick' });
    expect(created.status).toBe('researching');
    const done = await svc.settled(created.id);
    const d = await svc.detail(created.id);
    expect(d.reports.flatMap((x) => x.checks.filter((c) => c.state === 'failed'))).toEqual([]);
    expect(done.status).toBe('awaiting-live-verification');
    expect(done.appInstalled).toBe(false);
    expect(done.verification.verified).toBe(0);
    expect(done.packagePath && fs.existsSync(done.packagePath)).toBe(true);
    expect(d.reports.find((x) => x.stage === 'simulated')?.mock).toBe(true);
    expect(d.nextSteps.join(' ')).toMatch(/not installed/);
    expect(d.commands.map((c) => c.id)).toEqual(['image.identify', 'image.resize']);
    expect(d.commands[0]!.readOnly).toBe(true);
    expect(d.commands[1]!.readOnly).toBe(false);
    // no live verification may exist without a real run
    expect(d.commands.every((c) => c.verifications.length === 0)).toBe(true);
    expect(d.files.map((f) => f.path)).toContain('main.js');
    expect(d.compatibility.tested).toEqual([]);
    expect(d.log.length).toBeGreaterThan(3);
  }, 180_000);

  it('stops honestly when the research is insufficient, not feasible, or a check fails', async () => {
    const r = await rig('stops');
    const base = load('freecad-enclosure.blueprint.json');
    const insufficient = { ...base.research, insufficient: 'Only marketing pages exist.', sourcesConsulted: false };
    const a = r.mk(new ScriptedAuthor({ research: insufficient, blueprint: base }));
    const s1 = await (async () => { const c = await a.create({ appName: 'Mystery' }); return a.settled(c.id); })();
    expect(s1.status).toBe('needs-documentation');
    expect(s1.packagePath).toBeNull();
    const nf = { ...base, decision: { ...base.decision, feasible: false, notFeasibleReason: 'Only UI automation is possible, which CreateCraft will not use.' }, commands: [] };
    const b = r.mk(new ScriptedAuthor({ blueprint: nf }));
    const s2 = await (async () => { const c = await b.create({ appName: 'Closed App' }); return b.settled(c.id); })();
    expect(s2.status).toBe('not-feasible');
    expect((await b.detail(s2.id)).nextSteps.join(' ')).toMatch(/UI automation/);
    const evil = structuredClone(base);
    evil.commands[0]!.python!.source = evil.commands[0]!.python!.source.replace('import Part', 'import Part\nimport subprocess');
    const c = r.mk(new ScriptedAuthor({ blueprint: evil }));
    const s3 = await (async () => { const x = await c.create({ appName: 'FreeCAD' }); return c.settled(x.id); })();
    expect(s3.status).toBe('failed');
    expect(s3.packagePath).toBeNull();
    expect((await c.detail(s3.id)).reports.some((x) => x.state === 'failed')).toBe(true);
  }, 180_000);

  it('signed-out Claude is reported plainly and nothing is built', async () => {
    const r = await rig('signedout');
    const svc = r.mk({ error: 'Claude Code on this PC is not signed in.' });
    const c = await svc.create({ appName: 'Anything' });
    const s = await svc.settled(c.id);
    expect(s.status).toBe('failed');
    expect(s.error).toMatch(/not signed in/);
  });

  it('installed program: approval, install, live verification per command and version, repair proposal, update, rollback', async () => {
    if (!(await mockLauncher()) || !(await findPython())) return;
    const r = await rig('installed', { exe: { folder: 'Mock FreeCAD (SIMULATED)/bin', name: 'FreeCADCmd.exe', scenario: await freecadScenario() } });
    const base = load('freecad-enclosure.blueprint.json');
    const repaired = structuredClone(base);
    repaired.commands[1]!.python!.source = repaired.commands[1]!.python!.source.replace('"message": "Measured', '"message": "Measured (repaired)');
    repaired.commands[1]!.description = `${repaired.commands[1]!.description} Also works with newer FreeCAD builds.`;
    const svc = r.mk(new ScriptedAuthor({ blueprint: base, repair: () => ({ blueprint: repaired, changes: ['Made the measure message clearer.'] }) }));
    const c = await svc.create({ appName: 'FreeCAD', exePath: (await r.mgr.list())[0]?.exePath });
    const s = await svc.settled(c.id);
    expect(s.appInstalled).toBe(true);
    expect(s.status).toBe('ready-for-approval');
    expect(s.adapterId).toBe('custom.freecad');

    // approval and install go through the normal package path; the AI cannot do this itself
    const review = await r.pk.review(s.packagePath!);
    expect(review.signature).toBe('unsigned');
    expect(review.publisherName).toBe('Created on this computer (AI-generated)');
    expect(review.warnings.join(' ')).toMatch(/not signed/);
    await r.pk.install(s.packagePath!, { permissions: review.permissions as Permission[], allowUnsigned: true });
    const synced = await svc.syncInstalled(c.id);
    expect(synced.status).toBe('installed');
    expect(synced.verification.verified).toBe(0);

    // live verification writes records per command AND per program version
    const rep = await svc.verifyLive(c.id);
    expect(rep.checks.filter((x) => x.state === 'failed')).toEqual([]);
    const d1 = await svc.detail(c.id);
    expect(d1.status).toBe('live-verified');
    const create = d1.commands.find((x) => x.id === 'enclosure.create')!;
    expect(create.verifications).toHaveLength(1);
    expect(create.verifications[0]).toMatchObject({ state: 'verified', appVersion: '1.50.0' });
    expect(d1.compatibility.tested).toEqual(['1.50.0']);
    expect(await svc.compatibility(c.id)).toMatchObject({ needsCheck: false });

    // repair: AI proposes, CreateCraft tests, nothing changes until approved
    const p = await svc.propose(c.id, { commandId: 'enclosure.measure', error: 'FreeCAD 1.2 renamed something' });
    expect(p.passed).toBe(true);
    expect(p.fromVersion).toBe('1.0.0');
    expect(p.toVersion).toBe('1.0.1');
    expect(p.changes.changed).toEqual(['enclosure.measure']);
    expect(p.changes.newPermissions).toEqual([]);
    expect((await r.pk.listing()).installed[0]!.version).toBe('1.0.0');
    const rv = await r.pk.review(p.packagePath!);
    expect(rv.action).toBe('update');
    await r.pk.install(p.packagePath!, { permissions: rv.permissions as Permission[], allowUnsigned: true });
    const after = await svc.syncInstalled(c.id);
    expect(after.version).toBe('1.0.1');
    const d2 = await svc.detail(c.id);
    expect(d2.versions.map((v) => v.version)).toEqual(['1.0.0', '1.0.1']);
    expect(d2.commands.find((x) => x.id === 'enclosure.measure')!.verifications).toHaveLength(0); // changed code must be tested again
    expect(d2.commands.find((x) => x.id === 'enclosure.create')!.verifications).toHaveLength(1); // untouched code keeps its record
    expect(fs.existsSync(svc.store.packagePath(c.id, '1.0.0'))).toBe(true); // last working package preserved

    // rollback to the saved original
    const rb = await svc.rollback(c.id, '1.0.0');
    expect(rb.version).toBe('1.0.0');
    expect((await r.pk.listing()).installed[0]!.version).toBe('1.0.0');
    expect(r.confirms.length).toBe(1);

    // My Integrations
    const mine = await svc.mine();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ origin: 'custom', adapterId: 'custom.freecad', enabled: true });
    await svc.removeIntegration(c.id);
    expect((await r.pk.listing()).installed).toHaveLength(0);
    expect((await svc.detail(c.id)).versions.length).toBe(2); // saved versions stay
  }, 300_000);
});

describe('installed-program inventory', () => {
  it('lists programs without an integration and hides system noise', async () => {
    const reg = (rows: Array<Record<string, string>>) => rows.map((v, i) => `HKEY_LOCAL_MACHINE\\SOFTWARE\\X\\${i}\n${Object.entries(v).map(([k, x]) => `    ${k}    REG_SZ    ${x}`).join('\n')}\n`).join('\n');
    const env: DiscoveryEnv = {
      env: {}, exists: async () => true, listDir: async () => [],
      run: async (f, a) => (f === 'reg' && /HKLM\\SOFTWARE\\Microsoft/.test(a[1] ?? '') && !/WOW6432Node/.test(a[1] ?? '') ? reg([
        { DisplayName: 'Adobe Photoshop 2026', Publisher: 'Adobe', DisplayVersion: '27.0', DisplayIcon: 'C:\\Program Files\\Adobe\\Photoshop.exe,0' },
        { DisplayName: 'Microsoft Visual C++ 2015-2022 Redistributable', DisplayVersion: '14' },
        { DisplayName: 'FreeCAD 1.1', Publisher: 'FreeCAD', DisplayIcon: 'E:\\FreeCAD 1.1\\bin\\FreeCAD.exe' },
        { DisplayName: 'Hidden Helper', SystemComponent: '0x1' },
      ]) : ''),
    };
    const list = await listInstalledPrograms({ covered: (n) => /^FreeCAD/.test(n) }, env);
    expect(list.map((p) => p.name)).toEqual(['Adobe Photoshop 2026']);
    expect(list[0]).toMatchObject({ publisher: 'Adobe', version: '27.0', exePath: 'C:\\Program Files\\Adobe\\Photoshop.exe' });
  });
});

// REAL FreeCAD proof of concept for the AI Adapter Builder. Opt-in: CS_LIVE_TESTS=1 (CS_FREECAD_BIN = folder with FreeCADCmd.exe).
//
// The blueprint (fixtures/ai-generated/freecad-enclosure.blueprint.json) was authored by Claude with new, narrowly scoped
// commands (a parametric enclosure) that the existing FreeCAD adapter does not have. It goes through the whole builder:
// validation, security checks, mock-simulated tests, the normal package review and install (unsigned, so every command asks),
// connection to the REAL FreeCADCmd, live execution of the generated Python inside FreeCAD, and an OUTSIDE check: a separate
// FreeCADCmd process (not the adapter's) re-opens the produced file and measures it again.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalRequest, Permission } from '@shared/integrations';
import { AdapterPackages, createIntegrationManager } from '../index';
import type { DiscoveryEnv } from '../discovery';
import { ScriptedAuthor } from './author';
import { parseBlueprint } from './blueprint';
import { BuilderService } from './service';

const live = process.env.CS_LIVE_TESTS === '1';
const BIN = process.env.CS_FREECAD_BIN ?? 'E:\\FreeCAD 1.1\\bin';
const EXE = path.join(BIN, 'FreeCADCmd.exe');
const present = live && fs.existsSync(EXE);
const fixture = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'ai-generated', 'freecad-enclosure.blueprint.json');

let tmp: string;
const closers: Array<() => Promise<unknown>> = [];
beforeAll(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-bfc-')); });
afterAll(async () => { for (const c of closers) await c().catch(() => undefined); await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); }, 60_000);

const discovery = (): DiscoveryEnv => ({ env: { PATH: '' }, run: async () => '', exists: (p) => fsp.stat(p).then(() => true, () => false), listDir: async () => [] });

/** A separate FreeCADCmd run that opens a produced file and prints what it measures. Not the adapter's code. */
async function outsideMeasure(file: string): Promise<{ solids: number; valid: boolean; volume: number; x: number; y: number; z: number }> {
  const dir = await fsp.mkdtemp(path.join(tmp, 'outside-'));
  const py = [
    'import FreeCAD, json, sys',
    `doc = FreeCAD.openDocument(${JSON.stringify(file.replace(/\\/g, '/'))})`,
    'shapes = [o.Shape for o in doc.Objects if hasattr(o, "Shape")]',
    's = shapes[0]',
    'bb = s.BoundBox',
    'sys.stdout.write("OUTSIDE " + json.dumps({"solids": len(s.Solids), "valid": bool(s.isValid()), "volume": s.Volume, "x": bb.XLength, "y": bb.YLength, "z": bb.ZLength}) + "\\n")',
    'sys.stdout.flush()',
    'import os; os._exit(0)',
  ].join('\n');
  await fsp.writeFile(path.join(dir, 'outside.py'), py);
  const out = await new Promise<string>((res, rej) => execFile(EXE, ['outside.py'], { cwd: dir, timeout: 120_000, windowsHide: true }, (e, so) => (e ? rej(e) : res(String(so)))));
  const m = /OUTSIDE (\{.*\})/.exec(out);
  if (!m) throw new Error(`no outside result: ${out.slice(-300)}`);
  return JSON.parse(m[1]!);
}

describe.skipIf(!present)('AI Adapter Builder against REAL FreeCAD', () => {
  it('builds, installs, runs and independently verifies a generated FreeCAD integration', async () => {
    const root = path.join(tmp, 'rig');
    const asked: ApprovalRequest[] = [];
    const mgr = createIntegrationManager({
      workDir: async (id) => path.join(root, 'work', id),
      permissions: { load: async () => ({}), save: async () => undefined },
      approve: async (r) => { asked.push(r); return 'once'; },
      discovery: discovery(),
      userPaths: async () => [EXE],
    });
    const pk = new AdapterPackages(path.join(root, 'integrations'), mgr);
    closers.push(() => mgr.shutdown(), () => pk.shutdown());
    await pk.load();
    const scan = await mgr.scan();
    const real = scan.apps.find((a) => a.exePath.toLowerCase() === EXE.toLowerCase())!;
    expect(real).toBeTruthy();
    const svc = new BuilderService({
      root: path.join(root, 'builder'), packages: pk, manager: mgr, claude: () => ({ ready: true, reason: '' }), confirm: async () => true, programs: async () => [],
      author: () => new ScriptedAuthor({ blueprint: parseBlueprint(JSON.parse(fs.readFileSync(fixture, 'utf8'))), note: 'blueprint authored by Claude in a development session (fixtures/ai-generated)' }),
    });

    // 1. create (research accepted as given, code checked, mock-tested)
    const created = await svc.create({ appName: 'FreeCAD', exePath: EXE });
    const built = await svc.settled(created.id);
    const d0 = await svc.detail(created.id);
    expect(d0.reports.flatMap((r) => r.checks.filter((c) => c.state === 'failed'))).toEqual([]);
    expect(built.status).toBe('ready-for-approval'); // the real program was found
    expect(built.appInstalled).toBe(true);

    // 2. the user's approval step: the normal review, then install (unsigned)
    const review = await pk.review(built.packagePath!);
    expect(review.problems).toEqual([]);
    expect(review.permissions.sort()).toEqual(['execute-scripts', 'read-info', 'read-project', 'write-files']);
    await pk.install(built.packagePath!, { permissions: review.permissions as Permission[], allowUnsigned: true });
    expect((await svc.syncInstalled(created.id)).status).toBe('installed');

    // 3. live verification through the manager (the same engine external_apps / external_run use)
    const appsNow = (await mgr.scan()).apps;
    const app = appsNow.find((a) => a.adapterId === 'custom.freecad')!;
    expect(app.exePath.toLowerCase()).toBe(EXE.toLowerCase());
    expect(app.origin).toBe('package');
    expect(app.trust).toBe('unsigned');
    expect(app.commands.map((c) => c.id)).toEqual(['app.health', 'enclosure.create', 'enclosure.measure']);
    const outside: string[] = [];
    const report = await svc.verifyLive(created.id, {
      independent: async (cid, r) => {
        if (cid !== 'enclosure.create') return ['(read-only command: nothing to re-open)'];
        const f = r.outputs[0]!.path;
        const m = await outsideMeasure(f);
        expect(m.solids).toBe(1);
        expect(m.valid).toBe(true);
        expect(Math.abs(m.volume - (60 * 40 * 30 - 56 * 36 * 28))).toBeLessThan(1e-3);
        expect([m.x, m.y, m.z].map((v) => Math.round(v))).toEqual([60, 40, 30]);
        outside.push(`${path.basename(f)}: 1 valid solid, volume ${m.volume.toFixed(3)} mm3, ${m.x} x ${m.y} x ${m.z}`);
        return [outside.at(-1)!];
      },
    });
    expect(report.checks.filter((c) => c.state === 'failed')).toEqual([]);
    const d1 = await svc.detail(created.id);
    expect(d1.status).toBe('live-verified');
    for (const id of ['app.health', 'enclosure.create', 'enclosure.measure']) {
      const v = (await svc.store.verifications(created.id)).find((x) => x.commandId === id)!;
      expect(v.state).toBe('verified');
      expect(v.appVersion).toBe(real.version ?? '1.1.4');
    }
    expect(d1.compatibility.tested[0]).toMatch(/^1\.1\./);
    expect(asked.length).toBe(3);
    expect(asked.every((a) => a.untrusted)).toBe(true);

    // 4. run the generated command directly once more: the file can be re-opened and re-measured, errors are honest, nothing is overwritten
    const make = await mgr.execute(app.key, 'enclosure.create', { name: 'Sensor Box', width: 80, depth: 50, height: 35, wall: 2.5 });
    expect(make.ok).toBe(true);
    expect(make.verified).toBe(true);
    expect(make.evidence.join(' | ')).toMatch(/independent check: .*volume .* equals the formula/);
    const m = await outsideMeasure(make.outputs[0]!.path);
    expect(m.volume).toBeCloseTo(80 * 50 * 35 - 75 * 45 * 32.5, 3);
    const again = await mgr.execute(app.key, 'enclosure.create', { name: 'Sensor Box', width: 80, depth: 50, height: 35, wall: 2.5 });
    expect(again.ok).toBe(false);
    expect(again.error?.message).toMatch(/already exists/);
    const tooThick = await mgr.execute(app.key, 'enclosure.create', { name: 'Bad Box', width: 20, depth: 20, height: 20, wall: 12 });
    expect(tooThick.ok).toBe(false);
    expect(tooThick.error?.kind).toBe('invalid-params');
    const outOfRange = await mgr.execute(app.key, 'enclosure.create', { name: 'Huge', width: 5000, depth: 20, height: 20, wall: 2 });
    expect(outOfRange.error?.kind).toBe('invalid-params');
    const measured = await mgr.execute(app.key, 'enclosure.measure', { document: 'Sensor Box.FCStd' });
    expect(measured.ok).toBe(true);
    expect((measured.data as { solids: number }).solids).toBe(1);
    const escape = await mgr.execute(app.key, 'enclosure.measure', { document: '..\\..\\secret.FCStd' });
    expect(escape.ok).toBe(false);
  }, 600_000);
});

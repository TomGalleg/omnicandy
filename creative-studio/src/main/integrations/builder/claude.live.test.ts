// OPT-IN, USES YOUR CLAUDE SIGN-IN (counts against your Claude usage): the real in-app author. Claude researches FreeCAD with its
// web tools, writes a blueprint of its own, CreateCraft validates and mock-tests it, and (with CS_LIVE_TESTS=1 and FreeCAD
// installed) it is installed and verified on the real program.
//   CS_CLAUDE_TESTS=1 [CS_LIVE_TESTS=1] npx vitest run src/main/integrations/builder/claude.live.test.ts
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission } from '@shared/integrations';
import { AdapterPackages, createIntegrationManager } from '../index';
import type { DiscoveryEnv } from '../discovery';
import { ClaudeAuthor } from './author';
import { DocsStore } from './docsStore';
import { BuilderService } from './service';

const on = process.env.CS_CLAUDE_TESTS === '1';
const live = process.env.CS_LIVE_TESTS === '1';
const BIN = process.env.CS_FREECAD_BIN ?? 'E:\\FreeCAD 1.1\\bin';
const EXE = path.join(BIN, 'FreeCADCmd.exe');
let tmp: string;
/** Removes anything that looks like a credential before a log is kept. */
const redact = (t: string) => t.replace(/(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|eyJ[A-Za-z0-9._-]{20,}|[A-Fa-f0-9]{40,})/g, '[redacted]').replace(/(token|secret|password|api[_-]?key)(\W{0,3})[^\s,"]{6,}/gi, '$1$2[redacted]');
const LOG = path.join(os.tmpdir(), 'cc-claude-live-result.json');
const closers: Array<() => Promise<unknown>> = [];
beforeAll(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-claude-b-')); });
afterAll(async () => { for (const c of closers) await c().catch(() => undefined); await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); }, 60_000);

/** A separate FreeCADCmd run (not the adapter's code) that opens a produced file and reports what it measures. */
async function outsideMeasure(file: string): Promise<{ solids: number; valid: boolean; volume: number }> {
  const dir = await fsp.mkdtemp(path.join(tmp, 'outside-'));
  const py = ['import FreeCAD, json, sys', `doc = FreeCAD.openDocument(${JSON.stringify(file.split('\\').join('/'))})`, 'shapes = [o.Shape for o in doc.Objects if hasattr(o, "Shape") and not o.Shape.isNull()]', 's = shapes[0]', 'sys.stdout.write("OUTSIDE " + json.dumps({"solids": len(s.Solids), "valid": bool(s.isValid()), "volume": s.Volume}) + chr(10))', 'sys.stdout.flush()', 'import os; os._exit(0)'].join(String.fromCharCode(10));
  await fsp.writeFile(path.join(dir, 'outside.py'), py);
  const out = await new Promise<string>((res, rej) => execFile(EXE, ['outside.py'], { cwd: dir, timeout: 120_000, windowsHide: true }, (e, so) => (e ? rej(e) : res(String(so)))));
  const m = /OUTSIDE (\{.*\})/.exec(out);
  if (!m) throw new Error(`no outside result: ${out.slice(-300)}`);
  return JSON.parse(m[1]!);
}

describe.skipIf(!on)('the real in-app Claude author', () => {
  it('researches, designs and builds an integration; every claim is validated by CreateCraft', async () => {
    const root = path.join(tmp, 'rig');
    const discovery: DiscoveryEnv = { env: { PATH: '' }, run: async () => '', exists: (p) => fsp.stat(p).then(() => true, () => false), listDir: async () => [] };
    const haveFreecad = live && fs.existsSync(EXE);
    const mgr = createIntegrationManager({
      workDir: async (id) => path.join(root, 'work', id), permissions: { load: async () => ({}), save: async () => undefined }, approve: async () => 'once',
      discovery, userPaths: async () => (haveFreecad ? [EXE] : []),
    });
    const pk = new AdapterPackages(path.join(root, 'integrations'), mgr);
    closers.push(() => mgr.shutdown(), () => pk.shutdown());
    await pk.load();
    await mgr.scan();
    // Reuse the local documentation cache: seed the builder's store with the FreeCAD 1.1.4 snapshot collected earlier (commit 014cd9d)
    // so this run does not download anything again.
    const snap = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'ai-generated', 'docs', 'freecad-1.1.4');
    const seeded = (JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8')) as Array<Record<string, unknown> & { file: string }>).map(({ file, ...d }) => ({ ...d, text: fs.readFileSync(path.join(snap, file), 'utf8') })) as unknown as import('./docsStore').StoredDoc[];
    await new DocsStore(path.join(root, 'builder')).saveAll('freecad', '1.1.4', seeded);
    const svc = new BuilderService({
      docsFetcher: async () => { throw new Error('this run must use the cached documentation and not download'); },
      maxAttempts: 3, // explicit limit of this test: research + generation + at most two Claude corrections
      root: path.join(root, 'builder'), packages: pk, manager: mgr, confirm: async () => true, programs: async () => [], claude: () => ({ ready: true, reason: '' }),
      author: () => new ClaudeAuthor({ model: process.env.CS_CLAUDE_MODEL ?? 'claude-opus-5-5', cwd: path.join(os.tmpdir(), 'cc-claude-live-diag'), web: true }),
    });
    const c = await svc.create({ appName: 'FreeCAD', goal: 'create a parametric rectangular enclosure with configurable width, height, depth and wall thickness' });
    const s = await svc.settled(c.id);
    const d = await svc.detail(c.id);
    const stageReports = d.reports.map((r) => ({ stage: r.stage, state: r.state, mock: !!r.mock, notPassed: r.checks.filter((k) => k.state !== 'passed').map((k) => `${k.state} ${k.id}: ${k.detail}`) }));
    const bpNow = await svc.store.readBlueprint(c.id);
    const generated = bpNow ? { application: bpNow.application, decision: bpNow.decision, python: bpNow.python, commands: bpNow.commands.map((k) => ({ id: k.id, params: k.params, permissions: k.permissions, docRefs: k.docRefs.map((r) => r.symbol), source: k.python?.source, verifySource: k.python?.verifySource })) } : null;
    const dump = (extra: unknown = {}) => redact(JSON.stringify({
      status: s.status, error: s.error, headline: s.headline, log: d.log.map((l) => l.text),
      detection: { appInstalledByCreateCraftDetection: s.appInstalled, detectedVersion: s.appVersion },
      usage: d.usage, research: d.research && { sources: d.research.sources.map((x) => x.url), insufficient: d.research.insufficient },
      documentation: d.documentation.map((x) => ({ origin: x.origin, title: x.title, url: x.url, version: x.versionNote, outdated: x.outdated })),
      generatedBlueprint: generated, decision: d.decision, commands: d.commands.map((x) => ({ id: x.id, permissions: x.permissions, readOnly: x.readOnly })), stageReports, versions: d.versions.map((v) => v.version),
      provenance: { research: 'real Claude (web tools + structured output)', blueprint: 'real Claude, unmodified except logged formatting normalization', simulated: 'MOCK program', live: 'real FreeCAD via CreateCraft manager', outsideCheck: 'separate FreeCADCmd process' }, ...(extra as object),
    }, null, 2));
    fs.writeFileSync(LOG, dump()); // kept outside the scratch profile, secrets removed
    console.log(dump());
    expect(['ready-for-approval', 'awaiting-live-verification']).toContain(s.status);
    expect(d.research!.sources.length).toBeGreaterThan(0);
    if (!haveFreecad || s.status !== 'ready-for-approval') return;
    // The test stands in for the user's approval in a scratch profile (the real flow shows the review and a native confirmation).
    const review = await pk.review(s.packagePath!);
    await pk.install(s.packagePath!, { permissions: review.permissions as Permission[], allowUnsigned: true });
    await svc.syncInstalled(c.id);
    const outside: string[] = [];
    const rep = await svc.verifyLive(c.id, {
      independent: async (_cid, r) => {
        const f = r.outputs.find((o) => /\.FCStd$/i.test(o.path))?.path;
        if (!f) return ['(no file produced by this command)'];
        const m = await outsideMeasure(f);
        outside.push(`${path.basename(f)}: ${JSON.stringify(m)}`);
        if (!m.valid || m.solids < 1) throw new Error(`outside check: ${JSON.stringify(m)}`);
        return [outside.at(-1)!];
      },
    });
    const verif = await svc.store.verifications(c.id);
    fs.writeFileSync(LOG, dump({ live: rep.checks.map((k) => `${k.state}: ${k.title}: ${k.detail}`), verifications: verif.map((v) => ({ command: v.commandId, state: v.state, appVersion: v.appVersion, evidence: v.evidence })), outside }));
    console.log(fs.readFileSync(LOG, 'utf8').slice(-3000));
    expect(rep.state).not.toBe('failed');
  }, 1_800_000);
});

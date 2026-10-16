// OPT-IN, USES YOUR CLAUDE SIGN-IN (counts against your Claude usage): the real in-app author. Claude researches FreeCAD with its
// web tools, writes a blueprint of its own, CreateCraft validates and mock-tests it, and (with CS_LIVE_TESTS=1 and FreeCAD
// installed) it is installed and verified on the real program.
//   CS_CLAUDE_TESTS=1 [CS_LIVE_TESTS=1] npx vitest run src/main/integrations/builder/claude.live.test.ts
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission } from '@shared/integrations';
import { AdapterPackages, createIntegrationManager } from '../index';
import type { DiscoveryEnv } from '../discovery';
import { ClaudeAuthor } from './author';
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
    const svc = new BuilderService({
      root: path.join(root, 'builder'), packages: pk, manager: mgr, confirm: async () => true, programs: async () => [], claude: () => ({ ready: true, reason: '' }),
      author: () => new ClaudeAuthor({ model: process.env.CS_CLAUDE_MODEL ?? 'claude-opus-5-5', cwd: path.join(os.tmpdir(), 'cc-claude-live-diag'), web: true }),
    });
    const c = await svc.create({ appName: 'FreeCAD', exePath: haveFreecad ? EXE : null, goal: 'create a parametric rectangular enclosure with configurable width, height, depth and wall thickness' });
    const s = await svc.settled(c.id);
    const d = await svc.detail(c.id);
    const dump = JSON.stringify({ status: s.status, error: s.error, log: d.log.map((l) => l.text), headline: s.headline, usage: d.usage, research: d.research && { sources: d.research.sources.map((x) => x.url), insufficient: d.research.insufficient }, decision: d.decision, commands: d.commands.map((x) => x.id), failed: d.reports.flatMap((r) => r.checks.filter((k) => k.state === 'failed').map((k) => `${r.stage}/${k.id}: ${k.detail}`)), stage: d.stage, author: 'claude (real in-app author)' }, null, 2);
    fs.writeFileSync(LOG, redact(dump)); // kept outside the scratch profile, secrets removed
    console.log(redact(dump));
    expect(['ready-for-approval', 'awaiting-live-verification']).toContain(s.status);
    expect(d.research!.sources.length).toBeGreaterThan(0);
    if (!haveFreecad || s.status !== 'ready-for-approval') return;
    const review = await pk.review(s.packagePath!);
    await pk.install(s.packagePath!, { permissions: review.permissions as Permission[], allowUnsigned: true });
    await svc.syncInstalled(c.id);
    const rep = await svc.verifyLive(c.id);
    console.log(JSON.stringify(rep.checks.map((k) => `${k.state}: ${k.title}: ${k.detail}`), null, 2));
    expect(rep.state).not.toBe('failed');
  }, 1_800_000);
});

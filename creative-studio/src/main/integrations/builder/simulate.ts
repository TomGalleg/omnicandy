// Stage 3: simulated testing. Everything runs for real EXCEPT the target program, which is replaced by a clearly marked MOCK
// (mockHost.ts). The generated package is installed into a throw-away profile through the same AdapterPackages / manager /
// restricted-process path the real install uses, then driven: connection, every command with its example inputs, bad input,
// a crashing program, a timeout, a cancel, and finally uninstall. A pass here means "the flow works". It NEVER means the
// package works with the real program, and the report says so.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ApprovalRequest, Permission } from '@shared/integrations';
import type { CheckResult, PipelineReport } from '@shared/builder';
import { AdapterPackages, createIntegrationManager, type IntegrationManager } from '../index';
import type { DiscoveryEnv } from '../discovery';
import type { Blueprint } from './blueprint';
import { packAssembled, type Assembled } from './assemble';
import { TOKEN_RE } from './templates/cli';
import { createMockProgram, mockLauncher, type MockScenario } from './mockHost';
import { findPython } from './pyguard';
import { reportOf } from './validate';

const ok = (id: string, title: string, detail: string): CheckResult => ({ id, title, state: 'passed', detail });
const bad = (id: string, title: string, detail: string): CheckResult => ({ id, title, state: 'failed', detail });
const warn = (id: string, title: string, detail: string): CheckResult => ({ id, title, state: 'warning', detail });
const skip = (id: string, title: string, detail: string): CheckResult => ({ id, title, state: 'skipped', detail });

const MOCK_VERSION = '99.0.0';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function versionLine(bp: Blueprint, a: Assembled): string {
  if (bp.decision.template === 'python-script' && a.host) {
    if (a.host.id === 'freecad') return `FreeCAD ${MOCK_VERSION}, Libs: ${MOCK_VERSION}R0 (SIMULATED program, not FreeCAD)`;
    if (a.host.id === 'blender') return `Blender ${MOCK_VERSION} (SIMULATED program, not Blender)`;
  }
  if (bp.cli?.versionExample) return bp.cli.versionExample.replace(/\d+(\.\d+){1,2}/, MOCK_VERSION);
  return `${bp.application.name} ${MOCK_VERSION} (SIMULATED program)`;
}

/** A regular expression that matches a command line made from this argument list (settings become \S+). */
function lineMatcher(argv: string[]): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${argv.map((t) => esc(t).replace(/\\\{[A-Za-z_]\w*\\\}/g, '\\S+')).join(' ')}$`;
}

function scenarioFor(bp: Blueprint, a: Assembled): MockScenario {
  const base = { label: `SIMULATED ${bp.application.name}`, versionLine: versionLine(bp, a) };
  if (bp.decision.template === 'python-script' && a.host) {
    return { ...base, versionArgs: a.host.versionArgs, mode: 'python-mock', python: '', modules: a.host.hostModules };
  }
  const cases: NonNullable<MockScenario['cases']> = [];
  for (const c of bp.commands) {
    if (!c.cli) continue;
    const outTok = c.cli.argv.findIndex((t) => [...t.matchAll(TOKEN_RE)].some((m) => c.cli!.rules[m[1]!]?.kind === 'work-file-out'));
    cases.push({ match: lineMatcher(c.cli.argv), stdout: c.mock.stdout, stderr: c.mock.stderr, exitCode: c.mock.exitCode ?? 0, ...(outTok >= 0 ? { writeArgIndex: outTok } : {}) });
    if (c.cli.verify) cases.push({ match: lineMatcher(c.cli.verify.argv), stdout: c.mock.verifyStdout ?? c.mock.stdout ?? '', exitCode: 0 });
  }
  return { ...base, versionArgs: bp.cli?.versionArgs ?? ['--version'], mode: 'scripted', cases };
}

function fakeDiscovery(): DiscoveryEnv {
  return { env: { PATH: '' }, run: async () => '', exists: (p) => fs.stat(p).then(() => true, () => false), listDir: async () => [] };
}

interface Rig { mgr: IntegrationManager; pk: AdapterPackages; exe: string; dir: string; work: string; asked: ApprovalRequest[]; scenarioFile: string; scenario: MockScenario }

async function makeRig(base: string, name: string, bp: Blueprint, a: Assembled, bytes: Buffer, python: string | null, mutate?: (m: Record<string, unknown>) => void): Promise<Rig> {
  const root = path.join(base, name);
  const dir = path.join(root, `Mock ${bp.application.name} (SIMULATED)`, 'bin');
  const scenario = scenarioFor(bp, a);
  if (python) scenario.python = python;
  const exeName = (a.manifest.application as { exeNames: string[] }).exeNames[0]!;
  const exe = await createMockProgram(dir, exeName, scenario);
  const work = path.join(root, 'work');
  const asked: ApprovalRequest[] = [];
  const stored: Record<string, Permission[]> = {};
  const mgr = createIntegrationManager({
    workDir: async (id) => path.join(work, id),
    permissions: { load: async () => ({ ...stored }), save: async (g) => { Object.assign(stored, g); } },
    approve: async (r) => { asked.push(r); return 'once'; },
    discovery: fakeDiscovery(),
    userPaths: async () => [exe],
  });
  const pk = new AdapterPackages(path.join(root, 'integrations'), mgr);
  let file = path.join(root, 'candidate.ccadapter');
  if (mutate) {
    const m = JSON.parse(JSON.stringify(a.manifest)) as Record<string, unknown>;
    mutate(m);
    file = path.join(root, 'candidate-modified.ccadapter');
    await fs.writeFile(file, packAssembled({ ...a, manifest: m }).bytes);
  } else await fs.writeFile(file, bytes);
  await pk.load();
  const review = await pk.review(file);
  if (review.problems.length) throw new Error(`The review of the candidate has problems: ${review.problems.join('; ')}`);
  await pk.install(file, { permissions: review.permissions, allowUnsigned: true });
  return { mgr, pk, exe, dir, work, asked, scenarioFile: path.join(dir, 'mockhost.json'), scenario };
}

async function writeScenario(rig: Rig, mutate: (s: MockScenario) => void): Promise<void> {
  const s = JSON.parse(await fs.readFile(rig.scenarioFile, 'utf8')) as MockScenario;
  mutate(s);
  await fs.writeFile(rig.scenarioFile, JSON.stringify(s, null, 2));
}

export interface SimulationOutcome { report: PipelineReport }

export async function simulate(bp: Blueprint, a: Assembled): Promise<SimulationOutcome> {
  const title = 'Simulated testing (mock program)';
  const note = 'Simulated with a mock program: this proves the flow, not that the real program accepts the commands.';
  if (a.problems.length) return { report: reportOf('simulated', title, [skip('simulated', title, `Not run: ${a.problems[0]}`)], true) };
  if (!(await mockLauncher())) return { report: reportOf('simulated', title, [skip('mock', 'Mock program', 'The mock program could not be built on this PC (it needs the Windows .NET Framework compiler), so no simulated run was possible.')], true) };
  const pyExe = bp.decision.template === 'python-script' ? await findPython() : null;
  if (bp.decision.template === 'python-script' && !pyExe) {
    return { report: reportOf('simulated', title, [skip('python', 'Python', 'No Python interpreter was found on this PC, so the program scripts could not be exercised against stand-in modules.')], true) };
  }
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-sim-'));
  const checks: CheckResult[] = [];
  const bytes = packAssembled(a).bytes;
  const id = a.adapterId;
  const rigs: Rig[] = [];
  try {
    const rig = await makeRig(base, 'a', bp, a, bytes, pyExe);
    rigs.push(rig);
    checks.push(ok('install', 'Install in a scratch profile', 'Reviewed and installed through the normal package path (unsigned, so every command is asked about).'));

    // connection
    const scan = await rig.mgr.scan();
    const app = scan.apps.find((x) => x.adapterId === id);
    if (!app) throw new Error(`The mock program was not recognised for ${id}.`);
    try {
      const info = await rig.mgr.connect(app.key);
      const v = await rig.mgr.verify(app.key);
      const version = info.version ?? '';
      checks.push(v.ok && (a.host || bp.cli) ? (version === MOCK_VERSION || bp.decision.template === 'file-exchange' ? ok('connect', 'Connect and health check', `Connected to the mock (reported version ${version || 'none'}); the health check passed.`) : bad('connect', 'Connect and health check', `The version regular expression read "${version}" from the mock's version output instead of ${MOCK_VERSION}.`)) : v.ok ? ok('connect', 'Connect and health check', 'Connected.') : bad('connect', 'Connect and health check', v.detail));
    } catch (e) { checks.push(bad('connect', 'Connect and health check', errText(e))); throw new Error('stop'); }

    // commands, in a fixed order: health first
    const run = async (command: string, params: Record<string, unknown>) => rig.mgr.execute(app.key, command, params);
    const health = await run('app.health', {});
    checks.push(health.ok ? ok('health-command', 'Connection check command', health.message) : bad('health-command', 'Connection check command', health.error?.message ?? health.message));
    let mockLimited = false;
    for (const c of bp.commands) {
      const r = await run(c.id, c.mock.params);
      if (!r.ok) {
        // Stand-in modules answer every program call with a placeholder, so a code check on a program result (for example "is the shape
        // empty?") can fail for a perfectly good command, and a later command can miss a file the first one could not create. Such
        // failures say nothing about the generated integration: they are reported as a mock limit, not as a defect. Anything else
        // (bad parameters, crashes, timeouts, wrong result shape, forbidden operations) stays a failure.
        const mockLimit = bp.decision.template === 'python-script' && (r.error?.kind === 'verification-failed' || (mockLimited && r.error?.kind === 'invalid-params' && /No file "/.test(r.error.message)));
        if (mockLimit) { mockLimited = true; checks.push(warn(`cmd:${c.id}`, `Command ${c.id}`, `The stand-in program cannot judge this command's own check (${r.error?.message}). This is a limit of the simulation, not proof of a defect; only the real program can decide.`)); continue; }
        checks.push(bad(`cmd:${c.id}`, `Command ${c.id}`, `${r.error?.kind}: ${r.error?.message}`)); continue;
      }
      const missing = r.outputs.filter((o) => o.bytes <= 0);
      const independent = r.evidence.some((e) => /independent check/.test(e)) || bp.decision.template === 'file-exchange';
      checks.push(missing.length || (!independent && bp.decision.template !== 'cli') ? bad(`cmd:${c.id}`, `Command ${c.id}`, 'No independent check ran or an output is empty.') : ok(`cmd:${c.id}`, `Command ${c.id}`, `Ran with its example inputs${r.outputs.length ? ` and produced ${r.outputs.map((o) => path.basename(o.path)).join(', ')}` : ''}; the independent check step ran. (Mock)`));
    }
    checks.push(rig.asked.length >= bp.commands.length + 1 && rig.asked.every((q) => q.untrusted) ? ok('approval', 'Asks before every command', `${rig.asked.length} approval request${rig.asked.length === 1 ? '' : 's'} were raised, all marked "untrusted": the integration is a candidate until you trust it.`) : bad('approval', 'Asks before every command', 'Commands ran without an approval request marked untrusted.'));

    // bad input
    const numeric = bp.commands.flatMap((c) => Object.entries(c.params).filter(([, p]) => p.type === 'number' && p.max !== undefined).map(([k, p]) => ({ c, k, max: p.max! })));
    const probe = numeric[0];
    const first = bp.commands[0];
    if (first) {
      const r1 = probe ? await run(probe.c.id, { ...probe.c.mock.params, [probe.k]: probe.max + 1 }) : await run(first.id, { ...first.mock.params, __bogus__: 1 });
      checks.push(!r1.ok && r1.error?.kind === 'invalid-params' ? ok('bad-input', 'Rejects invalid settings', probe ? `${probe.c.id}: ${probe.k} above its limit was refused before anything ran.` : 'An unknown setting was refused before anything ran.') : bad('bad-input', 'Rejects invalid settings', `Expected invalid-params, got ${r1.ok ? 'success' : r1.error?.kind}.`));
    }

    // crash recovery (the program dies without a result, then works again)
    if (bp.decision.template === 'python-script' && first && mockLimited) {
      checks.push({ id: 'recovery', title: 'Recovers after a crash', state: 'skipped', detail: 'Not run: the first command cannot complete under the stand-in program, so a crash and a second run cannot be compared.' });
    } else if (bp.decision.template === 'python-script' && first) {
      await writeScenario(rig, (s) => { s.crash = { command: first.id, phase: 'run', times: 1 }; });
      const fresh = { ...first.mock.params };
      // New output names: files from the earlier runs are never overwritten.
      for (const [k, v] of Object.entries(fresh)) if (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,40}$/.test(v) && first.python?.outputExtensions.length) fresh[k] = `${v} again`;
      const r1 = await run(first.id, fresh);
      const r2 = await run(first.id, fresh);
      await writeScenario(rig, (s) => { delete s.crash; });
      checks.push(!r1.ok && r2.ok ? ok('recovery', 'Recovers after a crash', `A crashing program was reported honestly (${r1.error?.kind}: ${String(r1.error?.message).slice(0, 90)}) and the next run worked.`) : bad('recovery', 'Recovers after a crash', `First run ok=${r1.ok}, second run ok=${r2.ok}.`));
    } else if (bp.decision.template === 'cli' && first?.cli) {
      const r1 = await run(first.id, first.mock.params);
      checks.push(r1.ok ? ok('recovery', 'Repeatable', 'The command can be run again after an earlier run.') : bad('recovery', 'Repeatable', r1.error?.message ?? 'failed'));
    }
    checks.push(await uninstallCheck(rig, id));

    // timeout and cancel on a second rig whose first command has a short limit
    if (first && bp.decision.template !== 'file-exchange') {
      const rig2 = await makeRig(base, 'b', bp, a, bytes, pyExe, (m) => { const cmds = m.commands as Array<{ id: string; timeoutMs?: number }>; const t = cmds.find((x) => x.id === first.id); if (t) t.timeoutMs = 2000; });
      rigs.push(rig2);
      const app2 = (await rig2.mgr.scan()).apps.find((x) => x.adapterId === id)!;
      await writeScenario(rig2, (s) => { s.slow = bp.decision.template === 'python-script' ? { command: first.id, phase: 'run', ms: 30_000 } : { command: '.', ms: 30_000 }; });
      const t0 = Date.now();
      const slow = await rig2.mgr.execute(app2.key, first.id, first.mock.params);
      checks.push(!slow.ok && slow.error?.kind === 'timeout' && Date.now() - t0 < 20_000 ? ok('timeout', 'Timeout', `A program that never answered was stopped after its ${(first.timeoutMs ?? 0) ? '' : 'declared '}time limit and reported as a timeout.`) : bad('timeout', 'Timeout', `Expected a timeout, got ${slow.ok ? 'success' : slow.error?.kind}.`));
      // cancel: start as a job and cancel it right away
      const job = await rig2.mgr.execute(app2.key, first.id, first.mock.params, { background: true });
      const jobId = String((job.data as { jobId?: string } | undefined)?.jobId ?? '');
      await new Promise((r) => setTimeout(r, 600));
      const cancelled = rig2.mgr.cancelJob(jobId);
      let status = rig2.mgr.job(jobId)?.status;
      for (let i = 0; i < 40 && status === 'running'; i++) { await new Promise((r) => setTimeout(r, 150)); status = rig2.mgr.job(jobId)?.status; }
      const left = await fs.readdir(path.join(rig2.work, id)).catch(() => [] as string[]);
      const claimed = left.filter((f) => !/^_cc_/.test(f));
      checks.push(cancelled && status === 'cancelled' ? ok('cancel', 'Cancellation', `Cancelling a running command stopped it${claimed.length ? ` (left in the work folder: ${claimed.join(', ')})` : ' and left no output behind'}.`) : bad('cancel', 'Cancellation', `Cancel returned ${cancelled}, job status ${status}.`));
    }
  } catch (e) {
    if (errText(e) !== 'stop') checks.push(bad('simulation', 'Simulation', errText(e)));
  } finally {
    for (const r of rigs) { await r.mgr.shutdown().catch(() => undefined); await r.pk.shutdown().catch(() => undefined); }
    await fs.rm(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }).catch(() => undefined);
  }
  checks.push({ id: 'mock-notice', title: 'What this proves', state: 'warning', detail: note });
  return { report: reportOf('simulated', title, checks, true) };
}

async function uninstallCheck(rig: Rig, id: string): Promise<CheckResult> {
  try {
    await rig.pk.uninstall(id);
    const listing = await rig.pk.listing();
    const gone = !listing.installed.some((x) => x.id === id) && !rig.mgr.manifests().some((m) => m.id === id);
    const dirGone = !(await fs.stat(path.join(rig.pk.store.root, 'adapters', id)).then(() => true, () => false));
    return gone && dirGone ? ok('uninstall', 'Uninstall', 'Removing the package unregistered it and deleted its files.') : bad('uninstall', 'Uninstall', 'Something of the package is still registered or on disk after removal.');
  } catch (e) { return bad('uninstall', 'Uninstall', errText(e)); }
}

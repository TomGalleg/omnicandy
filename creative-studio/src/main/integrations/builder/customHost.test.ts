// A "custom" Python host for programs like Unreal Editor: a project file in the launch line, the job file given as -script=<full path>,
// and a version taken from the program file when the program has no version option. Nothing here starts a real program.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleBlueprint } from './assemble';
import { parseBlueprint, type Blueprint } from './blueprint';
import { buildCandidate } from './pipeline';
import { resolvePythonHost } from './templates/python';

const onWindows = process.platform === 'win32';
const fixture = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'ai-generated', 'freecad-enclosure.blueprint.json');
const opts = { version: '1.0.0', createdAt: '2026-01-01T00:00:00Z', author: { kind: 'scripted' as const }, projectId: 'u1' };

type Custom = NonNullable<NonNullable<Blueprint['python']>['custom']>;
const UNREAL: Custom = {
  versionArgs: [], versionRegex: '', versionFrom: 'file', projectExtension: '.uproject',
  launchArgs: ['{project}', '-run=pythonscript', '-script={run}', '-unattended', '-nosplash', '-nullrhi', '-stdout'],
  hostModules: ['FreeCAD', 'App', 'Part', 'Mesh', 'MeshPart', 'Import', 'Spreadsheet', 'Draft', 'Sketcher', 'PartDesign'],
};
/** The FreeCAD enclosure blueprint, re-described as a custom program with the given launch settings. */
const bpWith = (custom: Partial<Custom> = {}): Blueprint => {
  const b = parseBlueprint(JSON.parse(fs.readFileSync(fixture, 'utf8')));
  b.application = { ...b.application, name: 'Mock Engine Editor', exeNames: ['MockEngineEditor.exe'], displayNames: ['Mock Engine Editor'] };
  b.python = { host: 'custom', custom: { ...UNREAL, ...custom } };
  return b;
};
const problemsOf = (custom: Partial<Custom>) => resolvePythonHost(bpWith(custom)).problems.join(' | ');

describe('custom Python host: launch line rules', () => {
  it('accepts the Unreal-style launch line (project file, -script={run}, version from the program file)', () => {
    const r = resolvePythonHost(bpWith());
    expect(r.problems).toEqual([]);
    expect(r.host).toMatchObject({ versionFrom: 'file', projectExtension: '.uproject', absolutePaths: true });
  });

  it('keeps the old simple form working: {run} alone, version from a command, relative paths', () => {
    const r = resolvePythonHost(bpWith({ versionArgs: ['--version'], versionRegex: 'App\\s+(\\d+\\.\\d+)', versionFrom: undefined, projectExtension: undefined, launchArgs: ['{run}'] }));
    expect(r.problems).toEqual([]);
    expect(r.host).toMatchObject({ versionFrom: 'command', projectExtension: null, absolutePaths: false });
  });

  it.each([
    ['{project} without a project extension', { projectExtension: undefined }, /only be used when projectExtension is set/],
    ['a project extension without {project}', { launchArgs: ['-script={run}'] }, /must contain \{project\} exactly once/],
    ['{project} glued to other text', { launchArgs: ['-project={project}', '-script={run}'] }, /\{project\} exactly once as a whole argument/],
    ['two job files', { launchArgs: ['{project}', '-script={run}', '{run}'] }, /\{run\} must appear exactly once/],
    ['{run} glued to other text', { launchArgs: ['{project}', 'x{run}'] }, /whole argument or the value of one option/],
    ['a switch that runs command text', { launchArgs: ['{project}', '-script={run}', '--python-expr=x'] }, /would run text/],
    ['a version option together with versionFrom file', { versionArgs: ['--version'] }, /versionArgs must be empty/],
  ] as Array<[string, Partial<Custom>, RegExp]>)('refuses %s', (_n, change, re) => { expect(problemsOf(change)).toMatch(re); });
});

describe('custom Python host: package', () => {
  it('gives every command a required project setting, even when the AI did not declare one, and says what the user needs', async () => {
    const a = await assembleBlueprint(bpWith(), { ...opts, usesWork: {} });
    expect(a.problems).toEqual([]);
    const cmds = (a.manifest as { commands: Array<{ id: string; params: Record<string, { type: string; required?: boolean }> }> }).commands;
    expect(cmds.length).toBeGreaterThan(1);
    for (const c of cmds) expect(c.params.project, c.id).toMatchObject({ type: 'string', required: true });
    const reqs = JSON.stringify((a.manifest as { requirements: unknown }).requirements);
    expect(reqs).toMatch(/\.uproject project file/);
    expect(reqs).toMatch(/no version option/);
  });
});

describe('generated main.js for a custom host (fake program, nothing started)', () => {
  let dir: string;
  let mod: { probe: (c: unknown) => Promise<{ version: string | null }>; healthCheck: (c: unknown) => Promise<{ ok: boolean; detail: string }>; execute: (cmd: string, params: Record<string, unknown>, c: unknown) => Promise<{ message: string }> };
  const calls: string[][] = [];

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-chost-'));
    const a = await assembleBlueprint(bpWith(), { ...opts, usesWork: {} });
    for (const [name, bytes] of a.files) { const f = path.join(dir, name); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, bytes); }
    mod = createRequire(import.meta.url)(path.join(dir, 'main.js'));
  });
  afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  /** A stand-in for the program: records the launch line and answers with the result line of the job it was given, behind a log prefix. */
  const ctx = (version: string | null = '5.4.4') => ({
    app: { name: 'Unreal Editor', version, exePath: 'X' }, signal: new AbortController().signal, progress: () => undefined,
    error: (kind: string, message: string) => Object.assign(new Error(message), { kind }),
    workDir: async () => dir,
    writeFile: async (name: string, data: string) => { await fsp.writeFile(path.join(dir, name), data); },
    runApp: async (args: string[]) => {
      calls.push(args);
      const job = await fsp.readFile(path.join(dir, '_cc_job.py'), 'utf8');
      const nonce = /^NONCE = "([^"]+)"/m.exec(job)![1];
      return { code: 0, out: `[2026.10.19-10.00.00:000][  0]LogPython: CREATECRAFT_RESULT_${nonce} {"ok":true,"message":"ran","outputs":[],"data":{},"evidence":["e"],"verified":true}\n`, err: '' };
    },
  });
  const project = onWindows ? 'C:\\Games\\My Game\\My Game.uproject' : '/games/my game/my game.uproject';

  it('takes the version from the detected program file and never starts the program to ask', async () => {
    calls.length = 0;
    expect((await mod.probe(ctx('5.4.4'))).version).toBe('5.4.4');
    expect((await mod.probe(ctx(null))).version).toBeNull();
    const h = await mod.healthCheck(ctx(null));
    expect(h.ok).toBe(true);
    expect(h.detail).toMatch(/version is not known/);
    expect(calls).toEqual([]);
  });

  it('launches with the project first, the job as -script=<full path>, and the work folder named in the job', async () => {
    calls.length = 0;
    const r = await mod.execute('enclosure.measure', { project }, ctx());
    expect(r.message).toBe('ran'); // the result line behind "LogPython: " is found
    expect(calls).toHaveLength(2); // the job and its independent check
    for (const args of calls) {
      expect(args[0]).toBe(project);
      expect(args.slice(1, 2)).toEqual(['-run=pythonscript']);
      const script = args.find((x) => x.startsWith('-script='))!.slice('-script='.length);
      expect(path.isAbsolute(script)).toBe(true);
      expect(script.startsWith(dir)).toBe(true);
      expect(args.slice(3)).toEqual(['-unattended', '-nosplash', '-nullrhi', '-stdout']);
    }
    const job = await fsp.readFile(path.join(dir, '_cc_job.py'), 'utf8');
    expect(job.startsWith(`WORKDIR = ${JSON.stringify(dir)}`)).toBe(true);
    const stub = await fsp.readFile(path.join(dir, '_cc_run.py'), 'utf8');
    expect(stub).toContain(JSON.stringify(path.join(dir, '_cc_job.py')));
  });

  it.each([
    ['no project', undefined, /full path of the project file/],
    ['a relative path', 'My Game.uproject', /full path of a project file/],
    ['something that looks like a switch', '-run=evil.uproject', /full path of a project file/],
    ['a path that climbs out', onWindows ? 'C:\\Games\\..\\x.uproject' : '/games/../x.uproject', /full path of a project file/],
    ['a quote in the path', onWindows ? 'C:\\Games\\a"b.uproject' : '/games/a"b.uproject', /full path of a project file/],
    ['the wrong file type', onWindows ? 'C:\\Games\\game.exe' : '/games/game.exe', /must end in \.uproject/],
  ])('refuses %s as the project, before the program is started', async (_n, value, re) => {
    calls.length = 0;
    await expect(mod.execute('app.health', { project: value }, ctx())).rejects.toThrow(re);
    expect(calls).toEqual([]);
  });
});

describe.skipIf(!onWindows)('custom Python host: whole pipeline with the mock program', () => {
  it('waits for commands marked long-running (they start as background jobs) instead of failing the simulated run', async () => {
    const b = bpWith();
    for (const c of b.commands) c.longRunning = true;
    const r = await buildCandidate(b, opts);
    const failed = r.reports.flatMap((x) => x.checks.filter((c) => c.state === 'failed').map((c) => `${x.stage}/${c.id}: ${c.detail}`));
    expect(failed).toEqual([]);
    expect(r.passed).toBe(true);
  }, 300_000);

  it('builds, installs and runs every command with a made-up project, an unknown version and -script=<path>', async () => {
    const r = await buildCandidate(bpWith(), opts);
    const failed = r.reports.flatMap((x) => x.checks.filter((c) => c.state === 'failed').map((c) => `${x.stage}/${c.id}: ${c.detail}`));
    expect(failed).toEqual([]);
    expect(r.passed).toBe(true);
    const m = JSON.parse(r.files!.get('adapter.json')!.toString('utf8')) as { commands: Array<{ params: Record<string, unknown> }> };
    expect(m.commands.every((c) => 'project' in c.params)).toBe(true);
  }, 240_000);
});

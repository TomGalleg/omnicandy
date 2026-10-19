// A clearly marked MOCK program for the simulated test stage. It is NOT the target application and proves nothing about it.
// It lets the generated connector run for real (restricted process, real manager, real ctx.runApp) against a stand-in
// executable, so the flow, parameter handling, timeouts, cancellation, crash recovery and install/uninstall are exercised
// without the program installed.
//
//   MockHost.exe   tiny Windows launcher compiled from MOCK_HOST_CS with the .NET Framework compiler that ships with Windows.
//                  It starts <runtime> <mockhost.js> <args...> in a Job Object, so killing the launcher kills everything below it.
//   mockhost.js    the pretend program. Modes:
//                    python-mock: runs the job script with stand-in modules (every host call "succeeds" and returns a placeholder)
//                    scripted:    answers command lines from the blueprint's example cases
//   mockhost.json  the scenario (versions, example cases, slow / crashing commands)

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface MockScenario {
  label: string;
  versionArgs: string[];
  versionLine: string;
  mode: 'python-mock' | 'scripted';
  python?: string;
  modules?: string[];
  cases?: Array<{ match: string; stdout?: string; stderr?: string; exitCode?: number; writeArgIndex?: number; content?: string; files?: Array<{ name: string; content: string }> }>;
  /** Make one command slow (ms) in the given phase, for timeout and cancellation tests. */
  slow?: { command: string; phase?: 'run' | 'verify'; ms: number };
  /** Make the first N runs of one command crash without a result. */
  crash?: { command: string; phase?: 'run' | 'verify'; times: number };
}

export const MOCK_HOST_CS = String.raw`// MOCK launcher (test double, NOT the target application). Starts: <runtime> <script> <args...> inside a Job Object.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class MockHost
{
    [DllImport("kernel32.dll")] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        var sb = new StringBuilder("\"");
        int bs = 0;
        foreach (char c in a)
        {
            if (c == '\\') { bs++; continue; }
            if (c == '"') { sb.Append('\\', bs * 2 + 1).Append('"'); bs = 0; continue; }
            sb.Append('\\', bs).Append(c); bs = 0;
        }
        sb.Append('\\', bs * 2).Append('"');
        return sb.ToString();
    }

    static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string[] cfg = File.ReadAllLines(Path.Combine(dir, "mockhost.cfg"));
        var sb = new StringBuilder(Quote(cfg[1]));
        foreach (string a in args) sb.Append(' ').Append(Quote(a));
        var psi = new ProcessStartInfo(cfg[0], sb.ToString());
        psi.UseShellExecute = false;
        psi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        IntPtr info = Marshal.AllocHGlobal(144);
        for (int i = 0; i < 144; i++) Marshal.WriteByte(info, i, 0);
        Marshal.WriteInt32(info, 16, 0x2000); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        SetInformationJobObject(job, 9, info, 144);
        var p = Process.Start(psi);
        AssignProcessToJobObject(job, p.Handle);
        p.WaitForExit();
        return p.ExitCode;
    }
}
`;

export const MOCK_HOST_JS = String.raw`'use strict';
// MOCK program (test double, NOT the target application).
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const dir = path.dirname(__filename);
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'mockhost.json'), 'utf8'));
const args = process.argv.slice(2);
const stateFile = path.join(dir, 'mock-state.json');
const state = (() => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return {}; } })();
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args.length === cfg.versionArgs.length && args.every((a, i) => a === cfg.versionArgs[i])) { console.log(cfg.versionLine); process.exit(0); }

const BOOT = [
  'import sys, os',
  'from unittest.mock import MagicMock',
  'class Fake(MagicMock):',
  '    def __init__(self, *a, **k):',
  '        MagicMock.__init__(self, *a, **k)',
  '        for n in ("__lt__", "__le__", "__gt__", "__ge__"):',
  '            try: setattr(self, n, lambda s, o: True)',
  '            except Exception: pass',
  '        try:',
  '            self.__iter__ = lambda s: iter([Fake()])',
  '            self.__len__ = lambda s: 1',
  '        except Exception: pass',
  '    def _get_child_mock(self, **kw):',
  '        kw.pop("_new_name", None)',
  '        return Fake()',
  'for m in os.environ.get("MOCK_MODULES", "").split(","):',
  '    if m: sys.modules[m] = Fake(name=m)',
  'script = sys.argv[1]',
  'sys.argv = [script]',
  'exec(compile(open(script, encoding="utf-8").read(), script, "exec"), {"__name__": "__main__", "__file__": script})',
].join('\n');

(async () => {
  if (cfg.mode === 'python-mock') {
    const script = (args.map((a) => a.replace(/^-{1,2}[A-Za-z][A-Za-z0-9_-]*=/, '')).find((a) => /\.py$/i.test(a)));
    if (!script) { console.error('mock: no script given'); process.exit(2); }
    const text = fs.readFileSync(path.resolve(process.cwd(), script), 'utf8');
    const job = fs.existsSync(path.resolve(process.cwd(), '_cc_job.py')) ? fs.readFileSync(path.resolve(process.cwd(), '_cc_job.py'), 'utf8') : text;
    const command = (/^COMMAND = "([^"]*)"/m.exec(job) || [])[1];
    const phase = (/^PHASE = "([^"]*)"/m.exec(job) || [])[1];
    if (cfg.crash && cfg.crash.command === command && (cfg.crash.phase || 'run') === phase) {
      const k = 'crash:' + command + ':' + phase;
      state[k] = (state[k] || 0) + 1; save();
      if (state[k] <= cfg.crash.times) { console.error('mock: simulated crash'); process.exit(3); }
    }
    if (cfg.slow && cfg.slow.command === command && (cfg.slow.phase || 'run') === phase) await sleep(cfg.slow.ms);
    const r = cp.spawnSync(cfg.python, ['-B', '-c', BOOT, path.resolve(process.cwd(), script)], { env: Object.assign({}, process.env, { MOCK_MODULES: (cfg.modules || []).join(','), PYTHONIOENCODING: 'utf-8' }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = r.stdout || '';
    // Stand-in modules cannot write real files: create clearly marked placeholders for the outputs the job reported.
    const m = /^CREATECRAFT_RESULT_\w+ (\{.*\})$/m.exec(out);
    if (m) {
      try {
        const res = JSON.parse(m[1]);
        for (const o of res.outputs || []) { const f = path.join(process.cwd(), path.basename(o)); if (!fs.existsSync(f)) fs.writeFileSync(f, 'CREATECRAFT MOCK OUTPUT - not produced by the real program\n'); }
      } catch (e) { /* the connector will report the unreadable result */ }
    }
    process.stdout.write(out);
    process.stderr.write(r.stderr || '');
    process.exit(r.status === null ? 1 : r.status);
  }
  // scripted: command-line programs
  const line = args.join(' ');
  const c = (cfg.cases || []).find((x) => new RegExp(x.match).test(line));
  if (!c) { console.error('mock: no scripted answer for: ' + line); process.exit(9); }
  if (cfg.slow && new RegExp(cfg.slow.command).test(line)) await sleep(cfg.slow.ms);
  if (typeof c.writeArgIndex === 'number' && args[c.writeArgIndex]) { const f = path.join(process.cwd(), args[c.writeArgIndex]); fs.writeFileSync(f, c.content || 'CREATECRAFT MOCK OUTPUT - not produced by the real program\n'); }
  for (const f of c.files || []) fs.writeFileSync(path.join(process.cwd(), f.name), f.content);
  if (c.stdout) console.log(c.stdout);
  if (c.stderr) console.error(c.stderr);
  process.exit(c.exitCode || 0);
})();
`;

const CSC_CANDIDATES = () => [
  path.join(process.env.windir ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.windir ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];

let compiled: Promise<string | null> | null = null;

/** The compiled launcher (cached in the temp folder), or null when this PC has no .NET Framework compiler (non-Windows). */
export function mockLauncher(): Promise<string | null> {
  compiled ??= (async () => {
    if (process.platform !== 'win32') return null;
    const csc = (await Promise.all(CSC_CANDIDATES().map((c) => fs.stat(c).then(() => c, () => null)))).find((x) => !!x);
    if (!csc) return null;
    const hash = createHash('sha256').update(MOCK_HOST_CS).digest('hex').slice(0, 10);
    const dir = path.join(os.tmpdir(), `createcraft-mockhost-${hash}`);
    const exe = path.join(dir, 'MockHost.exe');
    if (await fs.stat(exe).then(() => true, () => false)) return exe;
    await fs.mkdir(dir, { recursive: true });
    const cs = path.join(dir, 'MockHost.cs');
    await fs.writeFile(cs, MOCK_HOST_CS);
    const tmpExe = path.join(dir, `MockHost.${process.pid}.tmp.exe`);
    const ok = await new Promise<boolean>((res) => execFile(csc, ['-nologo', `-out:${tmpExe}`, cs], { timeout: 90_000, windowsHide: true }, (e) => res(!e)));
    if (!ok) return null;
    await fs.rename(tmpExe, exe).catch(() => undefined);
    return (await fs.stat(exe).then(() => true, () => false)) ? exe : tmpExe;
  })();
  return compiled;
}

/** Creates `<folder>/<exeName>` plus its scenario files. Returns the path of the mock program. */
export async function createMockProgram(folder: string, exeName: string, scenario: MockScenario, runtimeExe = process.execPath): Promise<string> {
  const launcher = await mockLauncher();
  if (!launcher) throw new Error('The mock program could not be built (no .NET Framework compiler on this PC).');
  await fs.mkdir(folder, { recursive: true });
  const exe = path.join(folder, exeName);
  await fs.copyFile(launcher, exe);
  await fs.writeFile(path.join(folder, 'mockhost.js'), MOCK_HOST_JS);
  await fs.writeFile(path.join(folder, 'mockhost.cfg'), `${runtimeExe}\n${path.join(folder, 'mockhost.js')}\n`);
  await fs.writeFile(path.join(folder, 'mockhost.json'), JSON.stringify(scenario, null, 2));
  return exe;
}

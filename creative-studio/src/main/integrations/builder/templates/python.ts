// "python-script" template: the program runs a Python job (FreeCADCmd, Blender in background mode, ...). OmniCandi's fixed
// main.js writes the job, starts ONLY the discovered program, parses one result line carrying a random nonce, and then runs a
// SECOND, independent job in a fresh process that re-checks the result. The AI contributes one `run` and one `verify` function
// per command; those are the only AI-written lines in the package, they run inside the program, and they are checked by the
// validators (validate.ts) before the package exists.

import type { Blueprint, BlueprintCommand } from '../blueprint';
import { CUSTOM_ARG_FORBIDDEN, PYTHON_HOSTS, type PythonHost } from '../hosts';
import { RUNTIME_HEAD, RUNTIME_TAIL } from './pythonRuntime';

export const JOB_BODY_FILE = 'job_body.py';

/** The host row for a blueprint: an OmniCandi-owned row, or a validated description for an unknown program. */
export function resolvePythonHost(bp: Blueprint): { host: PythonHost; problems: string[] } {
  const problems: string[] = [];
  const cfg = bp.python;
  if (!cfg) return { host: PYTHON_HOSTS.freecad, problems: ['The blueprint has no "python" section.'] };
  if (cfg.host !== 'custom') {
    const known = PYTHON_HOSTS[cfg.host];
    const exes = bp.application.exeNames.map((e) => e.toLowerCase());
    if (!known.exeNames.every((e) => exes.includes(e.toLowerCase()))) problems.push(`For ${known.label} the program file must be ${known.exeNames.join(' or ')} (the blueprint lists ${bp.application.exeNames.join(', ') || 'none'}).`);
    return { host: known, problems };
  }
  const c = cfg.custom;
  if (!c) return { host: PYTHON_HOSTS.freecad, problems: ['A custom Python host needs python.custom (version arguments, launch arguments, host modules).'] };
  const versionFrom = c.versionFrom ?? 'command';
  const projectExtension = c.projectExtension ? c.projectExtension.toLowerCase() : null;
  const names = (a: string) => a.split('=')[0]!;
  for (const a of [...c.versionArgs, ...c.launchArgs]) if (CUSTOM_ARG_FORBIDDEN.test(a) || CUSTOM_ARG_FORBIDDEN.test(names(a))) problems.push(`The argument "${a}" would run text from the command line; only a script file is allowed.`);
  // {run} is the job file: a whole argument, or the value of one option such as -script={run}.
  const runArgs = c.launchArgs.filter((a) => a.includes('{run}'));
  if (runArgs.length !== 1) problems.push('{run} must appear exactly once.');
  else if (runArgs[0] !== '{run}' && !/^-{1,2}[A-Za-z][A-Za-z0-9_-]{0,30}=\{run\}$/.test(runArgs[0]!)) problems.push('{run} must be a whole argument or the value of one option, for example -script={run}.');
  // {project} is the project file the user names in each command; only when the blueprint says the program works with project files.
  const projArgs = c.launchArgs.filter((a) => a.includes('{project}'));
  if (projectExtension) {
    if (projArgs.length !== 1 || projArgs[0] !== '{project}') problems.push('With projectExtension, the launch arguments must contain {project} exactly once as a whole argument.');
  } else if (projArgs.length) problems.push('{project} can only be used when projectExtension is set (for example ".uproject").');
  if (versionFrom === 'command') {
    try { new RegExp(c.versionRegex); } catch { problems.push('versionRegex is not a valid regular expression.'); }
    if (!/\((?!\?)/.test(c.versionRegex)) problems.push('versionRegex needs one capture group for the version.');
  } else if (c.versionArgs.length) problems.push('With versionFrom "file" the program is not started to read its version, so versionArgs must be empty.');
  const absolutePaths = !!projectExtension || runArgs[0] !== '{run}';
  return {
    host: {
      id: 'custom', label: bp.application.name, exeNames: bp.application.exeNames, displayNames: bp.application.displayNames,
      versionArgs: c.versionArgs, versionRegex: c.versionRegex, launchArgs: c.launchArgs, versionFrom, projectExtension, absolutePaths, hostModules: c.hostModules, coreModules: [], launcher: 'exec-stub',
      knownSymbols: [], docs: [], testedNote: 'Not yet run on the real program.',
    },
    problems,
  };
}

const pyId = (i: number, kind: 'run' | 'verify') => `_${kind}_${i}`;

function indent(code: string, n = 4): string {
  const pad = ' '.repeat(n);
  return code.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n').map((l) => (l.trim() ? pad + l : '')).join('\n');
}

/** The single Python file main.js sends to the program: fixed runtime + the AI's functions wrapped in factories + dispatcher. */
export function assemblePythonJob(bp: Blueprint, host: PythonHost): string {
  const cmds = bp.commands.filter((c) => c.python);
  const parts: string[] = [RUNTIME_HEAD, `HOST_MODULES = ${JSON.stringify(host.hostModules)}`, ''];
  cmds.forEach((c, i) => {
    parts.push(`# command ${c.id}: run`);
    parts.push(`def ${pyId(i, 'run')}():`);
    parts.push(indent(c.python!.source));
    parts.push('    return run');
    parts.push('');
    parts.push(`# command ${c.id}: independent check`);
    parts.push(`def ${pyId(i, 'verify')}():`);
    parts.push(indent(c.python!.verifySource));
    parts.push('    return verify');
    parts.push('');
  });
  parts.push(`_RUN = {${cmds.map((c, i) => `${JSON.stringify(c.id)}: ${pyId(i, 'run')}`).join(', ')}}`);
  parts.push(`_VERIFY = {${cmds.map((c, i) => `${JSON.stringify(c.id)}: ${pyId(i, 'verify')}`).join(', ')}}`);
  parts.push(`_OUTPUT_EXTS = ${JSON.stringify(Object.fromEntries(cmds.map((c) => [c.id, c.python!.outputExtensions])))}`);
  parts.push(RUNTIME_TAIL);
  return parts.join('\n');
}

/** What main.js needs to know about each command (the same values the manifest declares). */
function commandTable(cmds: BlueprintCommand[]) {
  return Object.fromEntries(cmds.filter((c) => c.python).map((c) => [c.id, { outputs: c.python!.outputExtensions.length > 0 }]));
}

export function renderPythonMain(bp: Blueprint, host: PythonHost): string {
  const config = {
    versionArgs: host.versionArgs, versionRegex: host.versionRegex, launchArgs: host.launchArgs, launcher: host.launcher,
    versionFrom: host.versionFrom, projectExtension: host.projectExtension, absolutePaths: host.absolutePaths,
    appLabel: bp.application.name, commands: commandTable(bp.commands),
  };
  const json = JSON.stringify(config, null, 2);
  return MAIN_JS.replace('__CONFIG__', () => json);
}

const MAIN_JS = String.raw`'use strict';
// Generated by OmniCandi's AI Adapter Builder from its fixed "python-script" template. This file is NOT written by the AI.
// It runs in OmniCandi's restricted adapter process: it can read this folder and talk to OmniCandi through ctx, nothing
// else. The program is started by OmniCandi (ctx.runApp) and only ever with the launch line below. The only AI-written code
// is inside job_body.py, which runs inside the program. Parameters travel as base64 JSON data and are never spliced into code.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG = __CONFIG__;
const JOB_BODY = fs.readFileSync(path.join(__dirname, 'job_body.py'), 'utf8');
const JOB_FILE = '_cc_job.py';
const RUN_FILE = '_cc_run.py';
// Some programs import the script they are given as a module, and Python then caches its bytecode keyed on size and
// whole-second mtime: two different jobs of equal size written within a second could run the OLD bytecode. A constant launcher
// that reads the job as text avoids that (seen on real FreeCAD 1.1.4).
const RUN_STUB = "exec(compile(open('" + JOB_FILE + "', encoding='utf-8').read(), '" + JOB_FILE + "', 'exec'))\n";
const ENTRY = CONFIG.launcher === 'exec-stub' ? RUN_FILE : JOB_FILE;
const KINDS = new Set(['app-error', 'unsupported', 'invalid-params', 'missing-app', 'verification-failed']);
const tail = (s) => String(s || '').trim().split(/\r?\n/).slice(-4).join(' ').slice(0, 400);
const b64 = (v) => Buffer.from(JSON.stringify(v === undefined ? {} : v), 'utf8').toString('base64');

async function version(ctx) {
  // A program without a version option is never started just to ask: the version found when it was detected is used (it may be unknown).
  if (CONFIG.versionFrom === 'file') return (ctx.app && ctx.app.version) || null;
  const r = await ctx.runApp(CONFIG.versionArgs, { timeoutMs: 60000 });
  const m = new RegExp(CONFIG.versionRegex, 'i').exec(r.out + '\n' + r.err);
  if (!m) throw ctx.error('app-error', 'The program did not report a version (exit ' + r.code + '). ' + tail(r.err || r.out));
  return m[1];
}

exports.probe = async (ctx) => { const v = await version(ctx); return { version: v, detail: CONFIG.appLabel + (v ? ' ' + v + '.' : ' (version not reported by the program).') }; };
exports.connect = async () => undefined;
exports.healthCheck = async (ctx) => {
  try { const v = await version(ctx); return { ok: true, detail: CONFIG.appLabel + (v ? ' answers (version ' + v + ').' : ' is installed (it has no version option; its version is not known).') + ' Run "Check the connection" for a full check.' }; }
  catch (e) { return { ok: false, detail: String((e && e.message) || e) }; }
};
exports.disconnect = async () => undefined;

// The project file a command names: one full path ending in the project extension. It is handed to the program as ONE argument and can
// never look like an option (a full path never starts with "-"), so a setting cannot add switches to the launch line.
function projectFile(ctx, params) {
  const p = params && params.project;
  if (typeof p !== 'string' || !p) throw ctx.error('invalid-params', 'Give the full path of the project file (' + CONFIG.projectExtension + ') in the "project" setting.');
  if (!(/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/')) || p.includes('..') || /[\u0000-\u001f"|<>*?]/.test(p) || p.length > 400) throw ctx.error('invalid-params', 'The project setting must be the full path of a project file, for example C:\\Projects\\Game\\Game' + CONFIG.projectExtension + '.');
  if (p.slice(-CONFIG.projectExtension.length).toLowerCase() !== CONFIG.projectExtension) throw ctx.error('invalid-params', 'The project file must end in ' + CONFIG.projectExtension + '.');
  return p;
}

async function runPhase(ctx, phase, command, params, prior, timeoutMs, label) {
  if (ctx.signal.aborted) throw ctx.error('app-error', 'The operation was cancelled.');
  const nonce = crypto.randomBytes(12).toString('hex');
  const head = [
    '# OmniCandi generated job. Parameters are data; they are never spliced into code.',
    'import base64 as _b64, json as _json',
    'PHASE = ' + JSON.stringify(phase),
    'COMMAND = ' + JSON.stringify(command),
    'NONCE = ' + JSON.stringify(nonce),
    'PARAMS = _json.loads(_b64.b64decode("' + b64(params) + '").decode("utf-8"))',
    'PRIOR = _json.loads(_b64.b64decode("' + b64(prior) + '").decode("utf-8"))',
    '',
  ].join('\n');
  let work = null;
  if (CONFIG.absolutePaths) work = await ctx.workDir();
  // Some programs change their working folder while starting, so the job and its launcher are then named by full path.
  const jobRef = work ? path.join(work, JOB_FILE) : JOB_FILE;
  const entryRef = work ? path.join(work, ENTRY) : ENTRY;
  await ctx.writeFile(JOB_FILE, (work ? 'WORKDIR = ' + JSON.stringify(work) + '\n' : '') + head + JOB_BODY);
  if (CONFIG.launcher === 'exec-stub') await ctx.writeFile(RUN_FILE, work ? "exec(compile(open(" + JSON.stringify(jobRef) + ", encoding='utf-8').read(), " + JSON.stringify(jobRef) + ", 'exec'))\n" : RUN_STUB);
  ctx.progress(label, phase === 'run' ? 0.25 : 0.7);
  const args = CONFIG.launchArgs.map((a) => (a === '{project}' ? projectFile(ctx, params) : a.replace('{run}', entryRef)));
  const r = await ctx.runApp(args, { timeoutMs });
  if (ctx.signal.aborted) throw ctx.error('app-error', 'The operation was cancelled.');
  // Only a line that carries THIS run's random nonce counts; the last one wins. Anything the job printed cannot forge it.
  // Some programs put a log prefix in front of what a script prints ("LogPython: ..."), so the marker may be anywhere in the line.
  const prefix = 'CREATECRAFT_RESULT_' + nonce + ' ';
  let line = null;
  for (const l of r.out.split(/\r?\n/)) { const i = l.indexOf(prefix); if (i >= 0) line = l.slice(i + prefix.length); }
  if (!line) throw ctx.error('app-error', 'The program did not report a result (exit ' + r.code + '). ' + tail(r.err || r.out));
  let res;
  try { res = JSON.parse(line); } catch (e) { throw ctx.error('app-error', 'The program reported an unreadable result.'); }
  if (!res.ok) throw ctx.error(KINDS.has(res.kind) ? res.kind : 'app-error', (res.declared ? 'Check in the command: ' : '') + String(res.error || 'The program reported an error.').slice(0, 1000));
  return res;
}

exports.execute = async (command, params, ctx) => {
  const spec = CONFIG.commands[command];
  if (!spec && command !== 'app.health') throw ctx.error('unsupported', 'Unknown command ' + command);
  ctx.progress('Preparing the job', 0.05);
  const timeout = command === 'app.health' ? 120000 : 600000;
  const res = await runPhase(ctx, 'run', command, params, {}, timeout, 'The program is working');
  const evidence = Array.isArray(res.evidence) ? res.evidence.filter((e) => typeof e === 'string') : [];
  const outputs = Array.isArray(res.outputs) ? res.outputs.filter((o) => typeof o === 'string') : [];
  let verified = res.verified === true;
  if (command !== 'app.health') {
    // Independent check: a fresh process re-opens what the first one produced and measures it again.
    ctx.progress('Checking the result in a fresh run', 0.7);
    const v = await runPhase(ctx, 'verify', command, params, { message: res.message, outputs, data: res.data || {}, evidence }, 300000, 'Checking the result independently');
    for (const e of Array.isArray(v.evidence) ? v.evidence : []) if (typeof e === 'string') evidence.push('independent check: ' + e);
    verified = true;
  }
  ctx.progress('Done', 1);
  return { message: String(res.message || 'Done.'), outputs, data: res.data, evidence, verified };
};
`;

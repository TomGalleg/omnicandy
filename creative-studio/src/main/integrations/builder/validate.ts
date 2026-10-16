// Stage 1 (static validation) and stage 2 (security validation) of the builder's test pipeline. Pure checks on the blueprint
// and the package it produces; nothing here runs the target program or installs anything.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { PERMISSION_LABEL, type Permission } from '@shared/integrations';
import type { CheckResult, CheckState, PipelineReport } from '@shared/builder';
import { MANIFEST_FILE, parsePackage } from '../packageFormat';
import { validateParams } from '../manager';
import { profileById } from '../install/hostProfiles';
import { type Blueprint } from './blueprint';
import { ALLOWED_PERMISSIONS, assembleBlueprint, EXTERNAL_TEMPLATES, HEALTH_ID, packAssembled, refusedPermissions, type Assembled } from './assemble';
import { PYTHON_HOSTS } from './hosts';
import { findPython, guardPython, pythonArgs, type PyGuardReport, type PySource } from './pyguard';
import { argvProblems } from './templates/cli';
import { JOB_BODY_FILE, resolvePythonHost } from './templates/python';
import { pluginSourceFindings } from './templates/plugin';
import { checkCitationsInDocs, type DocIndex } from './docsIndex';

const ok = (id: string, title: string, detail: string): CheckResult => ({ id, title, state: 'passed', detail });
const bad = (id: string, title: string, detail: string): CheckResult => ({ id, title, state: 'failed', detail });
const warn = (id: string, title: string, detail: string): CheckResult => ({ id, title, state: 'warning', detail });
const skip = (id: string, title: string, detail: string): CheckResult => ({ id, title, state: 'skipped', detail });

export function reportOf(stage: PipelineReport['stage'], title: string, checks: CheckResult[], mock?: boolean): PipelineReport {
  const state: CheckState = checks.some((c) => c.state === 'failed') ? 'failed' : checks.every((c) => c.state === 'skipped') ? 'skipped' : checks.some((c) => c.state === 'warning' || c.state === 'skipped') ? 'warning' : 'passed';
  return { stage, title, state, checks, at: new Date().toISOString(), ...(mock ? { mock: true } : {}) };
}

const hostOf = (u: string): string | null => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
const segments = (sym: string) => sym.split(/[.:/ ()]+/).filter(Boolean);

/** Everything the two stages need to know that only the Python scan can tell. */
export interface ScanOutcome { guard: PyGuardReport | null; usesWork: Record<string, boolean> }

export function pythonSources(bp: Blueprint): PySource[] {
  return bp.commands.flatMap((c) => c.python ? [
    { name: `${c.id}#run`, kind: 'run' as const, text: c.python.source },
    { name: `${c.id}#verify`, kind: 'verify' as const, text: c.python.verifySource },
  ] : []);
}

export async function scanPython(bp: Blueprint): Promise<ScanOutcome> {
  if (bp.decision.template !== 'python-script') return { guard: null, usesWork: {} };
  const { host } = resolvePythonHost(bp);
  const guard = await guardPython(pythonSources(bp), host.hostModules);
  const usesWork: Record<string, boolean> = {};
  for (const c of bp.commands) {
    const f = guard.findings.filter((x) => x.name.startsWith(`${c.id}#`));
    usesWork[c.id] = f.some((x) => x.usesWorkPath);
  }
  return { guard, usesWork };
}

/** Stage 1: is this a well-formed, self-consistent integration? */
export async function staticChecks(bp: Blueprint, a: Assembled, scan: ScanOutcome): Promise<PipelineReport> {
  const checks: CheckResult[] = [];
  const t = bp.decision.template;

  // research and decision
  if (!bp.decision.feasible) checks.push(bad('decision', 'Integration decision', bp.decision.notFeasibleReason ?? 'The research concluded this program cannot be integrated safely.'));
  else if (EXTERNAL_TEMPLATES.includes(t) && bp.decision.type !== 'external') checks.push(bad('decision', 'Integration decision', `The ${t} template builds an external integration, but the blueprint says "${bp.decision.type}". An add-in inside the program needs the dotnet-addin or uxp-plugin template.`));
  else if (!EXTERNAL_TEMPLATES.includes(t) && bp.decision.type === 'external') checks.push(bad('decision', 'Integration decision', `The ${t} template is an add-in inside the program, but the blueprint says "external".`));
  else checks.push(ok('decision', 'Integration decision', `${bp.decision.type} integration using ${t} (${bp.decision.methods.join(', ')}).`));
  if (bp.research.insufficient) checks.push(bad('research', 'Research', `Not enough trustworthy information: ${bp.research.insufficient}`));
  else if (!bp.research.sourcesConsulted || !bp.research.sources.length) checks.push(bad('research', 'Research', 'No documentation was consulted, so no capability can be backed by a source.'));
  else if (!bp.research.sources.some((s) => s.kind === 'official' || s.kind === 'user-supplied')) checks.push(warn('research', 'Research', 'Only unofficial sources were found. Prefer vendor documentation before trusting this.'));
  else checks.push(ok('research', 'Research', `${bp.research.sources.length} source${bp.research.sources.length === 1 ? '' : 's'} (${bp.research.sources.filter((s) => s.kind === 'official').length} official).`));

  // commands
  const ids = new Set<string>();
  const dup: string[] = [];
  for (const c of bp.commands) { if (ids.has(c.id)) dup.push(c.id); ids.add(c.id); }
  if (!EXTERNAL_TEMPLATES.includes(t)) checks.push(warn('template', 'Template', `The ${t} template produces source for review only: it does not build an installable package.`));
  if (!bp.commands.length) checks.push(bad('commands', 'Commands', 'The integration has no commands.'));
  else if (dup.length) checks.push(bad('commands', 'Commands', `Duplicate command ids: ${dup.join(', ')}.`));
  else if (ids.has(HEALTH_ID)) checks.push(bad('commands', 'Commands', `"${HEALTH_ID}" is added by the template; the AI cannot define it.`));
  else {
    const wrong = bp.commands.filter((c) => (t === 'python-script' ? !c.python || c.cli || c.file : t === 'cli' ? !c.cli || c.python || c.file : t === 'file-exchange' ? !c.file || c.python || c.cli : !c.plugin));
    checks.push(wrong.length ? bad('commands', 'Commands', `These commands do not match the ${t} template: ${wrong.map((c) => c.id).join(', ')}.`) : ok('commands', 'Commands', `${bp.commands.length} typed command${bp.commands.length === 1 ? '' : 's'} plus the built-in connection check.`));
  }

  // settings
  const paramProblems: string[] = [];
  for (const c of bp.commands) {
    for (const [k, p] of Object.entries(c.params)) {
      if (p.type !== 'number' && (p.min !== undefined || p.max !== undefined)) paramProblems.push(`${c.id}.${k}: min/max only apply to numbers`);
      if (p.min !== undefined && p.max !== undefined && p.min > p.max) paramProblems.push(`${c.id}.${k}: min is greater than max`);
      if (typeof p.default === 'number' && ((p.min !== undefined && p.default < p.min) || (p.max !== undefined && p.default > p.max))) paramProblems.push(`${c.id}.${k}: default is outside min/max`);
      if (p.default !== undefined && typeof p.default !== p.type) paramProblems.push(`${c.id}.${k}: default is not a ${p.type}`);
      if (p.type === 'number' && p.required && (p.min === undefined || p.max === undefined)) paramProblems.push(`${c.id}.${k}: a required number needs min and max so bad input is refused`);
    }
  }
  checks.push(paramProblems.length ? bad('capability-schema', 'Capability schema', paramProblems.slice(0, 6).join('; ')) : ok('capability-schema', 'Capability schema', 'Every setting has a type, sensible limits and a default or is required.'));

  // example inputs must satisfy the typed settings (the simulated test uses them)
  const mockProblems: string[] = [];
  for (const c of bp.commands) {
    const spec = a.manifest.commands && Array.isArray(a.manifest.commands) ? (a.manifest.commands as Array<{ id: string }>).find((x) => x.id === c.id) : null;
    if (!spec) continue;
    const r = validateParams(spec as never, c.mock.params);
    if (typeof r === 'string') mockProblems.push(`${c.id} example: ${r}`);
    if (c.liveTest) { const lr = validateParams(spec as never, c.liveTest.params); if (typeof lr === 'string') mockProblems.push(`${c.id} live test: ${lr}`); }
  }
  checks.push(mockProblems.length ? bad('examples', 'Example inputs', mockProblems.slice(0, 5).join('; ')) : ok('examples', 'Example inputs', 'The example inputs used for testing satisfy the typed settings.'));

  if (a.sourceOnly) {
    const p = bp.plugin;
    const wantTech = t === 'dotnet-addin' ? 'dotnet-addin' : 'uxp';
    if (!p) checks.push(bad('plugin-source', 'Add-in source', 'The blueprint has no "plugin" section.'));
    else {
      const caps = new Set(p.capabilities.map((c) => c.id));
      const missing = bp.commands.filter((c) => c.plugin && !caps.has(c.plugin.capability)).map((c) => c.id);
      const findings = pluginSourceFindings(bp).filter((f) => f.problems.some((x) => /valid JSON|braces/.test(x)));
      checks.push(p.technology !== wantTech ? bad('plugin-source', 'Add-in source', `The ${t} template needs technology "${wantTech}".`)
        : missing.length ? bad('plugin-source', 'Add-in source', `Commands call capabilities the add-in does not register: ${missing.join(', ')}.`)
        : findings.length ? bad('plugin-source', 'Add-in source', findings.map((f) => `${f.file}: ${f.problems.join('; ')}`).join(' | '))
        : ok('plugin-source', 'Add-in source', `${p.files.length} source file${p.files.length === 1 ? '' : 's'} laid out; every command maps to a registered capability.`));
    }
    checks.push(skip('compile', 'Build', 'Building add-ins needs the vendor SDK and a build step that CreateCraft does not run yet, so the source was not compiled.'));
    return reportOf('static', 'Static validation', checks);
  }

  // manifest + package structure (the same reader the installer uses)
  if (a.problems.length) checks.push(bad('manifest', 'Manifest', a.problems.join('; ')));
  else {
    const packed = packAssembled(a);
    const parsed = parsePackage(packed.files);
    if (!parsed.manifest || parsed.problems.length) checks.push(bad('manifest', 'Manifest and package structure', (parsed.problems.length ? parsed.problems : ['invalid manifest']).slice(0, 6).join('; ')));
    else checks.push(ok('manifest', 'Manifest and package structure', `Manifest version ${parsed.manifest.manifestVersion}, SDK ${parsed.manifest.sdk.min}-${parsed.manifest.sdk.max}, ${packed.files.size} files, every hash matches.`));
  }

  // source validation
  const main = a.files.get('main.js');
  if (main) {
    try { new vm.Script(main.toString('utf8'), { filename: 'main.js' }); checks.push(ok('javascript', 'Connector code', 'main.js (rendered from CreateCraft\'s template) compiles.')); } catch (e) { checks.push(bad('javascript', 'Connector code', `main.js does not compile: ${(e as Error).message}`)); }
  }
  if (t === 'python-script') {
    const body = a.files.get(JOB_BODY_FILE);
    const py = await findPython();
    if (!body) checks.push(bad('python', 'Program script', `${JOB_BODY_FILE} was not produced.`));
    else if (!py) checks.push(skip('python', 'Program script', 'No Python interpreter on this PC: the assembled script was not compiled here (the syntax scan above still ran).'));
    else checks.push(await compilePython(py, body.toString('utf8')));
    if (scan.guard) {
      const syntax = scan.guard.findings.filter((f) => f.problems.some((p) => /syntax error/.test(p)));
      checks.push(syntax.length ? bad('python-syntax', 'Python syntax', syntax.map((f) => `${f.name}: ${f.problems[0]}`).join('; ')) : ok('python-syntax', 'Python syntax', `${scan.guard.findings.length} function${scan.guard.findings.length === 1 ? '' : 's'} parsed.`));
    }
  }
  return reportOf('static', 'Static validation', checks);
}

async function compilePython(py: string, text: string): Promise<CheckResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pyc-'));
  try {
    const file = path.join(dir, 'job.py');
    // The header the real run adds, so the script is compiled the way it will run.
    await fs.writeFile(file, `PHASE = "run"\nCOMMAND = "x"\nNONCE = "n"\nPARAMS = {}\nPRIOR = {}\n${text}`);
    const err = await new Promise<string | null>((res) => execFile(py, pythonArgs(py, ['-I', '-B', '-c', 'import sys;compile(open(sys.argv[1],encoding="utf-8").read(),"job","exec")', file]), { timeout: 30_000, windowsHide: true }, (e, _o, se) => res(e ? String(se || e.message).trim().split('\n').slice(-2).join(' ') : null)));
    return err ? bad('python', 'Program script', `The assembled script does not compile: ${err}`) : ok('python', 'Program script', 'The assembled script compiles.');
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

/** Stage 2: may this run at all, and does it only touch what it says it touches? */
export interface DocContext { index: DocIndex; coreModules: string[] }

export async function securityChecks(bp: Blueprint, a: Assembled, scan: ScanOutcome, docs?: DocContext): Promise<PipelineReport> {
  const checks: CheckResult[] = [];
  const t = bp.decision.template;

  // 1. permissions
  const refused = refusedPermissions(bp);
  if (refused.length) checks.push(bad('permissions', 'Permission inspection', `The AI asked for permissions this kind of integration is never given: ${[...new Set(refused.map((r) => `${PERMISSION_LABEL[r.permission]} (${r.command})`))].join('; ')}.`));
  else {
    const all = new Set<Permission>((Array.isArray(a.manifest.commands) ? (a.manifest.commands as Array<{ permissions: Permission[] }>) : []).flatMap((c) => c.permissions));
    const powerful = [...all].filter((p) => p === 'execute-scripts' || p === 'modify-project' || p === 'write-files');
    checks.push(ok('permissions', 'Permission inspection', `Allowed set for ${t}: ${ALLOWED_PERMISSIONS[t].length} kinds; this integration asks for ${[...all].map((p) => PERMISSION_LABEL[p].toLowerCase()).join(', ') || 'none'}${powerful.length ? ' (you review these before installing)' : ''}.`));
  }
  const destructive = bp.commands.filter((c) => c.destructive);
  if (destructive.length) checks.push(warn('destructive', 'Destructive commands', `${destructive.map((c) => c.id).join(', ')} always ask before running.`));

  // 2. the AI-written code
  if (t === 'python-script' && scan.guard) {
    const failed = scan.guard.findings.filter((f) => !f.ok);
    checks.push(failed.length
      ? bad('ai-code', 'AI-written code', failed.map((f) => `${f.name}: ${f.problems.slice(0, 3).join('; ')}`).slice(0, 4).join(' | '))
      : ok('ai-code', 'AI-written code', `${scan.guard.findings.length} function${scan.guard.findings.length === 1 ? '' : 's'} use only the program's own modules, safe maths/text modules and the file helper H. No processes, network, raw file access or interpreter internals. ${scan.guard.engine === 'python-ast' ? 'Checked with a syntax tree and a text scan.' : 'Only the text scan ran (no Python on this PC).'}`));
    if (scan.guard.engine !== 'python-ast') checks.push(warn('ai-code-depth', 'AI-written code', scan.guard.note));
  } else if (t === 'cli') {
    const probs = bp.commands.flatMap((c) => c.cli ? [...argvProblems(c.cli.argv, c.cli.rules, c.id), ...(c.cli.verify ? argvProblems(c.cli.verify.argv, c.cli.rules, `${c.id} check`) : [])] : []);
    checks.push(probs.length ? bad('ai-code', 'Command lines', probs.slice(0, 4).join(' | ')) : ok('ai-code', 'Command lines', 'Every argument is a fixed word or one validated setting. No shell, no list files, no URLs, no paths outside the work folder.'));
  } else if (t === 'dotnet-addin' || t === 'uxp-plugin') {
    const bad2 = pluginSourceFindings(bp).filter((f) => f.problems.some((x) => !/braces|valid JSON/.test(x)));
    checks.push(bad2.length ? bad('ai-code', 'Add-in source', bad2.map((f) => `${f.file}: ${f.problems.join('; ')}`).join(' | ')) : ok('ai-code', 'Add-in source', 'The source does not start processes, write or delete files, use the network, load code or touch the registry.'));
  } else if (t === 'file-exchange') {
    const risky = bp.commands.filter((c) => c.file && /<script|javascript:|powershell|cmd\.exe|#!\/|\beval\s*\(|\bexec\s*\(/i.test(c.file.template));
    checks.push(risky.length ? bad('ai-code', 'File templates', `${risky.map((c) => c.id).join(', ')} contain script-like content.`) : ok('ai-code', 'File templates', 'The file templates are plain data with {setting} placeholders.'));
  }

  // 3. documented interfaces only
  checks.push(documentedInterfaceCheck(bp, scan));
  if (docs && docs.index.docs.length && bp.decision.template === 'python-script') {
    const r = checkCitationsInDocs(bp, docs.index, docs.coreModules);
    checks.push(r.missing.length
      ? bad('cited-in-docs', 'Citations match the documentation', `These cited symbols do not appear in the collected documentation: ${r.missing.slice(0, 8).map((m) => `${m.command}: ${m.symbol}`).join('; ')}.`)
      : ok('cited-in-docs', 'Citations match the documentation', `Every cited symbol was found in the ${docs.index.docs.length} collected document${docs.index.docs.length === 1 ? '' : 's'}${r.prose ? ` (${r.prose} descriptive citation${r.prose === 1 ? ' was' : 's were'} not counted as symbols)` : ''}.`));
  }

  // 4. package integrity
  if (a.sourceOnly) {
    checks.push(warn('integrity', 'Package integrity', 'No installable package is produced for this template, so nothing can be installed from it.'));
  } else if (a.problems.length === 0) {
    const packed = packAssembled(a);
    const parsed = parsePackage(packed.files);
    const allowedNames = new Set(['main.js', JOB_BODY_FILE, 'docs/USER_GUIDE.md', 'tests/mock-cases.json', 'provenance.json', MANIFEST_FILE]);
    const extra = [...packed.files.keys()].filter((n) => !allowedNames.has(n));
    if (parsed.problems.length) checks.push(bad('integrity', 'Package integrity', parsed.problems.slice(0, 4).join('; ')));
    else if (extra.length) checks.push(bad('integrity', 'Package integrity', `Unexpected files in the package: ${extra.join(', ')}.`));
    else checks.push(ok('integrity', 'Package integrity', 'SHA-256 of every file recorded in the manifest; nothing unlisted; strict schema (no scripts, paths or hooks).'));
    const m = parsed.manifest;
    if (m) {
      checks.push(m.publisher.name === 'Created on this computer (AI-generated)' && m.id.startsWith('custom.')
        ? ok('identity', 'Identity', 'Publisher is fixed to "Created on this computer (AI-generated)" and the id starts with "custom.", so it cannot pass as an official integration.')
        : bad('identity', 'Identity', 'The package does not carry the fixed local publisher identity.'));
      checks.push(m.integration ? bad('destination', 'Installation destination', 'Generated external integrations must not declare an in-program installer section.') : ok('destination', 'Installation destination', 'Installs nothing outside CreateCraft\'s own integrations folder; no plug-in files are copied into other programs.'));
    }
  } else checks.push(bad('integrity', 'Package integrity', a.problems.join('; ')));
  if (!EXTERNAL_TEMPLATES.includes(t)) {
    const profile = profileById(bp.decision.hostProfile ?? '');
    checks.push(profile ? ok('destination', 'Installation destination', `Uses CreateCraft's installation profile for ${profile.name} (readiness: ${profile.readiness}).`) : bad('destination', 'Installation destination', 'CreateCraft has no installation profile for this program, so it will not write plug-in files for it.'));
  }

  // 5. restricted runtime
  checks.push(ok('runtime', 'Runtime isolation', 'Runs in the existing restricted adapter process (OS-enforced read-only access to its own folder, no spawning, minimal environment). Commands are asked about every time until you trust it. This is not an operating-system sandbox: see Known limitations.'));
  return reportOf('security', 'Security validation', checks);
}

function documentedInterfaceCheck(bp: Blueprint, scan: ScanOutcome): CheckResult {
  const t = bp.decision.template;
  const sourceHosts = new Set(bp.research.sources.map((s) => hostOf(s.url)).filter((h): h is string => !!h));
  const problems: string[] = [];
  const unknown: string[] = [];
  for (const c of bp.commands) {
    if (!c.docRefs.length) problems.push(`${c.id}: lists no documented interface`);
    for (const d of c.docRefs) {
      const h = hostOf(d.url);
      if (!h) problems.push(`${c.id}: "${d.symbol}" has no valid address`);
      else if (!sourceHosts.has(h)) problems.push(`${c.id}: "${d.symbol}" cites ${h}, which is not one of the research sources`);
    }
    const declared = c.docRefs.map((d) => d.symbol);
    if (t === 'python-script' && scan.guard) {
      const found = scan.guard.findings.filter((f) => f.name.startsWith(`${c.id}#`));
      const used = new Set(found.flatMap((f) => f.moduleSymbols));
      const calls = new Set(found.flatMap((f) => f.methodCalls));
      for (const s of used) if (!declared.some((d) => d === s || d.startsWith(`${s}.`) || s.startsWith(`${d}.`))) problems.push(`${c.id}: uses ${s} without documenting it`);
      for (const m of calls) if (!declared.some((d) => segments(d).includes(m))) problems.push(`${c.id}: calls .${m}() without documenting it`);
      if (bp.python) {
        const { host } = resolvePythonHost(bp);
        if (host.knownSymbols.length) for (const s of used) if (!host.knownSymbols.some((r) => r.test(s))) unknown.push(s);
      }
    } else if (t === 'cli' && c.cli) {
      const flags = c.cli.argv.filter((a) => /^-/.test(a)).map((a) => a.replace(/\{.*$/, '').replace(/=$/, ''));
      for (const f of [...flags, ...(c.cli.verify?.argv ?? []).filter((a) => /^-/.test(a))]) if (!declared.some((d) => d.includes(f))) problems.push(`${c.id}: option ${f} is not documented`);
    }
  }
  if (problems.length) return bad('documented', 'Documented interfaces only', problems.slice(0, 6).join('; '));
  if (unknown.length) return warn('documented', 'Documented interfaces only', `Every interface is cited. CreateCraft does not recognise ${[...new Set(unknown)].slice(0, 5).join(', ')}; only a real run can confirm they exist.`);
  return ok('documented', 'Documented interfaces only', 'Every function, class or option used is cited with a source that the research consulted.');
}

/** Both pre-install stages together. */
export async function runStaticAndSecurity(bp: Blueprint, assembled: Assembled, scan: ScanOutcome): Promise<PipelineReport[]> {
  return [await staticChecks(bp, assembled, scan), await securityChecks(bp, assembled, scan)];
}

export { PYTHON_HOSTS, assembleBlueprint };

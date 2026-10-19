// Turns a validated Blueprint into the files of a .ccadapter package, using OmniCandi's fixed templates. The result is
// always a manifest-version-2 EXTERNAL package: generated integrations carry no installer-side behaviour, and every file that
// can run is either a template rendered by OmniCandi or an AI function that the validators already checked.

import { createHash } from 'node:crypto';
import { ADAPTER_SDK_VERSION, PACKAGE_MANIFEST_VERSION, PERMISSION_LABEL, type CommandSpec, type Permission } from '@shared/integrations';
import { BUILDER_PUBLISHER, type TemplateId } from '@shared/builder';
import { adapterIdFor, type Blueprint, type BlueprintCommand } from './blueprint';
import { writeZip } from '../zip';
import { renderCliMain } from './templates/cli';
import { renderFileMain } from './templates/file';
import { assemblePythonJob, JOB_BODY_FILE, renderPythonMain, resolvePythonHost } from './templates/python';
import type { PythonHost } from './hosts';
import { renderPluginSource } from './templates/plugin';

export const HEALTH_ID = 'app.health';
export const EXTERNAL_TEMPLATES: TemplateId[] = ['python-script', 'cli', 'file-exchange'];
export const PLUGIN_TEMPLATES: TemplateId[] = ['dotnet-addin', 'uxp-plugin'];

/** Permissions a template lets the AI keep. Everything else it asks for is refused; the template adds what it itself needs. */
export const ALLOWED_PERMISSIONS: Record<TemplateId, Permission[]> = {
  'python-script': ['read-info', 'read-project', 'modify-project', 'write-files', 'execute-scripts'],
  cli: ['read-info', 'read-project', 'open-files', 'write-files', 'execute-scripts'],
  'file-exchange': ['read-info', 'read-project', 'open-files', 'write-files'],
  'dotnet-addin': ['read-info', 'read-project', 'modify-project'],
  'uxp-plugin': ['read-info', 'read-project', 'modify-project'],
};
const REQUIRED_PERMISSIONS: Record<TemplateId, Permission[]> = {
  'python-script': ['execute-scripts', 'write-files'], cli: ['execute-scripts'], 'file-exchange': ['write-files'], 'dotnet-addin': [], 'uxp-plugin': [],
};

export interface AssembleOptions {
  version: string;
  createdAt: string;
  /** Who wrote the blueprint, recorded in provenance.json. */
  author: { kind: 'claude' | 'scripted' | 'repair'; note?: string };
  projectId: string;
  /** Commands whose code reads existing files in the work folder (found by the Python scan): they also need read-project. */
  usesWork?: Record<string, boolean>;
}

export interface Assembled {
  adapterId: string;
  version: string;
  files: Map<string, Buffer>;
  manifest: Record<string, unknown>;
  host: PythonHost | null;
  problems: string[];
  /** add-in templates: source for review only, no installable package. */
  sourceOnly?: boolean;
  pluginSource?: Map<string, Buffer>;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const buf = (s: string) => Buffer.from(s, 'utf8');
const sortPerms = (p: Iterable<Permission>) => [...new Set(p)].sort();

export function commandPermissions(bp: Blueprint, c: BlueprintCommand, extra: Permission[] = []): Permission[] {
  const t = bp.decision.template;
  const allowed = new Set(ALLOWED_PERMISSIONS[t]);
  return sortPerms([...c.permissions.filter((p) => allowed.has(p)), ...REQUIRED_PERMISSIONS[t], ...extra]);
}

/** The permissions the AI asked for that the template does not allow (refused by the security stage). */
export function refusedPermissions(bp: Blueprint): Array<{ command: string; permission: Permission }> {
  const allowed = new Set(ALLOWED_PERMISSIONS[bp.decision.template]);
  const fromCommands = bp.commands.flatMap((c) => c.permissions.filter((p) => !allowed.has(p)).map((p) => ({ command: c.id, permission: p })));
  const fromPlugin = (bp.plugin?.capabilities ?? []).flatMap((c) => c.permissions.filter((p) => !allowed.has(p)).map((p) => ({ command: `capability ${c.id}`, permission: p })));
  return [...fromCommands, ...fromPlugin];
}

/** The setting every command of a program that works with project files takes: the full path of the project file. */
export function projectParam(ext: string, appName: string): CommandSpec['params'][string] {
  return { type: 'string', required: true, description: `Full path of the ${appName} project file (it ends in ${ext}), for example C:\\Projects\\MyProject\\MyProject${ext}.` } as CommandSpec['params'][string];
}

function commandSpecs(bp: Blueprint, usesWork: Record<string, boolean>, host: PythonHost | null): CommandSpec[] {
  const t = bp.decision.template;
  const projExt = t === 'python-script' ? host?.projectExtension ?? null : null;
  const withProject = (params: CommandSpec['params']): CommandSpec['params'] => (projExt ? { ...params, project: projectParam(projExt, bp.application.name) } : params);
  const health: CommandSpec = {
    id: HEALTH_ID, label: `Check that ${bp.application.name} works`, idempotent: true, timeoutMs: 120_000,
    description: t === 'python-script'
      ? `Starts ${bp.application.name} without a window and runs a tiny job to prove its scripting works. Saves nothing.`
      : t === 'cli' ? `Runs ${bp.application.name} with its version option to prove the command line works. Saves nothing.` : `Checks that this integration can write files for ${bp.application.name}. The program is not started.`,
    params: withProject({}), permissions: t === 'file-exchange' ? ['read-info'] : sortPerms(['read-info', ...REQUIRED_PERMISSIONS[t], ...(t === 'python-script' ? ['write-files' as Permission] : [])]),
  };
  const specs = bp.commands.map((c): CommandSpec => ({
    id: c.id, label: c.label, description: c.description, params: withProject(c.params as CommandSpec['params']),
    permissions: commandPermissions(bp, c, usesWork[c.id] ? ['read-project'] : []),
    ...(c.destructive ? { destructive: true } : {}), ...(c.idempotent ? { idempotent: true } : {}),
    timeoutMs: c.timeoutMs ?? (t === 'python-script' ? 180_000 : 120_000), ...(c.longRunning ? { longRunning: true } : {}),
  }));
  return [health, ...specs];
}

function userGuide(bp: Blueprint, specs: CommandSpec[]): string {
  const lines = [
    `# ${bp.application.name} integration (created on this computer)`, '',
    bp.userGuide.trim(), '',
    '## What it can do', '',
    ...specs.map((c) => `- **${c.label}** (\`${c.id}\`): ${c.description}${c.destructive ? ' Always asks first.' : ''}`), '',
    '## What it may do on your computer', '',
    ...sortPerms(specs.flatMap((c) => c.permissions)).map((p) => `- ${PERMISSION_LABEL[p]}`), '',
    '## Good to know', '',
    '- This integration was written by an AI for this computer only. It is not shared or published anywhere.',
    '- It starts as an untrusted candidate: OmniCandi asks before every command until you decide otherwise.',
    '- "Tested" only ever means tested against the real program on this computer. Simulated tests prove the flow, not the program.',
    ...bp.research.limitations.map((l) => `- ${l}`),
  ];
  return `${lines.join('\n')}\n`;
}

/** Manifest requirements: what the user needs, in plain words. */
function requirements(bp: Blueprint, host: PythonHost | null): Array<{ kind: 'application' | 'other'; text: string }> {
  const reqs: Array<{ kind: 'application' | 'other'; text: string }> = [
    { kind: 'application', text: `${bp.application.name} must be installed on this computer.` },
    ...bp.research.requiredTools.slice(0, 6).map((t) => ({ kind: 'other' as const, text: t })),
    { kind: 'other', text: 'Written by an AI for this computer. Simulated tests passed; it is only called "tested" after commands succeed on the real program.' },
  ];
  if (host?.projectExtension) reqs.push({ kind: 'other', text: `Each command needs the full path of a ${host.projectExtension} project file.` });
  if (host?.versionFrom === 'file') reqs.push({ kind: 'other', text: `${bp.application.name} has no version option, so its version is taken from the program file and may be unknown.` });
  if (host?.testedNote) reqs.push({ kind: 'other', text: host.testedNote });
  return reqs;
}

export async function assembleBlueprint(bp: Blueprint, o: AssembleOptions): Promise<Assembled> {
  const t = bp.decision.template;
  const problems: string[] = [];
  const files = new Map<string, Buffer>();
  const adapterId = adapterIdFor(bp);
  let host: PythonHost | null = null;
  const usesWork = o.usesWork ?? {};
  let exeNames = bp.application.exeNames;
  let methods = bp.decision.methods;

  if (!EXTERNAL_TEMPLATES.includes(t)) {
    return { adapterId, version: o.version, files, manifest: {}, host: null, problems: [], sourceOnly: true, pluginSource: renderPluginSource(bp) };
  }
  if (t === 'python-script') {
    const r = resolvePythonHost(bp);
    problems.push(...r.problems);
    host = r.host;
    exeNames = host.exeNames;
    files.set(JOB_BODY_FILE, buf(assemblePythonJob(bp, host)));
    files.set('main.js', buf(renderPythonMain(bp, host)));
    if (!methods.includes('scripting')) methods = ['scripting', ...methods].slice(0, 4) as typeof methods;
  } else if (t === 'cli') {
    files.set('main.js', buf(renderCliMain(bp)));
    if (!methods.includes('cli')) methods = ['cli', ...methods].slice(0, 4) as typeof methods;
  } else {
    files.set('main.js', buf(renderFileMain(bp)));
    if (!methods.includes('file-exchange')) methods = ['file-exchange', ...methods].slice(0, 4) as typeof methods;
  }
  const specs = commandSpecs(bp, usesWork, host);
  const displayNames = host?.displayNames?.length ? [...new Set([...bp.application.displayNames, ...host.displayNames])] : bp.application.displayNames;
  const manifest: Record<string, unknown> = {
    manifestVersion: PACKAGE_MANIFEST_VERSION,
    id: adapterId,
    name: `${bp.application.name} (custom)`.slice(0, 80),
    version: o.version,
    description: `${bp.research.summary}`.slice(0, 500),
    license: 'Private: created on this computer',
    publisher: { name: BUILDER_PUBLISHER },
    sdk: { min: ADAPTER_SDK_VERSION, max: ADAPTER_SDK_VERSION },
    application: {
      kind: 'program', name: bp.application.name, exeNames, displayNames: displayNames.slice(0, 10),
      ...(bp.application.versions.length ? { versions: bp.application.versions } : {}),
    },
    requirements: requirements(bp, host),
    runtime: { entry: 'main.js', dependencies: [] },
    methods,
    capabilities: ['detect', 'connect', 'disconnect', 'healthCheck', 'executeCommand'],
    commands: specs,
    files: {},
  };
  files.set('docs/USER_GUIDE.md', buf(userGuide(bp, specs)));
  files.set('tests/mock-cases.json', buf(`${JSON.stringify(bp.commands.map((c) => ({ command: c.id, mock: c.mock })), null, 2)}\n`));
  files.set('provenance.json', buf(`${JSON.stringify({
    generator: 'OmniCandi AI Adapter Builder', blueprintSchema: bp.schemaVersion, projectId: o.projectId, createdAt: o.createdAt, template: t,
    author: o.author, trust: 'untrusted-candidate',
    sources: bp.research.sources,
    documentedInterfaces: bp.commands.map((c) => ({ command: c.id, uses: c.docRefs })),
    blueprintSha256: sha(JSON.stringify(bp)),
  }, null, 2)}\n`));
  return { adapterId, version: o.version, files, manifest, host, problems };
}

/** Hashes every file into the manifest and returns the finished .ccadapter bytes (unsigned) plus the file map as written. */
export function packAssembled(a: Assembled): { bytes: Buffer; files: Map<string, Buffer> } {
  const out = new Map(a.files);
  const hashes = Object.fromEntries([...out.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([n, b]) => [n, sha(b)]));
  const manifest = { ...a.manifest, files: hashes };
  out.set('adapter.json', buf(`${JSON.stringify(manifest, null, 2)}\n`));
  return { bytes: writeZip(out), files: out };
}

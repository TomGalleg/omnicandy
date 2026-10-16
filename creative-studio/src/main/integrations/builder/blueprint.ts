// The Blueprint: the ONLY thing the AI hands to the builder. It is data (a strict JSON document), not a package.
// Everything that can run is produced by CreateCraft's own templates from this data; the AI-written parts are
// confined to named slots (a Python function per command, a command-line argument list, a file template, plug-in
// sources) that the validators check before anything is built. A blueprint cannot name paths, scripts to run or
// permissions beyond what its template allows.

import { z } from 'zod';
import { PERMISSION_LABEL, type Permission } from '@shared/integrations';

const PERMS = Object.keys(PERMISSION_LABEL) as [Permission, ...Permission[]];
const text = (max: number) => z.string().min(1).max(max);
const versionStr = z.string().regex(/^\d+(\.\d+){0,2}$/, 'a version such as 1.2 or 1.2.3');
const range = z.object({ min: versionStr.optional(), max: versionStr.optional() }).strict();

export const sourceSchema = z.object({
  title: text(160),
  url: z.string().max(300),
  kind: z.enum(['official', 'vendor-community', 'user-supplied', 'other']),
  note: z.string().max(700).optional(),
}).strict();

export const researchSchema = z.object({
  application: z.object({
    name: text(80),
    publisher: z.string().max(80).nullable(),
    platforms: z.array(text(40)).max(6),
    version: z.string().max(40).nullable(),
  }).strict(),
  summary: text(2000),
  sources: z.array(sourceSchema).max(30),
  methods: z.array(z.object({
    method: z.enum(['api', 'scripting', 'mcp', 'cli', 'file-exchange', 'ui-automation', 'visual']),
    officialSupport: z.enum(['official', 'partial', 'none']),
    note: text(400),
  }).strict()).max(8),
  scripting: z.array(text(300)).max(10),
  commandLine: z.array(text(300)).max(10),
  fileFormats: z.array(text(120)).max(20),
  pluginTechnologies: z.array(text(160)).max(10),
  licensing: z.string().max(600),
  requiredTools: z.array(text(160)).max(10),
  limitations: z.array(text(400)).max(12),
  insufficient: z.string().max(800).nullable(),
  sourcesConsulted: z.boolean(),
}).strict();

const paramSpec = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  description: text(300),
  required: z.boolean().optional(),
  default: z.union([z.string().max(300), z.number(), z.boolean()]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
}).strict();

const docRef = z.object({
  /** The documented function, class, property, option or flag the command relies on, e.g. "Part.makeBox" or "-resize". */
  symbol: text(160),
  url: z.string().max(300),
  note: z.string().max(200).optional(),
}).strict();

const cliRule = z.object({
  /** work-file-in: an existing file in the work folder. work-file-out: a NEW file name in the work folder. enum, text and number as named. */
  kind: z.enum(['work-file-in', 'work-file-out', 'enum', 'text', 'number']),
  extensions: z.array(z.string().regex(/^\.[A-Za-z0-9]{1,8}$/)).max(8).optional(),
  values: z.array(z.string().max(60)).max(40).optional(),
}).strict();

const mock = z.object({
  /** Example arguments for the simulated test. */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  stdout: z.string().max(4000).optional(),
  /** cli template: what the independent check prints for a good result. */
  verifyStdout: z.string().max(2000).optional(),
  stderr: z.string().max(2000).optional(),
  exitCode: z.number().int().min(0).max(255).optional(),
  /** Files the pretend program creates in the work folder. */
  files: z.array(z.object({ name: text(80), content: z.string().max(20_000) }).strict()).max(6).optional(),
}).strict();

export const commandSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]{0,60}$/, 'command id: lower-case letters, digits, "_", "." or "-"'),
  label: text(80),
  description: text(400),
  params: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/), paramSpec).refine((o) => Object.keys(o).length <= 20, 'at most 20 settings per command'),
  permissions: z.array(z.enum(PERMS)).max(PERMS.length),
  destructive: z.boolean().optional(),
  idempotent: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(30 * 60 * 1000).optional(),
  longRunning: z.boolean().optional(),
  /** Every documented interface this command uses. The validators compare this list with what the code really touches. */
  docRefs: z.array(docRef).max(30),
  /** python-script template: a function `run(P, H)` and a function `verify(P, R, H)` (see templates/python.ts). */
  python: z.object({
    source: text(16_000),
    verifySource: text(10_000),
    /** Extensions of NEW files the command may create (for example ".FCStd"). */
    outputExtensions: z.array(z.string().regex(/^\.[A-Za-z0-9]{1,8}$/)).max(5),
  }).strict().optional(),
  /** cli template: fixed argument list; `{name}` tokens are replaced by validated settings, one argument each, never through a shell. */
  cli: z.object({
    argv: z.array(z.string().max(160)).min(1).max(40),
    rules: z.record(z.string(), cliRule),
    /** Output files (may contain {name} tokens) that must exist afterwards. */
    outputs: z.array(z.string().max(120)).max(6),
    expect: z.object({ exitCodes: z.array(z.number().int().min(0).max(255)).max(4), stdoutRegex: z.string().max(200).optional() }).strict(),
    /** A second, independent run (read-only) that checks the result, for example an "identify" call on the new file. */
    verify: z.object({ argv: z.array(z.string().max(160)).min(1).max(30), stdoutRegex: z.string().max(200) }).strict().optional(),
  }).strict().optional(),
  /** file-exchange template: writes a file in a documented format for the program to open or import. */
  file: z.object({
    extension: z.string().regex(/^\.[A-Za-z0-9]{1,8}$/),
    nameParam: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/),
    /** Text with {name} tokens for the command's settings (numbers are written with a fixed format, text is escaped). */
    template: text(20_000),
    check: z.object({ kind: z.enum(['json', 'xml', 'regex']), regex: z.string().max(200).optional() }).strict(),
  }).strict().optional(),
  /** Plug-in templates: which capability inside the program this command calls. */
  plugin: z.object({ capability: z.string().regex(/^[a-z][a-z0-9_.-]{0,60}$/) }).strict().optional(),
  mock,
  /** What to run against the REAL program once it is installed. */
  liveTest: z.object({
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    kind: z.enum(['read', 'edit']),
  }).strict().optional(),
}).strict();

export const decisionSchema = z.object({
  feasible: z.boolean(),
  notFeasibleReason: z.string().max(1200).nullable(),
  type: z.enum(['external', 'internal', 'hybrid']),
  template: z.enum(['python-script', 'cli', 'file-exchange', 'dotnet-addin', 'uxp-plugin']),
  methods: z.array(z.enum(['api', 'scripting', 'mcp', 'cli', 'file-exchange', 'ui-automation', 'visual'])).min(1).max(4),
  rationale: text(1200),
  /** internal and hybrid only: the id of an installation profile CreateCraft already has. */
  hostProfile: z.string().max(60).nullable(),
}).strict();

const pluginFile = z.object({ path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/), content: z.string().max(60_000) }).strict();

export const blueprintSchema = z.object({
  schemaVersion: z.literal(1),
  application: z.object({
    name: text(80),
    publisher: z.string().max(80).nullable(),
    platforms: z.array(text(40)).max(6),
    versions: z.array(range).max(6),
    exeNames: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,60}\.exe$/i, 'a plain .exe file name')).max(6),
    displayNames: z.array(text(80)).max(8),
  }).strict(),
  research: researchSchema,
  decision: decisionSchema,
  /** cli template: how to read the program's version. */
  cli: z.object({
    versionArgs: z.array(z.string().regex(/^[A-Za-z0-9_./=-]{1,40}$/)).max(3),
    versionRegex: z.string().max(120),
    /** A realistic sample of what the version option prints; used to check the regex and by the simulated test. */
    versionExample: text(300),
  }).strict().optional(),
  /** python-script template configuration. */
  python: z.object({
    host: z.enum(['freecad', 'blender', 'custom']),
    custom: z.object({
      versionArgs: z.array(z.string().regex(/^[A-Za-z0-9_./=-]{1,40}$/)).max(3),
      versionRegex: z.string().max(120),
      launchArgs: z.array(z.string().regex(/^[A-Za-z0-9_./={}-]{1,60}$/)).min(1).max(6),
      hostModules: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/)).max(12),
    }).strict().optional(),
  }).strict().optional(),
  commands: z.array(commandSchema).max(12),
  /** dotnet-addin and uxp-plugin templates: source files of the code that runs inside the program. */
  plugin: z.object({
    technology: z.enum(['dotnet-addin', 'uxp']),
    files: z.array(pluginFile).max(12),
    /** Capabilities the plug-in registers. */
    capabilities: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_.-]{0,60}$/), permissions: z.array(z.enum(PERMS)).max(PERMS.length) }).strict()).max(20),
  }).strict().optional(),
  userGuide: text(6000),
}).strict();

export type Blueprint = z.infer<typeof blueprintSchema>;
export type BlueprintCommand = z.infer<typeof commandSchema>;
export type ResearchData = z.infer<typeof researchSchema>;

export class BlueprintError extends Error {
  constructor(message: string, readonly problems: string[] = []) { super(message); }
}

/** Pulls the first JSON object out of the AI's answer (it may arrive in a code fence or with a sentence in front). */
export function extractJson(raw: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = (fence?.[1] ?? raw).trim();
  const start = body.indexOf('{');
  if (start < 0) throw new BlueprintError('The AI did not answer with a JSON document.');
  // Walk to the matching brace so trailing commentary is ignored; strings are skipped so braces inside them do not count.
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i]!;
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(body.slice(start, i + 1)); } catch (e) { throw new BlueprintError(`The AI's JSON could not be read: ${(e as Error).message}`); } } }
  }
  throw new BlueprintError('The AI\'s JSON document is incomplete.');
}

export function parseResearch(input: unknown): ResearchData {
  const raw = typeof input === 'string' ? extractJson(input) : input;
  const r = researchSchema.safeParse(raw);
  if (!r.success) throw new BlueprintError('The research result is not in the expected form.', r.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'research'}: ${i.message}`));
  return r.data;
}

export function parseBlueprint(input: unknown): Blueprint {
  const raw = typeof input === 'string' ? extractJson(input) : input;
  const r = blueprintSchema.safeParse(raw);
  if (!r.success) throw new BlueprintError('The generated integration is not in the expected form.', r.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'blueprint'}: ${i.message}`));
  return r.data;
}

/** "freecad-enclosure" from any text: lower-case letters, digits and dashes. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/\.exe$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}

/** Adapter id of a privately generated integration. The "custom." prefix keeps it away from every official id. */
export function adapterIdFor(bp: Pick<Blueprint, 'application'>, suffix?: string): string {
  return `custom.${slug(bp.application.name)}${suffix ? `-${slug(suffix)}` : ''}`.slice(0, 60);
}

export function isReadOnly(perms: readonly Permission[]): boolean {
  return !perms.some((p) => p === 'modify-project' || p === 'write-files' || p === 'ui-automation' || p === 'network');
}
